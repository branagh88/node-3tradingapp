// ticker-multiselect.js — Phase 10 reusable compact multi-select builders.
//
// Pure string builders only: no DOM access, no fetch, no imports beyond
// `esc` from utils.js. Used for BOTH instances (RUN REAL VALIDATION tickers
// and the explicit HISTORICAL DATA retrieval tickers). Zero network by
// construction — rendering or toggling checkboxes never issues a request.

import { esc } from './utils.js';

/**
 * Pure: compact summary for the collapsed multi-select trigger.
 * - 0 selected            → 'Select tickers…'
 * - whole watchlist       → `${n} tickers selected`
 * - 1–3 selected          → comma-joined symbols ('AAPL, MSFT, NVDA')
 * - >3 selected           → first two + counter ('AAPL, MSFT +3')
 *
 * @param {string[]} selectedSymbols selected (already-uppercase) symbols
 * @param {number} totalSymbols total options in the watchlist
 */
export function buildMultiSelectSummary(selectedSymbols, totalSymbols) {
  const selected = Array.isArray(selectedSymbols)
    ? selectedSymbols.map((s) => String(s || '').toUpperCase()).filter(Boolean)
    : [];
  const total = Number(totalSymbols) || 0;
  if (!selected.length) return 'Select tickers…';
  if (total > 0 && selected.length === total) return `${selected.length} tickers selected`;
  if (selected.length <= 3) return selected.join(', ');
  return `${selected[0]}, ${selected[1]} +${selected.length - 2}`;
}

/** Pure: collapsed trigger button markup (summary text injected separately). */
export function buildMultiSelectTriggerHtml(summaryText) {
  return `<button type="button" class="ms-trigger" aria-expanded="false" aria-haspopup="true">`
    + `<span class="ms-summary">${esc(String(summaryText ?? 'Select tickers…'))}</span>`
    + `<span class="ms-caret" aria-hidden="true">▾</span></button>`;
}

/**
 * Pure: popover markup wrapping an options container.
 * @param {string} optionsHtml chip checkbox markup (rendered by
 *        renderRvTickerSelector into the container afterwards)
 * @param {{idPrefix: string}} opts unique id prefix (e.g. 'rv' / 'hd')
 */
export function buildMultiSelectPopoverHtml(optionsHtml, { idPrefix }) {
  const p = String(idPrefix || 'ms');
  return `<div class="ms-actions">`
    + `<button type="button" id="${p}-select-all" class="btn btn--ghost btn--sm">Select all</button>`
    + `<button type="button" id="${p}-clear-all" class="btn btn--ghost btn--sm">Clear all</button>`
    + `</div>`
    + `<div id="${p}-tickers" class="chip-row ms-options ms-box-sizing" role="group">${optionsHtml}</div>`;
}

/**
 * Pure: pre-fetch estimate panel HTML (zero API calls — numbers come from the
 * pure page estimator).
 * @param {Array<{ticker: string, cached?: boolean, valid?: boolean}>} perTickerStatus
 * @param {{pagesPerTicker?: number, totalEstimatedCalls?: number}} est estimate result
 */
export function buildRvEstimatePanelHtml(perTickerStatus, est) {
  const list = Array.isArray(perTickerStatus) ? perTickerStatus : [];
  const pages = Math.max(0, Number(est?.pagesPerTicker) || 0);
  const totalCalls = Math.max(0, Number(est?.totalEstimatedCalls) || 0);
  const lines = list.map((s) => {
    const sym = esc(String(s?.ticker || '').toUpperCase());
    if (s?.valid) {
      return `<div class="ms-est-line">✓ ${sym} — cached (COMPLETE, 0 requests needed)</div>`;
    }
    return `<div class="ms-est-line">✗ ${sym} — needs data (~${pages} request${pages === 1 ? '' : 's'})</div>`;
  });
  return `<div class="ms-est-title">Per-ticker status:</div>`
    + `${lines.join('')}`
    + `<div class="ms-est-total">New API requests required: ${totalCalls}</div>`;
}
