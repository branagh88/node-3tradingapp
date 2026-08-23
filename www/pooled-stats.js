// pooled-stats.js — Browser-safe pooled statistics (Phase 5/6 extraction).
//
// Extracted VERBATIM (where possible) from scripts/research/run-pooled-validation.mjs
// and scripts/research/run-real-validation.mjs so the browser can import the same
// math without pulling in `node:` builtins. The research runners re-export these
// functions, so existing tests stay green with zero edits.
//
// Pure functions only: no DOM access, no network access, no side effects.
// This module NEVER references or logs any API key or credential.

function pct(n, d = 2) { return n == null ? null : Number((n * 100).toFixed(d)); }

/**
 * Deterministic seeded PRNG (mulberry32). Fully deterministic across runs —
 * required for reproducible bootstrap confidence intervals.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wilson 95% score interval → [loFrac, hiFrac]. */
export function wilsonInterval(correct, n) {
  if (!(n > 0)) return [null, null];
  const z = 1.959963984540054;
  const p = correct / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Abramowitz–Stegun erf approximation. */
export function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-x * x);
  return s * y;
}

export function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

/**
 * Two-sided two-proportion z-test (normal approximation). Returns p-value.
 */
export function zTestTwoProportions(k1, n1, k2, n2) {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = k1 / n1; const p2 = k2 / n2;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(se) || se === 0) return null;
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z: Number(z.toFixed(4)), pValue: Number(pValue.toFixed(5)) };
}

/**
 * Pool per-horizon stats across tickers. Each input cell is one ticker's
 * out-of-sample test-row aggregate from walkForwardParameterSearch.test.horizons[h].
 * Model accuracy pools signaled predictions; baselines pool eligibility-weighted
 * per-ticker baseline rates (so tickers contribute proportionally to their test rows).
 *
 * @param {Array<object>} cells per-ticker horizon cells (nulls ignored)
 * @param {{ minSignalSample?: number }} [opts] injectable verdict threshold.
 *   Default 30 = pattern-engine DEFAULTS.MIN_SIGNAL_SAMPLE. Callers that need
 *   the live value pass it explicitly; default behavior matches Phase 5.
 * Pure function — unit-testable.
 */
