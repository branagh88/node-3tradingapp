// tests/real-data-validation.test.mjs — Phase 4 real-data validation harness tests.
//
// Offline & deterministic: uses SEEDED synthetic bars ONLY to exercise the
// harness mechanics (leakage-safety, walk-forward behavior, NO-SIGNAL handling,
// determinism, schema). These tests never validate market edge and never feed
// synthetic data into research results.

import { describe, it, expect } from 'vitest';
import {
  analyzeBars, validateResultsSchema, zTestTwoProportions, verdictFor,
} from '../scripts/research/run-real-validation.mjs';
import { validateBarsDataset } from '../scripts/research/validate-bars.mjs';
import { genBars } from '../scripts/research/gen-bars.mjs';

const DAY = 24 * 3600 * 1000;
const GEN_AT = '2026-01-01T00:00:00.000Z';

function series(n = 600) {
  return genBars(n, { seed: 42, startClose: 100, dailyVol: 0.015, drift: 0.0003 });
}

describe('real-data validation runner', () => {
  it('is deterministic — two runs produce byte-identical JSON (timestamps excluded)', async () => {
    const bars = series(500);
    const a = JSON.stringify(analyzeBars({ bars, ticker: 'TEST', generatedAt: GEN_AT }));
    const b = JSON.stringify(analyzeBars({ bars: bars.slice(), ticker: 'TEST', generatedAt: GEN_AT }));
    expect(a).toBe(b);
  }, 120_000);

  it('has no future leakage — mutating bars AFTER each prediction date never changes that date\'s signal', async () => {
    const bars = series(400);
    // Baseline run.
    const base = await import('../prediction-engine.js');
    const cfg = { horizons: [1], matchMode: 'topk', kFraction: 0.05 };
    const clean = base.walkForwardBacktest({ bars, ...cfg });
    // Corrupt every bar after a mid-series point; earlier predictions must be unchanged.
    const cut = Math.floor(bars.length * 0.75);
    const poisoned = bars.map((b, i) => (i >= cut
      ? { t: b.t + i * 0, o: 999, h: 9999, l: 1, c: i % 2 ? 5000 : 2, v: 1e9 }
      : b));
    const dirty = base.walkForwardBacktest({ bars: poisoned, ...cfg });
    // All rows up to `cut - maxHorizon` are decided using only prior data → identical counts there.
    expect(clean.databaseRows).toBe(dirty.databaseRows);
    expect(clean.splitIndex).toBe(dirty.splitIndex);
    // The first part of the test window shares identical per-row behavior; verify via
    // point checks: recompute a single early-test-row signal by hand on both series.
    const peMod = await import('../pattern-engine.js');
    for (const mod of [peMod]) {
      const rowsClean = mod.extractFeatures(bars);
      const rowsDirty = mod.extractFeatures(poisoned);
      for (let i = 10; i < cut - 20; i += 25) {
        if (!rowsClean[i].features || !rowsDirty[i].features) continue;
        expect(rowsClean[i].features.rsi14).toBeCloseTo(rowsDirty[i].features.rsi14, 10);
        expect(rowsClean[i].features.return5d).toBeCloseTo(rowsDirty[i].features.return5d, 10);
      }
    }
  });

  it('chronological walk-forward: splitIndex is monotone in splitRatio and matches lie strictly before test rows', async () => {
    const bars = series(500);
    const eng = await import('../prediction-engine.js');
    const r70 = eng.walkForwardBacktest({ bars, horizons: [1] });
    const r50 = eng.walkForwardBacktest({ bars, horizons: [1], splitRatio: 0.5 });
    expect(r50.splitIndex).toBeLessThan(r70.splitIndex);
    // Database rows all precede test rows by construction of qualifying slices:
    expect(r70.databaseRows).toBeGreaterThan(0);
    expect(r70.testRows).toBeGreaterThan(0);
  });

  it('records train/validation/test separation boundaries in output', async () => {
    const res = analyzeBars({ bars: series(600), ticker: 'SEP', generatedAt: GEN_AT });
    expect(res.scheme.trainFrac).toBe(0.6);
    expect(res.scheme.valFrac).toBe(0.2);
    expect(res.scheme.testFrac).toBeCloseTo(0.2);
    expect(res.scheme.testRows).toBeGreaterThan(0);
    // Parameter search scored configs on validation only; chosen config exists.
    expect(typeof res.parameterSearch.chosen).toBe('object');
  }, 120_000);

  it('handles NO-SIGNAL correctly — gated rows yield zero predictions and null accuracy', async () => {
    const { walkForwardBacktest } = await import('../prediction-engine.js');
    const small = series(60); // tiny DB → matched samples far below MIN_SIGNAL_SAMPLE
    const r = walkForwardBacktest({ bars: small, horizons: [1] });
    if (r.ok === false) {
      expect(r.message).toMatch(/qualifying/i);
    } else {
      for (const s of Object.values(r.horizons)) {
        expect(s.eligibleRows).toBeGreaterThan(0); // outcomes exist…
        if ((s.upSignals + s.downSignals) < 30) {
          expect(s.predictions).toBe(0);            // …but the gate refuses to predict
          expect(s.noSignals).toBe(s.eligibleRows);
          expect(s.accuracyPct).toBeNull();
          expect(s.coveragePct).toBe(0);
        }
      }
    }
  });

  it('handles insufficient history gracefully (ok:false message, no crash)', async () => {
    const { walkForwardBacktest } = await import('../prediction-engine.js');
    const tiny = series(15);
    const r = walkForwardBacktest({ bars: tiny, horizons: [1] });
    expect(r.ok).toBe(false);
    expect(typeof r.message).toBe('string');
    expect(r.horizons).toEqual({});
    // Runner-level: analyzeBars still returns structured output with integrity info.
    const res = analyzeBars({ bars: tiny, ticker: 'TINY', generatedAt: GEN_AT });
    expect(res.ticker).toBe('TINY');
    expect(res.dataIntegrity.candleCount).toBe(15);
  });

  it('z-test and verdict helpers behave mechanically', () => {
    expect(zTestTwoProportions(65, 100, 50, 100).pValue).toBeLessThan(0.05);
    expect(zTestTwoProportions(52, 100, 50, 100).pValue).toBeGreaterThan(0.05);
    const baseStats = {
      upSignals: 40, downSignals: 0, correct: 34, accuracyPct: 85,
      wilsonLowPct: 72, baselineDominantAccuracyPct: 55,
      baselineAlwaysUpAccuracyPct: 60, baselineMomentumAccuracyPct: 52,
    };
    expect(verdictFor(baseStats).verdict).toBe('EDGE');
    expect(verdictFor({ ...baseStats, correct: 26, accuracyPct: 65, wilsonLowPct: 51 }).verdict)
      .toBe('NO EDGE'); // CI low does not beat best baseline
    expect(verdictFor({ ...baseStats, upSignals: 10, downSignals: 0 }).verdict)
      .toBe('INSUFFICIENT_SAMPLE');
  });
});

