// pattern-engine.js — Phase 2 Pattern Analysis.
//
// Transparent, local-only historical pattern analysis:
//  1. Feature extraction for every candle with sufficient history
//     (strict no-lookahead: each feature uses only data up to that day).
//  2. Identical feature vector for the latest bar = "current condition".
//  3. Similarity via robust z-score normalization (past data only) +
//     weighted Euclidean distance; match count / threshold / min matches /
//     top contributing features fully exposed.
//  4. Forward outcomes (1/3/5/10D) for matched days computed locally from
//     existing OHLCV data — zero extra API calls.
//  5. Honest sample-size classification.
//
// Everything here is HISTORICAL CONDITIONAL FREQUENCY only — never a
// prediction, forecast, or recommendation. No API key is ever referenced.

import { sma, ema, rsi } from './indicators.js';

// Ordered feature names — index alignment matters everywhere below.
export const FEATURE_NAMES = [
  'return1d', 'return3d', 'return5d', 'return10d',
  'bodyPct', 'upperWickPct', 'lowerWickPct', 'highLowRangePct',
  'volume', 'volumeVsAvg20',
  'distFromSma5', 'distFromSma10', 'distFromSma20', 'distFromSma50',
  'distFromEma9', 'distFromEma21',
  'consecutiveUpDown', 'volatility5d', 'volatility10d', 'rsi14',
];

export const DEFAULTS = {
  MAX_DISTANCE: 1.5,   // legacy threshold mode ceiling (z-space)
  MIN_MATCHES: 30,
  HORIZONS: [1, 3, 5, 10],
  VOLUME_AVG_PERIOD: 20,
  // --- Phase 3 selective matching defaults (chosen from measured walk-forward
  // comparisons in scripts/research/compare.mjs; see results JSON) ---
  MATCH_MODE: 'topk',      // 'topk' | 'threshold' | 'composite'
  K_FRACTION: 0.05,        // adaptive K = clamp(round(dbSize * K_FRACTION), ...)
  K_MIN: 40,
  K_MAX: 200,
  PERCENTILE_GATE: 0.05,   // candidate must sit within the p most-similar tail
  MIN_SIGNAL_SAMPLE: 30,   // below this the engine returns NO SIGNAL
};

/**
 * Selective match selection from scored candidates (Phase 3).
 *
 * @param {Array<{index:number,t:number,distance:number}>} candidates
 *        ALL prior qualifying days with finite distance (unsorted ok).
 * @param {object} opts
 * @returns {{matches:Array, matchMode:string, kUsed:number|null,
 *            percentileCutoff:number|null, maxMatchDistance:number|null}}
 */
export function selectMatches(candidates, opts = {}) {
  const {
    matchMode = DEFAULTS.MATCH_MODE,
    kFraction = DEFAULTS.K_FRACTION,
    kMin = DEFAULTS.K_MIN,
    kMax = DEFAULTS.K_MAX,
    maxDistance = null,       // optional hard ceiling applied AFTER ranking
    percentileGate = DEFAULTS.PERCENTILE_GATE,
  } = opts;
  const sorted = candidates.filter((c) => Number.isFinite(c.distance))
    .slice().sort((a, b) => a.distance - b.distance || a.index - b.index);
  if (!sorted.length) {
    return { matches: [], matchMode, kUsed: null, percentileCutoff: null, maxMatchDistance: null };
  }
  let matches;
  let kUsed = null;
  let percentileCutoff = null;
  if (matchMode === 'topk' || matchMode === 'composite') {
    kUsed = Math.max(1, Math.min(kMax, Math.max(kMin, Math.round(sorted.length * kFraction))));
    kUsed = Math.min(kUsed, sorted.length);
    matches = sorted.slice(0, kUsed);
    // Percentile gate on the candidate distance distribution (relative rarity).
    if (percentileGate != null && percentileGate >= 0) {
      const dists = sorted.map((c) => c.distance);
      const cutoffIdx = Math.min(dists.length - 1, Math.floor((dists.length - 1) * percentileGate) + 1);
      percentileCutoff = dists[cutoffIdx];
      matches = matches.filter((m) => m.distance <= percentileCutoff + 1e-12);
      if (!matches.length) matches = [sorted[0]]; // always keep the nearest neighbor
    }
  } else { // legacy threshold mode
    matches = sorted.filter((m) => m.distance <= (maxDistance != null ? maxDistance : DEFAULTS.MAX_DISTANCE));
  }
  if (maxDistance != null && matchMode !== 'threshold') {
    matches = matches.filter((m) => m.distance <= maxDistance);
  }
  return {
    matches,
    matchMode,
    kUsed,
    percentileCutoff,
    maxMatchDistance: matches.length ? matches[matches.length - 1].distance : null,
  };
}