export function poolHorizonCells(cells, { minSignalSample = 30 } = {}) {
  const usable = cells.filter((c) => c && Number.isFinite(c.predictions) && c.predictions >= 0);
  const predictions = usable.reduce((a, c) => a + (c.correct != null ? c.predictions : 0), 0);
  const correct = usable.reduce((a, c) => a + (c.correct ?? 0), 0);
  const upSignals = usable.reduce((a, c) => a + (c.upSignals || 0), 0);
  const downSignals = usable.reduce((a, c) => a + (c.downSignals || 0), 0);
  const noSignals = usable.reduce((a, c) => a + (c.noSignals || 0), 0);
  const eligibleRows = usable.reduce((a, c) => a + (c.eligibleRows || 0), 0);

  // Eligibility-weighted pooled baselines.
  function poolBaseline(key) {
    let w = 0; let acc = 0;
    for (const c of usable) {
      const rate = c[key];
      const elig = c.eligibleRows || 0;
      if (rate == null || !(elig > 0)) continue;
      w += elig; acc += (rate / 100) * elig;
    }
    return w ? pct(acc / w) : null;
  }
  const baselineDominantAccuracyPct = poolBaseline('baselineDominantAccuracyPct');
  const baselineAlwaysUpAccuracyPct = poolBaseline('baselineAlwaysUpAccuracyPct');
  const baselineMomentumAccuracyPct = poolBaseline('baselineMomentumAccuracyPct');

  const signals = predictions; // every recorded prediction was a signal
  const accuracyPct = predictions ? pct(correct / predictions) : null;
  const [loFrac, hiFrac] = wilsonInterval(correct, predictions);
  const bestBase = [baselineDominantAccuracyPct, baselineAlwaysUpAccuracyPct,
    baselineMomentumAccuracyPct].filter((v) => v != null);
  const bestBaselinePct = bestBase.length ? Math.max(...bestBase) : null;

  let significance = null;
  if (predictions > 0 && bestBaselinePct != null) {
    const t = zTestTwoProportions(
      correct, predictions,
      Math.round((bestBaselinePct / 100) * predictions), predictions,
    );
    if (t) significance = { test: 'two-proportion-z', ...t, alpha: 0.05 };
  }

  let verdict; let verdictReason;
  if (signals < minSignalSample) {
    verdict = 'INSUFFICIENT EVIDENCE';
    verdictReason = `${signals} pooled signals < ${minSignalSample} minimum`;
  } else if (accuracyPct == null || bestBaselinePct == null) {
    verdict = 'INSUFFICIENT EVIDENCE';
    verdictReason = 'missing accuracy/baseline inputs';
  } else {
    const pOk = significance == null ? false : significance.pValue < 0.05;
    if (accuracyPct > bestBaselinePct && pct(loFrac) > bestBaselinePct && pOk) {
      verdict = 'EDGE';
      verdictReason = `pooled accuracy ${accuracyPct}% > best baseline ${bestBaselinePct}%, `
        + `Wilson-95% low ${pct(loFrac)}% > baseline, p=${significance.pValue}`;
    } else {
      verdict = 'NO EDGE';
      verdictReason = `fails EDGE criteria (acc=${accuracyPct}%, bestBase=${bestBaselinePct}%, `
        + `wilsonLow=${pct(loFrac)}%, p=${significance ? significance.pValue : 'n/a'})`;
    }
  }
  return {
    horizonsTested: cells.length,
    tickersContributing: usable.filter((c) => (c.upSignals || 0) + (c.downSignals || 0) > 0).length,
    eligibleRows, predictions, correct, noSignals,
    upSignals, downSignals,
    accuracyPct,
    wilsonLowPct: pct(loFrac), wilsonHighPct: pct(hiFrac),
    baselineDominantAccuracyPct, baselineAlwaysUpAccuracyPct, baselineMomentumAccuracyPct,
    bestBaselinePct,
    edgeVsBestBaselinePp: accuracyPct != null && bestBaselinePct != null
      ? Number((accuracyPct - bestBaselinePct).toFixed(2)) : null,
    significance,
    verdict, verdictReason,
  };
}

/**
 * Moving-block bootstrap percentile CI over an in-order series of per-signal
 * outcomes (e.g. correctness 0/1 of chronologically-concatenated test rows).
 *
 * OVERLAP-AWARE: blockSize defaults to max(horizonDays, 5) so adjacent
 * h-day windows' serial overlap is respected by the resampling blocks.
 * Deterministic under a fixed seed (mulberry32).
 *
 * @param {Array<number>} values series of numeric outcomes (chronological)
 * @param {{ iterations?: number, blockSize?: number, seed?: number, horizonDays?: number }} opts
 * @returns {{ lowPct: number|null, highPct: number|null, meanPct: number|null,
 *             iterations: number, blockSize: number, seed: number }|null}
 */
export function bootstrapCI(values, {
  iterations = 1000, blockSize, seed = 42, horizonDays = 1,
} = {}) {
  if (!Array.isArray(values) || !values.length) return null;
  const bs = blockSize ?? Math.max(horizonDays, 5);
  const rand = mulberry32(seed);
  const n = values.length;
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let acc = 0;
    let drawn = 0;
    while (drawn < n) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < bs && drawn < n; j += 1) {
        acc += values[(start + j) % n];
        drawn += 1;
      }
    }
    means.push(acc / n);
  }
  means.sort((a, b) => a - b);
  const q = (pIdx) => means[Math.min(means.length - 1, Math.max(0, Math.floor(pIdx * means.length)))];
  return {
    lowPct: pct(q(0.025)),
    highPct: pct(q(0.975)),
    meanPct: pct(means.reduce((a, b) => a + b, 0) / means.length),
    iterations,
    blockSize: bs,
    seed,
  };
}