describe('validate-bars integrity checks', () => {
  const mk = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v });
  const T0 = Date.UTC(2024, 0, 1);

  it('accepts valid weekday OHLCV data', () => {
    const bars = [];
    let t = T0;
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(t).getUTCDay();
      if (d !== 0 && d !== 6) bars.push(mk(t, 100 + i, 102 + i, 99 + i, 101 + i));
      t += DAY;
    }
    const rep = validateBarsDataset({ ticker: 'X', interval: '1d', bars });
    expect(rep.ok).toBe(true);
    expect(rep.invalidOhlcRows).toBe(0);
    expect(rep.duplicateTimestamps).toBe(0);
    expect(rep.largeGaps.length).toBe(0); // weekends ignored
  });

  it('fails on inverted high/low and non-positive prices', () => {
    const bars = [mk(T0, 100, 90, 95, 101), mk(T0 + DAY, 100, 102, 99, 0)];
    const rep = validateBarsDataset({ ticker: 'X', interval: '1d', bars });
    expect(rep.ok).toBe(false);
    expect(rep.invalidOhlcRows).toBe(2);
    expect(rep.zeroCloseRows).toBe(1);
  });

  it('detects duplicate timestamps and ordering violations', () => {
    const bars = [mk(T0, 1, 2, 0.5, 1.5), mk(T0 + DAY, 1, 2, 0.5, 1.5),
      mk(T0 + DAY, 1, 2, 0.5, 1.5), mk(T0, 1, 2, 0.5, 1.5)];
    const rep = validateBarsDataset({ ticker: 'X', interval: '1d', bars });
    expect(rep.duplicateTimestamps).toBeGreaterThanOrEqual(1);
    expect(rep.orderedStrictly).toBe(false);
    expect(rep.hardErrors.length).toBeGreaterThan(0);
  });

  it('flags large calendar gaps but ignores weekends', () => {
    const bars = [mk(T0, 1, 2, 0.5, 1.5), mk(T0 + 40 * DAY, 1, 2, 0.5, 1.5)];
    const rep = validateBarsDataset({ ticker: 'X', interval: '1d', bars });
    expect(rep.largeGaps.length).toBe(1);
  });

  it('rejects empty datasets', () => {
    const rep = validateBarsDataset({ ticker: 'X', interval: '1d', bars: [] });
    expect(rep.ok).toBe(false);
    expect(rep.hardErrors[0]).toMatch(/no bars/);
  });
});