/**
 * Wilson score interval for a binomial proportion (95% by default).
 * @returns {[number,number]} [lower, upper] in 0..1
 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return [null, null];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// Fixed RSI regime bands (no data fitting → no leakage surface).
const RSI_BANDS = [30, 45, 55, 70];
function rsiBand(v) { let b = 0; while (b < RSI_BANDS.length && v > RSI_BANDS[b]) b += 1; return b; }

function quantileEdges(values, qs) {
  const s = values.slice().sort((a, b) => a - b);
  return qs.map((q) => {
    if (!s.length) return null;
    const idx = (s.length - 1) * q;
    const lo = Math.floor(idx); const hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  });
}

function bucketOf(v, edges) {
  let b = 0;
  for (const e of edges) { if (v > e) b += 1; else break; }
  return b;
}

/**
 * Composite condition signature per qualifying index (Phase 3, Improvement 3):
 * a conjunction tuple of discretized regimes. All quantile edges are derived
 * from STRICTLY PRIOR qualifying days only — point-in-time, no leakage.
 *
 * Signature components:
 *   rsi14 band (fixed thresholds), distFromSma20 tercile (prior quantiles),
 *   return5d tercile (prior quantiles), volumeVsAvg20 tercile (prior quantiles),
 *   volatility5d tercile (prior quantiles).
 *
 * @param {Array} featureRows output of extractFeatures(bars)
 * @returns {Array<string|null>} signature string per index (null when not
 *          computable or insufficient prior history).
 */
export function computeCompositeSignatures(featureRows) {
  const n = featureRows.length;
  const out = new Array(n).fill(null);
  const past = { distFromSma20: [], return5d: [], volumeVsAvg20: [], volatility5d: [] };
  for (let i = 0; i < n; i += 1) {
    const row = featureRows[i];
    if (!row || !row.features) continue;
    const f = row.features;
    if (past.distFromSma20.length >= 30) {
      const sig = [
        `rsi${rsiBand(f.rsi14)}`,
        `sma${bucketOf(f.distFromSma20, quantileEdges(past.distFromSma20, [1 / 3, 2 / 3]))}`,
        `r5${bucketOf(f.return5d, quantileEdges(past.return5d, [1 / 3, 2 / 3]))}`,
        `vol${bucketOf(f.volumeVsAvg20, quantileEdges(past.volumeVsAvg20, [1 / 3, 2 / 3]))}`,
        `vlt${bucketOf(f.volatility5d, quantileEdges(past.volatility5d, [1 / 3, 2 / 3]))}`, // prettier-ignore-line
      ].join('|');
      out[i] = sig;
    }
    past.distFromSma20.push(f.distFromSma20);
    past.return5d.push(f.return5d);
    past.volumeVsAvg20.push(f.volumeVsAvg20);
    past.volatility5d.push(f.volatility5d);
  }
  return out;
}

function isFiniteNum(v) {
  return v != null && Number.isFinite(v);
}

// Daily log-free simple returns: ret[i] = c[i]/c[i-1] - 1 (null at i=0).
function dailyReturns(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && isFiniteNum(closes[i])) out[i] = closes[i] / closes[i - 1] - 1;
  }
  return out;
}

