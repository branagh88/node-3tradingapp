// rv-status.js — Phase 8 per-ticker validation status layer.
//
// Pure, dependency-free (except utils.esc for markup builders): a tiny state
// machine over per-ticker statuses plus SANITIZED diagnostic helpers.
//
// SECURITY CONTRACT: diagnostics rendered/logged from this module contain ONLY
// structured fields — { ticker, operation, stage, httpStatus, stoppedReason,
// attempts, hasCache } (+ err.name for display). They NEVER include err.message,
// headers, URLs, or raw response bodies. safeErrorInfo derives everything from
// structured properties (err.status, err.kind, err.name, stoppedReason) and
// never stringifies an error object.
//
// Stage derivation table:
//   rate-limit signal (err.kind === 'rate_limit' | err.name 'RateLimitError'
//     | stoppedReason 'rate_limited')            → 'rate_limited', err.status ?? null
//   stoppedReason ∈ repeated_cursor/no_progress/
//     max_pages/server_exhausted                 → 'pagination', null
//   stoppedReason 'error' w/ numeric err.status  → 'http', err.status
//   stoppedReason 'error' without status         → 'transport', null
//   engine throw (err.name present, op walk_forward/pool) → 'engine', null
//   anything else                                → 'unknown', null

import { esc } from './utils.js';

export const RV_STATES = Object.freeze({
  READY: 'READY',
  FETCHING_HISTORY: 'FETCHING HISTORY',
  USING_CACHE: 'USING CACHE',
  VALIDATING: 'VALIDATING',
  COMPLETE: 'COMPLETE',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
  ERROR: 'ERROR',
});

const PAGINATION_REASONS = ['repeated_cursor', 'no_progress', 'max_pages', 'server_exhausted'];

/** Fresh per-ticker status record. */
export function createTickerStatus(ticker) {
  return {
    ticker: String(ticker || '').toUpperCase(),
    state: RV_STATES.READY,
    attempts: 0,
    fromCache: false,
    candles: null,
    stoppedReason: null,
    httpStatus: null,
    stage: null,
    operation: null,
    errorName: null,
  };
}

