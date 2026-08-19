// app.js — Main UI Controller & Router
import { on, logger, esc, fmtPrice, fmtPct, fmtVolume, fmtTime } from './utils.js';
import { storage } from './storage.js';
import { loadConfig, saveConfig, isConfigured, isValidHttpUrl, API_CONFIG, DEFAULTS } from './config.js';
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
function boot() {
  // Phase 1 — storage/config. Failure must not prevent UI from rendering.
  let config = null;
  try {
    storage.migrate();
    config = loadConfig();
  } catch (err) {
    reportBootError('[boot] storage/config init failed', err);
    config = {};
  }

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

  // Phase 4 — onboarding redirect (only when the app is unconfigured).
  try {
    if (config && !isConfigured(config)) {
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
    if (config && isConfigured(config) && marketData) marketData.start();
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
function fillSettingsForm() {
 const cfg = loadConfig();
 const set = (name, value) => {
   const el = document.querySelector(`[name="${name}"]`);
   if (el) el.value = value == null ? '' : String(value);
 };
 set('baseURL', cfg.baseURL);
 set('apiKey', cfg.apiKey);
 set('pollInterval', cfg.settings.pollInterval);
 set('apiVersion', cfg.apiVersion);
 set('stockEndpoint', cfg.stockEndpoint);
 set('cryptoEndpoint', cfg.cryptoEndpoint);
 set('wsEndpoint', cfg.wsEndpoint);
 const capSearch = document.querySelector('[name="capabilitiesSearch"]');
 if (capSearch) capSearch.checked = !cfg.capabilities || cfg.capabilities.search !== false;
}

async function testConnection() {
 const resultEl = document.querySelector('#settings-test-result');
 const cfg = loadConfig();
 const elBase = document.querySelector('[name="baseURL"]');
 const elKey = document.querySelector('[name="apiKey"]');
 const baseURL = elBase ? elBase.value.trim() : cfg.baseURL;
 const apiKey = elKey ? elKey.value.trim() : cfg.apiKey;
 
 if (!baseURL) {
   resultEl.hidden = false;
   resultEl.className = 'settings-test-result err';
   resultEl.innerHTML = 'API Base URL is required.';
   return;
 }

 resultEl.hidden = false;
 resultEl.className = 'settings-test-result';
 resultEl.innerHTML = 'Testing Tickerbot API connection...<br>';

 const testApi = new TickerbotAPI({ baseURL, apiKey });
 
 try {
   const res = await testApi.getTickerQuote('AAPL');
   resultEl.innerHTML += `
     <div style="margin-top: 10px; border-left: 3px solid green; padding-left: 8px;">
       <strong>CONNECTION SUCCESSFUL</strong><br>
       Endpoint: <code>${res._debug.url}</code><br>
       Status: 200 OK<br>
       Symbol: ${res.symbol} | Price: ${res.price}
     </div>
   `;
 } catch (err) {
   // Diagnostics: log the exact request dispatched and the full thrown error
   // (including any err.cause from the native HTTP plugin) so a connection
   // failure can be classified as DNS vs SSL vs CORS vs timeout.
   console.error('[testConnection] request dispatched', {
     url: `${String(baseURL).replace(/\/+$/, '')}/v2/tickers/AAPL`,
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
   });
   resultEl.innerHTML += `
     <div style="margin-top: 10px; border-left: 3px solid red; padding-left: 8px;">
       <strong>CONNECTION FAILED</strong><br>
       Error: ${err.message}<br>
       Status: ${err.status || 'N/A'}
     </div>
   `;
 }
}

function wireSettings() {
 const form = $('#settings-form');
 if (form) {
   form.addEventListener('submit', (e) => {
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
       apiKey: elKey ? elKey.value.trim() : cfg.apiKey,
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
         pollInterval: elPoll ? Number(elPoll.value) || 30 : cfg.settings.pollInterval
       }
     };
     saveConfig(newCfg);
     if (api) api.setConfig(newCfg);
     toast('Settings saved successfully', 'success');
     if (isConfigured(newCfg)) {
       $('#settings-onboarding').hidden = true;
       if (marketData) marketData.start();
       window.location.hash = '#/watchlist';
     }
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
     const scanResults = await api.runScan({ query: q });
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
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
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