// Population standard deviation of the trailing `period` returns ending at i.
function trailingStddev(values, i, period) {
  const vals = [];
  for (let j = Math.max(0, i - period + 1); j <= i; j += 1) {
    if (!isFiniteNum(values[j])) return null;
    vals.push(values[j]);
  }
  if (vals.length < period) return null;
  const m = vals.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / period);
}

// Median of finite numbers (null when empty).
export function median(xs) {
  const vals = xs.filter(isFiniteNum).slice().sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/**
 * Extract the Phase 2 feature vector for every candle that has sufficient
 * history. STRICT NO-LOOKAHEAD: every feature at index i uses only bars[0..i].
 *
 * @param {Array<{t,o,h,l,c,v}>} bars chronologically sorted daily candles
 * @returns {Array<{index:number,t:number,features:Object|null}>}
 *   entries with null features lack enough history (warm-up).
 */
export function extractFeatures(bars) {
  const n = bars.length;
  const out = new Array(n).fill(null).map((_, i) => ({ index: i, t: bars[i].t, features: null }));
  if (n === 0) return out;

  const closes = bars.map((b) => b.c);
  const rets = dailyReturns(closes);
  const sma5 = sma(closes, 5);
  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  // Rolling average volume (trailing, inclusive of current bar).
  const volAvg = new Array(n).fill(null);
  let volSum = 0;
  const volWindow = [];
  for (let i = 0; i < n; i += 1) {
    const v = isFiniteNum(bars[i].v) ? bars[i].v : 0;
    volWindow.push(v); volSum += v;
    if (volWindow.length > DEFAULTS.VOLUME_AVG_PERIOD) volSum -= volWindow.shift();
    if (i >= DEFAULTS.VOLUME_AVG_PERIOD - 1) volAvg[i] = volSum / volWindow.length;
  }
  // Consecutive up/down day streak ending at each index (+up / -down).
  const streak = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const dir = rets[i] > 0 ? 1 : rets[i] < 0 ? -1 : 0;
    if (dir === 0) { streak[i] = 0; continue; }
    const prev = isFiniteNum(rets[i - 1]) ? Math.sign(streak[i - 1]) : 0;
    streak[i] = prev === dir ? streak[i - 1] + dir : dir;
  }

  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const c = b.c;
    // Sufficient history gate: need SMA50 warm-up + 10d lookback + RSI14.
    if (i < 50 || !(c > 0)) continue;

    const rangeHL = b.h - b.l;
    const body = c - b.o;
    const upperWick = b.h - Math.max(b.o, c);
    const lowerWick = Math.min(b.o, c) - b.l;
    const denomOk = rangeHL > 0 && isFiniteNum(rangeHL);

    const dist = (mv) => (isFiniteNum(mv) && mv > 0 && c > 0 ? c / mv - 1 : null);
    const retAt = (k) => (i >= k && isFiniteNum(rets[i - k + 1]) && closes[i - k] > 0 ? closes[i] / closes[i - k] - 1 : null);

    const feats = {
      return1d: retAt(1),
      return3d: retAt(3),
      return5d: retAt(5),
      return10d: retAt(10),
      bodyPct: denomOk ? body / rangeHL : null,
      upperWickPct: denomOk ? upperWick / rangeHL : null,
      lowerWickPct: denomOk ? lowerWick / rangeHL : null,
      highLowRangePct: c > 0 ? rangeHL / c : null,
      volume: isFiniteNum(b.v) ? b.v : null,
      volumeVsAvg20: isFiniteNum(volAvg[i]) && volAvg[i] > 0 && isFiniteNum(b.v) ? b.v / volAvg[i] : null,
      distFromSma5: dist(sma5[i]),
      distFromSma10: dist(sma10[i]),
      distFromSma20: dist(sma20[i]),
      distFromSma50: dist(sma50[i]),
      distFromEma9: dist(ema9[i]),
      distFromEma21: dist(ema21[i]),
      consecutiveUpDown: streak[i],
      volatility5d: trailingStddev(rets, i, 6),
      volatility10d: trailingStddev(rets, i, 11),
      rsi14: isFiniteNum(rsi14[i]) ? rsi14[i] : null,
    };
    // A candle qualifies only when EVERY feature is computable point-in-time.
    let complete = true;
    for (const k of FEATURE_NAMES) {
      if (!isFiniteNum(feats[k])) { complete = false; break; }
    }
    if (complete) out[i].features = feats;
  }
  return out;
}

