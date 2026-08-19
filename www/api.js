// api.js — Tickerbot REST Client (Endpoints /v2/tickers, /v2/signals, /v2/scan, /v2/series)
//
// ONE central API abstraction for the app. TickerbotAPI is the class the app
// uses; `MarketAPI` is exported as an alias so the offline smoke contract
// (tests/smoke.mjs) and any code written against the older family of names
// keeps working. No endpoints/auth are invented here: base URL defaults to
// https://api.tickerbot.io, the Bearer key comes only from Settings
// (localStorage via config.js) and is never logged.
import { isConfigured } from './config.js';
import { logger } from './utils.js';

const DEFAULT_BASE_URL = 'https://api.tickerbot.io';
const PLACEHOLDER_BASE_URL = 'YOUR_API_BASE_URL';

// Hostnames served by the tiny Node dev proxy at the repo root (server.mjs,
// `npm run dev`). When the app runs on one of these, browser fetches must go
// to the SAME origin so server.mjs can forward /v2/* to api.tickerbot.io and
// bypass the API's CORS restrictions. Every other origin (Capacitor native,
// StackBlitz, static hosting) keeps calling the absolute API base directly.
const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Is `loc` (defaults to globalThis.location in the browser) a local dev
// origin that should route API calls through the same-origin proxy?
export function isLocalDevOrigin(loc) {
  const target = loc || globalThis.location;
  if (!target || typeof target.hostname !== 'string') return false;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return LOCAL_DEV_HOSTNAMES.has(target.hostname);
}

// Resolve the effective API base for the current runtime: on local dev
// origins use location.origin (the dev proxy), everywhere else keep the
// configured/absolute API base untouched.
export function resolveBaseURL(base, loc) {
  if (isLocalDevOrigin(loc)) {
    const origin = (loc || globalThis.location).origin;
    if (origin) return String(origin).replace(/\/+$/, '');
  }
  return base;
}

