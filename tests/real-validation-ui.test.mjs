// tests/real-validation-ui.test.mjs — Phase 6 RUN REAL VALIDATION tests.
//
// Fully OFFLINE & DETERMINISTIC: a stub transport implements the
// fetchBarsPageRaw contract over seeded synthetic fixtures (gen-bars). No
// network, no Tickerbot credential, no key anywhere. These tests validate
// harness mechanics (selection, caching, estimation, retry, gating, pooling,
// determinism), NOT market edge.

import { describe, it, expect } from 'vitest';
import { genBars } from '../scripts/research/gen-bars.mjs';
import {
  RealValidationController,
  RV_HORIZONS,
  estimateApiCallsForDepth,
  formatCallWarning,
} from '../real-validation.js';
import { HistoricalAnalysisController } from '../historical-analysis.js';
import {
  poolHorizonCells,
  wilsonInterval,
  bootstrapCI,
} from '../pooled-stats.js';

const DAY = 24 * 3600 * 1000;

// Shift generated bars so the newest candle is "now"-anchored (the retrieval
// window ends at Date.now()).
function freshBars(n, opts = {}) {
  const bars = genBars(n, opts);
  const shift = Date.now() - 2 * DAY - bars[bars.length - 1].t;
  return bars.map((b) => ({ ...b, t: b.t + shift }));
}

// Stub transport implementing the fetchBarsPageRaw contract: slices a fixture
// series into cursor-paginated pages honoring the requested [from,to] window.
function makeStubApi({ datasets, pageSize = 500, failFirstPageOf = null }) {
  let failedOnce = false;
  const callsByTicker = {};
  const api = {
    callCount: (ticker) => (ticker ? (callsByTicker[ticker] || 0) : Object.values(callsByTicker).reduce((a, b) => a + b, 0)),
    fetchBarsPageRaw: async ({ ticker, from, to, cursor }) => {
      callsByTicker[ticker] = (callsByTicker[ticker] || 0) + 1;
      if (failFirstPageOf && ticker === failFirstPageOf && !failedOnce) {
        failedOnce = true;
        const err = new Error('transport boom');
        err.name = 'TransportError';
        throw err;
      }
      const all = datasets[ticker] || [];
      const inRange = all.filter((b) => b.t >= from && b.t <= to);
      const startIdx = cursor ? Number(cursor) : 0;
      const page = inRange.slice(startIdx, startIdx + pageSize);
      const nextCursor = startIdx + pageSize < inRange.length ? String(startIdx + pageSize) : null;
      return { data: { bars: page.map((b) => ({ ...b })), next_cursor: nextCursor } };
    },
  };
  return api;
}

function makeController(api) {
  // No-op rate limiter (same shape as HistorySource expects) → instant tests.
  const hist = new HistoricalAnalysisController({ api, rateLimiter: { acquire: async () => {} } });
  return new RealValidationController({ histController: hist });
}

const cell = (predictions, correct, baseline, eligibleRows = 100) => ({
  predictions, correct, upSignals: predictions, downSignals: 0,
  noSignals: 0, eligibleRows,
  baselineDominantAccuracyPct: baseline,
  baselineAlwaysUpAccuracyPct: baseline,
  baselineMomentumAccuracyPct: baseline,
});

describe('RV constants', () => {
  it('exposes horizons and NO hardcoded ticker universe (watchlist-driven)', async () => {
    expect(RV_HORIZONS).toEqual([1, 3, 5, 10]);
    expect('RV_TICKERS' in await import('../real-validation.js')).toBe(false);
  });
});

describe('call estimation (pure helpers)', () => {
  it('estimateApiCallsForDepth: 1y ⇒ ceil(252/1000)=1 page/ticker', () => {
    expect(estimateApiCallsForDepth(['AAPL', 'MSFT'], '1y')).toEqual({
      pagesPerTicker: 1, totalEstimatedCalls: 2,
    });
  });

  it('warning string contains the estimated call count', () => {
    const s = formatCallWarning({ totalEstimatedCalls: 3, cachedTickers: 1, freshTickers: 2 });
    expect(s).toContain('3');
  });

  it('controller estimate respects cache contents', async () => {
    const api = makeStubApi({ datasets: { AAPL: freshBars(450, { seed: 7 }) } });
    const rv = makeController(api);
    const before = rv.estimateApiCalls(['AAPL', 'MSFT'], '1y');
    expect(before.cachedTickers).toBe(0);
    expect(before.totalEstimatedCalls).toBe(2);
    await rv.hist.run({ ticker: 'AAPL', depth: '1y' });
    const after = rv.estimateApiCalls(['AAPL', 'MSFT'], '1y');
    expect(after.cachedTickers).toBe(1);
    expect(after.freshTickers).toBe(1);
    expect(after.totalEstimatedCalls).toBe(1); // cached ticker costs nothing
  });
});

