// history-diagnostics.js — TEMPORARY diagnostic overlay (revert later).
//
// Renders a floating 'HISTORY DIAGNOSTICS' panel showing SAFE metadata for the
// HISTORICAL data request only (GET /v2/tickers/{SYM}/bars/{interval}).
//
// Safety rules enforced here:
//   - NEVER displays the API key, the Authorization header VALUE (only
//     PRESENT/MISSING), request headers, or any raw response body.
//   - Only reports key NAMES / counts / statuses emitted by api.js
//     getHistoricalData() via the bus ('history:diagnostics').
//
// The panel auto-shows when a GME 1D or 5D chart is loaded; a small toggle
// button (bottom-right) shows/hides it at any time.

import { bus, esc } from './utils.js';

const AUTO_SHOW_TICKER = 'GME';
const AUTO_SHOW_RANGES = new Set(['1D', '5D']);

function fmtVal(v) {
  if (v == null) return 'N/A';
  return esc(String(v));
}

function renderDiag(diag) {
  const req = diag.request || {};
  const res = diag.response || {};
  const shape = diag.shape || {};
  const counts = diag.counts || {};
  const errDetail = diag.errorDetail;
  const errLine = diag.error && diag.error !== 'NONE'
    ? `${fmtVal(diag.error)}${errDetail ? ` — ${esc(errDetail.name)}: ${esc(errDetail.message || '')}` : ''}`
    : 'NONE';
  const topKeys = Array.isArray(shape.topKeys) ? shape.topKeys : [];
  return `
    <div><strong>Request</strong></div>
    <div>ticker: ${fmtVal(req.ticker)} | timeframe: ${fmtVal(req.range)} | interval: ${fmtVal(req.interval)}</div>
    <div>from: ${fmtVal(req.from)} ms | to: ${fmtVal(req.to)} ms | limit: ${fmtVal(req.limit)}</div>
    <div style="margin-top:4px;"><strong>Authentication</strong></div>
    <div>Authorization: ${diag.auth === 'MISSING' ? 'MISSING' : 'PRESENT'} (value never shown)</div>
    <div style="margin-top:4px;"><strong>Response</strong></div>
    <div>HTTP status: ${fmtVal(res.httpStatus)} | elapsed: ${fmtVal(res.elapsedMs)} ms</div>
    <div>content type: ${fmtVal(res.contentType)} | body typeof: ${fmtVal(res.bodyTypeof)}</div>
    <div style="margin-top:4px;"><strong>Response shape (actual keys)</strong></div>
    <div>top-level keys: ${esc(JSON.stringify(topKeys))}</div>
    <div>bars: ${fmtVal(shape.barsExists)} | data: ${fmtVal(shape.dataExists)} | series: ${fmtVal(shape.seriesExists)} | candles: ${fmtVal(shape.candlesExists)}</div>
    <div style="margin-top:4px;"><strong>Counts</strong></div>
    <div>raw bars: ${fmtVal(counts.rawBars)} | parsed: ${fmtVal(counts.parsed)} | normalized candles: ${fmtVal(counts.normalized)}</div>
    <div style="margin-top:4px;"><strong>Errors</strong></div>
    <div>${errLine}</div>`;
}

export function initHistoryDiagnostics({ bus: eventBus = bus } = {}) {
  if (typeof document === 'undefined') return null;

  // Toggle button + panel, appended to body so they survive router re-renders.
  let toggle = document.querySelector('#history-diag-toggle');
  let panel = document.querySelector('#history-diag-panel');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'history-diag-toggle';
    toggle.type = 'button';
    toggle.textContent = 'HIST DIAG';
    toggle.title = 'Toggle HISTORY DIAGNOSTICS panel (temporary)';
    Object.assign(toggle.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '9999',
      padding: '6px 10px', fontSize: '11px', cursor: 'pointer',
      background: '#1f2937', color: '#e5e7eb', border: '1px solid #4b5563', borderRadius: '6px',
    });
    document.body.appendChild(toggle);
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'history-diag-panel';
    panel.hidden = true;
    Object.assign(panel.style, {
      position: 'fixed', right: '12px', bottom: '48px', zIndex: '9999',
      width: 'min(420px, calc(100vw - 24px))', maxHeight: '60vh', overflowY: 'auto',
      background: 'rgba(17,24,39,0.96)', color: '#d1d5db',
      border: '1px solid #4b5563', borderRadius: '8px', padding: '10px 12px',
      font: '11px/1.45 monospace', whiteSpace: 'normal',
    });
    document.body.appendChild(panel);
  }

  const setPanel = (html) => {
    panel.innerHTML = `<div style="font-weight:bold;margin-bottom:6px;">HISTORY DIAGNOSTICS (temporary)</div>${html}`;
  };

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  const handler = (diag) => {
    if (!diag || typeof diag !== 'object') return;
    setPanel(renderDiag(diag));
    const req = diag.request || {};
    if (
      String(req.ticker || '').toUpperCase() === AUTO_SHOW_TICKER
      && AUTO_SHOW_RANGES.has(String(req.range || '').toUpperCase())
    ) {
      panel.hidden = false;
    }
  };
  eventBus.on('history:diagnostics', handler);

  // Show an idle placeholder so the toggle is self-explanatory before the
  // first GME 1D/5D chart load.
  if (!panel.innerHTML) {
    setPanel('<div>No historical request captured yet. Load a GME 1D or 5D chart.</div>');
  }
  return { handler };
}
