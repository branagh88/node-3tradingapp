// app.js — Main UI Controller & Router
import { on, logger, esc, fmtPrice, fmtPct, fmtVolume, fmtTime, bus } from './utils.js';
import { storage } from './storage.js';
import { loadConfig, saveConfig, isConfigured, hasApiKey, configStatus, isValidHttpUrl, API_CONFIG, DEFAULTS } from './config.js';
import { getApiKey, setApiKey, clearApiKey, migrateLegacyApiKey } from './secure-store.js';
import { BUILD_INFO } from './build-info.js';
import { TickerbotAPI } from './api.js'; 
import { MarketData } from './market-data.js';
import { AssetsController } from './assets.js';
import { ChartController } from './charts.js';
import { toast } from './notifications.js';
import { initHistoryDiagnostics } from './history-diagnostics.js';
import { HistoricalAnalysisController } from './historical-analysis.js';
import { RealValidationController, formatCallWarning, shouldBypassConfirm, prefetchDatasets } from './real-validation.js';
import { buildMultiSelectSummary, buildMultiSelectPopoverHtml, buildRvEstimatePanelHtml } from './ticker-multiselect.js';
import { renderRvTickerSelector } from './rv-ticker-selector.js';
import { renderRealValidationResults } from './real-validation-ui.js';
import {
  applyRvEvent,
  createTickerStatus,
  rvStatusStripHtml,
  safeErrorInfo,
  formatRvRetryError,
} from './rv-status.js';
import { initEdgeScreen } from './edge-ui.js';
import { setOddsApiKey, getOddsApiKey, clearOddsApiKey, setSerpApiKey, getSerpApiKey, clearSerpApiKey } from './sports-credentials.js';
import { analyzePattern } from './pattern-engine.js';
import { predictCurrentMarketState, renderLivePredictionHtml } from './live-prediction.js';
import { PredictionRepository, renderPredictionRecordsHtml, isValidPredictionContract } from './prediction-repository.js';
import { walkForwardBacktest } from './prediction-engine.js';

const $ = (sel) => document.querySelector(sel);

let api = null;
let assets = null;
let marketData = null;
let chart = null;
let histAnalysis = null;
let realValidation = null;
let edgeUiHandle = null;
let currentRoute = '';
let currentSymbol = null;
const predictionRepo = new PredictionRepository();
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

  // TEMP-DIAGNOSTICS (revert later): floating HISTORY DIAGNOSTICS overlay —
  // safe metadata for the historical bars request only. Independent of boot.
  try {
    initHistoryDiagnostics();
  } catch (err) {
    reportBootError('[boot] history diagnostics init failed', err);
  }

  // Historical Analysis controller (uses ONLY HistorySource pagination —
  // never TickerbotAPI.getHistoricalData). Failure must not break boot.
  try {
    histAnalysis = api ? new HistoricalAnalysisController({ api }) : null;
    realValidation = api && histAnalysis
      ? new RealValidationController({ histController: histAnalysis }) : null;
  } catch (err) {
    reportBootError('[boot] historical analysis init failed', err);
    histAnalysis = null;
    realValidation = null;
  }

  // Phase 3 — event wiring. Each wire* is guarded independently so a single
  // binding failure cannot abort the rest of boot (or the router below).
  guardedWire(wireSearch, '[boot] wireSearch');
  guardedWire(wireSettings, '[boot] wireSettings');
  guardedWire(wireWatchlistControls, '[boot] wireWatchlistControls');
  guardedWire(wireConfirmModal, '[boot] wireConfirmModal');
  guardedWire(wireEvents, '[boot] wireEvents');
  guardedWire(wireHistoricalAnalysis, '[boot] wireHistoricalAnalysis');
 guardedWire(wireLivePrediction, '[boot] wireLivePrediction');
  guardedWire(wirePredictionRecords, '[boot] wirePredictionRecords');
  guardedWire(wireRealValidation, '[boot] wireRealValidation');
  guardedWire(wireHistoricalRetrieval, '[boot] wireHistoricalRetrieval');
  guardedWire(() => { edgeUiHandle = initEdgeScreen(); }, '[boot] edge screen init');

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
 } else if (baseRoute === 'edge') {
   $('#screen-edge').hidden = false;
   if (edgeUiHandle) edgeUiHandle.onRouteEnter();
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
 // Reset the Historical Analysis panel state for this asset.
 const ht = document.getElementById('hist-ticker');
 if (ht) ht.textContent = symbol.toUpperCase();
}

// ---------------------------------------------------------------------------
// Historical Analysis (asset detail view)
// ---------------------------------------------------------------------------
function wireHistoricalAnalysis() {
 const openBtn = document.getElementById('hist-analysis-btn');
 const panel = document.getElementById('hist-panel');
 if (!openBtn || !panel) return;
 openBtn.addEventListener('click', () => {
   if (panel.hidden) renderRvTickerOptions(); // refresh from live Watchlist on open
   panel.hidden = !panel.hidden;
   const ht = document.getElementById('hist-ticker');
   if (ht && currentSymbol) ht.textContent = currentSymbol.toUpperCase();
 });
 const analyzeBtn = document.getElementById('hist-analyze');
 if (analyzeBtn) analyzeBtn.addEventListener('click', runHistoricalAnalysis);
}

// -------------------------------------------------------------------------
// LIVE PREDICTION (Phase A) — runs the SAME local pattern engine against the
// latest retrieved candle via the shared HistoricalAnalysisController session
// cache. Conditional historical frequency only — NOT a forecast.
// -------------------------------------------------------------------------
function wireLivePrediction() {
 const panel = document.getElementById('hist-panel');
 const btn = document.getElementById('live-predict-btn');
 if (!panel || !btn) return;
 btn.addEventListener('click', runLivePrediction);
 // A removed ticker's stale live prediction must never be shown for a
 // different symbol — clear results whenever the watchlist changes.
 try {
   bus.on('watchlist:changed', () => {
     const resultsEl = document.getElementById('live-prediction-results');
     if (resultsEl) resultsEl.innerHTML = '';
   });
 } catch { /* event bus unavailable */ }
}

