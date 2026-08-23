// prediction-engine.js — Phase 2 Out-of-Sample Walk-Forward Backtest.
//
// Chronological split: older candles form the pattern database, newer candles
// are an out-of-sample test set. For each eligible test date:
//   • features are built POINT-IN-TIME (only data up to that day),
//   • matches are searched ONLY among PRIOR dates,
//   • direction is predicted from matched historical forward outcomes,
//   • compared to the actual forward move.
//
// This is a descriptive out-of-sample evaluation of the Phase 2 pattern
// similarity method — NOT a trading signal or forecast. All computation is
// local; no network calls, no API keys.

import { extractFeatures, normalizeFeatures, weightedDistance,
  FEATURE_NAMES, DEFAULTS } from './pattern-engine.js';
import { median } from './pattern-engine.js';

function pct(n, digits = 2) {
  return n == null ? null : Number((n * 100).toFixed(digits));
}

/**
 * Walk-forward backtest of pattern-matching direction prediction.
 *
 * @param {object} opts
 * @param {Array<{t,o,h,l,c,v}>} opts.bars chronologically sorted daily candles
 * @param {number} [opts.splitRatio] fraction (0..1) of qualifying feature rows
 *        assigned to the in-sample database; the rest are out-of-sample tests.
 * @param {number[]} [opts.horizons] forward horizons evaluated (default [1])
 * @param {number} [opts.maxDistance] match distance threshold
 * @returns {object} aggregate backtest statistics
 */