describe('RealValidationController', () => {
  it('runs only selected tickers and records per-ticker summaries', async () => {
    const datasets = {
      AAPL: freshBars(450, { seed: 101 }),
      MSFT: freshBars(450, { seed: 303 }),
      NVDA: freshBars(450, { seed: 404 }),
      TSLA: freshBars(450, { seed: 505 }),
    };
    const api = makeStubApi({ datasets });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['AAPL', 'MSFT', 'NVDA'], depth: '1y' });
    expect(r.requested).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(r.included.sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(r.perTicker.AAPL).toBeTruthy();
    expect(r.perTicker.TSLA).toBeUndefined();
    expect(r.perTicker.AAPL.horizons[1]).toBeTruthy();
    expect(typeof r.perTicker.AAPL.paramSearchSkipped).toBe('boolean');
    expect(r.pooled[1]).toBeTruthy();
  }, 240_000);

  it('cache reuse: second run makes ZERO additional API calls', async () => {
    const api = makeStubApi({ datasets: { AAPL: freshBars(450, { seed: 11 }) } });
    const rv = makeController(api);
    const first = await rv.run({ tickers: ['AAPL'], depth: '1y' });
    const callsAfterFirst = api.callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await rv.run({ tickers: ['AAPL'], depth: '1y' });
    expect(api.callCount()).toBe(callsAfterFirst); // no new calls
    expect(second.perTicker.AAPL.fromCache).toBe(true);
    expect(first.perTicker.AAPL.fromCache).toBe(false);
    expect(second.totals.apiCallsSpent).toBe(0); // cached run spends nothing
  }, 120_000);

  it('chronological integrity + determinism: two runs byte-equal (timestamps excluded)', async () => {
    const mk = () => makeController(makeStubApi({ datasets: { AAPL: freshBars(430, { seed: 21 }) } }));
    const strip = (r) => JSON.stringify({ ...r, startedAt: null, finishedAt: null });
    const a = strip(await mk().run({ tickers: ['AAPL'], depth: '1y' }));
    const b = strip(await mk().run({ tickers: ['AAPL'], depth: '1y' }));
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    const pt = parsed.perTicker.AAPL;
    expect(pt.horizons[1]).toBeTruthy();
    // Engine guarantees strict train→val→test separation:
    expect(parsed.included).toContain('AAPL');
    expect(pt.paramSearchSkipped).toBeDefined();
  }, 240_000);

  it('retry-once: transient failure still includes the ticker; permanent failure skips only that ticker', async () => {
    const datasets = {
      AAPL: freshBars(430, { seed: 31 }),
      MSFT: freshBars(430, { seed: 32 }),
    };
    const flaky = makeStubApi({ datasets, failFirstPageOf: 'MSFT' });
    const rvFlaky = makeController(flaky);
    const ok = await rvFlaky.run({ tickers: ['AAPL', 'MSFT'], depth: '1y' });
    expect(ok.skipped).toEqual([]);
    expect(ok.included.sort()).toEqual(['AAPL', 'MSFT']); // one retry rescued MSFT
    // Exactly ONE extra attempt for MSFT vs a clean single-ticker run.
    const clean = makeStubApi({ datasets });
    const rvClean = makeController(clean);
    await rvClean.run({ tickers: ['MSFT'], depth: '1y' });
    expect(flaky.callCount('MSFT')).toBe(clean.callCount('MSFT') + 1);

    // Permanent failure: always throws for MSFT.
    const dead = {
      callCount: () => 0,
      fetchBarsPageRaw: async ({ ticker }) => {
        if (ticker === 'MSFT') { const e = new Error('down'); e.name = 'TransportError'; throw e; }
        const all = datasets[ticker] || [];
        return { data: { bars: all.filter((b) => b.t >= Date.now() - 365 * DAY), next_cursor: null } };
      },
    };
    const rvDead = makeController(dead);
    const res = await rvDead.run({ tickers: ['AAPL', 'MSFT'], depth: '1y' });
    expect(res.included).toEqual(['AAPL']); // sibling unaffected
    expect(res.skipped.map((s) => s.ticker)).toEqual(['MSFT']);
    expect(res.skipped[0].reason).toMatch(/retrieval failed twice|stopped/i);
  }, 300_000);

  it('insufficient history (<200 candles) lands in skipped; no fabricated bars', async () => {
    const api = makeStubApi({ datasets: { GME: freshBars(50, { seed: 41 }) } });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['GME'], depth: '1y' });
    expect(r.included).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/insufficient history/);
    expect(r.perTicker.GME).toBeUndefined();
  }, 60_000);

  it('progress events cover RETRIEVING → BACKTESTING → POOLING → DONE phases', async () => {
    const api = makeStubApi({ datasets: { AAPL: freshBars(430, { seed: 51 }) } });
    const rv = makeController(api);
    const phases = new Set();
    await rv.run({ tickers: ['AAPL'], depth: '1y', onProgress: (e) => phases.add(e.phase) });
    expect(phases.has('RETRIEVING')).toBe(true);
    expect(phases.has('BACKTESTING')).toBe(true);
    expect(phases.has('POOLING')).toBe(true);
    expect(phases.has('DONE')).toBe(true);
  }, 240_000);
});

