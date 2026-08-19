// tests/smoke.mjs — OFFLINE DEV-ONLY verification (specs/phase1.md B9).
// Uses tiny known fixtures ONLY to prove indicator math and normalization work.
// This file is never imported by the app and its fixtures are never rendered
// as market data anywhere in the UI.
//
// Run:  node tests/smoke.mjs   (or: npm run smoke)

import assert from 'node:assert/strict';
import { sma, ema, rsi, INDICATORS } from '../indicators.js';
import { MarketAPI, resolveBaseURL } from '../api.js';
import { loadConfig, saveConfig, isConfigured, API_CONFIG } from '../config.js';
import { storage } from '../storage.js';

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Indicator math — known series
// ---------------------------------------------------------------------------
console.log('indicators:');

// Known sequence where SMA(3) at index 2 = (1+2+3)/3 = 2
const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const sma3 = sma(closes, 3);
ok('SMA(3) warm-up nulls', sma3[0] === null && sma3[1] === null);
ok('SMA(3) value at i=2', sma3[2] === 2);
ok('SMA(3) value at i=5', sma3[5] === 5); // (4+5+6)/3

const ema5 = ema(closes, 5);
ok('EMA(5) seed == SMA(5)', Math.abs(ema5[4] - 3) < 1e-9);
ok('EMA(5) warm-up nulls', ema5[0] === null && ema5[3] === null);
ok('EMA(5) length preserved', ema5.length === closes.length);

// RSI on a strictly increasing series must read 100
const rising = Array.from({ length: 30 }, (_, i) => i + 1);
const rsiRising = rsi(rising, 14);
ok('RSI rising series = 100 at first valid index', rsiRising[14] === 100);
ok('RSI rising nulls before period', rsiRising[13] === null);

// RSI on strictly decreasing series must read 0
const falling = Array.from({ length: 30 }, (_, i) => 30 - i);
const rsiFalling = rsi(falling, 14);
ok('RSI falling series = 0 at first valid index', rsiFalling[14] === 0);

// Known RSI case: alternating-ish series — just verify bounded 0..100 over all values
const mixed = [44, 45, 46, 44, 43, 45, 46, 47, 45, 44, 43, 44, 45, 46, 47, 45, 44, 43, 44, 45, 46, 47, 45, 44, 43, 44, 45, 46, 47, 46];
const rsiMixed = rsi(mixed, 14);
const bounded = rsiMixed.filter((v) => v !== null).every((v) => v >= 0 && v <= 100);
ok('RSI bounded 0..100', bounded);

// INDICATORS builders emit {time, value} lines, skip nulls
const candles = Array.from({ length: 30 }, (_, i) => ({ time: i + 1, open: 1, high: 2, low: 0, close: i + 1, volume: 100 }));
const line = INDICATORS.sma20(candles);
ok('INDICATORS.sma20 emits {time,value}', line.length > 0 && line[0].time != null && line[0].value != null);
ok('INDICATORS.sma50 on 30 candles is empty (insufficient)', INDICATORS.sma50(candles).length === 0);
ok('INDICATORS.rsi on 30 candles emits', INDICATORS.rsi(candles).length > 0);

// ---------------------------------------------------------------------------
// 2. Normalization — alias tables (never assume one fixed shape)
// ---------------------------------------------------------------------------
console.log('normalization:');
const api = new MarketAPI({
  baseURL: 'https://api.example.com',
  apiKey: 'sk-test',
  settings: { timeoutMs: 5000, maxConcurrency: 4, retryMax: 1 },
});

const q1 = api.normalizeQuote({ symbol: 'AAPL', lastPrice: 150.25, change: 1.5, changePercent: 1.01, volume: 1000000, currency: 'USD', ts: '2026-01-01T12:00:00Z' }, 'AAPL');
ok('quote yahoo-style fields', q1.price === 150.25 && q1.percentChange === 1.01 && q1.timestamp > 0 && typeof q1.timestamp === 'number');

const q2 = api.normalizeQuote({ symbol: 'BTC', c: 45000.5, o: 44000, h: 45200, l: 43900, v: 12345, t: 1700000000 }, 'BTC');
ok('quote crypto shorthand (c/h/l/o/v)', q2.price === 45000.5 && q2.high === 45200 && q2.volume === 12345);

const q3 = api.normalizeQuote({ last: '9.99', changesPercentage: 5.25, previousClose: 9.49 }, 'SNAP');
ok('quote finviz-style + derived change', q3.price === 9.99 && q3.percentChange === 5.25 && Math.abs(q3.change - 0.5) < 1e-9);

const q4 = api.normalizeQuote({ data: { symbol: 'MSFT', regularMarketPrice: 420.11, regularMarketVolume: 20000000 } }, 'MSFT');
ok('quote wrapped data object', q4.price === 420.11 && q4.volume === 20000000);

const candlesFlat = api.normalizeCandles([
  { date: '2026-01-03', open: 2, high: 5, low: 1, close: 4, volume: 100 },
  { date: '2026-01-01', open: 1, high: 3, low: 0.5, close: 2, volume: 90 },
  { date: '2026-01-03', open: 2, high: 5, low: 1, close: 4, volume: 100 }, // duplicate time
]);
ok('candles sorted ascending + deduped', candlesFlat.length === 2 && candlesFlat[0].time < candlesFlat[1].time);
ok('candle epoch seconds', candlesFlat[0].time === Math.floor(Date.parse('2026-01-01') / 1000));

