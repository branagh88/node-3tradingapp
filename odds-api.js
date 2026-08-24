// odds-api.js — Thin provider for The Odds API v4 (the "OddsApiProvider").
//
// Standalone by design: no import from api.js (TickerbotAPI is frozen). The
// Odds API authenticates via an `apiKey` QUERY PARAMETER, so every log line
// and Error message produced here must be scrubbed of the key — URLs are
// rebuilt without the param before logging (same redaction mindset as
// api.js safeErrorInfo).
//
// Zero hardcoded sports/books/teams. Zero bundled keys.
import { logger } from './utils.js';

const DEFAULT_BASE_URL = 'https://api.the-odds-api.com';

// Build a URL string safe for logs: strips the apiKey query parameter value.
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('apiKey')) u.searchParams.set('apiKey', 'REDACTED');
    return u.toString();
  } catch {
    return '<unparseable-url>';
  }
}

function makeError(name, message, extra = {}) {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

async function _doFetch(url) {
  if (typeof globalThis.fetch !== 'function') {
    throw makeError('TransportError', 'Network transport unavailable in this environment.');
  }
  try {
    return await globalThis.fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    // Never include the raw URL (contains the key) in the thrown error.
    throw makeError('TransportError', `Network request failed: ${(err && err.message) || 'unknown transport error'}`);
  }
}

class OddsApiProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, transport = null } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._doFetch = typeof transport === 'function' ? transport : _doFetch;
  }

  // Shared GET + status normalization. Throws ApiError (with statusCode) on
  // non-2xx; TransportErrors propagate from the transport. All messages are
  // key-free; logged URLs are redacted.
  async _get(path, params, apiKey) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    if (apiKey) url.searchParams.set('apiKey', String(apiKey));
    logger.info(`[OddsApi] GET ${redactUrl(url.toString())}`);
    let res;
    try {
      res = await this._doFetch(url.toString());
    } catch (err) {
      if (err && err.name === 'TransportError') throw err;
      throw makeError('TransportError', `Network request failed: ${(err && err.message) || 'unknown'}`);
    }
    if (!res.ok) {
      const statusCode = res.status;
      let detail = '';
      try {
        const body = await res.text();
        detail = body ? ` — ${body.slice(0, 200)}` : '';
        // Body could theoretically echo the key param; scrub defensively.
        if (apiKey) detail = detail.split(String(apiKey)).join('REDACTED');
      } catch { /* body unreadable — keep empty detail */ }
      const kind = statusCode === 401 || statusCode === 403 || statusCode === 422
        ? 'unconfigured-or-invalid-key'
        : statusCode === 429 ? 'rate-limited' : 'server';
      throw makeError(
        'ApiError',
        `The Odds API request failed with HTTP ${statusCode} (${kind})${detail}`,
        { statusCode, kind },
      );
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw makeError('ApiError', 'The Odds API returned a non-JSON response.', { statusCode: res.status, kind: 'server' });
    }
    return data;
  }

  // GET /v4/sports → [{ key, group, title, description, active, hasOutrights }]
  async fetchSports(apiKey) {
    const data = await this._get('/v4/sports/', {}, apiKey);
    if (!Array.isArray(data)) {
      throw makeError('ApiError', 'The Odds API /v4/sports returned an unexpected payload.', { statusCode: 0, kind: 'server' });
    }
    return data.map((s) => ({
      key: typeof s.key === 'string' ? s.key : '',
      group: typeof s.group === 'string' ? s.group : '',
      title: typeof s.title === 'string' ? s.title : s.key || '',
      description: typeof s.description === 'string' ? s.description : '',
      active: !!s.active,
      hasOutrights: !!s.has_outrights,
    }));
  }

  // GET /v4/sports/{sportKey}/events → [{ id, sportKey, commenceTime, homeTeam, awayTeam }]
  async fetchUpcomingEvents(apiKey, sportKey, { dateFormat = 'iso' } = {}) {
    if (!sportKey) throw makeError('ApiError', 'A sport key is required to list events.', { statusCode: 0, kind: 'client' });
    const path = `/v4/sports/${encodeURIComponent(sportKey)}/events`;
    const data = await this._get(path, { dateFormat }, apiKey);
    if (!Array.isArray(data)) {
      throw makeError('ApiError', 'The Odds API events endpoint returned an unexpected payload.', { statusCode: 0, kind: 'server' });
    }
    return data.map((e) => ({
      id: typeof e.id === 'string' ? e.id : '',
      sportKey: typeof e.sport_key === 'string' ? e.sport_key : sportKey,
      commenceTime: typeof e.commence_time === 'string' ? e.commence_time : '',
      homeTeam: typeof e.home_team === 'string' ? e.home_team : '',
      awayTeam: typeof e.away_team === 'string' ? e.away_team : '',
    }));
  }

  // GET /v4/sports/{sportKey}/events/{eventId}/odds → normalized bookmakers
  async fetchEventOdds(apiKey, sportKey, eventId, { regions = 'us', markets = 'h2h', oddsFormat = 'decimal' } = {}) {
    if (!sportKey || !eventId) {
      throw makeError('ApiError', 'Sport key and event id are required to fetch odds.', { statusCode: 0, kind: 'client' });
    }
    const path = `/v4/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(eventId)}/odds`;
    const data = await this._get(path, { regions, markets, oddsFormat }, apiKey);
    const rawBooks = Array.isArray(data && data.bookmakers) ? data.bookmakers : [];
    return {
      bookmakers: rawBooks.map((b) => ({
        key: typeof b.key === 'string' ? b.key : '',
        title: typeof b.title === 'string' ? b.title : b.key || '',
        lastUpdate: typeof b.last_update === 'string' ? b.last_update : '',
        markets: (Array.isArray(b.markets) ? b.markets : []).map((m) => ({
          key: typeof m.key === 'string' ? m.key : '',
          outcomes: (Array.isArray(m.outcomes) ? m.outcomes : [])
            .filter((o) => o && typeof o.name === 'string')
            .map((o) => ({ name: o.name, price: Number(o.price) })),
        })),
      })),
    };
  }
}

export { OddsApiProvider };
export default OddsApiProvider;
