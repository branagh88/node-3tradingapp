// real-validation-ui.js — Phase 6 RUN REAL VALIDATION result rendering.
//
// Pure string builders extracted from app.js so they can be unit-tested
// offline under Vitest. No DOM access, no fetching, no key handling.
//
// Responsive contract (UI-only fix):
//  - Desktop (>860px): the original pooled-horizon TABLE is shown, wrapped in
//    a horizontally scrollable container as a last-resort safety net.
//  - Narrow screens (<=860px): the same data renders as stacked per-horizon
//    CARDS (.rv-card) carrying every field the table shows; the table is
//    hidden by CSS so a phone portrait viewport never scrolls horizontally.
// Both representations are always present in the markup; visibility is CSS-
// driven only, so no information is ever lost and no JS resize logic runs.

import { esc } from './utils.js';
import {
  buildValidationDetailsHtml,
  rvStateBadgeHtml,
} from './rv-status.js';

export const RV_UI_HORIZONS = [1, 3, 5, 10];

function fmtNum(v, digits = 2) {
  return v == null || !Number.isFinite(Number(v))
    ? '\u2014'
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Distinct verdict badge class per verdict value (visually unambiguous). */
export function rvVerdictBadge(verdict) {
  const cls = verdict === 'EDGE'
    ? 'edge'
    : verdict === 'NO EDGE'
      ? 'no-edge'
      : 'insufficient';
  return `<span class="badge badge--${cls}">${esc(verdict || '\u2014')}</span>`;
}

/** Edge pp color coding: positive green, negative red, neutral dim. */
export function rvEdgeCell(pp) {
  if (pp == null || !Number.isFinite(Number(pp))) return '\u2014';
  const n = Number(pp);
  const cls = n > 0 ? 'rv-edge--pos' : n < 0 ? 'rv-edge--neg' : 'rv-edge--zero';
  return `<span class="${cls}">${esc(fmtNum(n))}</span>`;
}

function pooledRow(h, p) {
  const boot = p.bootstrapCI && p.bootstrapCI.lowPct != null
    ? `[${fmtNum(p.bootstrapCI.lowPct)}%, ${fmtNum(p.bootstrapCI.highPct)}%]`
    : '\u2014';
  return `<tr>`
    + `<th scope="row">${h}D</th>`
    + `<td>${fmtNum(p.predictions, 0)}</td>`
    + `<td>${p.accuracyPct == null ? '\u2014' : `${fmtNum(p.accuracyPct)}%`}</td>`
    + `<td>[${fmtNum(p.wilsonLowPct)}%, ${fmtNum(p.wilsonHighPct)}%]</td>`
    + `<td>${esc(boot)}</td>`
    + `<td>${p.bestBaselinePct == null ? '\u2014' : `${fmtNum(p.bestBaselinePct)}%`}</td>`
    + `<td>${rvEdgeCell(p.edgeVsBestBaselinePp)}</td>`
    + `<td>${p.significance ? esc(String(p.significance.pValue)) : '\u2014'}</td>`
    + `<td>${rvVerdictBadge(p.verdict)}${p.overlapAwareEdge ? ' <span class="hint">(overlap-aware)</span>' : ''}</td>`
    + `</tr>`;
}

/** One stacked card per horizon — every pooled-table field preserved. */
export function rvHorizonCard(h, p) {
  if (!p) return '';
  const boot = p.bootstrapCI && p.bootstrapCI.lowPct != null
    ? `[${fmtNum(p.bootstrapCI.lowPct)}%, ${fmtNum(p.bootstrapCI.highPct)}%]`
    : '\u2014';
  const row = (label, value) => `<div class="rv-card__row"><span class="rv-card__label">${label}</span>`
    + `<span class="rv-card__value">${value}</span></div>`;
  return `<article class="rv-card" data-rv-horizon="${h}">`
    + `<header class="rv-card__header"><h5 class="rv-card__title">${h}D</h5>`
    + `<span class="rv-card__verdict">${rvVerdictBadge(p.verdict)}${p.overlapAwareEdge ? ' <span class="hint">(overlap-aware)</span>' : ''}</span></header>`
    + row('Signals', esc(fmtNum(p.predictions, 0)))
    + row('Accuracy', p.accuracyPct == null ? '\u2014' : esc(`${fmtNum(p.accuracyPct)}%`))
    + row('Wilson 95% CI', esc(`[${fmtNum(p.wilsonLowPct)}%, ${fmtNum(p.wilsonHighPct)}%]`))
    + row('Bootstrap CI', esc(boot))
    + row('Best baseline', p.bestBaselinePct == null ? '\u2014' : esc(`${fmtNum(p.bestBaselinePct)}%`))
    + row('Edge pp', rvEdgeCell(p.edgeVsBestBaselinePp))
    + row('p-value', p.significance ? esc(String(p.significance.pValue)) : '\u2014')
    + `</article>`;
}

/**
 * Pure: full RUN REAL VALIDATION results markup.
 * @param {object} r validation report from RealValidationController.run()
 * @returns {string} HTML
 */
export function renderRealValidationResults(r, options = {}) {
  if (!r) return '';
  const diagnostics = r.diagnostics || options.diagnostics || null;
  let html = '<h4>Datasets</h4>'
    + '<div class="rv-table-wrap"><table class="table"><thead><tr>'
    + '<th>Ticker</th><th>Status</th><th>Candles</th><th>Range</th><th>API reqs</th><th>Source</th>'
    + '</tr></thead><tbody>';
  for (const sym of r.included || []) {
    const t = r.perTicker[sym] || {};
    const diag = diagnostics ? diagnostics[sym] : null;
    html += `<tr><td>${esc(sym)}</td><td>${esc(t.status || '\u2014')}${
      diag && diag.finalState ? ` ${rvStateBadgeHtml(diag.finalState)}` : ''}</td><td>${fmtNum(t.candles, 0)}</td>`
      + `<td>${esc(t.dateRange || '\u2014')}</td><td>${fmtNum(t.apiRequests, 0)}</td>`
      + `<td>${t.fromCache ? '(cached, 0 API calls)' : 'fresh'}</td></tr>`;
  }
  html += '</tbody></table></div>';
  if ((r.skipped || []).length) {
    html += '<h4>Skipped</h4><div class="rv-table-wrap"><table class="table"><tbody>';
    for (const s of r.skipped) {
      html += `<tr><td>${esc(s.ticker)}</td><td>${esc(s.reason)}</td>`
        + `<td><button type="button" class="btn btn--sm btn--ghost" data-rv-retry="${esc(s.ticker)}">Retry</button></td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  // Phase 8: collapsed per-run diagnostics block — only when the report
  // carries diagnostics; plain-text rendering stays identical otherwise.
  if (diagnostics) {
    html += buildValidationDetailsHtml(diagnostics);
  }
  html += '<h4>Pooled horizons</h4>';
  // Desktop: original table (CSS-hidden on narrow screens).
  html += '<div class="rv-table-wrap rv-pooled-desktop"><table class="table rv-pooled-table"><thead><tr>'
    + '<th>H</th><th>Signals</th><th>Accuracy</th><th>Wilson 95% CI</th><th>Bootstrap CI</th>'
    + '<th>Best baseline</th><th>Edge pp</th><th>p-value</th><th>Verdict</th>'
    + '</tr></thead><tbody>';
  let cards = '';
  for (const h of RV_UI_HORIZONS) {
    const p = r.pooled && r.pooled[h];
    if (!p) continue;
    html += pooledRow(h, p);
    cards += rvHorizonCard(h, p);
  }
  html += '</tbody></table></div>';
  // Narrow screens: stacked cards (CSS-hidden on desktop).
  html += `<div class="rv-cards" role="list">${cards}</div>`;
  html += `<p class="hint">Total API requests spent: ${fmtNum(r.totals?.apiCallsSpent, 0)} | `
    + `Cached datasets: ${fmtNum(r.totals?.cachedDatasets, 0)}. `
    + `${esc(r.disclaimer || 'Descriptive historical evaluation \u2014 NOT a forecast.')}</p>`;
  return html;
}

export default renderRealValidationResults;