const av = api.normalizeCandles({
  'Time Series (Daily)': {
    '2026-01-03': { '1. open': '10', '2. high': '12', '3. low': '9', '4. close': '11', '5. volume': '1000' },
    '2026-01-02': { '1. open': '9', '2. high': '10', '3. low': '8', '4. close': '10', '5. volume': '900' },
  },
});
ok('alpha vantage numbered keys', av.length === 2 && av[1].close === 11 && av[1].time === Math.floor(Date.parse('2026-01-03') / 1000));

const binance = api.normalizeCandles([[1700000000000, 100, 110, 95, 105, 5000, 1700000001000], [1700000001000, 105, 115, 100, 110, 6000, 1700000002000]]);
ok('binance kline arrays', binance.length === 2 && binance[1].close === 110 && binance[1].volume === 6000);

const search = api.normalizeSearchResult({ ticker: 'aapl', shortName: 'Apple Inc.', type: 'EQUITY', exchange: 'NASDAQ', currency: 'USD' });
ok('search aliases', search.symbol === 'AAPL' && search.name === 'Apple Inc.' && search.exchange === 'NASDAQ');

const searchList = [
  api.normalizeSearchResult({ symbol: 'BTC-USDT', exchange: 'COINBASE' }),
  api.normalizeSearchResult({ symbol: 'AAPL', exchange: 'NASDAQ' }),
];
ok('search type heuristic crypto/stock', searchList[0].type === 'crypto' && searchList[1].type === 'stock');

// ---------------------------------------------------------------------------
// 3. Endpoint resolution (B4)
// ---------------------------------------------------------------------------
console.log('endpoints:');
const api2 = new MarketAPI({ baseURL: 'https://api.example.com', apiKey: '', apiVersion: 'v2' });
ok('effectivePath default', api2.effectivePath('quote') === 'https://api.example.com/v2/quote');
const api3 = new MarketAPI({ baseURL: 'https://api.example.com/', apiKey: '', stockEndpoint: '/v1/stock/quote' });
ok('effectivePath full-path endpoint wins', api3.effectivePath('quote', api3.config.stockEndpoint) === 'https://api.example.com/v1/stock/quote');

// ---------------------------------------------------------------------------
// 4. Origin resolver — same-origin dev proxy routing (CORS fix)
// ---------------------------------------------------------------------------
console.log('origin resolver:');
const localLoc = { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:3000' };
ok('resolveBaseURL localhost -> same origin', resolveBaseURL('https://api.tickerbot.io', localLoc) === 'http://localhost:3000');
ok('resolveBaseURL 127.0.0.1 -> same origin', resolveBaseURL('https://api.tickerbot.io', { hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:3000' }) === 'http://127.0.0.1:3000');
ok('resolveBaseURL [::1] -> same origin', resolveBaseURL('https://api.tickerbot.io', { hostname: '[::1]', protocol: 'http:', origin: 'http://[::1]:3000' }) === 'http://[::1]:3000');
const remoteLoc = { hostname: 'stackblitz.io', protocol: 'https:', origin: 'https://example.stackblitz.io' };
// Every non-native web origin now routes through our same-origin proxy, not
// just localhost — so a remote browser origin must also resolve to location.origin.
ok('resolveBaseURL non-local origin -> same origin (proxy for all web origins)', resolveBaseURL('https://api.tickerbot.io', remoteLoc) === 'https://example.stackblitz.io');
ok('resolveBaseURL no location keeps base', resolveBaseURL('https://api.tickerbot.io') === 'https://api.tickerbot.io');

// End-to-end: buildUrl honours the resolver in both directions.
const prevLocation = globalThis.location;
globalThis.location = localLoc;
const devApi = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '' });
ok('buildUrl on localhost -> same-origin /v2 path', devApi.buildUrl('/v2/tickers/AAPL') === 'http://localhost:3000/v2/tickers/AAPL');
if (prevLocation === undefined) delete globalThis.location;
else globalThis.location = prevLocation;
const prodApi = new MarketAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '' });
ok('buildUrl on non-local origin -> absolute API URL', prodApi.buildUrl('/v2/tickers/AAPL') === 'https://api.tickerbot.io/v2/tickers/AAPL');

// ---------------------------------------------------------------------------
// 5. Config + storage round-trip (localStorage shim for Node)
// ---------------------------------------------------------------------------
console.log('config/storage:');
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
saveConfig({ baseURL: 'https://real.example.com', apiKey: 'sekret-key', settings: { pollInterval: 10 } });
const cfg = loadConfig();
ok('config persisted + merged', cfg.baseURL === 'https://real.example.com' && cfg.settings.pollInterval === 10 && cfg.settings.freshnessMs === 60000);
ok('isConfigured true for real URL', isConfigured(cfg));
ok('isConfigured false for placeholder', !isConfigured(loadConfig() && { baseURL: API_CONFIG.baseURL, apiKey: API_CONFIG.apiKey }));

// collection CRUD + LRU bound
const col = storage.collection('quoteCache', 3);
col.put({ id: 'A', quote: { price: 1 } });
col.put({ id: 'B', quote: { price: 2 } });
col.put({ id: 'C', quote: { price: 3 } });
col.put({ id: 'D', quote: { price: 4 } });
ok('collection evicts LRU head', col.all().length === 3 && !col.get('A'));
col.put({ id: 'C', quote: { price: 33 } });
ok('collection upsert', col.get('C').quote.price === 33);
ok('collection remove', col.remove('B') === true && col.get('B') === undefined);
col.clear();
ok('collection clear', col.all().length === 0);

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);