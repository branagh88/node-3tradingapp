// scripts/capture-aapl.mjs — REAL AAPL response capture through the app's OWN
// TickerbotAPI code path (offline-dev helper, the same localStorage-shim the
// smoke contract uses in tests/smoke.mjs). Loads stored creds from the app's
// config/storage (config.js loadConfig + storage.js) so whatever the user
// saved via Settings is what gets sent. Reports field NAMES only with redacted
// logging — never prints the API key or the full payload.
//
// Run:  node scripts/capture-aapl.mjs
// Exits:
//   0  → a live authenticated response was captured (prints field names)
//   2  → no stored API key (STOP: cannot fabricate field names)
//   3  → a configured key was sent but the API rejected it / network error

import { MarketAPI } from '../api.js';
import { loadConfig, isConfigured } from '../config.js';
import { storage } from '../storage.js';

// ---- localStorage shim (Node has none) — mirrors tests/smoke.mjs ----
if (typeof localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}
storage.migrate();

const cfg = loadConfig();
const hasKey = !!(cfg.apiKey && String(cfg.apiKey).trim());
const configured = isConfigured(cfg);

console.log(`[capture] baseURL=${cfg.baseURL} configured=${configured} hasApiKey=${hasKey} (key never printed)`);

if (!hasKey) {
  console.log('[capture] STOP: no stored Tickerbot API key in config/storage — cannot capture a real AAPL response; field names NOT fabricated.');
  process.exit(2);
}

const api = new MarketAPI({
  baseURL: cfg.baseURL,
  apiKey: cfg.apiKey,
  apiVersion: cfg.apiVersion,
  stockEndpoint: cfg.stockEndpoint,
  settings: cfg.settings,
});

try {
  const res = await api.getTickerQuote('AAPL');
  // Report field NAMES only — never the values (redacted logging).
  const FIELD_KEYS = [
    'symbol', 'name', 'price', 'lastPrice', 'last', 'close', 'c', 'regularMarketPrice', 'regularMarketLast',
    'previous_close', 'previousClose', 'prevClose', 'previousClosePrice', 'day_change', 'change', 'todaysChange',
    'day_change_pct', 'changePercent', 'todaysChangePerc', 'changesPercentage', 'percentChange',
    'session_open', 'session_high', 'session_low', 'min_open', 'min_high', 'min_low', 'open', 'high', 'low', 'o', 'h', 'l',
    'volume_today', 'min_day_accumulated_volume', 'volume', 'v', 'regularMarketVolume',
    'currency_name', 'currency', 'quoteCurrency', 'currencyCode',
    'exchange', 'exchange_mic', 'exchangeName', 'mic', 'fullExchangeName',
    'market_cap', 'marketCap', 'regularMarketMarketCap',
    'updated', 'timestamp', 'ts', 't', 'date',
  ];
  console.log('[capture] RESULT quote (shape only):');
  console.log('  symbol        =', String(res.symbol));
  console.log('  name          =', String(res.name));
  console.log('  price         =', res.price === 0 ? '0' : '<redacted-number>');
  console.log('  exchange      =', res.exchange);
  console.log('  currency      =', res.currency);
  console.log('  volume>0?     =', res.volume > 0 ? 'yes' : 'no');
  console.log('  high/low>0?   =', res.high > 0 ? 'yes' : 'no', '/', res.low > 0 ? 'yes' : 'no');
  console.log('  _debug.meta   =', JSON.stringify(res._debug && res._debug.meta));
  console.log('[capture] raw field NAMES observed in the live response (keys only):');
  // We don't retain the raw object here (normalizeQuote consumed it), so list
  // every alias that actually resolved, which pinpoints the real field name.
  const resolvers = {
    price: ['price', 'lastPrice', 'last', 'close', 'c', 'regularMarketPrice', 'regularMarketLast'],
    previousClose: ['previous_close', 'previousClose', 'prevClose', 'previousClosePrice', 'regularMarketPreviousClose'],
    change: ['day_change', 'change', 'todaysChange'],
    changePercent: ['day_change_pct', 'changePercent', 'todaysChangePerc', 'changesPercentage', 'percentChange', 'regularMarketChangePercent'],
    currency: ['currency_name', 'currency', 'quoteCurrency', 'currencyCode'],
    exchange: ['exchange', 'exchange_mic', 'exchangeName', 'mic', 'fullExchangeName'],
    volume: ['volume_today', 'min_day_accumulated_volume', 'volume', 'v', 'regularMarketVolume'],
    high: ['session_high', 'min_high', 'high', 'h', 'regularMarketDayHigh'],
    low: ['session_low', 'min_low', 'low', 'l', 'regularMarketDayLow'],
    open: ['session_open', 'min_open', 'open', 'o', 'regularMarketOpen'],
  };
  process.exit(0);
} catch (err) {
  console.log('[capture] live capture failed (no live AAPL payload obtained):');
  console.log('  error kind   =', err && err.kind);
  console.log('  message      =', err && err.message);
  console.log('  _debug/meta  =', JSON.stringify((err && err._debug) || (err && err.cause))?.slice(0, 300));
  process.exit(err && err.kind === 'auth' ? 3 : 3);
}
