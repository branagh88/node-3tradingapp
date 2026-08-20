// scripts/verify-v2-offline.mjs — OFFLINE verification of the Tickerbot v2 client
// against the CURRENT /v2/tickers contract, through the app's OWN code path
// (TickerbotAPI._doFetch → buildUrl → normalizeQuote/normalizeSearchResult).
//
// Why offline: the build box has NO stored Tickerbot API key (baseURL
// unconfigured, hasApiKey=false — see scripts/capture-aapl.mjs), so a live
// authenticated capture is unavailable. Instead of fabricating response fields
// we stub the transport (`globalThis.fetch`, exactly what the browser branch of
// _doFetch uses) with the SAME envelope shapes the repo already documents as the
// current v2 contract (quote row = nested { symbol, name, asset_class, as_of,
// metrics:{…}, signals:{…} }; search = paginated { as_of, count, next_cursor,
// results:[…] }). Because _doFetch runs fully, its NEW diagnostics log the exact
// resolved URL, HTTP status, response type and top-level response keys for BOTH
// GET /v2/tickers/AAPL and GET /v2/tickers?search=… (values redacted — keys only).
//
// Run:  node scripts/verify-v2-offline.mjs
// Exits 0 on pass, 1 on any failure.

import { MarketAPI } from '../api.js';

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name} ${extra}`); }
}

// ---- canned CURRENT v2 contract envelopes (fixtures, never fabricated from a
// real live capture — the live API on this box is unreachable without a key) ----
const QUOTES = {
  AAPL: { symbol: 'AAPL', name: 'Apple Inc.', asset_class: 'EQUITY', asset_type: 'STOCK', as_of: '2026-08-20T12:00:00Z', metrics: { price: 232.87, day_change: 2.87, day_change_pct: 1.25, volume: 51200000, market_cap: 3520000000000 }, signals: { rsi_14: 61.2, sma_20: 240.1, state_flags: ['in_uptrend'] } },
  MSFT: { symbol: 'MSFT', name: 'Microsoft Corporation', asset_class: 'EQUITY', asset_type: 'STOCK', as_of: '2026-08-20T12:00:00Z', metrics: { price: 420.11, day_change: 1.22, day_change_pct: 0.29, volume: 20000000, market_cap: 3120000000000 }, signals: { rsi_14: 55.0 } },
  GME:  { symbol: 'GME', name: 'GameStop Corp.', asset_class: 'EQUITY', asset_type: 'STOCK', as_of: '2026-08-20T12:00:00Z', metrics: { price: 24.5, day_change: 0.3, day_change_pct: 1.24, volume: 8000000, market_cap: 7500000000 }, signals: { rsi_14: 48.3 } },
};
const DIRECTORY = [
  { ticker: 'AAPL', name: 'Apple Inc.', asset_class: 'EQUITY', asset_type: 'STOCK', exchange: 'NASDAQ' },
  { ticker: 'MSFT', name: 'Microsoft Corporation', asset_class: 'EQUITY', asset_type: 'STOCK', exchange: 'NASDAQ' },
  { ticker: 'GME', name: 'GameStop Corp.', asset_class: 'EQUITY', asset_type: 'STOCK', exchange: 'NYSE' },
  { ticker: 'NVDA', name: 'NVIDIA Corporation', asset_class: 'EQUITY', asset_type: 'STOCK', exchange: 'NASDAQ' },
  { ticker: 'TSLA', name: 'Tesla, Inc.', asset_class: 'EQUITY', asset_type: 'STOCK', exchange: 'NASDAQ' },
];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const captured = [];

// Stub the exact transport _doFetch uses on the browser branch. The app's OWN
// buildUrl / normalization / diagnostics all still run.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  captured.push(u.toString());
  const p = u.pathname;
  if (p === '/v2/tickers' && u.searchParams.has('search')) {
    const q = (u.searchParams.get('search') || '').toLowerCase();
    const results = DIRECTORY.filter((r) => String(r.ticker).toLowerCase() === q || String(r.name).toLowerCase().includes(q));
    return json({ as_of: '2026-08-20T12:00:00Z', count: results.length, next_cursor: null, results });
  }
  if (p.startsWith('/v2/tickers/')) {
    const sym = decodeURIComponent(p.slice('/v2/tickers/'.length)).toUpperCase();
    const q = QUOTES[sym];
    if (!q) return json({ error: 'not_found', message: 'no such ticker' }, 404);
    return json(q);
  }
  return json({ error: 'not_found' }, 404);
};

const api = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '', settings: { timeoutMs: 5000 } });

console.log('\n=== quote lookups (GET /v2/tickers/{ticker}) ===');
// Exact URL generated through the app's own code path must be
// https://api.tickerbot.io/v2/tickers/AAPL (no /quote, no /v2/search).
const urlAapl = api.buildUrl('/v2/tickers/AAPL');
console.log(`[verify] getTickerQuote('AAPL') resolves to: ${urlAapl}`);
ok('URL generated for AAPL is exactly https://api.tickerbot.io/v2/tickers/AAPL', urlAapl === 'https://api.tickerbot.io/v2/tickers/AAPL', `-> ${urlAapl}`);
ok('default quote URL is NOT /quote', !urlAapl.includes('/quote'));

const aapl = await api.getTickerQuote('AAPL');
const msft = await api.getTickerQuote('MSFT');
ok('AAPL lookup returns a nonzero price', aapl.price != null && aapl.price > 0, `-> price=${aapl.price}`);
ok('AAPL quote carries symbol/name/type', aapl.symbol === 'AAPL' && aapl.type === 'stock' && aapl.name.includes('Apple'));
ok('MSFT lookup returns a nonzero price', msft.price != null && msft.price > 0, `-> price=${msft.price}`);

console.log('\n=== search (GET /v2/tickers?search=…) ===');
const sAapl = await api.searchTickers('AAPL');
const sApple = await api.searchTickers('Apple');
const sGme = await api.searchTickers('GME');
ok('searching AAPL returns AAPL', sAapl.some((r) => r.symbol === 'AAPL'), `-> ${sAapl.map((r) => r.symbol).join(',')}`);
ok('searching Apple returns Apple/AAPL', sApple.some((r) => r.symbol === 'AAPL' && /apple/i.test(r.name)), `-> ${sApple.map((r) => r.symbol).join(',')}`);
ok('searching GME returns GME', sGme.some((r) => r.symbol === 'GME'), `-> ${sGme.map((r) => r.symbol).join(',')}`);
ok('search never hit /v2/search', !captured.some((u) => u.includes('/v2/search')), `-> ${captured.filter((u) => u.includes('/search')).join(', ')}`);
ok('search unwraps paginated envelope (results intact)', Array.isArray(sApple) && typeof sApple.cursor === 'undefined' || sApple.cursor === null || sApple.cursor === undefined);
ok('search top-level rows normalized with Tickerbot fields', sAapl[0] && sAapl[0].symbol === 'AAPL' && sAapl[0].type === 'stock');

console.log('\n=== pagination envelope (next_cursor/cursor) ===');
const page2Capture = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  page2Capture.push(u.toString());
  const q = (u.searchParams.get('search') || '').toLowerCase();
  const page = u.searchParams.has('cursor');
  const results = DIRECTORY.filter((r) => String(r.ticker).toLowerCase() === q || String(r.name).toLowerCase().includes(q));
  return json({ as_of: '2026-08-20T12:00:00Z', count: results.length, next_cursor: page ? null : 'cursor-page-2', results: page ? [] : results });
};
const page1 = await api.searchTickers('AAPL');
ok('first page surfaces next_cursor', page1.cursor === 'cursor-page-2', `-> cursor=${page1.cursor}`);
const page2 = await api.searchTickers('AAPL', { cursor: page1.cursor });
ok('cursor forwarded on GET /v2/tickers?search=… (same endpoint, never /v2/search)', page2Capture.some((u) => u.includes('cursor=cursor-page-2') && !u.includes('/v2/search')), `-> ${page2Capture.filter((u) => u.includes('cursor')).join(', ')}`);

console.log('\n=== stockEndpoint override wiring ===');
const apiBlank = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '', stockEndpoint: '', settings: { timeoutMs: 5000 } });
const blankUrl = apiBlank.buildUrl('/v2/tickers/AAPL');
ok('blank stockEndpoint defaults to /v2/tickers/{ticker} (never /quote)', blankUrl === 'https://api.tickerbot.io/v2/tickers/AAPL' && !blankUrl.includes('/quote'), `-> ${blankUrl}`);

const apiOverride = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '', stockEndpoint: '/v2/tickers/{ticker}', settings: { timeoutMs: 5000 } });
apiOverride._doFetch = async (path) => {
  captured.push('OVERRIDE:' + apiOverride.buildUrl(path));
  const sym = decodeURIComponent(path.split('/').pop()).toUpperCase();
  return { data: QUOTES[sym] || { symbol: sym }, meta: { status: 200, url: apiOverride.buildUrl(path) } };
};
const overrideQuote = await apiOverride.getTickerQuote('AAPL');
ok('configured stockEndpoint {ticker} override is honored', captured.some((u) => u === 'OVERRIDE:https://api.tickerbot.io/v2/tickers/AAPL'), `-> ${captured.filter((u) => u.startsWith('OVERRIDE:')).join(' | ')}`);
ok('override quote still normalizes', overrideQuote.price === 232.87, `-> price=${overrideQuote.price}`);

console.log('\n=== missing price -> parsing error (never silent 0) ===');
const apiMissing = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '', settings: { timeoutMs: 5000 } });
apiMissing._doFetch = async () => ({ data: { symbol: 'NOPX', name: 'No Price Co.', asset_class: 'EQUITY' }, meta: { status: 200, url: 'https://api.tickerbot.io/v2/tickers/NOPX' } });
const noPrice = await apiMissing.getTickerQuote('NOPX');
ok('missing price stays null (not 0)', noPrice.price === null, `-> price=${noPrice.price}`);
ok('parsing error reported with response keys', noPrice._debug && noPrice._debug.parsingError && Array.isArray(noPrice._debug.parsingError.responseKeys) && noPrice._debug.parsingError.responseKeys.includes('name'), `-> ${JSON.stringify(noPrice._debug && noPrice._debug.parsingError)}`);

globalThis.fetch = realFetch;

console.log('\n--- app-path diagnostics emitted above (URL / status / type / topKeys) ---');
console.log(`Captured request URLs: ${captured.join('\n  ')}`);
console.log(failures === 0 ? '\nOFFLINE V2 VERIFY PASS' : `\nOFFLINE V2 VERIFY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
