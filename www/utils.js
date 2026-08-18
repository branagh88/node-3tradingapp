// utils.js
// Shared browser utilities for Market Intelligence.

export const logger = {
  debug(...args) { if (typeof console !== 'undefined') console.debug('[MarketIntel]', ...args); },
  info(...args) { if (typeof console !== 'undefined') console.info('[MarketIntel]', ...args); },
  warn(...args) { if (typeof console !== 'undefined') console.warn('[MarketIntel]', ...args); },
  error(...args) { if (typeof console !== 'undefined') console.error('[MarketIntel]', ...args); },
};

export function on(target, event, handler, options) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtPrice(value, currency = 'USD') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      maximumFractionDigits: n >= 1000 ? 2 : 4,
    }).format(n);
  } catch {
    return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  }
}

export function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function fmtVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

export function fmtTime(value) {
  if (value == null) return '—';
  const date = value instanceof Date ? value : new Date(
    typeof value === 'number' && value < 1e12 ? value * 1000 : value
  );
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Tiny in-process event bus. market-data.js / charts.js / assets.js all do
// `import { bus } from './utils.js'` and emit/observe app events (e.g.
// 'market-data:updated', 'api:error', 'watchlist:changed').
export const bus = {
  _listeners: new Map(),
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  },
  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return this;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(event);
    return this;
  },
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[MarketIntel] bus handler error:', err);
      }
    }
    return true;
  },
};