export function walkForwardBacktest({
  bars,
  splitRatio = 0.7,
  horizons = [1],
  maxDistance = DEFAULTS.MAX_DISTANCE,
  minMatches = DEFAULTS.MIN_MATCHES,
  weights = {},
} = {}) {
  const empty = {
    ok: false,
    predictionsCount: 0, correctCount: 0, accuracyPct: null,
    positiveSignalCount: 0, positiveCorrectCount: 0, positiveAccuracyPct: null,
    negativeSignalCount: 0, negativeCorrectCount: 0, negativeAccuracyPct: null,
    avgReturnAfterPositiveSignalPct: null,
    baselineUpPct: null, baselineAccuracyPct: null,
    improvementOverBaselinePp: null,
    horizons: {},
    splitIndex: null, databaseRows: 0, testRows: 0,
    message: 'No data.',
  };
  if (!bars || bars.length === 0) return empty;

  const rows = extractFeatures(bars);
  // Qualifying indices (complete point-in-time feature vectors).
  const qualifying = [];
  for (const row of rows) {
    if (row && row.features) qualifying.push(row.index);
  }
  if (qualifying.length < 20) {
    return { ...empty, message: 'Not enough qualifying rows for a meaningful split.' };
  }

  // Normalize once; normalization at index i uses only prior rows (no leak).
  const { normalized } = normalizeFeatures(rows);

  // Chronological split over QUALIFYING rows only (fair point-in-time split).
  const splitPos = Math.min(
    qualifying.length - 1,
    Math.max(1, Math.floor(qualifying.length * splitRatio)),
  );
  const dbPositions = new Set(qualifying.slice(0, splitPos));
  const testPositions = qualifying.slice(splitPos);

  const perHorizon = {};
  for (const h of horizons) {
    perHorizon[h] = {
      days: h,
      predictions: 0, correct: 0, accuracyPct: null,
      positiveSignals: 0, positiveCorrect: 0, positiveAccuracyPct: null,
      negativeSignals: 0, negativeCorrect: 0, negativeAccuracyPct: null,
      avgReturnAfterPositivePct: null, medianReturnAfterPositivePct: null,
      actualUps: 0, baselineUpPct: null, baselineAccuracyPct: null,
      improvementOverBaselinePp: null,
      avgMatchCount: null,
    };
  }
  const posRetsByHorizon = Object.fromEntries(horizons.map((h) => [h, []]));

  let dbMaxIdx = -1;
  for (const idx of dbPositions) dbMaxIdx = Math.max(dbMaxIdx, idx);

  for (const testIdx of testPositions) {
    const vec = normalized[testIdx];
    if (!vec || vec.return1d == null) continue;
    // Matches ONLY among PRIOR qualifying dates (strict temporal ordering).
    const matchIndexes = [];
    for (let i = 0; i < testIdx; i += 1) {
      if (!dbPositions.has(i)) continue;
      const mv = normalized[i];
      if (!mv || mv.return1d == null) continue;
      const { distance } = weightedDistance(vec, mv, weights);
      if (Number.isFinite(distance) && distance <= maxDistance) matchIndexes.push(i);
    }
    if (!matchIndexes.length || matchIndexes.length < Math.min(minMatches, 5)) continue;

    for (const h of horizons) {
      const stats = perHorizon[h];
      if (testIdx + h >= bars.length) continue;
      const base = bars[testIdx].c;
      const later = bars[testIdx + h].c;
      if (!(base > 0) || !Number.isFinite(later)) continue;
      const actualRet = later / base - 1;
      const actualDir = actualRet > 0 ? 'up' : actualRet < 0 ? 'down' : 'flat';

      // Predicted direction from majority of matched forward outcomes.
      let ups = 0;
      let downs = 0;
      for (const mi of matchIndexes) {
        if (mi + h >= bars.length) continue;
        const mb = bars[mi].c;
        const ml = bars[mi + h].c;
        if (!(mb > 0) || !Number.isFinite(ml)) continue;
        const r = ml / mb - 1;
        if (r > 0) ups += 1; else if (r < 0) downs += 1;
      }
      const decided = ups > downs ? 'up' : downs > ups ? 'down' : null;
      if (!decided) continue;

      stats.predictions += 1;
      if (decided === actualDir) stats.correct += 1;
      if (decided === 'up') {
        stats.positiveSignals += 1;
        if (actualDir === 'up') stats.positiveCorrect += 1;
        posRetsByHorizon[h].push(actualRet);
      }
      if (decided === 'down') {
        stats.negativeSignals += 1;
        if (actualDir === 'down') stats.negativeCorrect += 1;
      }
      if (actualDir === 'up') stats.actualUps += 1;
    }
  }

  // Finalize aggregates.
  const totalPredictions = horizons.reduce((a, h) => a + perHorizon[h].predictions, 0);
  const totalCorrect = horizons.reduce((a, h) => a + perHorizon[h].correct, 0);
  const result = {
    ...empty,
    ok: true,
    message: null,
    splitRatio,
    splitIndex: dbMaxIdx,
    databaseRows: dbPositions.size,
    testRows: testPositions.length,
    predictionsCount: totalPredictions,
    correctCount: totalCorrect,
    accuracyPct: totalPredictions ? pct(totalCorrect / totalPredictions) : null,
    horizons: {},
  };

  for (const h of horizons) {
    const s = perHorizon[h];
    s.accuracyPct = s.predictions ? pct(s.correct / s.predictions) : null;
    s.positiveAccuracyPct = s.positiveSignals ? pct(s.positiveCorrect / s.positiveSignals) : null;
    s.negativeAccuracyPct = s.negativeSignals ? pct(s.negativeCorrect / s.negativeSignals) : null;
    const posRets = posRetsByHorizon[h];
    if (posRets.length) {
      s.avgReturnAfterPositivePct = pct(posRets.reduce((a, b) => a + b, 0) / posRets.length);
      s.medianReturnAfterPositivePct = pct(median(posRets));
    }
    const totalActual = s.predictions;
    s.baselineUpPct = totalActual ? pct(s.actualUps / totalActual) : null;
    // Baseline strategy: always predict "up" → its accuracy = up rate.
    s.baselineAccuracyPct = s.baselineUpPct;
    s.improvementOverBaselinePp = (s.accuracyPct != null && s.baselineAccuracyPct != null)
      ? Number((s.accuracyPct - s.baselineAccuracyPct).toFixed(2))
      : null;
    result.horizons[h] = s;
  }
  // Aggregate-level baseline from horizon 1 when present.
  const h1 = perHorizon[horizons[0]];
  if (h1 && h1.predictions) {
    result.baselineUpPct = h1.baselineUpPct;
    result.baselineAccuracyPct = h1.baselineAccuracyPct;
    result.improvementOverBaselinePp = h1.improvementOverBaselinePp;
    result.avgReturnAfterPositiveSignalPct = h1.avgReturnAfterPositivePct;
    result.positiveSignalCount = h1.positiveSignals;
    result.positiveCorrectCount = h1.positiveCorrect;
    result.positiveAccuracyPct = h1.positiveAccuracyPct;
    result.negativeSignalCount = h1.negativeSignals;
    result.negativeCorrectCount = h1.negativeCorrect;
    result.negativeAccuracyPct = h1.negativeAccuracyPct;
  }
  return result;
}

// Backwards-compatible named surface from the Phase 4 stub interface.
export const predictionEngine = {
  async predict(_symbol, _horizon) {
    throw new Error('predictionEngine.predict remains out of scope in Phase 2 (use patternEngine.analyze)');
  },
  async backtest(_symbol) {
    throw new Error('predictionEngine.backtest(symbol) is not supported; use walkForwardBacktest({bars})');
  },
  walkForwardBacktest,
};

export default predictionEngine;
