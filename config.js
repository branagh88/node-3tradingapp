// config.js — Tickerbot API Configuration
//
// API_CONFIG.baseURL is the out-of-the-box PLACEHOLDER so the app boots
// unconfigured (Settings onboarding → isConfigured() === false). The real
// default endpoint lives in the central API client (api.js buildUrl →
// https://api.tickerbot.io); it is only used once the user saves a real URL
// in Settings. The offline smoke contract (tests/smoke.mjs) asserts that
// isConfigured() is false for the API_CONFIG defaults — i.e. the placeholder.
export const API_CONFIG = {
baseURL: 'YOUR_API_BASE_URL',
apiKey: '',
capabilities: {
  search: true,
},
};

export const DEFAULTS = {
settings: {
  pollInterval: 30,
  freshnessMs: 60000,
  timeoutMs: 10000,
  maxConcurrency: 4,
  retryMax: 2,
  staleAfterMs: null,
},
};

export const TIMEFRAMES = {
stock: [
  { id: '1D', label: '1D', range: '1D', resolution: '5m' },
  { id: '5D', label: '5D', range: '5D', resolution: '15m' },
  { id: '1M', label: '1M', range: '1M', resolution: '1h' },
  { id: '3M', label: '3M', range: '3M', resolution: '1d' },
  { id: '1Y', label: '1Y', range: '1Y', resolution: '1d' },
],
crypto: [
  { id: '1H', label: '1H', range: '1H', resolution: '1m' },
  { id: '1D', label: '1D', range: '1D', resolution: '5m' },
  { id: '1W', label: '1W', range: '1W', resolution: '1h' },
]
};

export const TIMEFRAME_DEFAULT = { range: '1D', resolution: '5m' };

export const SORTS = ['name', 'ticker', 'price', 'changePercent', 'volume', 'score'];

import { storage } from './storage.js';

function pickString(stored, key) {
const v = stored ? stored[key] : undefined;
return typeof v === 'string' ? v : API_CONFIG[key];
}

// NOTE: loadConfig() NEVER returns a persisted apiKey. The runtime key lives
// only in secure-store.js (Capacitor Preferences on native, dedicated
// localStorage key on web) and is merged in by the async boot step. Any legacy
// plaintext copy is migrated out by secure-store.migrateLegacyApiKey().
export function loadConfig() {
const stored = storage.get('config') || {};
const settings = { ...DEFAULTS.settings, ...(stored.settings || {}) };
const capabilities = { ...API_CONFIG.capabilities, ...(stored.capabilities || {}) };
return {
  baseURL: pickString(stored, 'baseURL'),
  apiKey: '', // runtime-only — see secure-store.js
  // Optional endpoint/version overrides from Settings (round-tripped when
  // present as strings; absent keys stay undefined so API defaults apply).
  apiVersion: pickString(stored, 'apiVersion'),
  stockEndpoint: pickString(stored, 'stockEndpoint'),
  cryptoEndpoint: pickString(stored, 'cryptoEndpoint'),
  wsEndpoint: pickString(stored, 'wsEndpoint'),
  capabilities,
  settings,
};
}

export function saveConfig(cfg) {
storage.set('config', cfg);
}

export function isValidHttpUrl(value) {
if (typeof value !== 'string' || !value.trim()) return false;
try {
  const u = new URL(value.trim());
  return u.protocol === 'http:' || u.protocol === 'https:';
} catch {
  return false;
}
}

export function isConfigured(cfg) {
return !!cfg && isValidHttpUrl(cfg.baseURL) && cfg.baseURL.trim() !== 'YOUR_API_BASE_URL';
}

// True when a non-empty API key is present on the (boot-merged) config.
export function hasApiKey(cfg) {
return !!cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '';
}

// Three-state configuration status:
//   'unconfigured' — placeholder / no valid base URL saved yet
//   'missing-key'  — real base URL but no API key stored on this device
//   'ready'        — base URL + key present; live polling may start
export function configStatus(cfg) {
if (!isConfigured(cfg)) return 'unconfigured';
return hasApiKey(cfg) ? 'ready' : 'missing-key';
}