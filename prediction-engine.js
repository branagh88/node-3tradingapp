// prediction-engine.js — Phase 3 Out-of-Sample Walk-Forward Backtest.
//
// Chronological walk-forward evaluation with NO-SIGNAL gating:
//   • features are built POINT-IN-TIME (only data up to that day),
//   • matches are searched ONLY among PRIOR database dates,
//   • selective matching (adaptive top-K + percentile gate by default),
//   • if the qualifying-match sample is below MIN_SIGNAL_SAMPLE the engine
//     emits NO SIGNAL for that date instead of a forced 51/49 prediction,
//   • direction from matched forward outcomes; probability = matched up-rate
//     with a Wilson 95% CI,
//   • three simple baselines (dominant direction / always-up / momentum)
//     computed on exactly the same test rows.
//
// Parameter search (walkForwardParameterSearch) uses a strict chronological
// TRAIN → VALIDATION → TEST scheme: grid configurations are scored ONLY on
// validation data and the winner is evaluated ONCE on test data.
//
// Descriptive historical evaluation — NOT a trading signal or forecast.
// All computation is local; no network calls, no API keys.

import {
  extractFeatures, normalizeFeatures, weightedDistance, selectMatches,
  wilsonInterval, computeCompositeSignatures, FEATURE_NAMES, DEFAULTS, median,
} from './pattern-engine.js';

