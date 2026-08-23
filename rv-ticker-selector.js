// rv-ticker-selector.js — Watchlist-driven ticker selector for RUN REAL
// VALIDATION.
//
// Single source of truth: the LIVE WATCHLIST (AssetsController.getWatchlist(),
// localStorage via storage.js). There is no hardcoded ticker universe
// anywhere — the checkboxes in #rv-tickers are re-rendered from the current
// watchlist every time the Historical Analysis panel is opened, when the
// watchlist changes, and before a run. Pure builders are exported for
// offline unit testing under Vitest (jsdom).
//
// No API access, no key handling, no fetching. Adding a ticker NEVER
// pre-fetches data or auto-runs validation; on run, datasets come from the
// session cache if present, otherwise they are fetched via the existing
// Tickerbot flow (HistoricalAnalysisController) and then cached.

import { esc } from './utils.js';

/**
 * Pure: HTML for the ticker checkbox chips derived from a watchlist.
 * @param {Array<{symbol: string}>|string[]} watchlist
 * @returns {string} markup of <label><input class="rv-ticker">…</label> chips,
 *   alphabetically sorted by symbol. Empty string when the watchlist is empty.
 */
export function buildRvTickerOptionsHtml(watchlist) {
  const symbols = normalizeWatchlistSymbols(watchlist);
  return symbols.map((sym) =>
    `<label><input type="checkbox" class="rv-ticker" value="${esc(sym)}">${esc(sym)}</label>`
  ).join('');
}

/** Pure: clear empty-state hint shown instead of chips. */
export function rvTickersEmptyHtml() {
  return '<span class="rv-tickers-empty hint" role="status">'
    + 'Your watchlist is empty — add tickers to your Watchlist to select them for validation.'
    + '</span>';
}

/**
 * Normalize a watchlist (objects with .symbol, or plain strings) to a sorted,
 * deduped list of uppercase ticker symbols.
 */
export function normalizeWatchlistSymbols(watchlist) {
  if (!Array.isArray(watchlist)) return [];
  const set = new Set();
  for (const entry of watchlist) {
    const sym = String(
      typeof entry === 'object' && entry !== null ? entry.symbol : entry || ''
    ).trim().toUpperCase();
    if (sym) set.add(sym);
  }
  return [...set].sort();
}

/**
 * Render the #rv-tickers container from the CURRENT watchlist. Previously
 * checked tickers that still exist keep their checked state; everything else
 * resets (removed tickers disappear; newly added tickers appear unchecked).
 *
 * @param {HTMLElement|null} container #rv-tickers element
 * @param {Array<{symbol: string}>|string[]} watchlist live watchlist
 * @returns {string[]} symbols now rendered (sorted)
 */
export function renderRvTickerSelector(container, watchlist) {
  if (!container) return [];
  const symbols = normalizeWatchlistSymbols(watchlist);
  if (!symbols.length) {
    container.innerHTML = rvTickersEmptyHtml();
    return [];
  }
  // Preserve prior selection state across re-renders.
  const previouslyChecked = new Set(
    Array.from(container.querySelectorAll('.rv-ticker:checked'))
      .map((cb) => String(cb.value || '').toUpperCase())
  );
  let html = '';
  for (const sym of symbols) {
    const checked = previouslyChecked.has(sym) ? ' checked' : '';
    html += `<label><input type="checkbox" class="rv-ticker"${checked} value="${esc(sym)}">${esc(sym)}</label>`;
  }
  container.innerHTML = html;
  return symbols;
}
