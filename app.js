// app.js — Main UI Controller & Router
import { on, logger, esc, fmtPrice, fmtPct, fmtVolume, fmtTime } from './utils.js';
import { storage } from './storage.js';
import { loadConfig, saveConfig, isConfigured, hasApiKey, configStatus, isValidHttpUrl, API_CONFIG, DEFAULTS } from './config.js';
import { getApiKey, setApiKey, clearApiKey, migrateLegacyApiKey } from './secure-store.js';
import { BUILD_INFO } from './build-info.js';
import { TickerbotAPI } from './api.js'; 
import { MarketData } from './market-data.js';
import { AssetsController } from './assets.js';
import { ChartController } from './charts.js';
import { toast } from './notifications.js';

const $ = (sel) => document.querySelector(sel);

let api = null;
let assets = null;
let marketData = null;
let chart = null;
let currentRoute = '';
let currentSymbol = null;
let pendingConfirm = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// boot() is hardened so a single failing subsystem can NEVER blank the app:
// every init/wire step is guarded independently, router() always runs (with a
// finally-guarded fallback that reveals at least one .screen), and boot errors
// are surfaced via the global banner + toast instead of silently hiding every
// screen. (Field bug: boot() aborted on a ReferenceError before router() ran,
// leaving all hidden-attribute .screen sections invisible — blank main + dead
// nav links.)
// boot() is async because the runtime-only API key loads from secure storage
// (Capacitor Preferences / localStorage fallback) BEFORE TickerbotAPI is
// constructed — the key must never live in the plaintext config blob.
async function boot() {
  // Phase 1 — storage/config. Failure must not prevent UI from rendering.
  let config = null;
  try {
    storage.migrate();
    config = loadConfig();
  } catch (err) {
    reportBootError('[boot] storage/config init failed', err);
    config = {};
  }
  // Merge the runtime key from secure storage (after migrating any legacy
  // plaintext copy out of the localStorage config blob). On failure default
  // to '' — the app degrades to missing-key, it never crashes or fabricates.
  try {
    await migrateLegacyApiKey();
    let storedKey = await getApiKey();
    // One immediate retry: a transient Preferences failure at cold start must
    // not permanently downgrade the session to missing-key (boot-time swallow).
    // Deliberately NOT timer-delayed so boot ordering stays synchronous-fast.
    if (!storedKey) storedKey = await getApiKey();
    const stored = loadConfig();
    stored.apiKey = typeof storedKey === 'string' ? storedKey : '';
    config = { ...config, ...stored };
  } catch (err) {
    if (!(config && typeof config.apiKey === 'string' && config.apiKey)) config.apiKey = '';
    reportBootError('[boot] secure key store read failed', err);
  }
  updateGlobalStatus(config);

  // Phase 2 — subsystem init. Each constructor is independent: one throw must
  // not abort the rest, and none may prevent router() from revealing a screen.
  try {
    api = new TickerbotAPI(config);
  } catch (err) {
    reportBootError('[boot] API client init failed', err);
    api = null;
  }

  try {
    assets = new AssetsController(api);
  } catch (err) {
    reportBootError('[boot] AssetsController init failed', err);
    assets = null;
  }

  try {
    marketData = new MarketData({ api, getAssets: () => (assets ? assets.getWatchlist() : []) });
  } catch (err) {
    reportBootError('[boot] MarketData init failed', err);
    marketData = null;
  }

  try {
    chart = new ChartController({
      mainEl: $('#main-chart'),
      rsiEl: $('#rsi-chart'),
      wrapEl: $('#chart-wrap'),
      timeframeEl: $('#timeframe-bar'),
      indicatorEl: $('#indicator-bar'),
      emptyEl: $('#chart-empty'),
      tooltipEl: $('#chart-tooltip'),
      statusEl: $('#chart-status'),
      api,
      getAsset: (sym) => (assets ? assets.getAsset(sym) : null),
    });
  } catch (err) {
    reportBootError('[boot] ChartController init failed', err);
    chart = null;
  }

  // Phase 3 — event wiring. Each wire* is guarded independently so a single
  // binding failure cannot abort the rest of boot (or the router below).
  guardedWire(wireSearch, '[boot] wireSearch');
  guardedWire(wireSettings, '[boot] wireSettings');
  guardedWire(wireWatchlistControls, '[boot] wireWatchlistControls');
  guardedWire(wireConfirmModal, '[boot] wireConfirmModal');
  guardedWire(wireEvents, '[boot] wireEvents');

  // Phase 4 — onboarding redirect (only when the app cannot poll live data:
  // no base URL OR no API key). A URL-without-key install lands on Settings
  // with the "API key not configured" banner instead of spamming 401s.
  try {
    if (config && configStatus(config) !== 'ready') {
      const onboarding = $('#settings-onboarding');
      if (onboarding) onboarding.hidden = false;
      if (!window.location.hash || window.location.hash === '#/' || window.location.hash === '#') {
        window.location.hash = '#/settings';
      }
    }
  } catch (err) {
    reportBootError('[boot] onboarding redirect failed', err);
  }

  // Phase 5 — router. This MUST always run so at least one .screen is
  // revealed; the finally-guard forces a fallback reveal when it fails.
  let routerOk = false;
  try {
    router();
    routerOk = true;
  } catch (err) {
    reportBootError('[router] failed to render route', err);
  } finally {
    if (!routerOk) revealFallbackScreen();
  }

  window.addEventListener('hashchange', () => {
    try {
      router();
    } catch (err) {
      reportBootError('[router] hashchange render failed', err);
      revealFallbackScreen();
    }
  });

  try {
    if (config && configStatus(config) === 'ready' && marketData) marketData.start();
    else if (marketData) logger.info('[boot] live polling not started — API not ready (missing key or URL)');
  } catch (err) {
    reportBootError('[boot] market data start failed', err);
  }
}