// kind -> default Tickerbot path segment (used by effectivePath when no
// explicit endpoint override is configured).
const KIND_ENDPOINTS = {
  quote: 'quote',
  candles: 'series',
  series: 'series',
  search: 'search',
  scan: 'scan',
  signals: 'signals',
};

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTimestamp(value) {
  if (value == null) return Date.now();
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// Candle time -> epoch seconds (Lightweight Charts expects seconds).
function toEpochSeconds(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function resolveType(raw, symbol) {
  const t = raw && (raw.type || raw.assetType || raw.securityType);
  if (typeof t === 'string') {
    const up = t.toUpperCase();
    if (up.includes('CRYPTO')) return 'crypto';
    if (up.includes('EQUITY') || up.includes('STOCK')) return 'stock';
  }
  // Default only — never fabricate a market that isn't implied by the symbol
  // shape (pairs like BTC/USD or BTC-USDT are crypto).
  return String(symbol || '').includes('/') || String(symbol || '').includes('-')
    ? 'crypto'
    : 'stock';
}

export class ApiError extends Error {
constructor(kind, message, status) {
  super(message);
  this.name = 'ApiError';
  this.kind = kind; 
  this.status = status;
}
}

export class RateLimitError extends ApiError {
constructor(message = 'Rate limited (HTTP 429)', status = 429) {
  super('rate_limit', message, status);
  this.name = 'RateLimitError';
}
}

export class TickerbotAPI {
constructor(config) {
  this.cache = new Map();
  this.setConfig(config);
}

getConfig() { return this.config; }

setConfig(config) {
  this.config = config || {};
  this.settings = this.config.settings || {};
  this.timeoutMs = this.settings.timeoutMs || 10000;
  this.cache.clear();
  return this;
}

isConfigured() {
  return isConfigured(this.config);
}

buildUrl(path) {
  const rawBase = this.config.baseURL;
  const base = (rawBase && String(rawBase).trim() && String(rawBase).trim() !== PLACEHOLDER_BASE_URL)
    ? String(rawBase).replace(/\/+$/, '')
    : DEFAULT_BASE_URL;
  const endpoint = String(path).replace(/^\/+/, '');
  // Normalization intact: base and endpoint are both single-slash joined.
  // On local dev origins the base is swapped for location.origin so the
  // request hits the same-origin proxy (server.mjs) instead of the API.
  return `${resolveBaseURL(base)}/${endpoint}`;
}

// Resolve a logical endpoint kind ("quote", "candles", "search", "scan", …)
// to a full URL. An explicit endpoint (e.g. Settings > Stock Endpoint) wins;
// otherwise `<apiVersion>/<kind>` is used (default apiVersion v2).
effectivePath(kind, endpoint) {
  if (endpoint) return this.buildUrl(endpoint);
  const version = this.config.apiVersion || 'v2';
  const segment = KIND_ENDPOINTS[kind] || String(kind);
  return this.buildUrl(`${version}/${segment}`);
}

async _doFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), this.timeoutMs);
  const finalUrl = this.buildUrl(path);
  const safeUrl = finalUrl;
  const method = options.method || 'GET';

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  if (this.config.apiKey) {
    headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
  }

  // Inside the Capacitor native shell (Android APK) the WebView cannot issue
  // CORS-free cross-origin fetches, so route through @capacitor-community/http
  // (native HTTP). The plugin is imported lazily so plain browsers never load
  // it; every non-native runtime keeps using window.fetch.
  const isNative = !!(
    globalThis.Capacitor &&
    typeof globalThis.Capacitor.isNativePlatform === 'function' &&
    globalThis.Capacitor.isNativePlatform()
  );

  let response;
  try {
    if (isNative) {
      const { Http } = await import('./vendor/http-plugin.js');
      const nativeRes = await Http.request({
        url: finalUrl,
        method,
        headers,
        data: options.body || undefined,
        connectTimeout: this.timeoutMs,
        readTimeout: this.timeoutMs,
      });
      response = {
        status: nativeRes.status,
        ok: nativeRes.status >= 200 && nativeRes.status < 300,
        json: async () => (typeof nativeRes.data === 'string' ? JSON.parse(nativeRes.data) : nativeRes.data),
      };
    } else {
      response = await fetch(finalUrl, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'Request timed out', 0);
    throw new ApiError('network', 'NETWORK OR CORS ERROR', 0);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) throw new ApiError('auth', 'INVALID TICKERBOT API KEY', 401);
  if (response.status === 403) throw new ApiError('auth', 'ACCESS DENIED / PLAN PERMISSION', 403);
  if (response.status === 404) throw new ApiError('not_found', 'ENDPOINT OR ASSET NOT FOUND', 404);
  if (response.status === 429) throw new RateLimitError('RATE LIMITED (429)', 429);
  if (response.status >= 500) throw new ApiError('server', 'TICKERBOT SERVER ERROR', response.status);
  if (!response.ok) throw new ApiError('unknown', `HTTP ${response.status}`, response.status);

  const data = await response.json();
  return { data, meta: { status: response.status, url: safeUrl, timestamp: Date.now() } };
}

async getTickerQuote(ticker) {
  const sym = ticker.toUpperCase();
  const { data, meta } = await this._doFetch(`/v2/tickers/${encodeURIComponent(sym)}`);
  return this.normalizeQuote(data, sym, meta);
}

async getSignals(ticker) {
  const sym = ticker.toUpperCase();
  try {
    const { data } = await this._doFetch(`/v2/signals/${encodeURIComponent(sym)}`);
    return data.signals || data || {};
  } catch {
    return {};
  }
}

async getHistoricalData(ticker, range = '1D', resolution = '5m') {
  const sym = ticker.toUpperCase();
  try {
    const { data } = await this._doFetch(`/v2/series?ticker=${encodeURIComponent(sym)}&range=${range}&resolution=${resolution}`);
    const candles = Array.isArray(data) ? data : (data.candles || data.series || []);
    return candles.map(c => ({
      time: Math.floor(new Date(c.time || c.timestamp || Date.now()).getTime() / 1000),
      open: Number(c.open || c.o || 0),
      high: Number(c.high || c.h || 0),
      low: Number(c.low || c.l || 0),
      close: Number(c.close || c.c || 0),
      volume: Number(c.volume || c.v || 0)
    }));
  } catch {
    return [];
  }
}

async runScan(criteria = {}) {
  try {
    const { data } = await this._doFetch(`/v2/scan`, { method: 'POST', body: criteria });
    return Array.isArray(data) ? data : (data.results || []);
  } catch {
    return [];
  }
}

async getQuote(symbol, { type } = {}) {
  return this.getTickerQuote(symbol);
}

// Normalize a raw quote response into the app's canonical quote shape.
// Field aliases are READ from the raw provider response when present — we
// never fabricate values, and type/exchange/currency fall back to defaults
// only (see resolveType); otherwise they stay null.
normalizeQuote(raw, ticker, meta) {
  const item = (raw && typeof raw === 'object') ? (raw.ticker || raw.data || raw) : (raw || {});
  const symbol = String(ticker || item.symbol || item.ticker || '').toUpperCase();
  const price = toNumber(item.price ?? item.lastPrice ?? item.last ?? item.close ?? item.c ?? item.regularMarketPrice ?? item.regularMarketLast ?? null);
  const previousClose = toNumber(item.previousClose ?? item.prevClose ?? item.previousClosePrice ?? item.regularMarketPreviousClose ?? null);
  const change = toNumber(item.change ?? item.todaysChange ?? (price != null && previousClose != null ? price - previousClose : null));
  const changePercent = toNumber(item.changePercent ?? item.todaysChangePerc ?? item.changesPercentage ?? item.percentChange ?? item.regularMarketChangePercent ?? null);
  const type = resolveType(item, symbol);
  const currency = item.currency ?? item.quoteCurrency ?? item.currencyCode ?? null;
  const exchange = item.exchange ?? item.exchangeName ?? item.mic ?? item.fullExchangeName ?? null;

  return {
    symbol,
    name: item.name || item.companyName || item.shortName || item.longName || symbol,
    type,
    assetType: type,
    exchange,
    currency,
    price: price ?? 0,
    change: change ?? 0,
    changePercent: changePercent ?? 0,
    // Back-compat alias: the smoke contract and some UIs read `percentChange`.
    percentChange: changePercent ?? 0,
    volume: toNumber(item.volume ?? item.v ?? item.regularMarketVolume ?? null) ?? 0,
    high: toNumber(item.high ?? item.h ?? item.regularMarketDayHigh ?? null) ?? 0,
    low: toNumber(item.low ?? item.l ?? item.regularMarketDayLow ?? null) ?? 0,
    open: toNumber(item.open ?? item.o ?? item.regularMarketOpen ?? null) ?? 0,
    previousClose,
    marketCap: toNumber(item.marketCap ?? item.market_cap ?? item.regularMarketMarketCap ?? null) ?? 0,
    signals: item.signals || {},
    timestamp: toTimestamp(item.updated ?? item.timestamp ?? item.ts ?? item.t ?? item.date ?? Date.now()),
    _debug: meta
  };
}

// Normalize provider candles into ascending, deduped {time(sec), ohlcv} rows.
// Accepts: flat arrays of candle objects, Alpha Vantage-style
// { 'Time Series (Daily)': { date: { '1. open': … } } }, and Binance-style
// kline arrays [openTime, open, high, low, close, volume, closeTime].
normalizeCandles(input) {
  let rows = [];

  if (Array.isArray(input)) {
    rows = input.map((row) => {
      if (Array.isArray(row)) {
        const [openTime, open, high, low, close, volume] = row;
        return { time: openTime, open, high, low, close, volume };
      }
      const o = row || {};
      return {
        time: o.time ?? o.date ?? o.timestamp ?? o.openTime ?? o.t,
        open: o.open ?? o['1. open'],
        high: o.high ?? o['2. high'],
        low: o.low ?? o['3. low'],
        close: o.close ?? o['4. close'],
        volume: o.volume ?? o['5. volume'],
      };
    });
  } else if (input && typeof input === 'object') {
    const series = input['Time Series (Daily)']
      || input['Time Series (Weekly)']
      || input['Time Series (Monthly)']
      || input;
    rows = Object.entries(series).map(([key, o]) => ({
      time: key,
      open: o['1. open'] ?? o.open,
      high: o['2. high'] ?? o.high,
      low: o['3. low'] ?? o.low,
      close: o['4. close'] ?? o.close,
      volume: o['5. volume'] ?? o.volume,
    }));
  }

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const time = toEpochSeconds(row.time);
    if (time == null) continue;
    if (seen.has(time)) continue;
    seen.add(time);
    out.push({
      time,
      open: toNumber(row.open) ?? 0,
      high: toNumber(row.high) ?? 0,
      low: toNumber(row.low) ?? 0,
      close: toNumber(row.close) ?? 0,
      volume: toNumber(row.volume) ?? 0,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Normalize a search/scan result entry into {symbol, name, type, exchange, currency}.
// alias tables + a crypto/stock default only when the response omits a type.
normalizeSearchResult(raw) {
  const item = (raw && typeof raw === 'object') ? (raw.data || raw) : (raw || {});
  const symbol = String(item.symbol || item.ticker || '').toUpperCase();
  const type = resolveType(item, symbol);
  return {
    symbol,
    name: item.name || item.shortName || item.longName || item.description || symbol,
    type,
    exchange: item.exchange || item.exchangeName || item.mic || null,
    currency: item.currency || item.quoteCurrency || null,
  };
}
}

// MarketAPI is an alias of the ONE central API abstraction (TickerbotAPI) so
// the offline smoke contract (tests/smoke.mjs) and older call sites keep
// working without a second, divergent API client.
export const MarketAPI = TickerbotAPI;

export default TickerbotAPI;