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

// True when running inside the Capacitor native shell (Android APK / iOS).
// The Capacitor WebView is served from https://localhost, which would
// otherwise be mistaken for a local dev origin — and the same-origin dev
// proxy (server.mjs) does not exist inside the app. On native we must keep
// the absolute API base so requests reach api.tickerbot.io via the native
// HTTP plugin (capacitor native HTTP is the ONE active proxy workaround).
function isNativeRuntime() {
  return !!(
    globalThis.Capacitor &&
    typeof globalThis.Capacitor.isNativePlatform === 'function' &&
    globalThis.Capacitor.isNativePlatform()
  );
}

// Is `loc` (defaults to globalThis.location in the browser) a local dev
// origin that should route API calls through the same-origin proxy?
export function isLocalDevOrigin(loc) {
  if (isNativeRuntime()) return false;
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

// ---------------------------------------------------------------------------
// CORS proxy helpers (module-level, pure)
// ---------------------------------------------------------------------------

// Parse a body that MUST be JSON. Returns { ok: true, data } on success, or
// { ok: false, reason } when the body is empty, HTML/error-page, or otherwise
// not JSON. Used to detect a "bad" proxy so the chain falls through.
function parseJsonBody(text) {
  const trimmed = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '') // strip UTF-8 BOM
    .trim();
  if (!trimmed) return { ok: false, reason: 'empty response body' };
  if (/^</.test(trimmed)) {
    return { ok: false, reason: `non-JSON body (HTML/error page: "${trimmed.slice(0, 60).replace(/\s+/g, ' ')}")` };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: `non-JSON body ("${trimmed.slice(0, 60).replace(/\s+/g, ' ')}")` };
  }
}

