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
function boot() {
 storage.migrate();
 const config = loadConfig();

 api = new TickerbotAPI(config);
 
 assets = new AssetsController(api);
 marketData = new MarketData({ api, getAssets: () => assets.getWatchlist() });
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
   getAsset: (sym) => assets.getAsset(sym),
 });

 wireSearch();
 wireSettings();
 wireWatchlistControls();
 wireConfirmModal();
 wireEvents();

 if (!isConfigured(config)) {
   const onboarding = $('#settings-onboarding');
   if (onboarding) onboarding.hidden = false;
   if (!window.location.hash || window.location.hash === '#/' || window.location.hash === '#') {
     window.location.hash = '#/settings';
   }
 }

 router();
 window.addEventListener('hashchange', router);
 if (isConfigured(config)) marketData.start();
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
   assets.renderWatchlist();
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
 const entry = assets.getAsset(symbol);
 $('#asset-name').textContent = entry ? entry.name : symbol.toUpperCase();
 $('#asset-ticker').textContent = symbol.toUpperCase();
 chart.renderAsset(symbol);
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
     api.setConfig(newCfg);
     toast('Settings saved successfully', 'success');
     if (isConfigured(newCfg)) {
       $('#settings-onboarding').hidden = true;
       marketData.start();
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
         assets.promptAdd(sym);
       });
     });
   } catch {
     resultsEl.innerHTML = '<div class="error-banner">Search request failed. Check API key & base URL.</div>';
   }
 });
}

function wireWatchListControls() {
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
     if (pendingConfirm) {
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

document.addEventListener('DOMContentLoaded', boot);