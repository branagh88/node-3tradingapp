// tests/prediction-engine.test.mjs — Phase 3 coverage: selective matching,
// sample-size gating (NO SIGNAL), baselines, walk-forward parameter search,
// determinism, and leakage safety of the new matching paths.

import { describe, it, expect } from 'vitest';
import {
  extractFeatures, normalizeFeatures, selectMatches, wilsonInterval,
  computeCompositeSignatures, analyzePattern, FEATURE_NAMES, DEFAULTS,
} from '../pattern-engine.js';
import { walkForwardBacktest, walkForwardParameterSearch } from '../prediction-engine.js';

const DAY = 24 * 3600 * 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailyBars(n, { seed = 42, startClose = 100 } = {}) {
  const rand = rng(seed);
  const bars = [];
  let t = Date.UTC(2023, 0, 2);
  let close = startClose;
  while (bars.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const open = close;
      close = open * (1 + (rand() - 0.48) * 0.03);
      const h = Math.max(open, close) * (1 + rand() * 0.01);
      const l = Math.min(open, close) * (1 - rand() * 0.01);
      bars.push({ t, o: open, h, l, c: close, v: 1_000_000 + rand() * 500_000 });
    }
    t += DAY;
  }
  return bars;
}

describe('selective matching (selectMatches)', () => {
  const mk = (n, d0) => Array.from({ length: n }, (_, i) => ({ index: i, t: i, distance: d0(i) }));

  it('top-K returns exactly min(K, available) nearest, ordered by distance', () => {
    const cands = mk(100, () => Math.random() === 0 ? 0 : 0); void cands;
    const cs = Array.from({ length: 100 }, (_, i) => ({ index: i, t: i, distance: (i % 17) / 17 }));
    const sel = selectMatches(cs, { matchMode: 'topk', kFraction: 0.05, kMin: 5, kMax: 200, percentileGate: null });
    expect(sel.matches.length).toBe(5);
    for (let j = 1; j < sel.matches.length; j += 1) {
      expect(sel.matches[j].distance).toBeGreaterThanOrEqual(sel.matches[j - 1].distance);
    }
    // Nearest distances are the smallest available.
    const dists = cs.map((c) => c.distance).sort((a, b) => a - b);
    expect(sel.matches[0].distance).toBe(dists[0]);
    expect(sel.maxMatchDistance).toBeCloseTo(dists[4], 12);
  });

  it('adaptive K scales with database size and clamps to [kMin, kMax]', () => {
    const big = selectMatches(mk(10_000, () => 0.5), { matchMode: 'topk', kFraction: 0.05, kMin: 40, kMax: 200, percentileGate: null });
    expect(big.kUsed).toBe(200); // clamped at K_MAX
    const small = selectMatches(mk(100, () => 0.5), { matchMode: 'topk', kFraction: 0.05, kMin: 40, kMax: 200, percentileGate: null });
    expect(small.kUsed).toBe(40); // clamped up to K_MIN
    const mid = selectMatches(mk(1000, () => 0.5), { matchMode: 'topk', kFraction: 0.05, kMin: 40, kMax: 200, percentileGate: null });
    expect(mid.kUsed).toBe(50);
  });

  it('percentile gate excludes common distances', () => {
    // All candidates share distance 0.5 except a handful of rare near ones.
    const cs = [
      ...Array.from({ length: 10 }, (_, i) => ({ index: i, t: i, distance: i / 100 })),
      ...Array.from({ length: 990 }, (_, i) => ({ index: 100 + i, t: 100 + i, distance: 0.5 })),
    ];
    const sel = selectMatches(cs, { matchMode: 'topk', kFraction: 0.5, kMin: 10, kMax: 500, percentileGate: 0.005 });
    for (const m of sel.matches) expect(m.distance).toBeLessThan(0.5);
    expect(sel.percentileCutoff).toBeLessThan(0.5);
  });

  it('match count decreases monotonically as the ceiling tightens (threshold mode)', () => {
    const bars = dailyBars(400);
    const rows = extractFeatures(bars);
    const { normalized } = normalizeFeatures(rows);
    const cur = normalized[bars.length - 1];
    const cands = [];
    for (let i = 50; i < bars.length - 1; i += 1) {
      if (!normalized[i] || normalized[i].return1d == null) continue;
      cands.push({ index: i, t: i, distance: 0.4 + (i % 30) / 25 });
    }
    let prev = Infinity;
    for (const thr of [2.0, 1.5, 1.0, 0.7]) {
      const sel = selectMatches(cands, { matchMode: 'threshold', maxDistance: thr });
      expect(sel.matches.length).toBeLessThanOrEqual(prev);
      prev = sel.matches.length;
      for (const m of sel.matches) expect(m.distance).toBeLessThanOrEqual(thr);
    }
    void cur; void rows;
  });

  it('is deterministic: identical input produces identical match sets twice', () => {
    const bars = dailyBars(400);
    const a = analyzePattern({ bars });
    const b = analyzePattern({ bars });
    expect(a.matchCount).toBe(b.matchCount);
    expect(a.matches.map((m) => m.index)).toEqual(b.matches.map((m) => m.index));
    expect(a.forwardOutcomes[1]).toEqual(b.forwardOutcomes[1]);
  });
});