async function runLivePrediction() {
 const progressEl = document.getElementById('live-prediction-progress');
 const errorEl = document.getElementById('live-prediction-error');
 const resultsEl = document.getElementById('live-prediction-results');
 const btn = document.getElementById('live-predict-btn');
 if (!progressEl || !errorEl || !resultsEl) return;
 const symbol = currentSymbol;
 const depth = (document.getElementById('hist-depth') || {}).value || '1y';
 if (!symbol || !histAnalysis) {
   errorEl.hidden = false;
   errorEl.textContent = !symbol
     ? 'No asset selected.'
     : 'Live prediction failed. API client not initialized.';
   return;
 }
 errorEl.hidden = true;
 progressEl.hidden = false;
 progressEl.textContent = 'Predicting current market state... (reuses cached historical data)';
 if (btn) btn.disabled = true;
 try {
   const contract = await predictCurrentMarketState(symbol, {
     histController: histAnalysis,
     depth,
     onProgress: ({ message }) => { progressEl.textContent = message; },
   });
   progressEl.hidden = true;
   resultsEl.innerHTML = renderLivePredictionHtml(contract);
 } catch (err) {
   progressEl.hidden = true;
   errorEl.hidden = false;
   const status = err && err.status != null ? `HTTP ${err.status}` : 'status unknown';
   errorEl.innerHTML = `<strong>Live prediction failed.</strong><br>`
     + `Status: ${esc(status)}<br>`
     + `Error type: ${esc((err && err.name) || 'Error')}<br>`
     + `Message: ${esc(String((err && err.message) || err))}`;
 } finally {
   if (btn) btn.disabled = false;
 }
}

// -------------------------------------------------------------------------
// PREDICTION RECORDS (Phase B) — persists each valid Phase A prediction and
// tracks its prospective outcomes over subsequent sessions. Duplicate-safe:
// identity is deterministic per (ticker, condition date, schema version), so
// repeated clicks on the same trading day never create a second record.
// -------------------------------------------------------------------------
function wirePredictionRecords() {
 const panel = document.getElementById('hist-panel');
 const btn = document.getElementById('pred-records-btn');
 if (!panel || !btn) return;
 btn.addEventListener('click', runSaveOrRefreshPredictionRecord);
 try {
   bus.on('watchlist:changed', () => {
     const resultsEl = document.getElementById('pred-records-results');
     if (resultsEl) resultsEl.innerHTML = '';
   });
 } catch { /* event bus unavailable */ }
}

async function runSaveOrRefreshPredictionRecord() {
 const progressEl = document.getElementById('pred-records-progress');
 const errorEl = document.getElementById('pred-records-error');
 const resultsEl = document.getElementById('pred-records-results');
 const btn = document.getElementById('pred-records-btn');
 if (!progressEl || !errorEl || !resultsEl) return;
 const symbol = currentSymbol;
 const depth = (document.getElementById('hist-depth') || {}).value || '1y';
 if (!symbol || !histAnalysis) {
   errorEl.hidden = false;
   errorEl.textContent = !symbol
     ? 'No asset selected.'
     : 'Prediction record failed. API client not initialized.';
   return;
 }
 errorEl.hidden = true;
 progressEl.hidden = false;
 progressEl.textContent = 'Saving / refreshing prediction record... (reuses cached historical data)';
 if (btn) btn.disabled = true;
 try {
   const contract = await predictCurrentMarketState(symbol, {
     histController: histAnalysis,
     depth,
     onProgress: ({ message }) => { progressEl.textContent = message; },
   });
   if (!isValidPredictionContract(contract)) {
     progressEl.hidden = true;
     resultsEl.innerHTML = `<div class="hint">Not persisted: ${esc(contract.status || 'INVALID')}`
       + (contract.reason ? ` — ${esc(contract.reason)}` : '') + '</div>';
     return;
   }
   // Entry close comes from the SAME cached series the engine consumed.
   const r = await histAnalysis.run({ ticker: symbol, depth });
   const bars = r && Array.isArray(r.bars) ? r.bars : [];
   const condIdx = bars.findIndex((b) => b.t === contract.conditionTime);
   const entryClose = condIdx >= 0 ? bars[condIdx].c : NaN;
   let record = predictionRepo.createPrediction(contract, { entryClose });
   if (!record) {
     progressEl.hidden = true;
     resultsEl.innerHTML = '<div class="hint">Not persisted: invalid prediction contract.</div>';
     return;
   }
   // Opportunistically resolve horizons whose future candles have arrived.
   try { record = predictionRepo.recordPredictionOutcome(record.id, bars) || record; } catch { /* keep pending */ }
   const records = predictionRepo.listPredictions({ ticker: symbol });
   progressEl.hidden = true;
   resultsEl.innerHTML = renderPredictionRecordsHtml(records);
 } catch (err) {
   progressEl.hidden = true;
   errorEl.hidden = false;
   errorEl.innerHTML = `<strong>Prediction record failed.</strong><br>`
     + `Error type: ${esc((err && err.name) || 'Error')}<br>`
     + `Message: ${esc(String((err && err.message) || err))}`;
 } finally {
   if (btn) btn.disabled = false;
 }
}

// -------------------------------------------------------------------------
// RUN REAL VALIDATION (Phase 6) — multi-ticker walk-forward + pooled verdicts.
// Reuses the EXISTING TickerbotAPI/HistoricalAnalysisController (injected,
// cached, no second client). Never renders or logs the API key.
// -------------------------------------------------------------------------
function wireRealValidation() {
 const panel = document.getElementById('hist-panel');
 if (!panel) return;
 // Ticker universe = the LIVE WATCHLIST. Render on wire-up, every time the
 // panel is opened, and whenever the watchlist changes.
 renderRvTickerOptions();
 const runBtn = document.getElementById('rv-run');
 if (runBtn) runBtn.addEventListener('click', showRvCallWarning);
 // Phase 10: compact multi-select popover (chips remain the popover content;
 // renderRvTickerSelector keeps working unchanged).
 wireMultiselectInstance({ triggerId: 'rv-ms-trigger', popoverId: 'rv-ms-popover', containerId: 'rv-tickers' });
 const depthSel = document.getElementById('rv-depth');
 if (depthSel) depthSel.addEventListener('change', () => refreshRvEstimatePanels());
 try {
   bus.on('watchlist:changed', () => renderRvTickerOptions());
 } catch { /* event bus unavailable — selector still renders on panel open */ }
}

