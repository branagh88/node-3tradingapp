// config.js — Tickerbot API Configuration
export const API_CONFIG = {
baseURL: 'https://api.tickerbot.io',
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

export function loadConfig() {
const stored = storage.get('config') || {};
const settings = { ...DEFAULTS.settings, ...(stored.settings || {}) };
const capabilities = { ...API_CONFIG.capabilities, ...(stored.capabilities || {}) };
return {
  baseURL: pickString(stored, 'baseURL'),
  apiKey: pickString(stored, 'apiKey'),
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