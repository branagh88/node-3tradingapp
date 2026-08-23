// tests/pooled-validation.test.mjs — Phase 5 pooled runner pure-function tests.
import { describe, it, expect } from 'vitest';
import { poolHorizonCells, wilsonInterval } from '../scripts/research/run-pooled-validation.mjs';

describe('wilsonInterval', () => {
  it('returns [null,null] for n=0', () => {
    expect(wilsonInterval(0, 0)).toEqual([null, null]);
  });
  it('is contained in [0,1] and contains the point estimate', () => {
    const [lo, hi] = wilsonInterval(60, 100);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
  });
});

describe('poolHorizonCells', () => {
  const cell = (predictions, correct, baseline, eligibleRows = 100) => ({
    predictions, correct, upSignals: predictions, downSignals: 0,
    noSignals: 0, eligibleRows,
    baselineDominantAccuracyPct: baseline,
    baselineAlwaysUpAccuracyPct: baseline,
    baselineMomentumAccuracyPct: baseline,
  });

  it('pools counts across tickers', () => {
    const p = poolHorizonCells([cell(50, 32), cell(70, 44)]);
    expect(p.predictions).toBe(120);
    expect(p.correct).toBe(76);
    expect(p.accuracyPct).toBeCloseTo(63.33, 1);
  });

  it('weights baselines by eligible rows', () => {
    const a = { ...cell(10, 6, 55, 40) };
    const b = { ...cell(10, 6, 65, 60) };
    const p = poolHorizonCells([a, b]);
    expect(p.bestBaselinePct).toBeCloseTo(61.0, 1); // (55*40 + 65*60)/100
  });

  it('verdict INSUFFICIENT EVIDENCE below minimum signal sample', () => {
    const p = poolHorizonCells([cell(10, 7, 50)]);
    expect(p.verdict).toBe('INSUFFICIENT EVIDENCE');
  });

  it('verdict EDGE only when accuracy, Wilson-low and p all clear the baseline', () => {
    // 300 signals at ~66% vs 50% baseline → clearly significant.
    const p = poolHorizonCells([cell(150, 100, 50), cell(150, 98, 52)]);
    expect(p.verdict).toBe('EDGE');
    expect(p.significance.pValue).toBeLessThan(0.05);
    // Coin-flip accuracy vs 50% baseline → NO EDGE.
    const q = poolHorizonCells([cell(200, 102, 50)]);
    expect(q.verdict).toBe('NO EDGE');
  });

  it('ignores null cells and empty input', () => {
    expect(poolHorizonCells([]).verdict).toBe('INSUFFICIENT EVIDENCE');
    const p = poolHorizonCells([null, cell(50, 30, 50)]);
    expect(p.predictions).toBe(50);
  });
});