// -------------------------------------------------------------------------
// Phase 10 — explicit HISTORICAL DATA retrieval (GET HISTORICAL DATA).
// Zero API calls until the button is pressed; fills the ONE shared session
// cache (histAnalysis) used by both this panel and RUN REAL VALIDATION.
// -------------------------------------------------------------------------
function wireHistoricalRetrieval() {
 const panel = document.getElementById('hist-panel');
 if (!panel) return;
 renderHdTickerOptions();
 wireMultiselectInstance({ triggerId: 'hd-ms-trigger', popoverId: 'hd-ms-popover', containerId: 'hd-tickers' });
 const fetchBtn = document.getElementById('hd-fetch');
 if (fetchBtn) fetchBtn.addEventListener('click', () => runHistoricalDataPrefetch());
}

let hdPrefetchEntries = [];

async function runHistoricalDataPrefetch(retryTargets) {
 const fetchBtn = document.getElementById('hd-fetch');
 const progressEl = document.getElementById('hd-progress');
 const statusEl = document.getElementById('hd-status');
 const errorEl = document.getElementById('hd-error');
 if (!progressEl || !statusEl || !errorEl) return;
 if (!histAnalysis) {
   errorEl.hidden = false;
   errorEl.textContent = 'Historical data retrieval failed. API client not initialized.';
   return;
 }
 errorEl.hidden = true;
 const isFirstPass = !Array.isArray(retryTargets);
 const targets = isFirstPass ? selectedHdTickers() : retryTargets.map((t) => String(t).toUpperCase());
 if (!targets.length) {
   errorEl.hidden = false;
   errorEl.textContent = 'Select at least one ticker.';
   return;
 }
 const depth = (document.getElementById('rv-depth') || {}).value || '1y';
 // Zero-API-call shortcut: every selected ticker already holds a valid cached
 // dataset → hint only, no requests fire.
 if (isFirstPass && targets.every((t) => histAnalysis.hasValidDataset(t, depth))) {
   toast('All selected tickers are already cached — 0 API requests needed.', 'info');
   hdPrefetchEntries = targets.map((t) => {
     const entry = histAnalysis.cache.get(`${t}:${depth}`);
     return { ticker: t, ok: true, status: entry?.status || 'COMPLETE',
       candles: Array.isArray(entry?.bars) ? entry.bars.length : 0,
       apiRequests: 0, fromCache: true, stoppedReason: null, barsRef: entry?.bars || null };
   });
   paintHdPrefetchStatus();
   return;
 }
 if (fetchBtn) fetchBtn.disabled = true;
 progressEl.hidden = false;
 progressEl.textContent = 'Retrieving historical data…';
 try {
   const result = await prefetchDatasets(histAnalysis, {
     tickers: targets,
     depth,
     onProgress: ({ message }) => { progressEl.textContent = message || progressEl.textContent; },
   });
   if (isFirstPass) hdPrefetchEntries = result.entries.slice();
   else {
     const bySym = new Map(result.entries.map((e) => [e.ticker, e]));
     hdPrefetchEntries = hdPrefetchEntries.map((e) => bySym.get(e.ticker) || e);
   }
   paintHdPrefetchStatus();
 } catch (err) {
   errorEl.hidden = false;
   errorEl.textContent = `Historical data retrieval failed: ${(err && err.message) || err}`;
 } finally {
   if (fetchBtn) fetchBtn.disabled = false;
   progressEl.hidden = true;
 }
}

function paintHdPrefetchStatus() {
 const statusEl = document.getElementById('hd-status');
 const progressEl = document.getElementById('hd-progress');
 if (!statusEl) return;
 statusEl.hidden = false;
 statusEl.innerHTML = hdPrefetchEntries.map((e) => e.ok
   ? `<div>✓ ${esc(e.ticker)} · ${esc(e.status || 'COMPLETE')} · ${e.candles} candles · ${e.fromCache ? 'cached' : `${e.apiRequests} reqs`}</div>`
   : `<div>✗ ${esc(e.ticker)} · ${esc(e.stoppedReason || e.errorName || 'failed')}</div>`).join('');
 const failed = hdPrefetchEntries.filter((e) => !e.ok);
 if (failed.length) {
   const btn = document.createElement('button');
   btn.type = 'button';
   btn.className = 'btn btn--ghost btn--sm hd-retry-failed';
   btn.textContent = '[Retry failed]';
   btn.addEventListener('click', async () => {
     btn.disabled = true;
     await runHistoricalDataPrefetch(failed.map((f) => f.ticker));
   });
   statusEl.appendChild(btn);
 }
 if (progressEl) progressEl.hidden = true;
}

function selectedHdTickers() {
 return Array.from(document.querySelectorAll('#hd-tickers .rv-ticker:checked'))
   .map((cb) => cb.value.toUpperCase());
}

function renderHdTickerOptions() {
 const container = document.getElementById('hd-tickers');
 if (!container) return;
 renderRvTickerSelector(container, assets ? assets.getWatchlist() : []);
 updateMsSummary('hd-ms-trigger', 'hd-tickers');
 refreshRvEstimatePanels();
}

// ---------------------------------------------------------------------------
// Phase 10 — reusable compact multi-select wiring (two independent instances).
// Popovers are local-only DOM: opening/closing/toggling NEVER issues a request.
// ---------------------------------------------------------------------------
function ensureMsPopover(popoverId) {
 const pop = document.getElementById(popoverId);
 if (!pop || pop.childElementCount) return pop;
 const prefix = String(popoverId).replace(/-ms-popover$/, '');
 pop.innerHTML = buildMultiSelectPopoverHtml('', { idPrefix: prefix });
 return pop;
}

