// tests/odds-api.test.mjs — OddsApiProvider (odds-api.js).
//
// OFFLINE: globalThis.fetch is stubbed with a recording fake. Sentinel key
// only; asserts redaction in every error message and log line.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY = 'test-sentinel-key-abc123';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => { calls.push(String(url)); return handler(url, calls.length); });
  return calls;
}

let logLines;
beforeEach(() => {
  vi.restoreAllMocks();
  logLines = [];
  for (const m of ['debug', 'info', 'warn', 'error']) {
    vi.spyOn(console, m).mockImplementation((...a) => logLines.push(a.map(String).join(' ')));
  }
});
afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

async function importProvider() {
  const mod = await import('../odds-api.js');
  return new mod.OddsApiProvider();
}

describe('OddsApiProvider — request shape', () => {
  it('fetchSports hits /v4/sports/ with apiKey query param', async () => {
    const provider = await importProvider();
    const calls = installFetch(() => jsonResponse([]));
    await provider.fetchSports(KEY);
    expect(calls.length).toBe(1);
    const u = new URL(calls[0]);
    expect(u.pathname).toBe('/v4/sports/');
    expect(u.searchParams.get('apiKey')).toBe(KEY);
  });

  it('fetchUpcomingEvents builds /v4/sports/{sport}/events with dateFormat', async () => {
    const provider = await importProvider();
    const calls = installFetch(() => jsonResponse([]));
    await provider.fetchUpcomingEvents(KEY, 'americanfootball_nfl');
    const u = new URL(calls[0]);
    expect(u.pathname).toBe('/v4/sports/americanfootball_nfl/events');
    expect(u.searchParams.get('dateFormat')).toBe('iso');
    expect(u.searchParams.get('apiKey')).toBe(KEY);
  });

  it('fetchEventOdds builds event odds path with regions/markets/oddsFormat', async () => {
    const provider = await importProvider();
    const calls = installFetch(() => jsonResponse({ bookmakers: [] }));
    await provider.fetchEventOdds(KEY, 'soccer_epl', 'evt-1');
    const u = new URL(calls[0]);
    expect(u.pathname).toBe('/v4/sports/soccer_epl/events/evt-1/odds');
    expect(u.searchParams.get('regions')).toBe('us');
    expect(u.searchParams.get('markets')).toBe('h2h');
    expect(u.searchParams.get('oddsFormat')).toBe('decimal');
  });
});

describe('OddsApiProvider — normalization', () => {
  it('maps snake_case sports payload to camelCase', async () => {
    const provider = await importProvider();
    installFetch(() => jsonResponse([
      { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: 'English Premier League', active: true, has_outrights: false },
      { key: 'wwc', group: 'Combat', title: null, active: false, has_outrights: true },
    ]));
    const sports = await provider.fetchSports(KEY);
    expect(sports).toEqual([
      { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: 'English Premier League', active: true, hasOutrights: false },
      { key: 'wwc', group: 'Combat', title: 'wwc', description: '', active: false, hasOutrights: true },
    ]);
  });

  it('normalizes events and odds payloads', async () => {
    const provider = await importProvider();
    installFetch((url) => {
      if (url.includes('/odds')) {
        return jsonResponse({
          bookmakers: [{ key: 'book_a', title: 'Book A', last_update: '2025-01-01T10:00:00Z',
            markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.1 }, { name: 'Chelsea', price: 3.4 }] }] }],
        });
      }
      if (url.includes('/events')) {
        return jsonResponse([{ id: 'e1', sport_key: 'soccer_epl', commence_time: '2025-01-01T12:00:00Z', home_team: 'Arsenal', away_team: 'Chelsea' }]);
      }
      return jsonResponse({
        bookmakers: [{
          key: 'book_a', title: 'Book A', last_update: '2025-01-01T10:00:00Z',
          markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.1 }, { name: 'Chelsea', price: 3.4 }] }],
        }],
      });
    });
    const events = await provider.fetchUpcomingEvents(KEY, 'soccer_epl');
    expect(events[0]).toEqual({ id: 'e1', sportKey: 'soccer_epl', commenceTime: '2025-01-01T12:00:00Z', homeTeam: 'Arsenal', awayTeam: 'Chelsea' });
    const odds = await provider.fetchEventOdds(KEY, 'soccer_epl', 'e1');
    expect(odds.bookmakers[0].title).toBe('Book A');
    expect(odds.bookmakers[0].markets[0].outcomes[0]).toEqual({ name: 'Arsenal', price: 2.1 });
  });
});

describe('OddsApiProvider — errors & redaction', () => {
  it('401 → ApiError classifiable as unconfigured-or-invalid-key', async () => {
    const provider = await importProvider();
    installFetch(() => jsonResponse({}, 401));
    await expect(provider.fetchSports(KEY)).rejects.toMatchObject({ name: 'ApiError', kind: 'unconfigured-or-invalid-key', statusCode: 401 });
  });

  it('429 → rate-limited kind', async () => {
    const provider = await importProvider();
    installFetch(() => jsonResponse({}, 429));
    await expect(provider.fetchSports(KEY)).rejects.toMatchObject({ name: 'ApiError', kind: 'rate-limited', statusCode: 429 });
  });

  it('fetch rejection → TransportError', async () => {
    const provider = await importProvider();
    installFetch(() => { throw new Error('offline'); });
    await expect(provider.fetchSports(KEY)).rejects.toMatchObject({ name: 'TransportError' });
  });

  it('no error message or log line ever contains the sentinel key', async () => {
    const provider = await importProvider();
    installFetch((url) => {
      if (url.endsWith('/sports/')) return jsonResponse({}, 401);
      if (url.includes('/events/')) throw new Error('network down');
      return jsonResponse({});
    });
    const errs = [];
    for (const p of [
      provider.fetchSports(KEY),
      provider.fetchUpcomingEvents(KEY, 'soccer_epl').catch((e) => e),
      provider.fetchEventOdds(KEY, 'soccer_epl', 'e1').catch((e) => e),
    ]) {
      try { await p; } catch (e) { errs.push(e); }
    }
    // First call rejects (401); others resolve — collect only rejections.
    const allText = errs.map((e) => `${e.message}`).concat(logLines).join('\n');
    expect(allText.includes(KEY)).toBe(false);
    // And a rejected URL-with-key never leaks through the message.
    const err401 = await provider.fetchSports(KEY).catch((e) => e);
    expect(err401.message.includes(KEY)).toBe(false);
  });
});

describe('OddsApiProvider — no hardcoded data', () => {
  it('module source contains no sport/book/team keys or bundled credentials', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../odds-api.js', import.meta.url), 'utf8');
    for (const banned of ['soccer_', 'americanfootball_', 'draftkings', 'fanduel', 'bet365', 'sk-', 'pinnacle']) {
      expect(src.toLowerCase().includes(banned)).toBe(false);
    }
  });
});
