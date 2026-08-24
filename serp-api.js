// serp-api.js — Thin provider for SerpAPI (the "SerpApiProvider").
//
// The api_key is a QUERY PARAMETER, so every log line and Error message is
// scrubbed of the key (same discipline as odds-api.js). An empty key throws
// NotConfiguredError BEFORE any network request.
import { logger } from './utils.js';

const DEFAULT_ENDPOINT = 'https://serpapi.com/search.json';

function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('api_key')) u.searchParams.set('api_key', 'REDACTED');
    return u.toString();
  } catch {
    return '<unparseable-url>';
  }
}

export async function fetchResearch(apiKey, query, { engine = 'google', num = 5 } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    const err = new Error('SerpAPI key not configured.');
    err.name = 'NotConfiguredError';
    throw err; // no network request
  }
  if (!query || !String(query).trim()) {
    const err = new Error('A search query is required.');
    err.name = 'ApiError';
    throw err;
  }

  const url = new URL(DEFAULT_ENDPOINT);
  url.searchParams.set('engine', String(engine));
  url.searchParams.set('q', String(query));
  if (num) url.searchParams.set('num', String(num));
  url.searchParams.set('api_key', key);
  logger.info(`[SerpApi] GET ${redactUrl(url.toString())}`);

  let res;
  try {
    res = await globalThis.fetch(url.toString(), { headers: { accept: 'application/json' } });
  } catch (err) {
    throw Object.assign(new Error(`Network request failed: ${(err && err.message) || 'unknown transport error'}`), { name: 'TransportError' });
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      detail = body ? ` — ${body.slice(0, 200)}` : '';
      detail = detail.split(key).join('REDACTED');
    } catch { /* keep empty */ }
    const kind = res.status === 401 || res.status === 403 ? 'unconfigured-or-invalid-key'
      : res.status === 429 ? 'rate-limited' : 'server';
    throw Object.assign(
      new Error(`SerpAPI request failed with HTTP ${res.status} (${kind})${detail}`),
      { name: 'ApiError', statusCode: res.status, kind },
    );
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(new Error('SerpAPI returned a non-JSON response.'), { name: 'ApiError' });
  }
  // Normalize organic_results → [{ title, link, snippet }]; everything else ignored.
  const organic = Array.isArray(data && data.organic_results) ? data.organic_results : [];
  return organic
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      link: typeof r.link === 'string' ? r.link : '',
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
    }))
    .filter((r) => r.title || r.link || r.snippet);
}

export default { fetchResearch };