function msCheckedSymbols(containerId) {
 const c = document.getElementById(containerId);
 if (!c) return [];
 return Array.from(c.querySelectorAll('.rv-ticker:checked')).map((cb) => cb.value.toUpperCase());
}

function updateMsSummary(triggerId, containerId) {
 const summary = document.querySelector(`#${triggerId} .ms-summary`);
 if (!summary) return;
 const container = document.getElementById(containerId);
 const total = container ? container.querySelectorAll('.rv-ticker').length : 0;
 summary.textContent = buildMultiSelectSummary(msCheckedSymbols(containerId), total);
}

function closeMsPopover(trigger, pop) {
 pop.hidden = true;
 trigger.setAttribute('aria-expanded', 'false');
}

function wireMultiselectInstance({ triggerId, popoverId, containerId }) {
 const trigger = document.getElementById(triggerId);
 const pop = ensureMsPopover(popoverId);
 if (!trigger || !pop) return;
 const prefix = String(popoverId).replace(/-ms-popover$/, '');
 trigger.addEventListener('click', () => {
   const willOpen = pop.hidden;
   pop.hidden = !willOpen;
   trigger.setAttribute('aria-expanded', String(willOpen));
   if (willOpen) {
     updateMsSummary(triggerId, containerId);
     renderRvTickerOptions(); // refresh chips from the live Watchlist on open
   } else {
     trigger.focus();
     refreshRvEstimatePanels();
   }
 });
 document.addEventListener('click', (e) => {
   if (pop.hidden) return;
   if (pop.contains(e.target) || trigger.contains(e.target)) return;
   closeMsPopover(trigger, pop);
   refreshRvEstimatePanels();
 });
 document.addEventListener('keydown', (e) => {
   if (e.key === 'Escape' && !pop.hidden) { closeMsPopover(trigger, pop); trigger.focus(); }
 });
 const selectAllBtn = document.getElementById(`${prefix}-select-all`);
 const clearAllBtn = document.getElementById(`${prefix}-clear-all`);
 const cont = document.getElementById(containerId);
 if (selectAllBtn && cont) selectAllBtn.addEventListener('click', () => {
   const boxes = cont.querySelectorAll('.rv-ticker');
   if (!boxes.length) return; // empty watchlist — nothing to select
   boxes.forEach((cb) => { cb.checked = true; });
   updateMsSummary(triggerId, containerId);
   refreshRvEstimatePanels();
 });
 if (clearAllBtn && cont) clearAllBtn.addEventListener('click', () => {
   cont.querySelectorAll('.rv-ticker').forEach((cb) => { cb.checked = false; });
   updateMsSummary(triggerId, containerId);
   refreshRvEstimatePanels();
 });
 if (cont) cont.addEventListener('change', () => {
   updateMsSummary(triggerId, containerId);
   refreshRvEstimatePanels();
 });
}

// Pure-local estimate panels (zero network): recompute from cache state only.
function refreshRvEstimatePanels() {
 if (!realValidation || typeof realValidation.estimatePerTicker !== 'function') return;
 const depth = (document.getElementById('rv-depth') || {}).value || '1y';
 paintRvEstimate(document.getElementById('rv-estimate'), msCheckedSymbols('rv-tickers'), depth);
 paintRvEstimate(document.getElementById('hd-estimate'), msCheckedSymbols('hd-tickers'), depth);
}

function paintRvEstimate(el, tickers, depth) {
 if (!el) return;
 if (!tickers.length) { el.hidden = true; el.innerHTML = ''; return; }
 const est = realValidation.estimatePerTicker(tickers, depth);
 el.hidden = false;
 el.innerHTML = buildRvEstimatePanelHtml(est.perTicker, est);
}

// Re-render BOTH validation and retrieval ticker checkboxes from the current
// Watchlist (event-driven sync — preserved exactly, see commit 48fa639).
function renderRvTickerOptions() {
 // Ensure both popover shells exist before rendering into their containers.
 ensureMsPopover('rv-ms-popover');
 ensureMsPopover('hd-ms-popover');
 const wl = assets ? assets.getWatchlist() : [];
 const rvContainer = document.getElementById('rv-tickers');
 if (rvContainer) renderRvTickerSelector(rvContainer, wl);
 const hdContainer = document.getElementById('hd-tickers');
 if (hdContainer) renderRvTickerSelector(hdContainer, wl);
 updateMsSummary('rv-ms-trigger', 'rv-tickers');
 updateMsSummary('hd-ms-trigger', 'hd-tickers');
 refreshRvEstimatePanels();
}

function selectedRvTickers() {
 return Array.from(document.querySelectorAll('#rv-tickers .rv-ticker:checked'))
   .map((cb) => cb.value.toUpperCase());
}

