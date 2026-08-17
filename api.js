// api.js — Tickerbot REST Client (Endpoints /v2/tickers, /v2/signals, /v2/scan, /v2/series)
import { isConfigured } from './config.js';
import { logger } from './utils.js';

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
  const base = String(this.config.baseURL || 'https://api.tickerbot.io').replace(/\/+$/, '');
  const endpoint = String(path).replace(/^\/+/, '');
  return `${base}/${endpoint}`;
}

async _doFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), this.timeoutMs);
  const finalUrl = this.buildUrl(path);
  const safeUrl = finalUrl;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  if (this.config.apiKey) {
    headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
  }

  let response;
  try {
    response = await fetch(finalUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
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

normalizeQuote(raw, ticker, meta) {
  const item = raw.ticker || raw.data || raw;
  return {
    symbol: ticker.toUpperCase(),
    name: item.name || item.companyName || ticker.toUpperCase(),
    assetType: ticker.includes('/') ? 'crypto' : 'stock',
    price: Number(item.price || item.last || item.close || 0),
    change: Number(item.change || item.todaysChange || 0),
    changePercent: Number(item.changePercent || item.todaysChangePerc || 0),
    volume: Number(item.volume || item.v || 0),
    high: Number(item.high || item.h || 0),
    low: Number(item.low || item.l || 0),
    open: Number(item.open || item.o || 0),
    previousClose: Number(item.previousClose || item.prevClose || 0),
    marketCap: Number(item.marketCap || item.market_cap || 0),
    signals: item.signals || {},
    timestamp: Number(item.updated || item.timestamp || Date.now()),
    _debug: meta
  };
}
}

export default TickerbotAPI;