// Build the proxied URL for a user-supplied custom CORS proxy. Supports the
// common conventions: an existing `url=` query param (allorigins-style base),
// a `{url}` placeholder, or a bare base that gets `?url=<encoded>` appended.
function buildCustomProxyUrl(proxyBase, target) {
  const base = String(proxyBase || '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return null;
  const encoded = encodeURIComponent(target);
  if (base.includes('{url}')) return base.replace(/\{url\}/g, encoded);
  try {
    const u = new URL(base);
    if (u.searchParams.has('url')) {
      u.searchParams.set('url', target);
      return u.toString();
    }
  } catch { /* not an absolute URL — treat as a bare base below */ }
  const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${sep}url=${encoded}`;
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
  // Settings > Android/CORS: useProxy checkbox + optional custom proxy URL.
  // Defaults: proxy ON (browser origins can't reach the API without one),
  // custom URL empty (use the built-in allorigins/corsproxy.io services).
  this.useProxy = this.settings.useProxy !== false;
  this.proxyUrl = typeof this.settings.proxyUrl === 'string' ? this.settings.proxyUrl.trim() : '';
  this.cache.clear();
  return this;
}

// Should this runtime route browser fetches through the CORS proxy chain?
// Local dev origins already use the same-origin server.mjs proxy, and the
// Capacitor native shell uses the native HTTP plugin — neither needs a CORS
// wrapper. Everywhere else the chain is used unless the user disabled it.
shouldUseProxy() {
  if (isNativeRuntime()) return false;
  if (isLocalDevOrigin()) return false;
  return this.useProxy;
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

// ---- CORS proxy fallback chain --------------------------------------------
// Tickerbot's API does not send CORS headers, so non-dev browser origins
// (static hosting, StackBlitz, GitHub Pages) cannot fetch api.tickerbot.io
// directly. `_fetchWithProxy` runs an ordered chain:
//   1. custom proxyUrl from Settings (user-controlled, may forward headers)
//   2. https://api.allorigins.win/get?url=...  (wraps body in {contents})
//   3. https://corsproxy.io/?<encoded-url>     (returns the raw body)
//   4. direct connection                       (last resort)
// A strategy is skipped when it fails to fetch, returns an HTTP error, or
// returns a non-JSON/HTML body, so a bad proxy falls through to the next.
// The per-strategy failures are attached to the final ApiError.strategyErrors
// and to a successful response's `_strategyErrors` for the Settings test.
async _fetchWithProxy(url, init = {}) {
  const method = init.method || 'GET';
  const strategies = [];

  // Public CORS proxies cannot forward an Authorization header, so only GET
  // data requests are routed through them (POST like /v2/scan goes straight
  // to direct/native). The user's custom proxy MAY forward headers, so the
  // original headers (incl. Bearer) are only sent to it.
  if (this.shouldUseProxy() && method === 'GET') {
    if (this.proxyUrl) {
      strategies.push({ name: 'custom proxy', run: () => this._fetchViaCustomProxy(this.proxyUrl, url, init) });
    }
    strategies.push({ name: 'allorigins', run: () => this._fetchViaAllOrigins(url, init) });
    strategies.push({ name: 'corsproxy.io', run: () => this._fetchViaCorsProxy(url, init) });
  }
  strategies.push({ name: 'direct', run: () => fetch(url, { method, headers: init.headers, body: init.body, signal: init.signal }) });

  const errors = [];
  for (const s of strategies) {
    try {
      const res = await s.run();
      try { res._strategyErrors = errors.slice(); } catch { /* non-extensible response */ }
      return res;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err; // timeout — stop the chain
      const detail = err && err.message ? err.message : String(err);
      errors.push({ strategy: s.name, message: detail });
      console.debug(`[api] strategy "${s.name}" failed (${detail}) — trying next`);
    }
  }

  // Every strategy failed: throw a single ApiError with per-strategy details
  // so callers (e.g. testConnection) can report exactly what happened instead
  // of a generic 'NETWORK OR CORS ERROR'.
  const apiErr = new ApiError('network', 'NETWORK OR CORS ERROR', 0);
  apiErr.strategyErrors = errors;
  apiErr.strategiesTried = strategies.map((s) => s.name);
  throw apiErr;
}

// User-configured proxy. Keeps the original headers (Bearer included) so a
// self-hosted proxy that forwards them can authenticate to the real API.
async _fetchViaCustomProxy(proxyBase, url, init) {
  const proxyUrl = buildCustomProxyUrl(proxyBase, url);
  if (!proxyUrl) throw new Error('invalid custom proxy URL');
  const res = await fetch(proxyUrl, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);
  const body = await res.text();
  const parsed = parseJsonBody(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  return this._fakeResponse(res.status, parsed.data, body, 'custom proxy');
}

// allorigins wraps the upstream body in JSON: { contents: "<body>", status: { http_code } }.
async _fetchViaAllOrigins(url, init) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  // No Authorization header: public proxies do not forward it (and we must
  // not leak the API key to a third party unnecessarily).
  const res = await fetch(proxyUrl, { signal: init.signal, headers: { 'Accept': 'application/json' } });
  const body = await res.text();
  const wrap = parseJsonBody(body);
  if (!wrap.ok) throw new Error(wrap.reason);
  const wrapper = wrap.data && typeof wrap.data === 'object' ? wrap.data : {};
  const code = wrapper.status && typeof wrapper.status.http_code === 'number' ? wrapper.status.http_code : res.status;
  if (code < 200 || code >= 300) {
    const ct = wrapper.status && wrapper.status.content_type ? ` (${wrapper.status.content_type})` : '';
    throw new Error(`proxy returned HTTP ${code}${ct}`);
  }
  let data = wrapper.contents;
  if (typeof data === 'string') {
    const inner = parseJsonBody(data);
    if (!inner.ok) throw new Error(`upstream returned ${inner.reason}`);
    data = inner.data;
  }
  if (data == null) throw new Error('empty upstream body');
  return this._fakeResponse(code, data, body, 'allorigins');
}

// corsproxy.io returns the raw upstream body (must already be JSON).
async _fetchViaCorsProxy(url, init) {
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { signal: init.signal, headers: { 'Accept': 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  return this._fakeResponse(res.status, parsed.data, body, 'corsproxy.io');
}

// Uniform response-shaped object for proxy strategies (direct fetches keep
// the native fetch Response; _doFetch only needs status/ok/json/text).
_fakeResponse(status, data, body, strategy) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
    text: async () => body,
    _strategy: strategy,
  };
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
  // CORS-free cross-origin fetches, so route through the native HTTP plugin
  // (@capacitor-community/http, registered in android/capacitor.plugins.json
  // and bundled with esbuild into ./vendor/http-plugin.js — see
  // www/vendor/http-plugin.src.mjs and `npm run build:http`). The bundle has
  // no bare specifiers, so the dynamic import resolves inside the WebView
  // (which has no node_modules). It is imported lazily so plain browsers
  // never load it; every non-native runtime keeps using window.fetch.
  const isNative = isNativeRuntime();

  // Log the exact dispatch for diagnostics (never the raw Authorization value).
  const logHeaders = { ...headers };
  if (logHeaders['Authorization']) logHeaders['Authorization'] = 'Bearer <redacted>';
  console.debug(`[api] dispatch ${method} ${safeUrl}`, { headers: logHeaders });

  let response;
  let strategy = null;
  let strategyErrors = [];
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
      strategy = 'native';
      response = {
        status: nativeRes.status,
        ok: nativeRes.status >= 200 && nativeRes.status < 300,
        json: async () => (typeof nativeRes.data === 'string' ? JSON.parse(nativeRes.data) : nativeRes.data),
      };
    } else {
      // Browser fetch through the CORS proxy fallback chain (custom proxy →
      // allorigins → corsproxy.io → direct). Local dev origins keep using the
      // same-origin server.mjs proxy and native never enters this branch, so
      // neither existing path is disturbed.
      response = await this._fetchWithProxy(finalUrl, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      strategy = response._strategy || 'direct';
      strategyErrors = response._strategyErrors || [];
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'Request timed out', 0);
    // Preserve + log the FULL original error (name, message, stack, cause, and
    // native plugin error fields) so callers can distinguish a DNS failure from
    // an SSL handshake failure from a blocked WebView request. Throw a NEW
    // ApiError but attach the original as `cause` for downstream inspection.
    console.error(`[api] ${method} ${safeUrl} failed`, {
      name: err && err.name,
      message: err && err.message,
      stack: err && err.stack,
      cause: err && err.cause,
      code: err && err.code,
      errorCode: err && err.errorCode,
      errorMessage: err && err.errorMessage,
      url: err && err.url,
      status: err && err.status,
      body: err && err.body,
    });
    const apiErr = new ApiError('network', 'NETWORK OR CORS ERROR', 0);
    apiErr.cause = err;
    // Attach per-strategy failures so testConnection can show what happened.
    if (err && Array.isArray(err.strategyErrors)) apiErr.strategyErrors = err.strategyErrors;
    throw apiErr;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) throw new ApiError('auth', 'INVALID TICKERBOT API KEY', 401);
  if (response.status === 403) throw new ApiError('auth', 'ACCESS DENIED / PLAN PERMISSION', 403);
  if (response.status === 404) throw new ApiError('not_found', 'ENDPOINT OR ASSET NOT FOUND', 404);
  if (response.status === 429) throw new RateLimitError('RATE LIMITED (429)', 429);
  if (response.status >= 500) throw new ApiError('server', 'TICKERBOT SERVER ERROR', response.status);
  if (!response.ok) throw new ApiError('unknown', `HTTP ${response.status}`, response.status);

  let data;
  try {
    data = await response.json();
  } catch (err) {
    // A strategy claimed JSON but the body wasn't (captive portal / HTML
    // error page) — surface it instead of a raw SyntaxError so the Settings
    // test can explain the failure.
    const apiErr = new ApiError('network', 'INVALID JSON RESPONSE (non-JSON body)', response.status || 0);
    apiErr.cause = err;
    apiErr.strategyErrors = strategyErrors;
    throw apiErr;
  }
  return { data, meta: { status: response.status, url: safeUrl, strategy, strategyErrors, timestamp: Date.now() } };
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