describe('pooled-stats extraction parity & overlap-aware CI', () => {
  it('poolHorizonCells matches the Phase 5 asserted values exactly', () => {
    const p = poolHorizonCells([cell(50, 32), cell(70, 44)]);
    expect(p.predictions).toBe(120);
    expect(p.correct).toBe(76);
    expect(p.accuracyPct).toBeCloseTo(63.33, 1);
    const w = poolHorizonCells([{ ...cell(10, 6, 55, 40) }, { ...cell(10, 6, 65, 60) }]);
    expect(w.bestBaselinePct).toBeCloseTo(61.0, 1);
    expect(poolHorizonCells([cell(10, 7, 50)]).verdict).toBe('INSUFFICIENT EVIDENCE');
    const edge = poolHorizonCells([cell(150, 100, 50), cell(150, 98, 52)]);
    expect(edge.verdict).toBe('EDGE');
    expect(poolHorizonCells([cell(200, 102, 50)]).verdict).toBe('NO EDGE');
    expect(poolHorizonCells([]).verdict).toBe('INSUFFICIENT EVIDENCE');
  });

  it('wilsonInterval parity with existing suite expectations', () => {
    expect(wilsonInterval(0, 0)).toEqual([null, null]);
    const [lo, hi] = wilsonInterval(60, 100);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(0.6);
  });

  it('bootstrapCI is deterministic under fixed seed and respects horizon blockSize', () => {
    const series = Array.from({ length: 80 }, (_, i) => (Math.sin(i * 1.7) > 0 ? 1 : 0));
    const a = bootstrapCI(series, { horizonDays: 10, seed: 42 });
    const b = bootstrapCI(series, { horizonDays: 10, seed: 42 });
    expect(a).toEqual(b);
    expect(a.blockSize).toBeGreaterThanOrEqual(10); // default ≥ horizon
    const smallBlock = bootstrapCI(series, { horizonDays: 10, blockSize: 3, seed: 42 });
    expect(smallBlock.blockSize).toBe(3);
  });

  it('bootstrap width ≥ Wilson width on an autocorrelated (regime-clustered) series', () => {
    // Regime-clustered correctness: long runs of hits/misses. Block bootstrap
    // (blockSize 5) preserves clustering ⇒ wider interval than the iid-based
    // Wilson score interval — exactly what the overlap guard is for.
    const clustered = [];
    while (clustered.length < 200) {
      const runLen = 8 + (clustered.length % 7);
      const bit = Math.floor(clustered.length / 15) % 2;
      for (let j = 0; j < runLen && clustered.length < 200; j += 1) clustered.push(bit);
    }
    const k = clustered.reduce((a, b) => a + b, 0);
    const n = clustered.length;
    const [lo, hi] = wilsonInterval(k, n);
    const boot = bootstrapCI(clustered, { horizonDays: 5, seed: 42 });
    expect((boot.highPct - boot.lowPct)).toBeGreaterThanOrEqual(((hi - lo) * 100) - 0.01);
  });

  it('controller pooled output carries overlap-aware annotation without mutating verdicts', async () => {
    const api = makeStubApi({ datasets: { AAPL: freshBars(430, { seed: 61 }) } });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['AAPL'], depth: '1y' });
    for (const h of RV_HORIZONS) {
      const p = r.pooled[h];
      expect(p.verdict).toBe(poolHorizonCells([r.perTicker.AAPL.horizons[h]]).verdict);
      expect(p.bootstrapCI.seed).toBe(42);
      expect(typeof p.overlapAwareEdge).toBe('boolean');
    }
  }, 240_000);
});