// Run one boot sub-step and report (never rethrow) its failure.
function guardedWire(fn, label) {
  try {
    fn();
  } catch (err) {
    reportBootError(label || 'boot step failed', err);
  }
}

// Surface a boot/runtime failure visibly (global banner + toast) instead of
// silently blanking. Both sinks are themselves guarded so this can't throw.
function reportBootError(label, err) {
  const detail = err && err.message ? `${label}: ${err.message}` : label;
  logger.error(label, err);
  try {
    const banner = document.getElementById('global-banner');
    if (banner && banner.hidden) {
      banner.hidden = false;
      banner.textContent = `⚠ ${detail}`;
    }
  } catch { /* never let the banner itself throw */ }
  try { toast(detail, 'error', 6000); } catch { /* never let toast throw */ }
}

// Guarantee the app is never a blank page: if router() failed and no .screen
// is visible, force the watchlist (or the first) screen visible.
function revealFallbackScreen() {
  const screens = document.querySelectorAll('.screen');
  const anyVisible = Array.prototype.some.call(screens, (s) => !s.hidden);
  if (anyVisible) return;
  const target = document.querySelector('#screen-watchlist') || screens[0];
  if (target) {
    target.hidden = false;
    reportBootError('[router] fallback: no screen was visible — revealed watchlist', null);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function router() {
 const hash = window.location.hash || '#/watchlist';
 const route = hash.startsWith('#/') ? hash.slice(2) : 'watchlist';
 const parts = route.split('/');
 const baseRoute = parts[0] || 'watchlist';
 currentSymbol = parts[1] ? decodeURIComponent(parts[1]) : null;

 if (currentRoute === route) return;
 currentRoute = route;

 document.querySelectorAll('.screen').forEach((el) => { el.hidden = true; });
 document.querySelectorAll('.nav-item').forEach((el) => {
   const nav = el.dataset.nav;
   el.classList.toggle('active', nav === baseRoute);
 });

 if (baseRoute === 'watchlist') {
   $('#screen-watchlist').hidden = false;
   if (assets) assets.renderWatchlist();
 } else if (baseRoute === 'search') {
   $('#screen-search').hidden = false;
 } else if (baseRoute === 'settings') {
   $('#screen-settings').hidden = false;
   fillSettingsForm();
 } else if (baseRoute === 'asset' && currentSymbol) {
   $('#screen-asset').hidden = false;
   renderAssetScreen(currentSymbol);
 } else {
   window.location.hash = '#/watchlist';
 }
}

function renderAssetScreen(symbol) {
 const entry = assets ? assets.getAsset(symbol) : null;
 $('#asset-name').textContent = entry ? entry.name : symbol.toUpperCase();
 $('#asset-ticker').textContent = symbol.toUpperCase();
 if (chart) chart.renderAsset(symbol);
}

// ---------------------------------------------------------------------------
// Settings Screen Binding & Test Connection
// ---------------------------------------------------------------------------
// Populate the Settings form. The API key is NEVER rendered back into the
// DOM — only a presence indicator ("key saved") is shown. The banner reflects
// configStatus().
async function fillSettingsForm() {
 const cfg = loadConfig();
 let storedKeyPresent = false;
 try { storedKeyPresent = hasApiKey({ ...cfg, apiKey: await getApiKey() }); } catch { storedKeyPresent = false; }
 const set = (name, value) => {
   const el = document.querySelector(`[name="${name}"]`);
   if (el) el.value = value == null ? '' : String(value);
 };
 set('baseURL', cfg.baseURL);
 set('apiKey', ''); // never render the raw key into the DOM
 set('pollInterval', cfg.settings.pollInterval);
 set('apiVersion', cfg.apiVersion);
 set('stockEndpoint', cfg.stockEndpoint);
 set('cryptoEndpoint', cfg.cryptoEndpoint);
 set('wsEndpoint', cfg.wsEndpoint);
 const capSearch = document.querySelector('[name="capabilitiesSearch"]');
 if (capSearch) capSearch.checked = !cfg.capabilities || cfg.capabilities.search !== false;
 const buildEl = document.getElementById('settings-build');
 if (buildEl) buildEl.textContent = `Diagnostic Build: ${BUILD_INFO.commit}`;
 renderSettingsStatusBanner(cfg, storedKeyPresent);
}

// Status banner + saved-key indicator on the Settings screen.
function renderSettingsStatusBanner(cfg, keyPresent) {
 const banner = document.getElementById('settings-status-banner');
 const savedEl = document.getElementById('api-key-saved');
 const status = configStatus({ ...cfg, apiKey: keyPresent ? 'stored' : '' });
 if (savedEl) {
   savedEl.hidden = !keyPresent;
   savedEl.textContent = keyPresent ? '•••• API key saved on this device' : '';
 }
 if (!banner) return;
 banner.hidden = false;
 banner.className = `settings-status-banner status--${status === 'ready' ? 'ok' : status}`;
 banner.textContent = status === 'unconfigured'
   ? 'No API base URL configured.'
   : status === 'missing-key'
     ? 'API key not configured — enter your Tickerbot API key to enable live data.'
     : 'Connected — key stored on this device.';
}

// Defense-in-depth: strip any credential-looking query param values before
// rendering an endpoint/URL into the diagnostic panel.
function redactUrl(url) {
 const SENSITIVE = /^(api_key|apikey|key|token|access_token|password)$/i;
 try {
  const u = new URL(String(url));
  u.searchParams.forEach((v, k) => { if (SENSITIVE.test(k)) u.searchParams.set(k, 'REDACTED'); });
  return u.toString();
 } catch {
  // Relative or malformed URL — best-effort regex redaction.
  return String(url).replace(/([?&](?:api_key|apikey|key|token|access_token|password)=)[^&#]*/gi, '$1REDACTED');
 }
}

async function testConnection() {
 const resultEl = document.querySelector('#settings-test-result');
 const cfg = loadConfig();
 const elBase = document.querySelector('[name="baseURL"]');
 const elKey = document.querySelector('[name="apiKey"]');
 // TEMP-DIAGNOSTIC (revert later): the requested symbol is dynamic — read from
 // the temporary Test Symbol input on the Settings screen (default AAPL).
 const elTestSymbol = document.querySelector('[name="testSymbol"]');
 const requestedSymbol = (elTestSymbol && elTestSymbol.value.trim()
   ? elTestSymbol.value.trim() : 'AAPL').toUpperCase();
 const baseURL = elBase ? elBase.value.trim() : cfg.baseURL;
 // Prefer a freshly typed key; otherwise fall back to the securely stored one.
 let apiKey = elKey ? elKey.value.trim() : '';
 if (!apiKey) { try { apiKey = await getApiKey(); } catch { apiKey = ''; } }
 
 if (!baseURL) {
   resultEl.hidden = false;
   resultEl.className = 'settings-test-result err';
   resultEl.innerHTML = 'API Base URL is required.';
   return;
 }

 resultEl.hidden = false;
 resultEl.className = 'settings-test-result';
 resultEl.innerHTML = `Testing Tickerbot API connection for ${esc(requestedSymbol)}...<br>`;

 // Tickerbot calls always route through our same-origin proxy (server.mjs).
 const testApi = new TickerbotAPI({
   baseURL,
   apiKey,
   settings: { ...(cfg.settings || {}), timeoutMs: (cfg.settings && cfg.settings.timeoutMs) || 10000 },
 });
 
 try {
   // TEMP-DIAGNOSTIC (revert later): same authenticated request path as before
   // (GET /v2/tickers/{symbol} with the user-entered key via _doFetch), but
   // through getTickerQuoteDiagnostic so safe stage-by-stage price traces are
   // captured. The API key / Authorization header / raw body are NEVER shown.
   const res = await testApi.getTickerQuoteDiagnostic(requestedSymbol);
   const debug = res._debug || {};
   const diag = debug.diag || {};
   const strategy = debug.strategy || diag.strategy || 'direct';
   const priorFailures = debug.strategyErrors || [];
   const fallbackNote = priorFailures.length
     ? `<div style="margin-top:6px;font-size:12px;opacity:.85;">Tried ${priorFailures.length} earlier strategy(ies) that failed: ${priorFailures.map(f => `<code>${esc(f.strategy)}</code> — ${esc(f.message)}`).join('; ')}</div>`
     : '';
   // Real HTTP status comes from the request's own _debug meta (set by
   // _doFetch) — never hard-coded.
   const httpStatus = debug.status != null ? debug.status : (diag.httpStatus != null ? diag.httpStatus : 'unknown');


   const hasPrice = res.price != null && Number.isFinite(Number(res.price));
   const displayPrice = hasPrice ? Number(res.price) : null;
   const pj = diag.parsedJson || {};
   const ni = diag.normalizeInput || {};
   const nq = diag.normalizedQuote || {};
   const rr = diag.rawResponse || {};
   const traceLine = (label, exists, type, valueHtml) =>
     `<div style="padding:1px 0;"><strong>${esc(label)}</strong>: price exists=${esc(exists)}, type=${esc(type)}${valueHtml != null ? `, price=${esc(valueHtml)}` : ''}</div>`;

   // ---- TEMP-DIAGNOSTIC panel (revert later): safe, REDACTED stage trace. ----
   const diagPanel = `
     <div style="margin-top:8px;font-size:12px;border-left:3px solid #888;padding-left:8px;">
       <strong>TEMP DIAGNOSTICS</strong><br>
       API key: ${apiKey ? 'CONFIGURED' : 'MISSING'}<br>
       HTTP status: ${esc(httpStatus)}<br>
       Requested symbol: ${esc(diag.requestedSymbol || requestedSymbol)}<br>
       Returned symbol: ${esc(diag.returnedSymbol == null ? 'null' : String(diag.returnedSymbol))}<br>
       Response JS type: ${esc(ni.jsType || 'n/a')}<br>
       Top-level keys: ${esc(JSON.stringify(ni.topKeys || []))}<br>
       Price field exists: ${esc(ni.priceExists || 'NO')} | typeof: ${esc(ni.priceType || 'n/a')} | value: REDACTED<br>
       Nested metrics object exists: ${esc(ni.metricsExists || 'NO')}<br>
       metrics.price exists: ${esc(ni.metricsPriceExists || 'NO')} | typeof: ${esc(ni.metricsPriceType || 'n/a')}<br>
       <div style="margin-top:6px;"><strong>Stage trace (price existence/type)</strong></div>
       ${traceLine('RAW RESPONSE', rr.priceFieldPresent || 'UNKNOWN', 'raw text', null)}
       ${traceLine('PARSED JSON', pj.priceExists || 'NO', pj.priceType || 'n/a', null)}
       ${traceLine('NORMALIZE INPUT', ni.priceExists || 'NO', ni.priceType || 'n/a', null)}
       <div style="padding:1px 0;"><strong>NORMALIZED QUOTE</strong>: price=${esc(nq.price == null ? 'null' : String(nq.price))}, type=${esc(nq.priceType || 'n/a')}</div>
       <div style="padding:1px 0;"><strong>UI MODEL</strong>: price=${esc(res.price == null ? 'null' : String(res.price))}, type=${esc(typeof res.price)}</div>
       <div style="padding:1px 0;"><strong>DISPLAYED</strong>: ${hasPrice ? esc(String(displayPrice)) : 'UNAVAILABLE'}</div>
     </div>`;


   // A 200 with NO usable price is NOT a successful connection test: the
   // transport worked but the payload could not be parsed into a quote, so
   // surface it as an explicit parsing error instead of 'CONNECTION SUCCESSFUL'.
   if (!hasPrice) {
     const parseMsg = debug.parsingError && debug.parsingError.message
       ? esc(debug.parsingError.message)
       : `Tickerbot response for ${esc(res.symbol || requestedSymbol)} contained no usable price field.`;
     resultEl.innerHTML += `
     <div style="margin-top: 10px; border-left: 3px solid red; padding-left: 8px;">
       <strong>CONNECTION ERROR — PRICE UNAVAILABLE</strong><br>
       Strategy/Proxy: <code>${esc(strategy)}</code><br>
       Endpoint: <code>${esc(redactUrl(debug.url || ''))}</code><br>
       Status: HTTP ${esc(httpStatus)} (OK) — but the response had no parsable price<br>
       ${parseMsg}
       ${diagPanel}
     </div>${fallbackNote}
   `;
   } else {
     resultEl.innerHTML += `
     <div style="margin-top: 10px; border-left: 3px solid green; padding-left: 8px;">
       <strong>CONNECTION SUCCESSFUL</strong><br>
       Strategy/Proxy: <code>${esc(strategy)}</code><br>
       Endpoint: <code>${esc(redactUrl(debug.url || ''))}</code><br>
       Status: HTTP ${esc(httpStatus)} OK<br>
       Symbol: ${esc(res.symbol)} | Price: ${esc(displayPrice)}
       ${diagPanel}
     </div>${fallbackNote}
   `;
   }
 } catch (err) {
   // Diagnostics: log the exact request dispatched and the full thrown error
   // (including any err.cause from the native HTTP plugin) so a connection
   // failure can be classified as DNS vs SSL vs CORS vs timeout.
   console.error('[testConnection] request dispatched', {
     url: `${String(baseURL).replace(/\/+$/, '')}/v2/tickers/${encodeURIComponent(requestedSymbol)}`,
     method: 'GET',
     headers: {
       Accept: 'application/json',
       'Content-Type': 'application/json',
       ...(apiKey ? { Authorization: 'Bearer <redacted>' } : {}),
     },
   });
   console.error('[testConnection] full error', {
     name: err && err.name,
     message: err && err.message,
     stack: err && err.stack,
     status: err && err.status,
     cause: err && err.cause,
     strategyErrors: err && err.strategyErrors,
   });
   // Per-strategy breakdown replaces the generic 'NETWORK OR CORS ERROR' so
   // the user can see exactly which proxy/strategy failed and why.
   const perStrategy = (err.strategyErrors && err.strategyErrors.length)
     ? `<div style="margin-top:8px;font-size:12px;">` +
       `<div style="margin-bottom:4px;"><strong>Strategies tried:</strong></div>` +
       err.strategyErrors.map(e =>
         `<div style="padding:2px 0;">• <code>${esc(e.strategy)}</code>: ${esc(e.message)}</div>`
       ).join('') +
       `</div>`
     : '';
   // TEMP-DIAGNOSTIC (revert later): surface the REAL native failure fields on
   // the Settings diagnostic screen. Never prints the API key.
   const causeObj = err && err.cause && typeof err.cause === 'object' ? err.cause : null;
   const causeBits = causeObj
     ? ['name', 'message', 'code', 'errorCode', 'errorMessage', 'url', 'status']
         .filter((k) => causeObj[k] != null)
         .map((k) => `<code>${esc(k)}</code>: ${esc(String(causeObj[k]))}`)
     : [];
   let capState = '';
   try {
     const cap = globalThis.Capacitor;
     const capNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
     const hdrs = cap && Array.isArray(cap.PluginHeaders) ? cap.PluginHeaders : [];
     const httpHeader = !!(hdrs.find((h) => h && h.name === 'Http'));
     console.log('[app:temp] testConnection failed', { isNative: capNative, nativeHttpPluginHeader: httpHeader, cause: causeObj });
     capState = `<div style="font-size:11px;opacity:.8;">native=${capNative}; native-Http-plugin-header=${httpHeader ? 'present' : 'MISSING'}</div>`;
   } catch (e) {
     capState = '';
   }
   const causeHtml = causeBits.length
     ? `<div style="margin-top:6px;font-size:12px;"><strong>TEMP native cause:</strong> ${causeBits.join(' · ')}</div>`
     : '';
   resultEl.innerHTML += `
     <div style="margin-top: 10px; border-left: 3px solid red; padding-left: 8px;">
       <strong>CONNECTION FAILED</strong><br>
       Error: ${esc(err.message || String(err))}<br>
       Status: ${err.status || 'N/A'}
       ${causeHtml}
       ${capState}
       ${perStrategy}
     </div>
   `;
 }
}

// Reflect the configured state in the #global-status pill (index.html:23).
// Nothing ever updated this static default markup, so it was stuck on the
// initial NOT CONFIGURED class. Configured means a valid HTTP(S) base URL was
// saved via Settings (isConfigured), NOT that a test connection succeeded —
// the pill flips only after Save Config with a real URL.
function updateGlobalStatus(cfg) {
  try {
    const el = document.getElementById('global-status');
    if (!el) return;
    const status = configStatus(cfg);
    const label = status === 'ready' ? 'CONFIGURED'
      : status === 'missing-key' ? 'NO API KEY' : 'NOT CONFIGURED';
    el.textContent = label;
    el.classList.toggle('status--ok', status === 'ready');
    el.classList.toggle('status--unavailable', status !== 'ready');
    el.title = status === 'ready' ? 'Tickerbot API configured'
      : status === 'missing-key' ? 'API key not configured — enter your key in Settings'
      : 'Global market data status';
  } catch { /* the status pill must never break boot */ }
}

function wireSettings() {
 const form = $('#settings-form');
 if (form) {
   form.addEventListener('submit', async (e) => {
     e.preventDefault();
     const cfg = loadConfig();
     const elBase = document.querySelector('[name="baseURL"]');
     const elKey = document.querySelector('[name="apiKey"]');
     const elPoll = document.querySelector('[name="pollInterval"]');
     const elVersion = document.querySelector('[name="apiVersion"]');
     const elStock = document.querySelector('[name="stockEndpoint"]');
     const elCrypto = document.querySelector('[name="cryptoEndpoint"]');
     const elWs = document.querySelector('[name="wsEndpoint"]');
     const capSearch = document.querySelector('[name="capabilitiesSearch"]');
     const clean = (el) => (el ? el.value.trim() || undefined : undefined);

     const newCfg = {
       ...cfg,
       baseURL: elBase ? elBase.value.trim() : cfg.baseURL,
       apiKey: '', // the key NEVER enters the localStorage config blob
       apiVersion: clean(elVersion) ?? cfg.apiVersion,
       stockEndpoint: clean(elStock) ?? cfg.stockEndpoint,
       cryptoEndpoint: clean(elCrypto) ?? cfg.cryptoEndpoint,
       wsEndpoint: clean(elWs) ?? cfg.wsEndpoint,
       capabilities: {
         ...(cfg.capabilities || {}),
         search: capSearch ? capSearch.checked : (cfg.capabilities ? cfg.capabilities.search !== false : true),
       },
       settings: {
         ...cfg.settings,
         pollInterval: elPoll ? Number(elPoll.value) || 30 : cfg.settings.pollInterval,
       }
     };
     saveConfig(newCfg);
     // The live client must NEVER go keyless during a Settings save. Capture
     // the key currently held by the runtime client before touching config,
     // resolve the effective key FIRST (store a freshly-typed key, then read
     // it back with boot()'s one-retry pattern for transient storage reads),
     // and only THEN push the merged config to the client — exactly once.
     const existingKey = (api && api.getConfig && api.getConfig().apiKey) || cfg.apiKey || '';
     let effectiveKey = '';
     try {
       if (elKey && elKey.value.trim()) await setApiKey(elKey.value.trim());
       effectiveKey = await getApiKey();
       if (!effectiveKey) effectiveKey = await getApiKey(); // one retry, same as boot()
     } catch (err) {
       logger.error('[settings] failed to store API key', err);
     }
     // Status/config reflect the runtime key even though it is never written
     // to the persisted config blob.
     const effCfg = { ...newCfg, apiKey: effectiveKey || existingKey };
     updateGlobalStatus(effCfg);
     if (api) api.setConfig(effCfg);
     updateGlobalStatus(effCfg);
     toast('Settings saved successfully', 'success');
     renderSettingsStatusBanner(newCfg, hasApiKey(effCfg));
     if (configStatus(effCfg) === 'ready') {
       $('#settings-onboarding').hidden = true;
       if (marketData) marketData.start();
       window.location.hash = '#/watchlist';
     }
   });
 }
 // Remove API key → back to missing-key state: clear secure storage, blank
 // the field, re-show onboarding, stop live polling.
 const removeBtn = document.getElementById('settings-remove-key');
 if (removeBtn) {
   removeBtn.addEventListener('click', async () => {
     try { await clearApiKey(); } catch (err) {
       logger.error('[settings] failed to remove API key', err);
     }
     const elKey = document.querySelector('[name="apiKey"]');
     if (elKey) elKey.value = '';
     const cfg = loadConfig();
     updateGlobalStatus(cfg);
     renderSettingsStatusBanner(cfg, false);
     const onboarding = $('#settings-onboarding');
     if (onboarding) onboarding.hidden = false;
     if (marketData) marketData.stop();
     toast('API key removed from this device', 'info');
   });
 }
 const testBtn = $('#settings-test');
 if (testBtn) {
   testBtn.addEventListener('click', testConnection);
 }
}

function wireSearch() {
 const input = $('#search-input');
 if (!input) return;
 input.addEventListener('input', async (e) => {
   const q = e.target.value.trim();
   const resultsEl = $('#search-results');
   const hintEl = $('#search-hint');
   if (q.length < 2) {
     resultsEl.innerHTML = '';
     if (hintEl) hintEl.hidden = false;
     return;
   }
   if (hintEl) hintEl.hidden = true;
   if (!api) {
     resultsEl.innerHTML = '<div class="error-banner">Search unavailable — API client failed to initialize at boot.</div>';
     return;
   }
   try {
     const scanResults = await api.searchTickers(q);
     if (!scanResults.length) {
       resultsEl.innerHTML = '<div class="empty-state"><p class="empty-sub">No matching assets found.</p></div>';
       return;
     }
     resultsEl.innerHTML = scanResults.map(item => `
       <div class="result-item" data-symbol="${esc(item.symbol)}">
         <span><b>${esc(item.symbol)}</b> - ${esc(item.name || '')}</span>
         <button class="btn btn--sm btn--primary select-asset-btn" data-symbol="${esc(item.symbol)}">Select</button>
       </div>
     `).join('');

     resultsEl.querySelectorAll('.select-asset-btn').forEach(btn => {
       btn.addEventListener('click', () => {
         const sym = btn.dataset.symbol;
         if (assets) assets.promptAdd(sym);
       });
     });
   } catch {
     resultsEl.innerHTML = '<div class="error-banner">Search request failed. Check API key & base URL.</div>';
   }
 });
}

function wireWatchlistControls() {
 const sortSelect = $('#watchlist-sort');
 if (sortSelect && assets) {
   sortSelect.addEventListener('change', (e) => {
     assets.setSort(e.target.value);
   });
 }
}

function wireConfirmModal() {
 const modal = $('#confirm-modal');
 if (!modal) return;
 const addBtn = $('#confirm-add');
 if (addBtn) {
   addBtn.addEventListener('click', async () => {
     if (pendingConfirm && assets) {
       await assets.addAsset(pendingConfirm);
       modal.close();
       pendingConfirm = null;
       window.location.hash = '#/watchlist';
     }
   });
 }
}

function wireEvents() {
 window.addEventListener('unhandledrejection', (e) => {
   logger.error('Unhandled rejection:', e.reason);
 });
}

// boot() runs on DOMContentLoaded. If this module evaluates AFTER that event
// already fired (slow WebView / delayed module fetch), plain listener
// registration would mean boot() NEVER runs and every .screen stays hidden —
// the blank-main bug. readyState check covers that; a watchdog covers any
// other path that leaves the app with zero visible screens.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot().catch((err) => reportBootError('[boot] failed', err)); });
} else {
  boot().catch((err) => reportBootError('[boot] failed', err));
}

// Last-resort safety net: if nothing revealed a .screen shortly after load
// (e.g. an unexpected throw outside boot), force one visible so the app is
// never a blank page, and surface the failure.
setTimeout(() => {
  try {
    const anyVisible = Array.prototype.some.call(
      document.querySelectorAll('.screen'),
      (s) => !s.hidden
    );
    if (!anyVisible) {
      reportBootError('[boot] watchdog: no screen visible after load — forcing fallback', null);
      revealFallbackScreen();
    }
  } catch {
    /* the watchdog must never throw */
  }
}, 2500);