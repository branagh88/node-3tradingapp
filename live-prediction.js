// live-prediction.js — Phase A: live prediction layer.
//
// Thin orchestrator over the EXISTING pattern engine (pattern-engine.js) and
// the EXISTING HistoricalAnalysisController retrieval path (historical-analysis.js).
// Nothing here re-implements matching, feature extraction, or statistics:
// analyzePattern / extractFeatures / normalizeFeatures / wilsonInterval /
// classifySampleSize are imported verbatim from pattern-engine.js.
//
// Guarantees:
//  - Browser-safe (no `node:` imports), key-free.
//  - Single schemaVersion-1 structured contract; every uncalculable field is
//    exactly null — never fabricated.
//  - Tickers only ever arrive via parameters (no hardcoded symbols).
//  - Honest language: "conditional historical frequency", never "forecast".

import {
  analyzePattern,
  wilsonInterval,
  classifySampleSize,
  DEFAULTS as PATTERN_DEFAULTS,
} from './pattern-engine.js';
import { HistoricalAnalysisController } from './historical-analysis.js';

export const LIVE_PREDICTION_SCHEMA_VERSION = 1;

export const LIVE_PREDICTION_DEFAULTS = {
  depth: '1y',
  horizons: PATTERN_DEFAULTS.HORIZONS.slice(),
  minSignalSample: PATTERN_DEFAULTS.MIN_SIGNAL_SAMPLE,
};

const DISCLAIMER = 'Conditional historical frequency over matched past analogs — NOT a prediction, forecast, or recommendation.';

/**
 * Build the structured prediction contract from already-retrieved bars.
 * Pure function of its inputs (deterministic; no clock except injected `now`).
 *
 * @param {object} opts
 * @param {string} opts.ticker
 * @param {Array<{t,o,h,l,c,v}>} opts.bars chronologically sorted daily candles
 * @param {number[]} [opts.horizons]
 * @param {number} [opts.minSignalSample]
 * @param {object} [opts.matchOptions] forwarded verbatim to analyzePattern
 * @param {number} [opts.now] epoch ms override (tests); defaults to Date.now()
 */