function slug(state) {
  return String(state || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function cloneStatus(s) {
  return { ...s };
}

/**
 * PURE reducer over a plain Map keyed by uppercase ticker.
 * Returns a NEW Map; never mutates the input. Unknown phases/tickers are
 * ignored (input returned unchanged); never throws.
 */
export function applyRvEvent(statusMap, evt) {
  if (!statusMap || typeof statusMap !== 'object' || !evt || !evt.ticker) return statusMap;
  const key = String(evt.ticker).toUpperCase();
  if (!statusMap.has(key)) return statusMap;
  const cur = statusMap.get(key);
  let next = null;
  const set = (patch) => { next = { ...cloneStatus(cur), ...patch }; };

  switch (evt.phase) {
    case 'FETCHING':
      set({ state: RV_STATES.FETCHING_HISTORY });
      break;
    case 'CACHE_HIT':
      set({ state: RV_STATES.USING_CACHE, fromCache: true });
      break;
    case 'RETRIEVING':
      // Relay events during retrieval keep the current in-flight state.
      next = null;
      break;
    case 'RETRYING':
      set({ state: RV_STATES.FETCHING_HISTORY });
      break;
    case 'RETRIEVED':
      set({
        state: evt.fromCache ? RV_STATES.USING_CACHE : RV_STATES.FETCHING_HISTORY,
        attempts: Number.isFinite(evt.attempts) ? evt.attempts : cur.attempts,
        fromCache: !!evt.fromCache,
        candles: Array.isArray(evt.bars) ? evt.bars.length
          : (Number.isFinite(evt.candles) ? evt.candles : cur.candles),
        stoppedReason: evt.stoppedReason != null ? evt.stoppedReason : cur.stoppedReason,
        httpStatus: Number.isFinite(evt.httpStatus) ? evt.httpStatus : cur.httpStatus,
        errorName: evt.errorName != null ? evt.errorName : cur.errorName,
      });
      break;
    case 'BACKTESTING':
      set({ state: RV_STATES.VALIDATING });
      break;
    case 'TICKER_DONE': {
      const ok = evt.outcome !== 'insufficient_data';
      set({
        state: ok ? RV_STATES.COMPLETE : RV_STATES.INSUFFICIENT_DATA,
        candles: Number.isFinite(evt.candles) ? evt.candles : cur.candles,
        attempts: Number.isFinite(evt.attempts) ? evt.attempts : cur.attempts,
        fromCache: evt.fromCache != null ? !!evt.fromCache : cur.fromCache,
        stoppedReason: ok ? null : cur.stoppedReason,
        stage: ok ? null : cur.stage,
      });
      break;
    }
    case 'TICKER_FAILED': {
      const f = evt.failure && typeof evt.failure === 'object' ? evt.failure : {};
      set({
        state: RV_STATES.ERROR,
        operation: f.operation || cur.operation,
        stage: f.stage || 'unknown',
        httpStatus: Number.isFinite(f.httpStatus) ? f.httpStatus : cur.httpStatus,
        stoppedReason: f.stoppedReason != null ? f.stoppedReason : cur.stoppedReason,
        attempts: Number.isFinite(f.attempts) ? f.attempts : cur.attempts,
        hasCache: f.hasCache != null ? !!f.hasCache : false,
        errorName: f.errorName != null ? f.errorName : cur.errorName,
        candles: Number.isFinite(f.candles) ? f.candles : cur.candles,
      });
      break;
    }
    default:
      next = null;
  }
  if (!next) return statusMap;
  const out = new Map(statusMap);
  out.set(key, next);
  return out;
}

/**
 * Sanitized error info — the ONLY shape allowed to reach UI/logs for failures.
 * Derives stage/httpStatus ONLY from structured properties. Never reads
 * err.message, never stringifies the error.
 */
export function safeErrorInfo({
  ticker = null, operation = 'fetch_history', err = null,
  stoppedReason = null, attempts = 0, hasCache = false, errorName = null,
} = {}) {
  const name = (err && typeof err.name === 'string' && err.name) || null;
  const kind = err && typeof err.kind === 'string' ? err.kind : null;
  const status = Number.isFinite(err && err.status) ? err.status : null;

  let stage = 'unknown';
  let httpStatus = null;
  if (kind === 'rate_limit' || name === 'RateLimitError' || stoppedReason === 'rate_limited') {
    stage = 'rate_limited';
    httpStatus = status;
  } else if (PAGINATION_REASONS.includes(stoppedReason)) {
    stage = 'pagination';
  } else if (stoppedReason === 'error') {
    if (Number.isFinite(status)) { stage = 'http'; httpStatus = status; }
    else stage = 'transport';
  } else if ((operation === 'walk_forward' || operation === 'pool') && (name || errorName)) {
    stage = 'engine';
  } else if (err) {
    // A thrown transport-shaped error without any structured reason.
    stage = 'transport';
  }
  return {
    ticker: ticker ? String(ticker).toUpperCase() : null,
    operation,
    stage,
    httpStatus,
    stoppedReason,
    attempts: Number.isFinite(attempts) ? attempts : 0,
    hasCache: !!hasCache,
    errorName: errorName || name,
  };
}

/** Badge span for a state value. */
export function rvStateBadgeHtml(state) {
  return `<span class="rv-status-badge rv-status-badge--${esc(slug(state))}">${esc(state || '\u2014')}</span>`;
}

/** Live strip: one row per ticker (chip + badge). Used inside #rv-status. */
export function rvStatusStripHtml(statusList) {
  const rows = Array.from(statusList || []).map((s) => {
    const st = s || createTickerStatus('?');
    return `<div class="rv-status__row" data-rv-status-ticker="${esc(st.ticker)}">`
      + `<span class="chip">${esc(st.ticker)}</span> `
      + `${rvStateBadgeHtml(st.state)}</div>`;
  }).join('');
  return `<div class="rv-status__rows">${rows}</div>`;
}

/** One label:value cell pair for details/error blocks (escaped values). */
function detailCell(label, valueHtml) {
  return `<div class="rv-details__pair"><span class="rv-details__label">${esc(label)}</span>`
    + `<span class="rv-details__value">${valueHtml}</span></div>`;
}

function detailPair(label, value) {
  return detailCell(label, esc(value == null ? '\u2014' : String(value)));
}

/**
 * Collapsed "Validation Details" block for a finished run.
 * @param {Array|Object} diagnostics array of diag records (or map keyed by ticker)
 */
export function buildValidationDetailsHtml(diagnostics) {
  const list = Array.isArray(diagnostics)
    ? diagnostics.filter(Boolean)
    : Object.values(diagnostics || {}).filter(Boolean);
  if (!list.length) return '';
  const sorted = list.slice().sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const bodyRows = sorted.map((d) => {
    const source = d.source === 'session cache' ? 'session cache' : 'fresh fetch';
    const row = (label, v) => `<td>${esc(v == null || v === '' ? '\u2014' : String(v))}</td>`;
    let html = `<tr><th scope="row">${esc(d.ticker)}</th>`
      + `<td>${rvStateBadgeHtml(d.finalState || d.state)}</td>`
      + row('source', source)
      + row('cache present', d.hasCache ? 'yes' : 'no')
      + row('attempts', d.attempts)
      + row('candles', d.candles)
      + row('stopped reason', d.stoppedReason)
      + row('http status', d.httpStatus)
      + row('stage', d.stage)
      + row('operation', d.operation)
      + '</tr>';
    if (d.finalState === RV_STATES.ERROR || d.finalState === RV_STATES.INSUFFICIENT_DATA) {
      html += '<tr class="rv-details__error-row"><td colspan="10">'
        + '<details class="rv-details__error"><summary>Error details</summary>'
        + detailPair('Ticker', d.ticker)
        + detailPair('Operation', d.operation)
        + detailPair('Stage', d.stage)
        + detailPair('HTTP status', d.httpStatus)
        + detailPair('Stopped reason', d.stoppedReason)
        + detailPair('Attempts', d.attempts)
        + detailPair('Cache present', d.hasCache ? 'yes' : 'no')
        + (d.errorName ? detailPair('Error type', d.errorName) : '')
        + '</details></td></tr>';
    }
    return html;
  }).join('');
  return '<details class="rv-details"><summary>Validation Details</summary>'
    + '<div class="rv-table-wrap"><table class="table rv-details-table"><thead><tr>'
    + '<th>Ticker</th><th>State</th><th>Source</th><th>Cache present</th><th>Attempts</th>'
    + '<th>Candles</th><th>Stopped reason</th><th>HTTP status</th><th>Stage</th><th>Operation</th>'
    + '</tr></thead><tbody>'
    + bodyRows
    + '</tbody></table></div></details>';
}

/**
 * Sanitized retry-failure message for the #rv-error banner (spec §3.4).
 * NEVER includes err.message/URLs/headers — only whitelisted structured fields.
 */
export function formatRvRetryError(err) {
  const info = safeErrorInfo({ operation: 'retry_validation', err });
  const bits = [
    `error type: ${info.errorName || 'Error'}`,
    `stage: ${info.stage}`,
    `HTTP status: ${info.httpStatus == null ? 'n/a' : info.httpStatus}`,
  ];
  return `Retry failed (${bits.join(', ')}).`;
}
