// api.js — Tickerbot REST Client (Endpoints /v2/tickers, /v2/signals, /v2/scan, /v2/series)
//
// ONE central API abstraction for the app. TickerbotAPI is the class the app
// uses; `MarketAPI` is exported as an alias so the offline smoke contract
// (tests/smoke.mjs) and any code written against the older family of names
// keeps working. No endpoints/auth are invented here: base URL defaults to
// https://api.tickerbot.io, the Bearer key comes only from Settings
// (localStorage via config.js) and is never logged.
import { isConfigured } from './config.js';
import { logger, bus } from './utils.js';

const DEFAULT_BASE_URL = 'https://api.tickerbot.io';
const PLACEHOLDER_BASE_URL = 'YOUR_API_BASE_URL';

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

// Should this (non-native) web origin route Tickerbot API calls through our
// SAME-ORIGIN proxy (server.mjs)? We now do this for EVERY non-native web
// runtime — not just localhost — because api.tickerbot.io sends no CORS
// headers, so the browser must never hit it directly (that is what produced
// the CORS-blocked "Status: N/A"). resolveBaseURL therefore returns
// location.origin on every browser origin; the only exceptions are the
// Capacitor native shell (native HTTP plugin) and non-http(s) contexts where
// there is no usable origin to proxy through.
export function isLocalDevOrigin(loc) {
  if (isNativeRuntime()) return false;
  const target = loc || globalThis.location;
  if (!target || typeof target.hostname !== 'string') return false;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return true;
}

// Resolve the effective API base for the current runtime: on every non-native
// web origin use location.origin so the request goes to our same-origin proxy
// (server.mjs), which forwards /v2/* to api.tickerbot.io and adds CORS
// headers. The absolute API base is only kept for the Capacitor native shell.
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

// Unwrap the Tickerbot directory-row ENVELOPE for GET /v2/tickers/{ticker}:
// the live endpoint returns HTTP 200 with {as_of, ticker, data:{...row}}.
// normalizeQuote() reads quote fields from the TOP-LEVEL item, so we merge
// `data`'s fields UP here (at the adapter boundary) — preserving the outer
// ticker and as_of timestamp and ALL fields from data without discarding any.
// Non-envelope payloads (flat rows, arrays, wrappers without a `data` object)
// DIAGNOSTIC-ONLY helpers for getHistoricalData — mirror the quotes
// describeRawKeys pattern: key NAMES and shapes only, never values.
function describeShape(data) {
  if (data == null || typeof data !== 'object') return `[${typeof data}]`;
  if (Array.isArray(data)) {
    const first = data.length ? Object.keys(data[0] && typeof data[0] === 'object' ? data[0] : {}) : [];
    return `array(${data.length}) firstKeys=${JSON.stringify(first)}`;
  }
  const entries = Object.entries(data).map(([k, v]) => `${k}:${Array.isArray(v) ? 'array' : typeof v}`);
  return `keys=${JSON.stringify(entries)}`;
}

// Redact any credential-looking query params before logging a request URL.
function redactUrl(url) {
  return String(url).replace(/([?&])(api[_-]?key|key|token|access[_-]?token)=([^&]*)/gi, '$1$2=<redacted>');
}

// pass through unchanged.
function unwrapQuoteEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const inner = (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) ? data.data : null;
  if (!inner) return data;
  return {
    ...inner,
    ticker: data.ticker ?? inner.ticker ?? inner.symbol,
    as_of: data.as_of ?? inner.as_of,
  };
}