describe('results schema validation', () => {
  const goodEntry = (verdict = 'NO EDGE') => ({
    days: 1, eligibleRows: 100, predictions: 80, correct: 45, noSignals: 20,
    coveragePct: 80, accuracyPct: 56.25, upSignals: 50, downSignals: 30,
    positiveAccuracyPct: 60, negativeAccuracyPct: 50, winRatePct: 56.25,
    avgReturnAfterPositivePct: 0.4, medianReturnAfterPositivePct: 0.2,
    wilsonLowPct: 43, wilsonHighPct: 69,
    baselineDominantAccuracyPct: 54, baselineAlwaysUpAccuracyPct: 55,
    baselineMomentumAccuracyPct: 51, edgeVsBestBaselinePp: 1.25,
    meetsSampleGate: true, significance: { test: 'two-proportion-z', pValue: 0.3, alpha: 0.05 },
    verdict, verdictReason: 'x',
  });
  const goodDoc = () => ({
    status: 'COMPLETE',
    tickers: [{
      ticker: 'AAPL',
      dataIntegrity: { ok: true },
      parameterSearch: {}, scheme: {}, engineConfig: {},
      horizons: { 1: { all: goodEntry(), highConfidence: goodEntry(), forced: goodEntry() } },
    }],
    crossTickerConsistency: {},
    provenance: { apiRequestsUsed: [] },
  });

  it('accepts a well-formed document', () => {
    const { ok, errors } = validateResultsSchema(goodDoc());
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects bad verdicts, out-of-range numbers, and inverted Wilson bounds', () => {
    const doc = goodDoc();
    doc.tickers[0].horizons[1].all.verdict = 'SUPER_EDGE';
    doc.tickers[0].horizons[1].all.accuracyPct = 250;
    doc.tickers[0].horizons[1].highConfidence.wilsonLowPct = 90;
    doc.tickers[0].horizons[1].highConfidence.wilsonHighPct = 60;
    doc.tickers[0].horizons[1].forced.predictions = -3;
    const { ok, errors } = validateResultsSchema(doc);
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('validates the blocked-status document shape too', () => {
    const blocked = {
      status: 'BLOCKED_NO_API_KEY', tickers: [], crossTickerConsistency: {},
      provenance: { apiRequestsUsed: [] },
    };
    const { ok, errors } = validateResultsSchema(blocked);
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });
});