export function buildPredictionContract({
  ticker,
  bars,
  horizons = LIVE_PREDICTION_DEFAULTS.horizons,
  minSignalSample = LIVE_PREDICTION_DEFAULTS.minSignalSample,
  matchOptions = {},
  dataset = {},
  now = Date.now(),
} = {}) {
  const base = {
    schemaVersion: LIVE_PREDICTION_SCHEMA_VERSION,
    ticker: String(ticker || '').toUpperCase().trim() || null,
    generatedAt: typeof now === 'number' ? now : Date.now(),
    dataset: {
      status: dataset.status ?? null,
      candles: Array.isArray(bars) ? bars.length : 0,
      coverageYears: dataset.coverageYears ?? null,
      dateRange: (dataset.quality && dataset.quality.dateRange) ?? null,
      stoppedReason: dataset.stoppedReason ?? null,
      depth: dataset.depth ?? LIVE_PREDICTION_DEFAULTS.depth,
    },
    status: 'OK',
    reason: null,
    condition: null,
    conditionTime: null,
    analysis: null,
    horizons: {},
    disclaimer: DISCLAIMER,
  };

  if (!Array.isArray(bars) || bars.length === 0) {
    base.status = 'NO_DATA';
    const sr = dataset.stoppedReason ? ` (stoppedReason: ${dataset.stoppedReason})` : '';
    base.reason = `No historical candles available${sr}.`;
    return base;
  }

  let p;
  try {
    p = analyzePattern({ bars, horizons, ...matchOptions });
  } catch (err) {
    base.status = 'NO_DATA';
    base.reason = `Pattern engine failed: ${String((err && err.message) || err)}`;
    return base;
  }

  if (!p || p.ok !== true) {
    if (p && p.reason === 'INSUFFICIENT_HISTORY') {
      base.status = 'INSUFFICIENT_HISTORY';
      base.reason = 'Latest candle lacks sufficient history for a complete condition vector.';
    } else {
      base.status = 'NO_DATA';
      base.reason = String((p && p.message) || 'Pattern analysis returned no usable result.');
    }
    return base;
  }

  // Engine succeeded — populate the live condition and analysis metadata
  // verbatim from analyzePattern output (no re-computation, no fork).
  base.condition = p.condition;
  base.conditionTime = p.conditionTime;
  base.analysis = {
    matchCount: p.matchCount,
    matchMode: p.matchMode,
    kUsed: p.kUsed,
    percentileCutoff: p.percentileCutoff,
    maxMatchDistance: p.maxMatchDistance,
    meetsMinMatches: p.meetsMinMatches,
    sampleClassification: p.sampleClassification,
    compositeSignature: p.compositeSignature ?? null,
    compositeRelaxed: !!p.compositeRelaxed,
    topContributingFeatures: p.topContributingFeatures ?? [],
    activeFeatures: p.activeFeatures ?? [],
  };

  let weakestStatus = 'OK';
  const reasons = [];

  for (const h of horizons) {
    const o = (p.forwardOutcomes || {})[h];
    const row = {
      days: h,
      sampleSize: o ? o.sampleSize : 0,
      direction: null,
      probabilityPct: null,
      wilsonLowPct: null,
      wilsonHighPct: null,
      upPct: null, downPct: null, flatPct: null,
      averageReturnPct: null, medianReturnPct: null,
      bestReturnPct: null, worstReturnPct: null,
      classification: classifySampleSize(o ? o.sampleSize : 0),
    };
    if (!o) {
      if (weakestStatus !== 'INSUFFICIENT_EVIDENCE') {
        weakestStatus = 'INSUFFICIENT_EVIDENCE';
        reasons.push(`${h}-day horizon had no computable forward outcomes.`);
      }
      base.horizons[h] = row;
      continue;
    }
    // Descriptive mirror of computeMatchedForwardOutcomes(h) — always copied.
    row.upPct = o.upPct; row.downPct = o.downPct; row.flatPct = o.flatPct;
    row.averageReturnPct = o.averageReturnPct; row.medianReturnPct = o.medianReturnPct;
    row.bestReturnPct = o.bestReturnPct; row.worstReturnPct = o.worstReturnPct;

    const usable = o.sampleSize;
    if (usable < minSignalSample) {
      if (weakestStatus !== 'INSUFFICIENT_EVIDENCE') {
        weakestStatus = 'INSUFFICIENT_EVIDENCE';
        reasons.push(`${h}-day matched sample (${usable}) below minimum signal sample (${minSignalSample}).`);
      }
      base.horizons[h] = row;
      continue;
    }

    // Direction gate: exact up/down tie ⇒ no direction (never fabricate).
    if (o.upPct == null || o.downPct == null) {
      if (weakestStatus !== 'INSUFFICIENT_EVIDENCE') {
        weakestStatus = 'INSUFFICIENT_EVIDENCE';
        reasons.push(`${h}-day horizon lacked computable up/down rates.`);
      }
      base.horizons[h] = row;
      continue;
    }
    if (o.upPct === o.downPct) {
      if (weakestStatus !== 'INSUFFICIENT_EVIDENCE') {
        weakestStatus = 'INSUFFICIENT_EVIDENCE';
        reasons.push(`${h}-day horizon had an exact up/down tie — no direction emitted.`);
      }
      base.horizons[h] = row;
      continue;
    }

    const direction = o.upPct > o.downPct ? 'up' : 'down';
    const ups = Math.round((o.upPct * usable) / 100);
    const successes = direction === 'up' ? ups : Math.max(0, usable - ups);
    const [lo, hi] = wilsonInterval(successes, usable);
    row.direction = direction;
    row.probabilityPct = Math.max(o.upPct, o.downPct);
    row.wilsonLowPct = lo == null ? null : Number((lo * 100).toFixed(2));
    row.wilsonHighPct = hi == null ? null : Number((hi * 100).toFixed(2));
    base.horizons[h] = row;
  }

  if (weakestStatus !== 'OK') {
    base.status = weakestStatus;
    base.reason = reasons.join(' ');
  }
  return base;
}

/**
 * Orchestrator: retrieve via the EXISTING HistoricalAnalysisController (DI,
 * session-cache aware), then run the pure core. Never throws for input/data
 * issues — returns a NO_DATA contract instead.
 *
 * @param {string} ticker ticker symbol (from watchlist entry / currentSymbol)
 * @param {object} [options]
 * @param {HistoricalAnalysisController} [options.histController] shared boot instance
 * @param {*} [options.api] used to construct a controller when none injected
 * @param {string} [options.depth]
 * @param {number[]} [options.horizons]
 * @param {number} [options.minSignalSample]
 * @param {object} [options.matchOptions]
 * @param {(p: object) => void} [options.onProgress]
 * @param {number} [options.now]
 */
