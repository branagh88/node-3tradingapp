// tests/prefetch-progress.test.mjs — Phase 10 explicit prefetch: per-ticker
// progress, failure isolation, [Retry failed] re-runs ONLY failed tickers,
// sibling cache entries are never discarded (reference-equality asserted).

import { describe, it, expect } from 'vitest';
import { HistoricalAnalysisController } from '../historical-analysis.js';
import { RealValidationController, prefetchDatasets } from '../real-validation.js';

const DAY = 24 * 3600 * 1000;

function mockApi({ fail = [], failFirstAttempt = [] } = {}) {
  const calls = [];
  const attempts = new Map();
  return {
    calls,
    fetchBarsPageRaw: async (req) => {
      calls.push({ ticker: req.ticker });
      const n = (attempts.get(req.ticker) || 0) + 1;
      attempts.set(req.ticker, n);
      if (fail.includes(req.ticker)
        || (failFirstAttempt.includes(req.ticker) && n === 1)) {
        const err = new Error('rate limited');
        err.status = 429;
        throw err;
      }
      const bars = [];
      let t = req.from;
      for (let i = 0; i < 400; i += 1) {
        bars.push({ t, o: 1, h: 2, l: 0.5, c: 1.5 + n, v: 10 });
        t += DAY;
      }
      return { data: { bars, next_cursor: null } };
    },
  };
}

function make(api) {
  const hist = new HistoricalAnalysisController({ api });
  const rv = new RealValidationController({ histController: hist });
  return { hist, rv };
}

describe('prefetchDatasets — progress & failure isolation', () => {
  it('ticker #2 failing does not touch tickers 1 and 3 (cache + reference equality)', async () => {
    const api = mockApi({ fail: ['MSFT'] });
    const { hist } = make(api);
    // Pre-populate AAPL so we can assert reference equality after MSFT fails.
    await prefetchDatasets(hist, { tickers: ['AAPL'], depth: '1y' });
    const aaplBarsBefore = hist.cache.get('AAPL:1y').bars;

    const events = [];
    const res = await prefetchDatasets(hist, {
      tickers: ['AAPL', 'MSFT', 'NVDA'],
      depth: '1y',
      onProgress: (e) => events.push(e),
    });

    expect(res.entries.map((e) => e.ticker)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(res.entries[0].ok).toBe(true);
    expect(res.entries[1].ok).toBe(false);
    expect(res.entries[2].ok).toBe(true);
    expect(res.failed.map((f) => f.ticker)).toEqual(['MSFT']);

    // Sibling data intact — same array reference, still valid in cache.
    expect(hist.cache.get('AAPL:1y').bars).toBe(aaplBarsBefore);
    expect(hist.hasValidDataset('NVDA', '1y')).toBe(true);

    // Progress sequence sane: FETCHING/TICKER_DONE per ticker + DONE.
    expect(events.filter((e) => e.phase === 'FETCHING').map((e) => e.ticker))
      .toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(events[events.length - 1].phase).toBe('DONE');
  });

  it('[Retry failed] path re-invokes only the failed ticker; success makes all three valid', async () => {
    const api = mockApi();
    const { hist } = make(api);
    const first = await prefetchDatasets(hist, { tickers: ['A', 'B', 'C'].map((s) => s), depth: '1y' });
    expect(first.failed.length).toBe(0);

    // New scenario: B fails on first pass via a fresh controller.
    const api2 = mockApi({ failFirstAttempt: ['B'] });
    const hist2 = new HistoricalAnalysisController({ api: api2 });
    const rv2 = new RealValidationController({ histController: hist2 });
    const pass1 = await prefetchDatasets(hist2, { tickers: ['A', 'B', 'C'], depth: '1y' });
    expect(pass1.failed.map((f) => f.ticker)).toEqual(['B']);
    expect(hist2.hasValidDataset('A', '1y')).toBe(true);
    expect(hist2.hasValidDataset('C', '1y')).toBe(true);
    const aaplCallsAfterPass1 = api2.calls.filter((c) => c.ticker === 'A').length;

    const beforeRetry = api2.calls.length;
    const pass2 = await prefetchDatasets(hist2, { tickers: ['B'], depth: '1y' });
    expect(pass2.failed.length).toBe(0);
    // Only B was requested on the retry — siblings untouched.
    expect(api2.calls.slice(beforeRetry).every((c) => c.ticker === 'B')).toBe(true);
    expect(api2.calls.filter((c) => c.ticker === 'A').length).toBe(aaplCallsAfterPass1);
    expect(['A', 'B', 'C'].every((t) => hist2.hasValidDataset(t, '1y'))).toBe(true);
  });

  it('validation run() over prefetched tickers spends 0 API calls (prefetch filled the shared cache)', async () => {
    const api = mockApi();
    const { hist, rv } = make(api);
    await prefetchDatasets(hist, { tickers: ['AAPL', 'MSFT'], depth: '1y' });
    const before = api.calls.length;
    const res = await rv.run({ tickers: ['AAPL', 'MSFT'], depth: '1y' });
    expect(api.calls.length).toBe(before);
    expect(res.included.sort()).toEqual(['AAPL', 'MSFT']);
    expect(res.totals.apiCallsSpent).toBe(0);
  });
});