// Return the RESPONSE KEYS of a raw provider object (REDACTED — names only,
// never values). Unwraps the same {ticker|data} nesting normalizeQuote reads so
// an audit of a no-price response shows the exact fields that were inspected.
function describeRawKeys(data) {
  if (data == null || typeof data !== 'object') return [String(typeof data)];
  if (Array.isArray(data)) return [`array(${data.length})`];
  const item = (data.ticker && typeof data.ticker === 'object') ? data.ticker : data;
  const nested = (item.data && typeof item.data === 'object') ? item.data : item;
  return Object.keys(nested);
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
  // asset_class is the canonical Tickerbot type field — read it FIRST so it wins
  // over the legacy aliases (type/assetType/securityType) whenever present.
  const t = raw && (raw.asset_class || raw.type || raw.assetType || raw.securityType);
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

// Should this runtime route browser fetches through a public CORS proxy?
// Never. Every non-native web origin now talks only to our SAME-ORIGIN proxy
// (resolveBaseURL → location.origin → server.mjs), and the Capacitor native
// shell uses the native HTTP plugin. Public CORS proxies are not used in the
// live path.
shouldUseProxy() {
  return false;
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
  // resolveBaseURL swaps the base for location.origin on every non-native web
  // origin (not just localhost), so the request always hits our same-origin
  // proxy (server.mjs) instead of calling api.tickerbot.io directly.
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

// ---- Same-origin reverse proxy (the ONLY live fetch path for browsers) ----
// All non-native web origins resolve their API base to location.origin
// (see resolveBaseURL/isLocalDevOrigin), so every request below is a
// SAME-ORIGIN fetch to our own server.mjs, which reverse-proxies /v2/* to
// api.tickerbot.io and returns the response with CORS headers. No public CORS
// proxy and no no-cors fetch is used.

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

  // TEMP-DIAGNOSTIC (revert later): log which branch will run and whether the
  // native bridge route exists in this WebView BEFORE dispatching, so a native
  // failure is never hidden behind the generic 'NETWORK OR CORS ERROR'.
  // Never prints the API key (Authorization stays redacted).
  {
    try {
      const cap = globalThis.Capacitor;
      const headers = (cap && Array.isArray(cap.PluginHeaders)) ? cap.PluginHeaders : [];
      const httpHeader = headers.find((h) => h && h.name === 'Http') || null;
      const hasRequestMethod = !!(httpHeader && (httpHeader.methods || []).some((m) => m && m.name === 'request'));
      console.log('[api:temp] dispatch method=' + method + ' branch=' + (isNative ? 'native' : 'browser') + ' url=' + safeUrl);
      console.log('[api:temp] Capacitor global=' + !!cap +
        ' isNativePlatform(fn)=' + (typeof (cap && cap.isNativePlatform) === 'function') +
        ' isNativePlatform()=' + !!(cap && cap.isNativePlatform && cap.isNativePlatform()));
      console.log('[api:temp] PluginHeaders count=' + headers.length +
        ' HttpHeader=' + (httpHeader
          ? ('present requestInHeader=' + hasRequestMethod + ' methods=' + JSON.stringify((httpHeader.methods || []).map((m) => m && m.name)))
          : 'MISSING (Http.request falls back to bundled HttpWeb web impl -> CORS-blocked fetch)'));
    } catch (e) {
      console.log('[api:temp] diag-error ' + (e && e.message));
    }
  }

  // Log the exact dispatch for diagnostics (never the raw Authorization value).
  const logHeaders = { ...headers };
  if (logHeaders['Authorization']) logHeaders['Authorization'] = 'Bearer <redacted>';
  console.debug(`[api] dispatch ${method} ${safeUrl}`, { headers: logHeaders });

  let response;
  let strategy = null;
  let strategyErrors = [];
  try {
    if (isNative) {
      strategy = 'native'; // TEMP-DIAGNOSTIC (revert later)
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
      // @capacitor-community/http returns the body in `data` (string when
      // responseType is text/json-as-string, pre-parsed object otherwise).
      // The shim must expose BOTH json() and text() — the diagnostic capture
      // path (_diagCapture) calls response.text() and previously crashed with
      // "response.text is not a function" on native.
      const nativeBodyText =
        typeof nativeRes.data === 'string' ? nativeRes.data : JSON.stringify(nativeRes.data);
      response = {
        status: nativeRes.status,
        ok: nativeRes.status >= 200 && nativeRes.status < 300,
        json: async () => (typeof nativeRes.data === 'string' ? JSON.parse(nativeRes.data) : nativeRes.data),
        text: async () => nativeBodyText,
      };
      // Safe diagnostics only: never log body content, keys, or Authorization.
      console.debug(
        `[api] native=YES status=${nativeRes.status} dataExists=${nativeRes.data != null ? 'YES' : 'NO'} dataType=${typeof nativeRes.data} text()=PRESENT`
      );
    } else {
      // Browser fetch to our SAME-ORIGIN proxy: finalUrl is location.origin +
      // /v2/* (see buildUrl → resolveBaseURL), so this is a normal same-origin
      // fetch — no CORS preflight, no public proxy, no no-cors. server.mjs
      // forwards it upstream to api.tickerbot.io (preserving the Bearer
      // Authorization header) and returns the body with CORS headers.
      response = await fetch(finalUrl, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      strategy = 'server.mjs';
      strategyErrors = [];
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'Request timed out', 0);
    // TEMP-DIAGNOSTIC (revert later): capture the EXACT native failure fields
    // (strategy that ran + full error object) so logcat shows the real cause.
    console.error('[api:temp] failed branch=' + strategy + ' method=' + method + ' url=' + safeUrl, {
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
      strategyErrors: err && Array.isArray(err.strategyErrors) ? err.strategyErrors : undefined,
    });
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
    // TEMP-DIAGNOSTIC (revert later): when the Settings Test Connection flow
    // enables _diagCapture, keep the RAW response text (in-memory only) so the
    // price-existence/type can be traced at each stage. Never logged, never
    // displayed raw — only key/type probes derived from it are shown.
    if (this._diagCapture) {
      const rawText = await response.text();
      this._diagLast = { rawText, status: response.status };
      data = JSON.parse(rawText);
    } else {
      data = await response.json();
    }
  } catch (err) {
    // A strategy claimed JSON but the body wasn't (captive portal / HTML
    // error page) — surface it instead of a raw SyntaxError so the Settings
    // test can explain the failure.
    const apiErr = new ApiError('network', 'INVALID JSON RESPONSE (non-JSON body)', response.status || 0);
    apiErr.cause = err;
    apiErr.strategyErrors = strategyErrors;
    throw apiErr;
  }
  // Response diagnostics (values REDACTED — top-level keys only, never the body
  // and never the API key). Logs the resolved URL, HTTP status, response type
  // (Content-Type) and top-level response keys for BOTH GET /v2/tickers/{ticker}
  // and GET /v2/tickers?search=… through the app's own _doFetch path, so a live
  // or offline capture can be audited.
  try {
    let contentType = null;
    if (response && response.headers) {
      contentType = typeof response.headers.get === 'function'
        ? response.headers.get('content-type')
        : (response.headers['content-type'] || response.headers['Content-Type'] || null);
    }
    const topKeys = Array.isArray(data)
      ? `array(${data.length})`
      : (data && typeof data === 'object' ? Object.keys(data) : `[${typeof data}]`);
    console.log(`[api] ${method} ${safeUrl} -> status=${response.status} type=${contentType || 'n/a'} topKeys=${JSON.stringify(topKeys)}`);
  } catch (diagErr) {
    /* response diagnostics must never change request behaviour */
  }
  return { data, meta: { status: response.status, url: safeUrl, strategy, strategyErrors, timestamp: Date.now() } };
}

async getTickerQuote(ticker) {
  const sym = String(ticker || '').toUpperCase();
  const enc = encodeURIComponent(sym);
  // Stock Endpoint override (Settings > Stock Endpoint). When an explicit Stock
  // Endpoint is configured it is honored as the override for THIS lookup — a
  // {ticker} placeholder is substituted when the configured path carries one,
  // otherwise the configured endpoint is used as-is. When it is BLANK (the
  // default) we request the canonical directory row GET /v2/tickers/{ticker} —
  // NEVER /quote.
  const configured = this.config.stockEndpoint && String(this.config.stockEndpoint).trim();
  const path = configured
    ? (String(configured).includes('{ticker}')
        ? String(configured).replace('{ticker}', enc)
        : String(configured))
    : `/v2/tickers/${enc}`;
  const { data, meta } = await this._doFetch(path);
  const quote = this.normalizeQuote(unwrapQuoteEnvelope(data), sym, meta);
  // Missing-price guard: if normalization produced NO usable price (null),
  // REPORT a parsing error showing the raw response keys — never silently turn
  // a missing price into 0. This is surfaced (logged + attached to _debug) but
  // NOT thrown, so callers that intentionally render a missing price as
  // UNAVAILABLE (testConnection, watchlist cards) still receive the quote.
  if (quote.price == null) {
    const rawKeys = describeRawKeys(data);
    const parsingError = {
      kind: 'no_usable_price',
      message: `Tickerbot response for ${sym} has no usable price; raw response keys: ${rawKeys.join(', ')}`,
      responseKeys: rawKeys,
    };
    quote._debug = quote._debug || {};
    quote._debug.parsingError = parsingError;
    console.error(`[api] getTickerQuote ${sym}: no usable price in response (keys: ${rawKeys.join(', ')})`);
  }
  return quote;
}

// TEMP-DIAGNOSTIC (revert later): same request path as getTickerQuote()
// (GET /v2/tickers/{symbol} with the user-entered Bearer key via _doFetch)
// but captures safe, REDACTED diagnostics for the Settings screen: HTTP
// status, requested/returned symbols, top-level keys, price/metrics presence
// and TYPES at every stage (raw text -> parsed JSON -> normalizeQuote input
// -> normalized quote). Values are never included except the final normalized
// price number. The API key / Authorization header / cookies / raw body are
// never exposed.
async getTickerQuoteDiagnostic(ticker) {
  this._diagCapture = true;
  this._diagLast = null;
  try {
    const sym = String(ticker || '').toUpperCase();
    const enc = encodeURIComponent(sym);
    const configured = this.config.stockEndpoint && String(this.config.stockEndpoint).trim();
    const path = configured
      ? (String(configured).includes('{ticker}')
          ? String(configured).replace('{ticker}', enc)
          : String(configured))
      : `/v2/tickers/${enc}`;
    const { data, meta } = await this._doFetch(path);
    const quote = this.normalizeQuote(unwrapQuoteEnvelope(data), sym, meta);
    const rawText = this._diagLast ? this._diagLast.rawText : null;
    let parsed = null;
    try { parsed = rawText != null ? JSON.parse(rawText) : null; } catch { parsed = null; }

    // Safe probe: shape/keys/types ONLY — no values.
    const probe = (obj) => {
      const o = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
      if (!o) return { isObject: 'NO', jsType: obj === null ? 'null' : (Array.isArray(obj) ? 'array' : typeof obj), topKeys: [], priceExists: 'NO', priceType: 'n/a', metricsExists: 'NO', metricsPriceExists: 'NO', metricsPriceType: 'n/a' };
      // TEMP-DIAGNOSTIC (revert later): envelope-aware price probe. The live
      // GET /v2/tickers/{ticker} payload wraps the row as
      // {as_of, ticker, data:{... price ...}} — the same shape
      // unwrapQuoteEnvelope()/normalizeQuote() unwrap — so look one level down
      // (data row) exactly where normalization reads, and report price/metrics
      // existence truthfully for BOTH flat rows and envelopes. Keys/types only,
      // never values.
      const inner = (!('price' in o) && o.data && typeof o.data === 'object' && !Array.isArray(o.data)) ? o.data : o;
      const hasMetrics = !!(inner.metrics && typeof inner.metrics === 'object');
      return {
        isObject: 'YES',
        jsType: 'object',
        topKeys: Object.keys(o),
        priceExists: ('price' in inner) ? 'YES' : 'NO',
        priceType: typeof inner.price,
        metricsExists: hasMetrics ? 'YES' : 'NO',
        metricsPriceExists: (hasMetrics && ('price' in inner.metrics)) ? 'YES' : 'NO',
        metricsPriceType: hasMetrics ? typeof inner.metrics.price : 'n/a',
      };
    };

    // Returned symbol: best-effort read from the parsed payload (string fields only).
    const returnedSymbol = [parsed && parsed.symbol, parsed && parsed.ticker,
      parsed && parsed.ticker && typeof parsed.ticker === 'object' && parsed.ticker.symbol,
      parsed && parsed.data && typeof parsed.data === 'object' && (parsed.data.symbol || parsed.data.ticker)]
      .find((v) => typeof v === 'string' && v) || null;

    quote._debug = quote._debug || {};
    quote._debug.diag = {
      requestedSymbol: sym,
      returnedSymbol,
      httpStatus: meta.status != null ? meta.status : (this._diagLast ? this._diagLast.status : null),
      urlPath: path,
      rawResponse: {
        captured: rawText != null ? 'YES' : 'NO',
        length: rawText != null ? rawText.length : 0,
        priceFieldPresent: rawText != null ? (/"price"\s*:/.test(rawText) ? 'YES' : 'NO') : 'UNKNOWN',
      },
      parsedJson: probe(parsed),
      normalizeInput: probe(unwrapQuoteEnvelope(data)), // TEMP-DIAGNOSTIC: probe the ACTUAL normalizeQuote input (post-unwrap)
      normalizedQuote: { price: quote.price, priceType: typeof quote.price },
      parsingError: quote._debug.parsingError || null,
    };
    return quote;
  } finally {
    this._diagCapture = false;
    this._diagLast = null;
  }
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
  // Chart bars come from GET /v2/tickers/{ticker}/bars/{interval} (intervals
  // 1s|1m|5m|15m|30m|1h|1d; params from/to epoch-ms, limit<=1000). The old
  // /v2/series?range=&resolution= call was wrong: series ignores range and
  // resolution entirely (it wants interval/from/to) and returns rows as an
  // object keyed by ticker with price-only fields — never OHLCV bars.
  const RANGE_MAP = {
    '1D': { interval: '5m',  ms: 1 * 24 * 3600 * 1000 },
    '5D': { interval: '15m', ms: 5 * 24 * 3600 * 1000 },
    '1M': { interval: '1d',  ms: 30 * 24 * 3600 * 1000 },
    '3M': { interval: '1d',  ms: 90 * 24 * 3600 * 1000 },
    '1Y': { interval: '1d',  ms: 365 * 24 * 3600 * 1000 },
  };
  const spec = RANGE_MAP[String(range).toUpperCase()] || RANGE_MAP['1D'];
  const to = Date.now();
  const from = to - spec.ms;
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
    limit: '1000'
  });
  const url = `/v2/tickers/${encodeURIComponent(sym)}/bars/${spec.interval}?${params.toString()}`;
  try {
    const { data } = await this._doFetch(url);
    // Tolerant unwrap of the bars envelope: documented shape is
    // { as_of, ticker, interval, count, next_cursor, bars:[{t,o,h,l,c,v}] }
    // but accept {bars|data|candles:[...]} or a bare array. Field-name
    // aliases are mapped below (t/time/timestamp -> time; o/h/l/c/v -> OHLCV).
    let candles;
    if (Array.isArray(data)) {
      candles = data;
    } else if (data && typeof data === 'object') {
      candles = (Array.isArray(data.bars) ? data.bars : null)
        || (Array.isArray(data.data) ? data.data : null)
        || (Array.isArray(data.candles) ? data.candles : null) || [];
    } else {
      candles = [];
    }
    const mapped = candles.map(c => ({
      time: Math.floor(new Date(c.time ?? c.t ?? c.timestamp ?? Date.now()).getTime() / 1000),
      open: Number(c.open ?? c.o ?? 0),
      high: Number(c.high ?? c.h ?? 0),
      low: Number(c.low ?? c.l ?? 0),
      close: Number(c.close ?? c.c ?? 0),
      volume: Number(c.volume ?? c.v ?? 0)
    }));
    // Log raw response shape when it does NOT already match an expected
    // candles/series/array shape, so an unexpected envelope is visible.
    const looksExpected = Array.isArray(data)
      || !!(data && typeof data === 'object'
        && (Array.isArray(data.bars) || Array.isArray(data.data) || Array.isArray(data.candles)));
    if (!looksExpected) {
      console.warn(`[api] historical-data unexpected response shape for ${sym}: ${describeShape(data)} url=${redactUrl(this.buildUrl(url))}`);
    }
    return mapped;
  } catch (err) {
    // DIAGNOSTIC: never silently swallow into []. Report HTTP status (when we
    // have one), the redacted request URL, and the error kind/message.
    const status = err && err.status != null ? err.status : (err && err.statusCode) ?? 'N/A';
    console.warn(`[api] historical-data FAILED status=${status} url=${redactUrl(this.buildUrl(url))} ` +
      `kind=${err && err.kind || 'unknown'} message=${err && err.message}`);
    try {
      bus.emit('api:error', { kind: (err && err.kind) || 'historical-data', message: (err && err.message) || String(err), fatal: false });
    } catch { /* diagnostics must never change behaviour */ }
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

// Search the Tickerbot ticker directory: GET /v2/tickers?search=…&asset_class=…&limit=…
// (the canonical search endpoint — NOT /v2/search which 404s, and distinct from the
// market-wide POST /v2/scan). The response is an ENVELOPE { as_of, count, next_cursor,
// results: [...] } — never a bare array — so unwrap data.results with the same pattern
// runScan uses. Slim directory rows carry NO currency column (ticker, name, asset_class,
// asset_type, exchange, market_cap, price, day_change_pct); normalizeSearchResult leaves
// currency null in that case — never fabricated, never defaulted to 0. Errors (401/403,
// network, timeout) are NOT swallowed into a silent [] so they propagate to the caller's
// try/catch (wireSearch shows the error banner) instead of masking a bad key.
async searchTickers(query, opts = {}) {
  const params = new URLSearchParams();
  if (query) params.set('search', String(query));
  if (opts.asset_class) params.set('asset_class', String(opts.asset_class));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  // Paginated directory envelope: when the caller passes back a cursor (from a
  // previous page's next_cursor/cursor), forward it as a query param so the
  // NEXT page is requested on the SAME GET /v2/tickers?search=… endpoint —
  // never /v2/search. Opt-in, so existing callers that ignore pagination are
  // unaffected.
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  const qs = params.toString();
  const { data, meta } = await this._doFetch(`/v2/tickers${qs ? `?${qs}` : ''}`);
  const rows = Array.isArray(data) ? data : (data.results || data.items || data.tickers || []);
  const nextCursor = (data && typeof data === 'object' && !Array.isArray(data))
    ? (data.next_cursor ?? data.cursor ?? null)
    : null;
  const result = rows.map((row) => this.normalizeSearchResult(row));
  // Expose pagination without changing the array contract callers rely on
  // (length, map, spread). cursor carries the NEXT page's cursor (or null).
  Object.defineProperty(result, 'cursor', { value: nextCursor, enumerable: false, writable: true });
  Object.defineProperty(result, '_meta', { value: meta, enumerable: false, writable: true });
  return result;
}

async getQuote(symbol, { type } = {}) {
  return this.getTickerQuote(symbol);
}

// Normalize a raw quote response into the app's canonical quote shape.
// Field aliases are READ from the raw provider response when present — we
// never fabricate values, and type/exchange/currency fall back to defaults
// only (see resolveType); otherwise they stay null.
normalizeQuote(raw, ticker, meta) {
  // Unwrap the REAL observed payload shapes. GET /v2/tickers/{ticker} can come
  // back as: a bare flat row ({price, previous_close, day_change, …} — the
  // snake_case names in tickerbot-schema.json), a single-key wrapper
  // ({ticker|data|quote|result: row}), or the same paginated ENVELOPE the
  // directory endpoints use ({as_of, count, results|items|rows|tickers: [row]}).
  // Arrays (envelope contents or bare [row]) collapse to their first element.
  let item = (raw && typeof raw === 'object') ? raw : (raw || {});
  if (Array.isArray(item)) item = item[0] || {};
  if (item && typeof item === 'object') {
    const wrapper = item.ticker ?? item.data ?? item.quote ?? item.result
      ?? (Array.isArray(item.results) ? item.results[0] : undefined)
      ?? (Array.isArray(item.items) ? item.items[0] : undefined)
      ?? (Array.isArray(item.rows) ? item.rows[0] : undefined)
      ?? (Array.isArray(item.tickers) ? item.tickers[0] : undefined);
    if (wrapper && typeof wrapper === 'object') item = Array.isArray(wrapper) ? (wrapper[0] || {}) : wrapper;
  }
  item = item || {};
  const symbol = String(ticker || item.symbol || item.ticker || '').toUpperCase();
  // Canonical-over-alias priority. The canonical nested Tickerbot /v2/tickers
  // {ticker} row (tickerbot.io/docs/schema.json) groups quote metrics under
  // `item.metrics.*`, technicals under `item.signals.*`, plus `item.asset_class`
  // and `item.as_of`. Every canonical read is tried FIRST (?? — a literal
  // canonical 0 still wins and is never confused with "missing"); when absent
  // we fall back to the existing legacy aliases (camelCase, Yahoo/Finviz/Alpha
  // Vantage-style AND the real flat schema names: `price`, `previous_close`,
  // `day_change`, `day_change_pct`, `session_open`, `session_high`,
  // `session_low`, `volume_today`, `currency_name`, `exchange`, `exchange_mic`,
  // `market_cap`). Values are only READ when present — never fabricated.
  //
  // Missing-vs-zero policy: toNumber() returns null for a value that is absent
  // OR present-but-unparsable, and we do NOT fall back to 0. The returned quote
  // therefore keeps null so callers (watchlist cards, analysis, UI) can tell a
  // genuinely missing field apart from a real zero. A provider `0` stays 0.
  const price = toNumber(item.metrics?.price ?? item.price ?? item.lastPrice ?? item.last ?? item.close ?? item.c ?? item.regularMarketPrice ?? item.regularMarketLast ?? null);
  const previousClose = toNumber(item.previousClose ?? item.prevClose ?? item.previousClosePrice ?? item.previous_close ?? item.regularMarketPreviousClose ?? null);
  const change = toNumber(item.metrics?.day_change ?? item.day_change ?? item.change ?? item.todaysChange ?? (price != null && previousClose != null ? price - previousClose : null));
  const changePercent = toNumber(item.metrics?.day_change_pct ?? item.day_change_pct ?? item.changePercent ?? item.todaysChangePerc ?? item.changesPercentage ?? item.percentChange ?? item.regularMarketChangePercent ?? null);
  const type = resolveType(item, symbol);
  const currency = item.currency ?? item.quoteCurrency ?? item.currencyCode ?? item.currency_name ?? null;
  const exchange = item.exchange ?? item.exchangeName ?? item.mic ?? item.exchange_mic ?? item.fullExchangeName ?? null;
  const volume = toNumber(item.metrics?.volume ?? item.volume_today ?? item.volume ?? item.v ?? item.min_day_accumulated_volume ?? item.regularMarketVolume ?? null);
  const high = toNumber(item.high ?? item.h ?? item.session_high ?? item.regularMarketDayHigh ?? null);
  const low = toNumber(item.low ?? item.l ?? item.session_low ?? item.regularMarketDayLow ?? null);
  const open = toNumber(item.open ?? item.o ?? item.session_open ?? item.regularMarketOpen ?? null);
  const marketCap = toNumber(item.metrics?.market_cap ?? item.market_cap ?? item.marketCap ?? item.regularMarketMarketCap ?? null);

  // Signals: preserve and normalize the whole canonical `item.signals` object.
  // Every non-standard key keeps flowing through (spread), while the standardized
  // indicator keys are normalized with toNumber() and fall back to the flat row's
  // own fields when missing from signals. state_flags stays available under
  // signals.state_flags so Marketanalysis.js and the UI can read it. A missing or
  // unparsable indicator is null (never 0); a real 0 stays 0.
  const rawSignals = (item.signals && typeof item.signals === 'object') ? item.signals : {};
  const signals = {
    ...rawSignals,
    sma_20: toNumber(rawSignals.sma_20 ?? item.sma_20 ?? null),
    sma_50: toNumber(rawSignals.sma_50 ?? item.sma_50 ?? null),
    sma_200: toNumber(rawSignals.sma_200 ?? item.sma_200 ?? null),
    rsi_14: toNumber(rawSignals.rsi_14 ?? item.rsi_14 ?? null),
    macd_line: toNumber(rawSignals.macd_line ?? item.macd_line ?? null),
    macd_signal: toNumber(rawSignals.macd_signal ?? item.macd_signal ?? null),
    macd_histogram: toNumber(rawSignals.macd_histogram ?? item.macd_histogram ?? null),
    bb_upper: toNumber(rawSignals.bb_upper ?? item.bb_upper ?? item.bollinger_upper ?? null),
    bb_lower: toNumber(rawSignals.bb_lower ?? item.bb_lower ?? item.bollinger_lower ?? null),
    atr_14: toNumber(rawSignals.atr_14 ?? item.atr_14 ?? null),
    short_interest_pct: toNumber(rawSignals.short_interest_pct ?? item.short_interest_pct ?? null),
    state_flags: rawSignals.state_flags ?? item.state_flags ?? null,
  };

  return {
    symbol,
    // Canonical `name` wins; legacy aliases only when it is absent.
    name: item.name ?? item.companyName ?? item.shortName ?? item.longName ?? symbol,
    type,
    assetType: type,
    exchange,
    currency,
    price,
    change,
    changePercent,
    // Back-compat alias: the smoke contract and some UIs read `percentChange`.
    percentChange: changePercent,
    volume,
    high,
    low,
    open,
    previousClose,
    marketCap,
    signals,
    // Canonical `as_of` wins, then `updated`, then the legacy aliases.
    timestamp: toTimestamp(item.as_of ?? item.updated ?? item.timestamp ?? item.ts ?? item.t ?? item.date ?? Date.now()),
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