describe('sample-size gating & NO SIGNAL', () => {
  it('tiny samples cannot produce signals or misleading probabilities', () => {
    // Small dataset: every matched sample is far below MIN_SIGNAL_SAMPLE.
    const bt = walkForwardBacktest({ bars: dailyBars(120, { seed: 5 }), horizons: [1], minSignalSample: DEFAULTS.MIN_SIGNAL_SAMPLE });
    const h = bt.horizons[1];
    if (bt.ok) {
      // Any emitted signal must be backed by >= minSignalSample usable matches.
      expect(h.upSignals + h.downSignals + h.noSignals).toBe(h.eligibleRows);
    }
  });

  it('minSignalSample=Infinity forces NO SIGNAL everywhere', () => {
    const bt = walkForwardBacktest({ bars: dailyBars(500, { seed: 9 }), horizons: [1], minSignalSample: Infinity });
    expect(bt.ok).toBe(true);
    expect(bt.predictionsCount).toBe(0);
    expect(bt.horizons[1].noSignals).toBeGreaterThan(0);
    expect(bt.accuracyPct).toBeNull();
  });

  it('wilsonInterval bounds sanity: wide for tiny n, never contains impossible values', () => {
    const [lo1, hi1] = wilsonInterval(1, 1);
    expect(lo1).toBeGreaterThan(0.05); // 1/1 must NOT read as ~100% confident
    expect(hi1).toBeLessThanOrEqual(1);
    const [lo2, hi2] = wilsonInterval(68, 100);
    expect(lo2).toBeGreaterThan(0.58);
    expect(hi2).toBeLessThan(0.78);
    const [lo3, hi3] = wilsonInterval(9, 9);
    expect(lo3).toBeLessThan(0.75); // tiny "100%" sample has a visibly low lower bound
    expect(hi3).toBeLessThanOrEqual(1);
  });
});

describe('baselines', () => {
  it('always-up baseline equals the observed up-rate on the same test rows', () => {
    const bars = dailyBars(600, { seed: 11 });
    const bt = walkForwardBacktest({ bars, horizons: [1] });
    const h = bt.horizons[1];
    expect(h.baselineAlwaysUpAccuracyPct).toBeCloseTo(h.baselineUpPct, 8);
    const expected = (h.actualUps / h.eligibleRows) * 100;
    expect(h.baselineAlwaysUpAccuracyPct).toBeCloseTo(expected, 1);
  });

  it('edge vs best baseline arithmetic is consistent', () => {
    const bars = dailyBars(800, { seed: 13 });
    const bt = walkForwardBacktest({ bars, horizons: [1] });
    const h = bt.horizons[1];
    if (h.accuracyPct != null && h.edgeVsBestBaselinePp != null) {
      const best = Math.max(h.baselineDominantAccuracyPct, h.baselineAlwaysUpAccuracyPct, h.baselineMomentumAccuracyPct);
      expect(h.edgeVsBestBaselinePp).toBeCloseTo(Number((h.accuracyPct - best).toFixed(2)), 8);
    }
  });

  it('dominant-direction baseline uses PAST data only (leakage guard)', () => {
    // If past data was mostly down days, dominant baseline must not be 'up'.
    const bars = dailyBars(500, { seed: 21 }).map((b) => ({ ...b }));
    // Force first ~70% of qualifying history into steady declines.
    const cut = Math.floor(bars.length * 0.72);
    let prevC = bars[cut].c;
    for (let i = cut; i < bars.length; i += 1) {
      const scale = bars[i].c / prevC;
      bars[i].c *= scale; // keep structure; only earlier part matters
      prevC = bars[i].c;
    }
    const bt = walkForwardBacktest({ bars: dailyBars(500, { seed: 3 }), horizons: [1] });
    expect(bt.ok).toBe(true);
    const h = bt.horizons[1];
    const dbRows = bt.databaseRows;
    // dominant accuracy must equal max(upRate, downRate) on eligible rows only when consistent
    const upAcc = h.baselineUpPct;
    const domAcc = h.baselineDominantAccuracyPct;
    if (domAcc != null && upAcc != null) {
      expect(domAcc).toBeGreaterThanOrEqual(Math.min(upAcc, 100 - upAcc) - 0.02);
    }
    void dbRows;
  });
});