// State CONFIRM: pre-run API-call estimate + warning; Confirm proceeds / Cancel resets.
function showRvCallWarning() {
 const warnEl = document.getElementById('rv-call-warning');
 const errorEl = document.getElementById('rv-error');
 const resultsEl = document.getElementById('rv-results');
 if (!warnEl) return;
 if (errorEl) errorEl.hidden = true;
 if (resultsEl) resultsEl.innerHTML = '';
 const tickers = selectedRvTickers();
 if (!tickers.length || !realValidation) {
   warnEl.hidden = false;
   warnEl.textContent = (!realValidation)
     ? 'Validation unavailable: API client not initialized.'
     : (assets && !assets.getWatchlist().length)
       ? 'Your watchlist is empty — add tickers to your Watchlist first.'
       : 'Select at least one ticker.';
   return;
 }
 const depth = (document.getElementById('rv-depth') || {}).value || '1y';
 const est = realValidation.estimateApiCalls(tickers, depth);
 const useCache = !(document.getElementById('rv-use-cache')) || document.getElementById('rv-use-cache').checked;
 // Phase 10 cache-first gate: everything valid-cached at this depth → run
 // directly with NO confirm dialog (0 fresh API calls).
 if (useCache && shouldBypassConfirm(est)) {
   warnEl.hidden = true;
   runRealValidation();
   return;
 }
 warnEl.hidden = false;
 warnEl.innerHTML = `<strong>FETCH &amp; RUN</strong><br>`
   + `${esc(formatCallWarning({ ...est, depthId: depth }))}<br>`
   + `New API requests required: ${est.totalEstimatedCalls}<br>`;
 if (typeof realValidation.estimatePerTicker === 'function') {
   const per = realValidation.estimatePerTicker(tickers, depth);
   const mini = document.createElement('div');
   mini.innerHTML = buildRvEstimatePanelHtml(per.perTicker, per);
   warnEl.appendChild(mini);
 }
 const confirmBtn = document.createElement('button');
 confirmBtn.type = 'button'; confirmBtn.className = 'btn btn--primary btn--sm'; confirmBtn.textContent = 'FETCH & RUN';
 const cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.className = 'btn btn--ghost btn--sm'; cancelBtn.textContent = 'Cancel';
 confirmBtn.addEventListener('click', () => { warnEl.hidden = true; runRealValidation(); });
 cancelBtn.addEventListener('click', () => {
   warnEl.hidden = true;
   const st = document.getElementById('rv-status');
   if (st) { st.hidden = true; st.innerHTML = ''; }
   setRvProgress('', true);
 });
 warnEl.appendChild(confirmBtn);
 warnEl.appendChild(document.createTextNode(' '));
 warnEl.appendChild(cancelBtn);
}

function setRvProgress(text, hide) {
 const el = document.getElementById('rv-progress');
 if (!el) return;
 el.hidden = !!hide;
 el.textContent = text || '';
}

async function runRealValidation() {
 const progressEl = document.getElementById('rv-progress');
 const errorEl = document.getElementById('rv-error');
 const resultsEl = document.getElementById('rv-results');
 const runBtn = document.getElementById('rv-run');
 if (!progressEl || !errorEl || !resultsEl) return;

 const tickers = selectedRvTickers();
 const depth = (document.getElementById('rv-depth') || {}).value || '1y';
 const useCache = !(document.getElementById('rv-use-cache')) || document.getElementById('rv-use-cache').checked;
 if (!tickers.length || !realValidation) {
   errorEl.hidden = false;
   errorEl.textContent = !realValidation
     ? 'Validation failed. API client not initialized.'
     : 'Select at least one ticker.';
   return;
 }

 errorEl.hidden = true;
 resultsEl.innerHTML = '';
 progressEl.hidden = false;
 progressEl.textContent = 'Starting validation…';
 // Phase 8: per-ticker live status strip (READY for all selected tickers).
 const statusEl = document.getElementById('rv-status');
 let rvStatusMap = new Map(tickers.map((t) => [t.toUpperCase(), createTickerStatus(t)]));
 const paintRvStatus = () => {
   if (!statusEl) return;
   statusEl.hidden = false;
   statusEl.innerHTML = rvStatusStripHtml(Array.from(rvStatusMap.values()));
 };
 if (statusEl) paintRvStatus();
 if (runBtn) runBtn.disabled = true;
 try {
   const result = await realValidation.run({
     tickers,
     depth,
     useCache,
     onProgress: ({ phase, message, ...evt }) => {
       try {
         if (phase !== 'DONE') { rvStatusMap = applyRvEvent(rvStatusMap, evt); paintRvStatus(); }
       } catch { /* status strip must never break the run */ }
       progressEl.hidden = phase === 'DONE';
       progressEl.textContent = message || '';
     },
   });
   if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
   resultsEl.innerHTML = renderRealValidationResults(result);
   wireRvRetryButtons(result);
 } catch (err) {
   errorEl.hidden = false;
   const status = err && err.status != null ? `HTTP ${err.status}` : 'status unknown';
   // Phase 8: leave the strip visible with non-completed tickers flipped to
   // ERROR via the reducer (never ad-hoc mutation), for failure context.
   try {
     for (const [k, s] of Array.from(rvStatusMap.entries())) {
       if (s.state === 'COMPLETE' || s.state === 'INSUFFICIENT DATA') continue;
       rvStatusMap = applyRvEvent(rvStatusMap, {
         phase: 'TICKER_FAILED', ticker: k,
         failure: safeErrorInfo({ ticker: k, operation: 'validation_run', err }),
       });
     }
     paintRvStatus();
   } catch { /* diagnostics must never mask the original error */ }
   console.warn('[RV] run failed', safeErrorInfo({ operation: 'validation_run', err }));
   errorEl.innerHTML = `<strong>Real validation failed.</strong><br>`
     + `Status: ${esc(status)}<br>`
     + `Error type: ${esc((err && err.name) || 'Error')}<br>`
     + `Message: ${esc(String((err && err.message) || err))}`;
 } finally {
   if (runBtn) runBtn.disabled = false;
   progressEl.hidden = true;
 }
}

function wireRvRetryButtons(r) {
 // Wire per-ticker RETRY buttons (rerun just that ticker and re-pool).
 requestAnimationFrame(() => {
   document.querySelectorAll('[data-rv-retry]').forEach((btn) => {
     btn.addEventListener('click', async () => {
       btn.disabled = true;
       try {
         const sub = await realValidation.run({ tickers: [btn.getAttribute('data-rv-retry')], depth: r.depth, useCache: false });
         // Merge: replace/add perTicker entry, drop from skipped, re-pool via a full rerun of included set.
         Object.assign(r.perTicker, sub.perTicker);
         r.skipped = (r.skipped || []).filter((s) => s.ticker !== sub.requested[0]);
         r.included = Array.from(new Set([...(r.included || []), ...sub.included]));
         const full = await realValidation.run({ tickers: r.included, depth: r.depth, useCache: true });
         const el = document.getElementById('rv-results');
         if (el) {
           el.innerHTML = renderRealValidationResults(full);
           wireRvRetryButtons(full);
         }
       } catch (err) {
         // Phase 8 fix (spec §3.4): never swallow retry errors silently.
         const sanitized = safeErrorInfo({ operation: 'retry_validation', err });
         console.warn('[RV] retry failed', sanitized);
         const errorBanner = document.getElementById('rv-error');
         if (errorBanner) {
           errorBanner.hidden = false;
           errorBanner.innerHTML = `<strong>${esc(formatRvRetryError(err))}</strong>`
             + `<br>Error type: ${esc(sanitized.errorName || 'Error')}`
             + ` | Stage: ${esc(sanitized.stage)}`
             + ` | HTTP status: ${esc(String(sanitized.httpStatus == null ? 'n/a' : sanitized.httpStatus))}`;
         }
         btn.disabled = false;
       }
     });
   });
 });
}