export async function predictCurrentMarketState(ticker, options = {}) {
  const sym = String(ticker || '').toUpperCase().trim();
  const now = options.now != null ? options.now : Date.now();

  if (!sym) {
    return buildPredictionContract({ ticker: '', bars: [], now });
  }

  let histController = options.histController || null;
  if (!histController && options.api) {
    histController = new HistoricalAnalysisController({ api: options.api });
  }
  if (!histController) {
    return buildPredictionContract({ ticker: sym, bars: [], now });
  }

  let result;
  try {
    result = await histController.run({
      ticker: sym,
      depth: options.depth || LIVE_PREDICTION_DEFAULTS.depth,
      onProgress: options.onProgress,
    });
  } catch (err) {
    return buildPredictionContract({
      ticker: sym,
      bars: [],
      now,
      dataset: { stoppedReason: String((err && err.message) || err) },
    });
  }

  const bars = result && Array.isArray(result.bars) ? result.bars : [];
  return buildPredictionContract({
    ticker: sym,
    bars,
    horizons: options.horizons,
    minSignalSample: options.minSignalSample,
    matchOptions: options.matchOptions,
    now,
    dataset: {
      status: result ? result.status : null,
      coverageYears: result ? result.coverageYears ?? null : null,
      quality: result ? result.quality ?? null : null,
      stoppedReason: result ? result.stoppedReason ?? null : null,
      depth: options.depth || LIVE_PREDICTION_DEFAULTS.depth,
    },
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(v, digits = 2) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(
    undefined, { maximumFractionDigits: digits },
  );
}

const STATUS_BADGE_CLASS = {
  OK: 'badge--ok',
  NO_DATA: 'badge--unavailable',
  INSUFFICIENT_HISTORY: 'badge--unavailable',
  INSUFFICIENT_EVIDENCE: 'badge--unavailable',
};

/**
 * Pure HTML renderer (string only, no DOM mutation).
 * @param {object} contract schemaVersion-1 contract from buildPredictionContract
 * @returns {string}
 */
export function renderLivePredictionHtml(contract) {
  if (!contract || contract.schemaVersion !== LIVE_PREDICTION_SCHEMA_VERSION) {
    return `<div class="hint">${escHtml('No live prediction available.')}</div>`;
  }
  const c = contract;
  const badgeCls = STATUS_BADGE_CLASS[c.status] || 'badge--unavailable';
  const parts = [];

  parts.push(`<div><span class="badge ${badgeCls}">${escHtml(c.status)}</span>`
    + ` <strong>${escHtml(c.ticker)}</strong>`
    + (c.reason ? `<div class="hint">Reason: ${escHtml(c.reason)}</div>` : '')
    + `</div>`);

  if (c.dataset && c.dataset.candles) {
    parts.push(`<div class="hint">Dataset: ${escHtml(fmt(c.dataset.candles, 0))} candles`
      + (c.dataset.status ? `, ${escHtml(c.dataset.status)}` : '')
      + (c.dataset.dateRange ? `, range ${escHtml(c.dataset.dateRange)}` : '')
      + (c.dataset.stoppedReason ? `, stopped early (${escHtml(c.dataset.stoppedReason)})` : '')
      + `</div>`);
  }

  if (c.analysis) {
    const a = c.analysis;
    const cond = c.condition || {};
    parts.push(`<div class="hint">Condition (latest bar): `
      + `RSI14 ${escHtml(fmt(cond.rsi14, 1))}, dist SMA20 ${escHtml(fmt(cond.distFromSma20))}%, `
      + `dist EMA21 ${escHtml(fmt(cond.distFromEma21))}%, 1D ret ${escHtml(fmt(cond.return1d))}%, `
      + `5D ret ${escHtml(fmt(cond.return5d))}%, vol5d ${escHtml(fmt(cond.volatility5d))}%, `
      + `streak ${escHtml(fmt(cond.consecutiveUpDown, 0))}, volVsAvg20 ${escHtml(fmt(cond.volumeVsAvg20))}</div>`);
    parts.push(`<div class="hint">Matches: ${escHtml(fmt(a.matchCount, 0))} (${escHtml(a.matchMode)}`
      + `${a.compositeRelaxed ? ', composite relaxed' : ''}), k=${escHtml(fmt(a.kUsed, 0))}`
      + `, sample class: ${escHtml(a.sampleClassification)}</div>`);
    if (Array.isArray(a.topContributingFeatures) && a.topContributingFeatures.length) {
      parts.push(`<div class="hint">Top contributing features: ${
        escHtml(a.topContributingFeatures.map((f) => f.feature).join(', '))}</div>`);
    }
  } else {
    parts.push('<div class="hint">Condition vector unavailable.</div>');
  }

  const rows = Object.keys(c.horizons).length
    ? Object.values(c.horizons).map((h) => {
      const dir = h.direction
        ? escHtml(String(h.direction).toUpperCase())
        : '<span title="not gated in">—</span>';
      return `<tr><td>${escHtml(h.days)}D</td><td>${dir}</td>`
        + `<td>${escHtml(fmt(h.probabilityPct, 2))}%</td>`
        + `<td>[${escHtml(fmt(h.wilsonLowPct, 2))}%, ${escHtml(fmt(h.wilsonHighPct, 2))}%]</td>`
        + `<td>${escHtml(fmt(h.sampleSize, 0))} (${escHtml(h.classification)})</td>`
        + `<td>${escHtml(fmt(h.averageReturnPct))}% / ${escHtml(fmt(h.medianReturnPct))}%</td></tr>`;
    }).join('')
    : '<tr><td colspan="6">—</td></tr>';

  parts.push(`<table style="width:100%;margin-top:8px;">`
    + `<thead><tr><th>Horizon</th><th>Direction</th><th>Probability</th>`
    + `<th>Wilson 95% CI</th><th>Sample</th><th>Avg/Median return</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`);

  parts.push(`<div class="hint">${escHtml(DISCLAIMER)}</div>`);
  return parts.join('\n');
}