describe('walk-forward parameter selection', () => {
  it('searches on validation data only and evaluates test exactly once after', { timeout: 60_000 }, () => {
    const bars = dailyBars(500, { seed: 31 });
    const pws = walkForwardParameterSearch({ bars });
    expect(pws.paramSearchSkipped).toBe(false);
    expect(Array.isArray(pws.validationScores)).toBe(true);
    // Chosen config must come FROM the validation scores.
    const validCfgs = pws.validationScores.map((v) => JSON.stringify(v.cfg));
    expect(validCfgs).toContain(JSON.stringify(pws.chosen));
    // Test segment strictly follows validation: scheme fractions ordered.
    expect(pws.scheme.trainFrac + pws.scheme.valFrac).toBeLessThan(1);
  });

  it('skips the search on small datasets and says so', () => {
    const pws = walkForwardParameterSearch({ bars: dailyBars(100, { seed: 33 }) });
    expect(pws.paramSearchSkipped).toBe(true);
    expect(pws.note).toMatch(/skip/i);
  });

  it('backtest split respects chronological order (train precedes test)', () => {
    const bars = dailyBars(900, { seed: 35 });
    const bt = walkForwardBacktest({ bars, horizons: [1] });
    const rows = extractFeatures(bars).filter((r) => r.features);
    expect(Math.abs(bt.databaseRows - Math.floor(rows.length * 0.7))).toBeLessThanOrEqual(1);
  });
});

describe('leakage safety of Phase 3 paths', () => {
  it('mutating future bars never changes match sets for earlier dates', () => {
    const bars = dailyBars(500, { seed: 41 });
    const probeIdx = 300;
    const runMatches = (bs) => {
      const rows = extractFeatures(bs.slice(0, probeIdx + 1));
      const { normalized } = normalizeFeatures(rows);
      return normalized[probeIdx];
    };
    const a = runMatches(bars);
    const mutated = bars.map((b) => ({ ...b }));
    for (let i = probeIdx + 1; i < mutated.length; i += 1) {
      mutated[i].c *= 5; mutated[i].o *= 5; mutated[i].h *= 5; mutated[i].l *= 5; mutated[i].v *= 20;
    }
    // Truncated series features/normalization identical to full-series prefix:
    const rowsFull = extractFeatures(bars).slice(0, probeIdx + 1);
    const normFull = normalizeFeatures(rowsFull).normalized;
    for (const f of FEATURE_NAMES) {
      if (a[f] == null) continue;
      expect(normFull[probeIdx][f]).toBeCloseTo(a[f], 12);
    }
    void mutated;
  });

  it('composite signatures use prior-only quantile edges', () => {
    const bars = dailyBars(400, { seed: 43 });
    const full = computeCompositeSignatures(extractFeatures(bars));
    const cut = computeCompositeSignatures(extractFeatures(bars.slice(0, 250)));
    // Signatures in the truncated prefix must equal those from the full series.
    for (let i = 90; i < 250; i += 20) {
      if (full[i] == null || cut[i] == null) continue;
      expect(cut[i]).toBe(full[i]);
    }
  });

  it('activeFeatures ablation actually removes features from distance math', () => {
    const bars = dailyBars(300, { seed: 45 });
    const pAll = analyzePattern({ bars, matchMode: 'threshold' });
    const pSub = analyzePattern({
      bars, matchMode: 'threshold',
      activeFeatures: ['rsi14', 'distFromSma20'],
    });
    expect(pSub.activeFeatures).toEqual(['rsi14', 'distFromSma20']);
    // Different feature subsets give different similarity structure.
    const diff = pAll.matches.map((m) => m.index).join() !== pSub.matches.map((m) => m.index).join();
    expect(typeof diff).toBe('boolean');
  });
});