async function runHistoricalAnalysis() {
 const progressEl = document.getElementById('hist-progress');
 const errorEl = document.getElementById('hist-error');
 const resultsEl = document.getElementById('hist-results');
 const analyzeBtn = document.getElementById('hist-analyze');
 if (!progressEl || !errorEl || !resultsEl) return;

 const symbol = currentSymbol;
 const depth = (document.getElementById('hist-depth') || {}).value || '1y';
 if (!symbol || !histAnalysis) {
   errorEl.hidden = false;
   errorEl.textContent = !symbol
     ? 'No asset selected.'
     : 'Historical analysis failed. API client not initialized.';
   return;
 }

 errorEl.hidden = true;
 resultsEl.innerHTML = '';
 progressEl.hidden = false;
 progressEl.textContent = 'Retrieving historical data... Page 1';
 if (analyzeBtn) analyzeBtn.disabled = true;
 try {
   const result = await histAnalysis.run({
     ticker: symbol,
     depth,
     onProgress: ({ message }) => {
       progressEl.textContent = message;
     },
   });
   // Phase 2: local pattern analysis + out-of-sample backtest (no API calls).
   let pattern = null;
   let backtest = null;
   if (result.bars && result.bars.length > 60) {
     try {
       pattern = analyzePattern({ bars: result.bars });
     } catch { pattern = null; }
     try {
       backtest = walkForwardBacktest({ bars: result.bars, horizons: [1, 3, 5, 10] });
     } catch { backtest = null; }
   }
   progressEl.hidden = true;
   resultsEl.innerHTML = renderHistoricalResults(result)
     + renderPatternSection(pattern)
     + renderBacktestSection(backtest);
 } catch (err) {
   progressEl.hidden = false;
   progressEl.textContent = '';
   errorEl.hidden = false;
   const status = err && err.status != null ? `HTTP ${err.status}` : 'status unknown';
   errorEl.innerHTML = `<strong>Historical analysis failed.</strong><br>`
     + `Status: ${esc(status)}<br>`
     + `Error type: ${esc((err && err.name) || 'Error')}<br>`
     + `Message: ${esc(String((err && err.message) || err))}`;
 } finally {
   if (analyzeBtn) analyzeBtn.disabled = false;
 }
}

function fmtNum(v, digits = 2) {
 return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined,
   { maximumFractionDigits: digits });
}

function renderHistoricalResults(r) {
 const partialBadge = r.status === 'PARTIAL'
   ? '<span class="badge badge--unavailable">PARTIAL DATASET</span>'
   : '<span class="badge badge--ok">COMPLETE</span>';
 const stoppedLine = r.stoppedReason && r.status === 'PARTIAL'
   ? `<div class="hint">Stopped early: ${esc(r.stoppedReason)}. No gaps were filled.</div>` : '';
 const s = r.statistics;
 const q = r.quality;
 const fo = r.forwardOutcomes || {};
 const outcomeRows = [1, 3, 5, 10].map((h) => {
   const o = fo[h] || {};
   return `<tr><td>${h}D</td><td>${fmtNum(o.positivePct)}%</td><td>${fmtNum(o.negativePct)}%</td><td>${fmtNum(o.averageReturnPct)}%</td></tr>`;
 }).join('');
 return `
  <section style="margin-top:12px;">
    <h3>DATASET ${partialBadge}</h3>
    <ul>
      <li>Status: ${esc(r.status)}</li>
      <li>Candles: ${fmtNum(r.bars.length, 0)} | Pages: ${r.pagesFetched} | API requests: ${r.apiRequests}</li>
      <li>Oldest: ${esc(q.oldestDate || '—')} | Newest: ${esc(q.newestDate || '—')}</li>
      <li>Interval: 1D</li>
      <li>Duplicates removed: ${fmtNum(r.duplicatesRemoved, 0)}</li>
      <li>Data coverage: ${fmtNum(r.coverageYears)} years</li>
    </ul>
    ${stoppedLine}
    <h3>STATISTICS</h3>
    <p class="hint">Historical descriptive statistics only — not a prediction or forecast.</p>
    <ul>
      <li>Total candles: ${fmtNum(s.totalCandles, 0)} (${fmtNum(s.tradingDays, 0)} trading days)</li>
      <li>First close: ${fmtNum(s.firstClose)} | Latest close: ${fmtNum(s.latestClose)}</li>
      <li>Highest close: ${fmtNum(s.highestClose)} | Lowest close: ${fmtNum(s.lowestClose)} | Average close: ${fmtNum(s.averageClose)}</li>
      <li>Average daily return: ${fmtNum(s.averageDailyReturnPct)}%</li>
      <li>Positive days: ${fmtNum(s.positiveDays, 0)} (${fmtNum(s.positiveDaysPct)}%) | Negative days: ${fmtNum(s.negativeDays, 0)} (${fmtNum(s.negativeDaysPct)}%) | Flat days: ${fmtNum(s.flatDays, 0)} (${fmtNum(s.flatDaysPct)}%)</li>
      <li>Largest gain: ${fmtNum(s.largestGainPct)}% | Largest loss: ${fmtNum(s.largestLossPct)}%</li>
      <li>Volume — avg: ${fmtVolume(s.avgVolume)} | max: ${fmtVolume(s.maxVolume)} | min: ${fmtVolume(s.minVolume)}</li>
    </ul>
    <h3>FORWARD OUTCOMES</h3>
    <p class="hint">Empirical historical frequencies only — “Historical Positive Outcome Rate” is NOT a forecast.</p>
    <table><thead><tr><th>Horizon</th><th>Historical Positive Outcome Rate</th><th>Negative %</th><th>Average Return</th></tr></thead><tbody>${outcomeRows}</tbody></table>
    <h3>DATA QUALITY</h3>
    <ul>
      <li>Candles: ${fmtNum(q.candles, 0)}</li>
      <li>Duplicates removed: ${fmtNum(q.duplicatesRemoved, 0)}</li>
      <li>Missing trading days (reported, never filled): ${q.missingTradingDays == null ? '—' : fmtNum(q.missingTradingDays, 0)}</li>
      <li>Chronological: ${q.chronological ? 'YES' : 'NO'} | OHLC valid: ${q.ohlcValid ? 'YES' : 'NO'} | Volume available: ${q.volumeAvailable ? 'YES' : 'NO'}</li>
      <li>Date range: ${esc(q.dateRange || '—')}</li>
    </ul>
  </section>`;
}

