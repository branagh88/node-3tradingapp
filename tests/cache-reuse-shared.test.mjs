// tests/cache-reuse-shared.test.mjs — Phase 10: ONE shared cache
// (HistoricalAnalysisController.cache) reused across the analysis-panel-style
// direct run(), the validation controller and explicit prefetch. Also covers
// the new additive helpers isDatasetCacheEntryValid / hasValidDataset.

import { describe, it, expect } from 'vitest';
import {
  HistoricalAnalysisController,
  isDatasetCacheEntryValid,
} from '../historical-analysis.js';
import { RealValidationController } from '../real-validation.js';
import { renderRealValidationResults } from '../real-validation-ui.js';

const DAY = 24 * 3600 * 1000;

function mockApi({ fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    fetchBarsPageRaw: async (req) => {
      calls.push({ ticker: req.ticker });
      if (fail.includes(req.ticker)) {
        const err = new Error('nope');
        err.status = 503;
        throw err;
      }
      const bars = [];
      let t = req.from;
      for (let i = 0; i < 400; i += 1) {
        bars.push({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
        t += DAY;
      }
      return { data: { bars, next_cursor: null } };
    },
  };
}

function make() {
  const api = mockApi();
  const hist = new HistoricalAnalysisController({ api });
  const rv = new RealValidationController({ histController: hist });
  return { api, hist, rv };
}

describe('isDatasetCacheEntryValid (additive pure helper)', () => {
  it('valid only for COMPLETE + non-empty bars', () => {
    expect(isDatasetCacheEntryValid(null)).toBe(false);
    expect(isDatasetCacheEntryValid(undefined)).toBe(false);
    expect(isDatasetCacheEntryValid({ status: 'COMPLETE', bars: [] })).toBe(false);
    expect(isDatasetCacheEntryValid({ status: 'PARTIAL', bars: [{ t: 1 }] })).toBe(false);
    expect(isDatasetCacheEntryValid({ status: 'COMPLETE' })).toBe(false);
    expect(isDatasetCacheEntryValid({ status: 'COMPLETE', bars: [{ t: 1 }] })).toBe(true);
  });

  it('hasValidDataset mirrors the cache key', () => {
    const { hist } = make();
    hist.cache.set('AAPL:1y', { status: 'COMPLETE', bars: [{ t: 1 }] });
    expect(hist.hasValidDataset('aapl', '1y')).toBe(true);
    expect(hist.hasValidDataset('MSFT', '1y')).toBe(false);
  });
});

describe('shared-cache reuse across features', () => {
  it('analysis-populated cache makes validation run spend 0 API calls', async () => {
    const { api, hist, rv } = make();
    // Simulate the Historical Analysis panel populating the cache.
    const analysis = await hist.run({ ticker: 'AAPL', depth: '1y' });
    expect(analysis.fromCache).toBe(false);
    const nAfterAnalysis = api.calls.length;

    const estBefore = rv.estimatePerTicker(['AAPL'], '1y');
    expect(estBefore.perTicker[0]).toEqual({ ticker: 'AAPL', cached: true, valid: true });
    expect(estBefore.freshTickers).toBe(0);

    const result = await rv.run({ tickers: ['AAPL'], depth: '1y' });
    expect(api.calls.length).toBe(nAfterAnalysis); // zero fresh calls
    expect(result.totals.cachedDatasets).toBe(1);
    expect(result.totals.apiCallsSpent).toBe(0);
    expect(result.perTicker.AAPL.fromCache).toBe(true);
    // Rendered rows annotate cached datasets.
    const html = renderRealValidationResults(result);
    expect(html).toContain('(cached, 0 API calls)');
  });

  it('PARTIAL cached entries are invalid → evicted → refetched on next explicit action', async () => {
    const { api, hist, rv } = make();
    // Hand-plant a stale PARTIAL entry (e.g. from an earlier failed retrieval).
    hist.cache.set('MSFT:3y', {
      status: 'PARTIAL', stoppedReason: 'error', bars: [{ t: 1 }],
      fromCache: false,
    });
    expect(hist.hasValidDataset('MSFT', '3y')).toBe(false);

    await rv.run({ tickers: ['MSFT'], depth: '3y' });
    // The stale entry was evicted and actually refetched.
    expect(api.calls.filter((c) => c.ticker === 'MSFT').length).toBeGreaterThan(0);
    const entry = hist.cache.get('MSFT:3y');
    expect(entry.status).toBe('COMPLETE');
    expect(rv.estimatePerTicker(['MSFT'], '3y').perTicker[0].valid).toBe(true);
  });

  it('prefetch fills the SAME cache the validation controller reads', async () => {
    const { api, hist, rv } = make();
    const { prefetchDatasets } = await import('../real-validation.js');
    await prefetchDatasets(hist, { tickers: ['NVDA'], depth: '1y' });
    const before = api.calls.length;
    const res = await rv.run({ tickers: ['NVDA'], depth: '1y' });
    expect(api.calls.length).toBe(before);
    expect(res.totals.apiCallsSpent).toBe(0);
    expect(res.totals.cachedDatasets).toBe(1);
  });
});