/**
 * Robust z-score normalization using ONLY PAST data (no leakage): for day i
 * and feature f, center/scale come from median & MAD of all PRIOR qualifying
 * days (indices < i). Falls back to raw 0 when scale is degenerate.
 *
 * @returns {{normalized:Array<Array<number|null>>, mediansByIndex:Array<Object>, madsByIndex:Array<Object>}}
 */
export function normalizeFeatures(featureRows) {
  const n = featureRows.length;
  const normalized = new Array(n).fill(null).map(() => ({}));
  const mediansByIndex = new Array(n).fill(null).map(() => ({}));
  const madsByIndex = new Array(n).fill(null).map(() => ({}));
  // Running per-feature history of past values (only qualifying rows).
  const history = {};
  for (const f of FEATURE_NAMES) history[f] = [];

  for (let i = 0; i < n; i += 1) {
    const row = featureRows[i];
    if (!row || !row.features) { continue; }
    const norm = {};
    for (const f of FEATURE_NAMES) {
      const past = history[f];
      const x = row.features[f];
      if (past.length >= 5) {
        const med = median(past);
        const absDev = past.map((v) => Math.abs(v - med));
        const mad = median(absDev);
        const scale = mad != null && mad > 1e-12 ? 1.4826 * mad : null;
        norm[f] = scale != null ? (x - med) / scale : 0;
        mediansByIndex[i][f] = med;
        madsByIndex[i][f] = mad;
      } else {
        norm[f] = null; // not enough history yet to normalize fairly
        mediansByIndex[i][f] = median(past);
        madsByIndex[i][f] = null;
      }
      history[f].push(x);
    }
    normalized[i] = norm;
  }
  return { normalized, mediansByIndex, madsByIndex };
}

/**
 * Weighted Euclidean distance between two normalized vectors (nulls skipped
 * symmetrically). Returns {distance, contributions} where contributions map
 * feature name -> weighted squared contribution.
 */
export function weightedDistance(a, b, weights = {}) {
  let sumSq = 0;
  let used = 0;
  const contributions = {};
  for (const f of FEATURE_NAMES) {
    const av = a[f];
    const bv = b[f];
    if (av == null || bv == null) continue;
    const w = weights[f] != null ? weights[f] : 1;
    const d = w * (av - bv);
    sumSq += d * d;
    contributions[f] = d * d;
    used += 1;
  }
  const distance = used > 0 ? Math.sqrt(sumSq / used) : Infinity;
  return { distance, contributions };
}

/**
 * Sample-size classification (honest language):
 *   <10   → 'INSUFFICIENT SAMPLE'
 *   10–29 → 'LOW SAMPLE'
 *   30–99 → 'MODERATE SAMPLE'
 *   ≥100  → 'STRONG SAMPLE'
 */