// Phase 2 — PATTERN ANALYSIS section (honest, conditional-historical language).
function renderPatternSection(p) {
  if (!p || !p.ok) {
    const why = p ? esc(p.message || p.reason || 'unavailable') : 'not computed';
    return `<section style="margin-top:12px;"><h3>PATTERN ANALYSIS</h3><p class="hint">Not available: ${why}</p></section>`;
  }
  const c = p.condition;
  const condItems = [
    ['RSI 14', fmtNum(c.rsi14)],
    ['Distance from SMA20', `${fmtNum(c.distFromSma20 * 100)}%`],
    ['Distance from EMA21', `${fmtNum(c.distFromEma21 * 100)}%`],
    ['1D return', `${fmtNum(c.return1d * 100)}%`],
    ['5D return', `${fmtNum(c.return5d * 100)}%`],
    ['10D volatility', fmtNum(c.volatility10d * 100)],
    ['Consecutive up/down days', String(c.consecutiveUpDown)],
    ['Volume vs 20-day avg', fmtNum(c.volumeVsAvg20)],
  ].map(([k, v]) => `<li>${k}: ${esc(v)}</li>`).join('');
  const horizonRows = [1, 3, 5, 10].map((h) => {
    const o = p.forwardOutcomes[h] || {};
    return `<tr><td>${h}D</td>
      <td>${fmtNum(o.upPct)}%</td>
      <td>${fmtNum(o.downPct)}%</td>
      <td>${fmtNum(o.averageReturnPct)}%</td>
      <td>${fmtNum(o.medianReturnPct)}%</td>
      <td>${fmtNum(o.bestReturnPct)}% / ${fmtNum(o.worstReturnPct)}%</td>
      <td>${o.sampleSize} (${esc(o.classification)})</td></tr>`;
  }).join('');
  const topFeatures = p.topContributingFeatures.length
    ? p.topContributingFeatures.map((f) => f.feature).join(', ')
    : '—';
  const warn = p.meetsMinMatches
    ? ''
    : '<div class="hint">Match count is below the minimum desired sample; treat these frequencies with extra caution.</div>';
  return `
  <section style="margin-top:12px;">
    <h3>PATTERN ANALYSIS</h3>
    <p class="hint">Historical Pattern Probability — how often similar past market conditions were followed by gains or losses. Conditional historical outcome only; NOT a prediction, forecast, or recommendation.</p>
    <h4>Current Condition Summary</h4>
    <ul>${condItems}</ul>
    <ul>
      <li>Similar past conditions: ${p.matchCount} matches within distance threshold ${esc(String(p.threshold))}</li>
      <li>Minimum desired matches: ${p.minMatches} | Sample classification: <strong>${esc(p.sampleClassification)}</strong></li>
      <li>Most influential matching conditions: ${esc(topFeatures)}</li>
    </ul>
    ${warn}
    <table><thead><tr><th>Horizon</th><th>Up After Similar Conditions</th><th>Down %</th><th>Avg Return</th><th>Median Return</th><th>Best / Worst</th><th>Sample Size</th></tr></thead><tbody>${horizonRows}</tbody></table>
  </section>`;
}