function pct(n, digits = 2) {
  return n == null ? null : Number((n * 100).toFixed(digits));
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function maxAdverseExcursion(bars, idx, h) {
  // Worst low-vs-entry drawdown over the h days AFTER entry (label-only info).
  const entry = bars[idx].c;
  if (!(entry > 0)) return null;
  let worst = 0;
  for (let j = idx + 1; j <= Math.min(idx + h, bars.length - 1); j += 1) {
    if (Number.isFinite(bars[j].l)) worst = Math.min(worst, bars[j].l / entry - 1);
  }
  return worst;
}

function emptyHorizonStats(h) {
  return {
    days: h,
    eligibleRows: 0,           // test rows with a known h-day outcome
    predictions: 0, correct: 0, accuracyPct: null,
    upSignals: 0, downSignals: 0, noSignals: 0,
    coveragePct: null,
    positiveSignals: 0, positiveCorrect: 0, positiveAccuracyPct: null,
    negativeSignals: 0, negativeCorrect: 0, negativeAccuracyPct: null,
    avgReturnAfterPositivePct: null, medianReturnAfterPositivePct: null,
    avgMatchCount: null, medianMatchCount: null,
    wilsonLowPct: null, wilsonHighPct: null,
    avgAdverseExcursionPct: null,
    actualUps: 0,
    baselineDominantAccuracyPct: null,
    baselineUpPct: null, baselineAlwaysUpAccuracyPct: null,
    baselineMomentumAccuracyPct: null,
    edgeVsBestBaselinePp: null, beatsBaselines: null,
  };
}

function finalizeHorizon(s) {
  s.accuracyPct = s.predictions ? pct(s.correct / s.predictions) : null;
  s.coveragePct = s.eligibleRows ? pct((s.upSignals + s.downSignals) / s.eligibleRows) : null;
  s.positiveAccuracyPct = s.positiveSignals ? pct(s.positiveCorrect / s.positiveSignals) : null;
  s.negativeAccuracyPct = s.negativeSignals ? pct(s.negativeCorrect / s.negativeSignals) : null;
  const nSig = s.upSignals + s.downSignals;
  if (s.upSignals) {
    const [lo, hi] = wilsonInterval(s.positiveCorrect, s.upSignals);
    s.wilsonLowPct = pct(lo); s.wilsonHighPct = pct(hi);
  }
  const baselines = [
    s.baselineDominantAccuracyPct,
    s.baselineAlwaysUpAccuracyPct,
    s.baselineMomentumAccuracyPct,
  ].filter((v) => v != null);
  const bestBaseline = baselines.length ? Math.max(...baselines) : null;
  s.edgeVsBestBaselinePp = (s.accuracyPct != null && bestBaseline != null)
    ? Number((s.accuracyPct - bestBaseline).toFixed(2))
    : null;
  s.beatsBaselines = s.edgeVsBestBaselinePp != null && s.edgeVsBestBaselinePp > 0
    && nSig >= DEFAULTS.MIN_SIGNAL_SAMPLE;
  return s;
}

/**
 * Walk-forward backtest with selective matching and NO-SIGNAL gating.
 *
 * @param {object} opts
 * @param {Array<{t,o,h,l,c,v}>} opts.bars chronologically sorted daily candles
 * @param {number} [opts.splitRatio] fraction of qualifying rows in the database
 * @param {number[]} [opts.horizons] forward horizons (default [1])
 * @param {string} [opts.matchMode] 'topk' | 'threshold' | 'composite'
 * @param {number} [opts.maxDistance] threshold-mode ceiling
 * @param {number} [opts.kFraction] adaptive-K fraction (topk/composite fallback)
 * @param {number} [opts.percentileGate]
 * @param {number} [opts.minMatches] minimum DB matches to consider a date at all
 * @param {number} [opts.minSignalSample] matched sample below this ⇒ NO SIGNAL
 * @param {boolean} [opts.requireEdge] if true, also emit NONE/'NO_EDGE' when the
 *        Wilson CI on the up-rate contains 50% (stricter signal definition)
 * @param {string[]} [opts.activeFeatures] feature subset for ablations
 * @returns {object} aggregate out-of-sample statistics
 */
export function walkForwardBacktest({
  bars,
  splitRatio = 0.7,
  horizons = [1],
  matchMode = DEFAULTS.MATCH_MODE,
  maxDistance = DEFAULTS.MAX_DISTANCE,
  kFraction = DEFAULTS.K_FRACTION,
  kMin = DEFAULTS.K_MIN,
  kMax = DEFAULTS.K_MAX,
  percentileGate = DEFAULTS.PERCENTILE_GATE,
  minMatches = 10,
  minSignalSample = DEFAULTS.MIN_SIGNAL_SAMPLE,
  requireEdge = false,
  activeFeatures = null,
  weights = {},
} = {}) {
  const empty = {
    ok: false,
    predictionsCount: 0, correctCount: 0, accuracyPct: null,
    positiveSignalCount: 0, positiveCorrectCount: 0, positiveAccuracyPct: null,
    negativeSignalCount: 0, negativeCorrectCount: 0, negativeAccuracyPct: null,
    noSignalCount: 0, coveragePct: null,
    avgReturnAfterPositiveSignalPct: null,
    baselineDominantAccuracyPct: null,
    baselineUpPct: null, baselineAlwaysUpAccuracyPct: null,
    baselineMomentumAccuracyPct: null,
    improvementOverBaselinePp: null, edgeVsBestBaselinePp: null,
    beatsBaselines: null,
    horizons: {}, splitIndex: null, databaseRows: 0, testRows: 0,
    message: 'No data.',
  };
  if (!bars || bars.length === 0) return empty;

  const rows = extractFeatures(bars);
  const qualifying = [];
  for (const row of rows) if (row && row.features) qualifying.push(row.index);
  if (qualifying.length < 20) {
    return { ...empty, message: 'Not enough qualifying rows for a meaningful split.' };
  }

  // Normalize once; normalization at index i uses only prior rows (no leak).
  const { normalized } = normalizeFeatures(rows);
  const signatures = matchMode === 'composite' ? computeCompositeSignatures(rows) : null;

  const effWeights = { ...weights };
  const usedFeatures = activeFeatures != null ? activeFeatures : FEATURE_NAMES;
  for (const f of FEATURE_NAMES) if (!usedFeatures.includes(f)) effWeights[f] = 0;

  // Chronological split over QUALIFYING rows only (fair point-in-time split).
  const splitPos = Math.min(
    qualifying.length - 1,
    Math.max(1, Math.floor(qualifying.length * splitRatio)),
  );
  const dbPositions = qualifying.slice(0, splitPos);
  const dbSet = new Set(dbPositions);
  const testPositions = qualifying.slice(splitPos);

  // Baseline A needs the historically dominant direction from PAST data only.
  let pastUps = 0;
  for (const idx of dbPositions) {
    if (idx > 0 && bars[idx].c > bars[idx - 1].c) pastUps += 1;
  }
  const dominantDir = pastUps >= dbPositions.length / 2 ? 'up' : 'down';

  const perHorizon = Object.fromEntries(horizons.map((h) => [h, emptyHorizonStats(h)]));
  const posRetsByHorizon = Object.fromEntries(horizons.map((h) => [h, []]));
  const adverseByHorizon = Object.fromEntries(horizons.map((h) => [h, []]));
  const matchCounts = [];

  for (const testIdx of testPositions) {
    const vec = normalized[testIdx];
    if (!vec || vec.return1d == null) continue;

    // Candidates strictly among PRIOR database dates.
    const candidates = [];
    for (const i of dbPositions) {
      const mv = normalized[i];
      if (!mv || mv.return1d == null) continue;
      const { distance } = weightedDistance(vec, mv, effWeights);
      if (Number.isFinite(distance)) candidates.push({ index: i, t: rows[i].t, distance });
    }

    let selected;
    if (matchMode === 'composite' && signatures[testIdx]) {
      const candByIndex = new Map(candidates.map((c) => [c.index, c]));
      const sameSig = [];
      for (let i = 0; i < testIdx; i += 1) {
        if (!dbSet.has(i) || signatures[i] == null) continue;
        if (signatures[i] === signatures[testIdx]) {
          const c = candByIndex.get(i);
          if (c) sameSig.push(c);
        }
      }
      selected = sameSig.length >= minMatches
        ? { matches: sameSig.sort((a, b) => a.distance - b.distance), matchMode: 'composite', kUsed: sameSig.length }
        : selectMatches(candidates, { matchMode: 'topk', maxDistance, kFraction, kMin, kMax, percentileGate });
    } else {
      selected = selectMatches(candidates, {
        matchMode, maxDistance, kFraction, kMin, kMax, percentileGate,
      });
    }

    const matches = selected.matches || [];
    matchCounts.push(matches.length);

    // Forward outcomes per horizon for this test date.
    for (const h of horizons) {
      const stats = perHorizon[h];
      if (testIdx + h >= bars.length) continue;
      const base = bars[testIdx].c;
      const later = bars[testIdx + h].c;
      if (!(base > 0) || !Number.isFinite(later)) continue;
      stats.eligibleRows += 1;
      const actualRet = later / base - 1;
      const actualDir = actualRet > 0 ? 'up' : actualRet < 0 ? 'down' : 'flat';
      if (actualDir === 'up') stats.actualUps += 1;

      // Matched forward outcomes (labels — used only as historical evidence).
      let ups = 0;
      let downs = 0;
      let usable = 0;
      for (const m of matches) {
        if (m.index + h >= bars.length) continue;
        const mb = bars[m.index].c;
        const ml = bars[m.index + h].c;
        if (!(mb > 0) || !Number.isFinite(ml)) continue;
        usable += 1;
        const r = ml / mb - 1;
        if (r > 0) ups += 1; else if (r < 0) downs += 1;
      }
      stats.avgMatchCount = stats.avgMatchCount == null ? usable : (stats.avgMatchCount * (stats.predictions + stats.noSignals) + usable) / (stats.predictions + stats.noSignals + 1);

      // --- NO-SIGNAL GATE -------------------------------------------------
      const decidedRaw = ups > downs ? 'up' : downs > ups ? 'down' : null;
      let decided = decidedRaw;
      let gatedReason = null;
      if (usable < minSignalSample) {
        decided = null;
        gatedReason = 'INSUFFICIENT_SAMPLE';
      } else if (requireEdge) {
        const [lo, hi] = wilsonInterval(ups, ups + downs);
        if (lo <= 0.5 && hi >= 0.5) { decided = null; gatedReason = 'NO_EDGE'; }
      }
      if (!decided) {
        stats.noSignals += 1;
        continue;
      }

      stats.predictions += 1;
      if (decided === actualDir) stats.correct += 1;
      if (decided === 'up') {
        stats.upSignals += 1;
        stats.positiveSignals += 1;
        if (actualDir === 'up') stats.positiveCorrect += 1;
        posRetsByHorizon[h].push(actualRet);
        const mae = maxAdverseExcursion(bars, testIdx, h);
        if (mae != null) adverseByHorizon[h].push(mae);
      }
      if (decided === 'down') {
        stats.downSignals += 1;
        stats.negativeSignals += 1;
        if (actualDir === 'down') stats.negativeCorrect += 1;
      }
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
    splitIndex: dbPositions[dbPositions.length - 1],
    databaseRows: dbPositions.length,
    testRows: testPositions.length,
    predictionsCount: totalPredictions,
    correctCount: totalCorrect,
    accuracyPct: totalPredictions ? pct(totalCorrect / totalPredictions) : null,
    matchMode,
    config: { matchMode, kFraction, kMin, kMax, percentileGate, maxDistance, minSignalSample, requireEdge, activeFeatures: usedFeatures.slice() },
    horizons: {},
  };
  result.medianMatchCount = matchCounts.length ? Number(median(matchCounts).toFixed(1)) : null;

  for (const h of horizons) {
    const s = perHorizon[h];
    const elig = s.eligibleRows;
    // Baselines must be set BEFORE finalizeHorizon so edge math includes them.
    s.baselineDominantAccuracyPct = elig
      ? pct(dominantDir === 'up' ? s.actualUps / elig : (elig - s.actualUps) / elig) : null;
    s.baselineUpPct = elig ? pct(s.actualUps / elig) : null;
    s.baselineAlwaysUpAccuracyPct = s.baselineUpPct;
    const fin = finalizeHorizon(s);
    const posRets = posRetsByHorizon[h];
    if (posRets.length) {
      fin.avgReturnAfterPositivePct = pct(mean(posRets));
      fin.medianReturnAfterPositivePct = pct(median(posRets));
    }
    const adv = adverseByHorizon[h];
    if (adv.length) fin.avgAdverseExcursionPct = pct(mean(adv));
    // Momentum baseline C: predict sign of trailing 5d return per test row.
    let momTotal = 0; let momCorrect = 0;
    for (const testIdx of testPositions) {
      if (testIdx + h >= bars.length) continue;
      const f = rows[testIdx].features;
      if (!f) continue;
      momTotal += 1;
      const pred = f.return5d > 0 ? 'up' : f.return5d < 0 ? 'down' : null;
      const actualRet = bars[testIdx + h].c / bars[testIdx].c - 1;
      const actualDir = actualRet > 0 ? 'up' : actualRet < 0 ? 'down' : 'flat';
      if (pred && pred !== 'flat' && pred === actualDir) momCorrect += 1;
    }
    fin.baselineMomentumAccuracyPct = momTotal ? pct(momCorrect / momTotal) : null;
    // Recompute edge now that all three baselines are known.
    {
      const bs = [fin.baselineDominantAccuracyPct, fin.baselineAlwaysUpAccuracyPct,
        fin.baselineMomentumAccuracyPct].filter((v) => v != null);
      fin.edgeVsBestBaselinePp = (bs.length && fin.accuracyPct != null)
        ? Number((fin.accuracyPct - Math.max(...bs)).toFixed(2)) : null;
      fin.beatsBaselines = fin.edgeVsBestBaselinePp != null && fin.edgeVsBestBaselinePp > 0
        && (fin.upSignals + fin.downSignals) >= DEFAULTS.MIN_SIGNAL_SAMPLE;
    }
    result.horizons[h] = fin;
  }

  // Aggregate-level summary from horizon 1 when present.
  const h1 = result.horizons[horizons[0]];
  if (h1) {
    result.baselineDominantAccuracyPct = h1.baselineDominantAccuracyPct;
    result.baselineUpPct = h1.baselineUpPct;
    result.baselineAlwaysUpAccuracyPct = h1.baselineAlwaysUpAccuracyPct;
    result.baselineMomentumAccuracyPct = h1.baselineMomentumAccuracyPct;
    result.improvementOverBaselinePp = h1.edgeVsBestBaselinePp;
    result.edgeVsBestBaselinePp = h1.edgeVsBestBaselinePp;
    result.beatsBaselines = h1.beatsBaselines;
    result.avgReturnAfterPositiveSignalPct = h1.avgReturnAfterPositivePct;
    result.positiveSignalCount = h1.positiveSignals;
    result.positiveCorrectCount = h1.positiveCorrect;
    result.positiveAccuracyPct = h1.positiveAccuracyPct;
    result.negativeSignalCount = h1.negativeSignals;
    result.negativeCorrectCount = h1.negativeCorrect;
    result.negativeAccuracyPct = h1.negativeAccuracyPct;
    result.noSignalCount = h1.noSignals;
    result.coveragePct = h1.coveragePct;
    result.wilsonLowPct = h1.wilsonLowPct;
    result.wilsonHighPct = h1.wilsonHighPct;
  }
  result.modelScore = modelScore(result, horizons[0]);
  return result;
}

/**
 * Walk-forward parameter selection (Improvement 8): strict chronological
 * TRAIN (~60% of qualifying rows, oldest) → VALIDATION (next ~20%) → TEST
 * (final ~20%). Each grid configuration is scored on VALIDATION rows only;
 * the single best configuration is then evaluated ONCE on TEST rows.
 * Test performance never influences parameter choice.
 *
 * @param {object} opts same as walkForwardBacktest plus:
 * @param {Array<object>} [opts.grid] list of partial configs to try
 * @param {number[]} [opts.horizons] scored at horizons[0] during selection
 * @returns {object} { chosen, validationScores, test, paramSearchSkipped, note }
 */
export function walkForwardParameterSearch({
  bars,
  grid = [
    { matchMode: 'threshold', maxDistance: 1.5 },
    { matchMode: 'topk', kFraction: 0.05 },
    { matchMode: 'topk', kFraction: 0.02 },
    { matchMode: 'topk', kFraction: 0.10 },
    { matchMode: 'composite' },
  ],
  trainFrac = 0.6,
  valFrac = 0.2,
  horizons = [1],
} = {}) {
  if (!bars || bars.length < 80) {
    return {
      paramSearchSkipped: true,
      note: 'Dataset too small for train/validation/test parameter search; conservative defaults used.',
      chosen: { matchMode: DEFAULTS.MATCH_MODE, kFraction: DEFAULTS.K_FRACTION },
      validationScores: [],
      test: walkForwardBacktest({ bars, horizons }),
    };
  }
  const rows = extractFeatures(bars);
  const qualifying = rows.filter((r) => r.features).length;
  if (qualifying < 150) {
    return {
      paramSearchSkipped: true,
      note: `Only ${qualifying} qualifying rows (<150); parameter search skipped, conservative defaults used.`,
      chosen: { matchMode: DEFAULTS.MATCH_MODE, kFraction: DEFAULTS.K_FRACTION },
      validationScores: [],
      test: walkForwardBacktest({ bars, horizons }),
    };
  }

  // Score each candidate on a TRAIN→VALIDATION sub-run: run the backtest on
  // bars truncated at the end of validation; its internal splitRatio places
  // the DB inside train and the "test" rows inside validation only. This keeps
  // every scoring decision strictly before the real TEST segment.
  const allQ = [];
  for (const r of rows) if (r.features) allQ.push(r.index);
  const valStartPos = Math.floor(allQ.length * trainFrac);
  const testStartPos = Math.floor(allQ.length * (trainFrac + valFrac));
  const valEndBarIdx = allQ[Math.max(0, testStartPos - 1)]; // last bar of validation segment

  const validationScores = grid.map((cfg) => {
    const truncated = bars.slice(0, valEndBarIdx + 1);
    const bt = walkForwardBacktest({ bars: truncated, horizons, splitRatio: trainFrac / (trainFrac + valFrac), ...cfg });
    const hs = bt.horizons[horizons[0]] || {};
    return {
      cfg,
      validationAccuracyPct: hs.accuracyPct ?? null,
      validationEdgeVsBestBaselinePp: hs.edgeVsBestBaselinePp ?? null,
      validationCoveragePct: hs.coveragePct ?? null,
      validationSignals: (hs.upSignals || 0) + (hs.downSignals || 0),
    };
  });

  // Selection criterion: validation directional accuracy where coverage is
  // non-trivial (≥ 25 signals); ties broken by edge vs baselines.
  const scored = validationScores
    .filter((v) => v.validationAccuracyPct != null)
    .sort((a, b) => {
      const covA = a.validationSignals >= 25 ? 1 : 0;
      const covB = b.validationSignals >= 25 ? 1 : 0;
      if (covA !== covB) return covB - covA;
      if (b.validationAccuracyPct !== a.validationAccuracyPct) {
        return b.validationAccuracyPct - a.validationAccuracyPct;
      }
      return (b.validationEdgeVsBestBaselinePp || 0) - (a.validationEdgeVsBestBaselinePp || 0);
    });
  const chosen = (scored[0] || { cfg: {} }).cfg;

  // Freeze chosen params; evaluate ONCE on the full series with the standard
  // 70/30 split so that TEST rows lie strictly after everything used above.
  const test = walkForwardBacktest({ bars, horizons, ...chosen });
  return {
    paramSearchSkipped: false,
    note: 'Parameters chosen solely on the validation segment (chronologically before test); test evaluated once.',
    scheme: { trainFrac, valFrac, testFrac: 1 - trainFrac - valFrac },
    chosen,
    validationScores,
    test,
  };
}

/**
 * Honest model-quality score (Improvement 9): separate from raw probability.
 * Confidence derives from signal sample size AND a positive out-of-sample
 * edge versus the best simple baseline AND a Wilson CI that excludes the
 * baseline — never from the raw percentage alone.
 */
export function modelScore(bt, h = 1) {
  if (!bt || !bt.ok) return null;
  const s = bt.horizons[h];
  if (!s) return null;
  const signals = (s.upSignals || 0) + (s.downSignals || 0);
  const ciExcludesBaseline = s.wilsonLowPct != null && s.edgeVsBestBaselinePp != null
    && (s.wilsonLowPct > s.baselineAlwaysUpAccuracyPct || s.wilsonHighPct < s.baselineAlwaysUpAccuracyPct);
  const positiveEdge = s.edgeVsBestBaselinePp != null && s.edgeVsBestBaselinePp >= 3;
  let confidence = 'LOW';
  if (signals >= 100 && positiveEdge && ciExcludesBaseline) confidence = 'HIGH';
  else if (signals >= DEFAULTS.MIN_SIGNAL_SAMPLE && positiveEdge) confidence = 'MODERATE';
  const oosValidationStatus = !positiveEdge ? 'INCONCLUSIVE'
    : (ciExcludesBaseline && signals >= DEFAULTS.MIN_SIGNAL_SAMPLE ? 'POSITIVE' : 'WEAK');
  return {
    horizonDays: h,
    signalCount: signals,
    accuracyPct: s.accuracyPct,
    baselineBestPct: s.edgeVsBestBaselinePp == null ? null
      : Number(((s.accuracyPct ?? 0) - s.edgeVsBestBaselinePp).toFixed(2)),
    observedEdgePp: s.edgeVsBestBaselinePp,
    beatsBaselines: s.beatsBaselines,
    oosValidationStatus,
    confidence,
    note: positiveEdge
      ? `Out-of-sample directional edge of ${s.edgeVsBestBaselinePp} pp over the best simple baseline.`
      : 'No meaningful out-of-sample edge versus simple baselines.',
  };
}

// Backwards-compatible named surface from the Phase 4 stub interface.
export const predictionEngine = {
  async predict(_symbol, _horizon) {
    throw new Error('predictionEngine.predict remains out of scope (use patternEngine.analyze)');
  },
  async backtest(_symbol) {
    throw new Error('predictionEngine.backtest(symbol) is not supported; use walkForwardBacktest({bars})');
  },
  walkForwardBacktest,
};

export default predictionEngine;