export function classifySampleSize(n) {
  if (n == null || n < 10) return 'INSUFFICIENT SAMPLE';
  if (n < 30) return 'LOW SAMPLE';
  if (n < 100) return 'MODERATE SAMPLE';
  return 'STRONG SAMPLE';
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Forward outcomes for matched days, per horizon, from local OHLCV only.
 */
export function computeMatchedForwardOutcomes(bars, matchIndexes, horizons = DEFAULTS.HORIZONS) {
  const results = {};
  for (const h of horizons) {
    const rets = [];
    for (const i of matchIndexes) {
      if (i + h >= bars.length) continue;
      const base = bars[i].c;
      const later = bars[i + h].c;
      if (!(base > 0) || !Number.isFinite(later)) continue;
      rets.push(later / base - 1);
    }
    const n = rets.length;
    if (n > 0) {
      const ups = rets.filter((r) => r > 0).length;
      const downs = rets.filter((r) => r < 0).length;
      const sorted = rets.slice().sort((a, b) => a - b);
      const avg = rets.reduce((a, b) => a + b, 0) / n;
      results[h] = {
        days: h,
        sampleSize: n,
        classification: classifySampleSize(n),
        upPct: Number(((ups / n) * 100).toFixed(2)),
        downPct: Number(((downs / n) * 100).toFixed(2)),
        flatPct: Number((((n - ups - downs) / n) * 100).toFixed(2)),
        averageReturnPct: Number((avg * 100).toFixed(2)),
        medianReturnPct: Number((percentile(sorted, 0.5) * 100).toFixed(2)),
        bestReturnPct: Number((sorted[n - 1] * 100).toFixed(2)),
        worstReturnPct: Number((sorted[0] * 100).toFixed(2)),
      };
    } else {
      results[h] = {
        days: h, sampleSize: 0, classification: classifySampleSize(0),
        upPct: null, downPct: null, flatPct: null,
        averageReturnPct: null, medianReturnPct: null,
        bestReturnPct: null, worstReturnPct: null,
      };
    }
  }
  return results;
}

/**
 * Full transparent pattern analysis against the LATEST bar.
 * All computation is local; no network calls.
 *
 * Phase 3 additions: selective matching (matchMode 'topk' default with an
 * adaptive-K + percentile gate; 'threshold' keeps legacy behavior;
 * 'composite' uses discretized multi-feature conjunction signatures and can
 * relax to topk when too few identical-signature days exist), activeFeatures
 * subsetting (ablation), and honest sample-size metadata on every horizon.
 *
 * @param {object} opts
 * @param {Array} opts.bars chronologically sorted daily candles
 * @param {string} [opts.matchMode] 'topk' | 'threshold' | 'composite'
 * @param {number} [opts.maxDistance] similarity threshold ('threshold' mode only)
 * @param {number} [opts.kFraction] adaptive-K fraction of database size
 * @param {number} [opts.percentileGate] relative-rarity cutoff p (topk/composite)
 * @param {number} [opts.minMatches] minimum desired matches (~30)
 * @param {number[]} [opts.horizons]
 * @param {string[]} [opts.activeFeatures] subset of FEATURE_NAMES to use
 * @param {Object<string,number>} [opts.weights] per-feature weights
 */
export function analyzePattern({
  bars,
  matchMode = DEFAULTS.MATCH_MODE,
  maxDistance = DEFAULTS.MAX_DISTANCE,
  kFraction = DEFAULTS.K_FRACTION,
  kMin = DEFAULTS.K_MIN,
  kMax = DEFAULTS.K_MAX,
  percentileGate = DEFAULTS.PERCENTILE_GATE,
  minMatches = DEFAULTS.MIN_MATCHES,
  horizons = DEFAULTS.HORIZONS,
  activeFeatures = null,
  weights = {},
} = {}) {
  if (!bars || bars.length === 0) {
    return { ok: false, reason: 'NO_DATA', message: 'No candles available for pattern analysis.' };
  }
  const rows = extractFeatures(bars);
  const latestRow = rows[bars.length - 1];
  if (!latestRow || !latestRow.features) {
    return { ok: false, reason: 'INSUFFICIENT_HISTORY', message: 'Latest candle lacks sufficient history for a complete condition vector.' };
  }
  const { normalized } = normalizeFeatures(rows);
  const currentVector = normalized[bars.length - 1];

  // Effective weights: zero-out inactive features (ablation support) so that
  // normalization statistics stay untouched but excluded features cannot
  // contribute to distance.
  const effWeights = { ...weights };
  const usedFeatures = activeFeatures != null ? activeFeatures : FEATURE_NAMES;
  for (const f of FEATURE_NAMES) {
    if (!usedFeatures.includes(f)) effWeights[f] = 0;
  }

  // Candidates: every PRIOR qualifying day with a finite distance.
  const candidates = [];
  const contributionsAccum = {};
  for (let i = 0; i < bars.length - 1; i += 1) {
    const vec = normalized[i];
    if (!vec || vec.return1d == null) continue;
    const { distance, contributions } = weightedDistance(currentVector, vec, effWeights);
    if (!Number.isFinite(distance)) continue;
    candidates.push({ index: i, t: rows[i].t, distance });
  }

  // Composite mode: prefer identical-signature prior days; fall back to top-K
  // when the identical-signature sample is too small.
  let selection = selectMatches(candidates, {
    matchMode, maxDistance, kFraction, kMin, kMax, percentileGate,
  });
  let compositeSignature = null;
  let compositeRelaxed = false;
  if (matchMode === 'composite') {
    const signatures = computeCompositeSignatures(rows);
    compositeSignature = signatures[bars.length - 1];
    const sameSig = signatures
      .map((sig, i) => ({ index: i, t: rows[i].t, sig }))
      .filter((x) => x.sig != null && x.sig === compositeSignature && x.index < bars.length - 1);
    if (sameSig.length >= minMatches) {
      const candByIndex = new Map(candidates.map((c) => [c.index, c]));
      selection = {
        matches: sameSig.map((x) => candByIndex.get(x.index)).filter(Boolean)
          .sort((a, b) => a.distance - b.distance),
        matchMode: 'composite', kUsed: sameSig.length,
        percentileCutoff: null, maxMatchDistance: null,
      };
    } else {
      compositeRelaxed = true;
    }
  }
  const matchRows = selection.matches;
  for (const m of matchRows) {
    const vec = normalized[m.index];
    const { contributions } = weightedDistance(currentVector, vec, effWeights);
    for (const f of usedFeatures) {
      if (contributions[f] != null) {
        contributionsAccum[f] = (contributionsAccum[f] || 0) + contributions[f];
      }
    }
  }

  // Top contributing features: highest average weighted squared deviation
  // among matched days (what most drives the similarity).
  const topContributingFeatures = Object.entries(contributionsAccum)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([feature, total]) => ({
      feature,
      avgWeightedSquaredDiff: Number((total / Math.max(1, matchRows.length)).toFixed(6)),
    }));

  const matchIndexes = matchRows.map((m) => m.index);
  const forwardOutcomes = computeMatchedForwardOutcomes(bars, matchIndexes, horizons);

  return {
    ok: true,
    condition: latestRow.features,
    conditionTime: latestRow.t,
    matches: matchRows,
    matchCount: matchRows.length,
    matchMode: selection.matchMode,
    kUsed: selection.kUsed,
    percentileCutoff: selection.percentileCutoff,
    maxMatchDistance: selection.maxMatchDistance,
    compositeSignature,
    compositeRelaxed,
    activeFeatures: usedFeatures.slice(),
    threshold: maxDistance,
    minMatches,
    meetsMinMatches: matchRows.length >= minMatches,
    sampleClassification: classifySampleSize(matchRows.length),
    topContributingFeatures,
    forwardOutcomes,
  };
}

// Backwards-compatible named surface (kept from the Phase 3 stub interface,
// now implemented locally without any network dependency).
export const patternEngine = {
  async buildProfile(symbol, bars) {
    if (!Array.isArray(bars)) throw new Error('patternEngine.buildProfile requires local bars');
    return { symbol, rows: extractFeatures(bars) };
  },
  async matchPattern(_symbol, opts) {
    return analyzePattern(opts);
  },
  analyze: analyzePattern,
};

export default patternEngine;