// Phase 2 — OUT-OF-SAMPLE BACKTEST section.
function renderBacktestSection(b) {
  if (!b || !b.ok) {
    const why = b ? esc(b.message || 'unavailable') : 'not computed';
    return `<section style="margin-top:12px;"><h3>OUT-OF-SAMPLE BACKTEST</h3><p class="hint">Not available: ${why}</p></section>`;
  }
  const rows = [1, 3, 5, 10].filter((h) => b.horizons[h]).map((h) => {
    const s = b.horizons[h];
    return `<tr><td>${h}D</td>
      <td>${s.upSignals + s.downSignals}/${s.noSignals}</td>
      <td>${fmtNum(s.coveragePct)}%</td>
      <td>${fmtNum(s.accuracyPct)}%</td>
      <td>${fmtNum(s.positiveAccuracyPct)}% (${s.positiveSignals})</td>
      <td>${fmtNum(s.negativeAccuracyPct)}% (${s.negativeSignals})</td>
      <td>${fmtNum(s.avgReturnAfterPositivePct)}%</td>
      <td>${fmtNum(s.baselineDominantAccuracyPct)}%</td>
      <td>${fmtNum(s.baselineAlwaysUpAccuracyPct)}%</td>
      <td>${fmtNum(s.baselineMomentumAccuracyPct)}%</td>
      <td>${s.edgeVsBestBaselinePp == null ? '—' : `${s.edgeVsBestBaselinePp > 0 ? '+' : ''}${fmtNum(s.edgeVsBestBaselinePp)} pp`}</td></tr>`;
  }).join('');
  const ms = b.modelScore;
  const msHtml = ms ? `
    <h4>MODEL QUALITY SCORE (1D)</h4>
    <ul>
      <li>Out-of-sample validation: <strong>${esc(ms.oosValidationStatus)}</strong> | Confidence: <strong>${esc(ms.confidence)}</strong></li>
      <li>Observed edge vs best simple baseline: ${ms.observedEdgePp == null ? '—' : `${ms.observedEdgePp > 0 ? '+' : ''}${fmtNum(ms.observedEdgePp)} pp`} | Signals evaluated: ${ms.signalCount}</li>
      <li>${esc(ms.note)}</li>
    </ul>` : '';
  return `
  <section style="margin-top:12px;">
    <h3>OUT-OF-SAMPLE BACKTEST</h3>
    <p class="hint">Out-of-Sample Result — walk-forward evaluation on the newest ${fmtNum(b.testRows, 0)} qualifying days (older data used only as the pattern database). Descriptive historical performance of the similarity method; past out-of-sample results never guarantee future behavior. The model may emit NO SIGNAL when the matched historical sample is too small to support a probability.</p>
    <ul>
      <li>Split: ${fmtNum(b.databaseRows, 0)} database rows / ${fmtNum(b.testRows, 0)} test rows (ratio ${esc(String(b.splitRatio))}) | Matching mode: ${esc(String(b.matchMode))}${b.medianMatchCount != null ? ` | Median matches per test day: ${b.medianMatchCount}` : ''}</li>
      <li>Signals emitted: ${b.predictionsCount} | No-signal days: ${b.noSignalCount} | Signal coverage: ${fmtNum(b.coveragePct)}% | Overall accuracy on signals: ${fmtNum(b.accuracyPct)}%</li>
    </ul>
    <table><thead><tr><th>Horizon</th><th>Signals/None</th><th>Coverage</th><th>Directional Accuracy</th><th>Positive Signal Accuracy</th><th>Negative Signal Accuracy</th><th>Avg Return After Positive</th><th>Baseline A (Dominant)</th><th>Baseline B (Always-Up)</th><th>Baseline C (Momentum)</th><th>Edge vs Best Baseline</th></tr></thead><tbody>${rows}</tbody></table>
    ${msHtml}
  </section>`;
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
 // Sports keys (EDGE): presence indicators only — raw values never rendered.
 try {
   const oddsPresent = await hasOddsCredentialSafe();
   const serpPresent = await hasSerpCredentialSafe();
   setSportsKeyIndicators(oddsPresent, serpPresent);
 } catch { /* indicators are best-effort */ }
}

async function hasOddsCredentialSafe() {
  try { return !!(await getOddsApiKey()); } catch { return false; }
}
async function hasSerpCredentialSafe() {
  try { return !!(await getSerpApiKey()); } catch { return false; }
}
function setSportsKeyIndicators(oddsPresent, serpPresent) {
  const oddsEl = document.getElementById('odds-key-saved');
  if (oddsEl) {
    oddsEl.hidden = !oddsPresent;
    oddsEl.textContent = oddsPresent ? '•••• Odds API key saved on this device' : '';
  }
  const serpEl = document.getElementById('serp-key-saved');
  if (serpEl) {
    serpEl.hidden = !serpPresent;
    serpEl.textContent = serpPresent ? '•••• SerpAPI key saved on this device' : '';
  }
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
     // Sports data keys (EDGE): persist BEFORE refreshing indicators; empty
     // fields never overwrite an existing key (same overwrite guard as the
     // main API key).
     const elOdds = document.querySelector('[name="oddsApiKey"]');
     const elSerp = document.querySelector('[name="serpApiKey"]');
     try {
       if (elOdds && elOdds.value.trim()) await setOddsApiKey(elOdds.value.trim());
       if (elSerp && elSerp.value.trim()) await setSerpApiKey(elSerp.value.trim());
       setSportsKeyIndicators(await hasOddsCredentialSafe(), await hasSerpCredentialSafe());
       if (elOdds) elOdds.value = '';
       if (elSerp) elSerp.value = '';
     } catch (err) {
       logger.error('[settings] failed to store sports keys', err);
     }
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
 // Remove Odds API key (EDGE).
 const removeOddsBtn = document.getElementById('settings-remove-odds-key');
 if (removeOddsBtn) {
   removeOddsBtn.addEventListener('click', async () => {
     try { await clearOddsApiKey(); } catch (err) {
       logger.error('[settings] failed to remove Odds API key', err);
     }
     const elOdds = document.querySelector('[name="oddsApiKey"]');
     if (elOdds) elOdds.value = '';
     setSportsKeyIndicators(false, await hasSerpCredentialSafe());
     toast('Odds API key removed from this device', 'info');
   });
 }
 // Remove SerpAPI key (EDGE).
 const removeSerpBtn = document.getElementById('settings-remove-serp-key');
 if (removeSerpBtn) {
   removeSerpBtn.addEventListener('click', async () => {
     try { await clearSerpApiKey(); } catch (err) {
       logger.error('[settings] failed to remove SerpAPI key', err);
     }
     const elSerp = document.querySelector('[name="serpApiKey"]');
     if (elSerp) elSerp.value = '';
     setSportsKeyIndicators(await hasOddsCredentialSafe(), false);
     toast('SerpAPI key removed from this device', 'info');
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
     // promptAdd stores the selected asset on the controller
     // (assets._pendingAsset); pendingConfirm is a legacy fallback.
     const asset = pendingConfirm || (assets && assets._pendingAsset);
     if (!asset || !assets) {
       modal.close();
       return;
     }
     addBtn.disabled = true;
     let ok = false;
     try {
       ok = await assets.addAsset(asset);
     } catch (err) {
       logger.error('Add to watchlist failed:', err);
       toast('Unable to add asset. Please try again.', 'error');
     }
     addBtn.disabled = false;
     pendingConfirm = null;
     if (assets._pendingAsset === asset) assets._pendingAsset = null;
     modal.close();
     if (ok) {
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