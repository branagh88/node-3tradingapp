// tests/api-efficiency-zero-calls.test.mjs — Phase 10 zero-API-call invariants
// against a counting mocked transport (fetchBarsPageRaw). No network.

import { describe, it, expect } from 'vitest';
import { HistoricalAnalysisController } from '../historical-analysis.js';
import {
  RealValidationController,
  estimateApiCallsForDepth,
  prefetchDatasets,
} from '../real-validation.js';
import {
  buildMultiSelectSummary,
  buildRvEstimatePanelHtml,
} from '../ticker-multiselect.js';
import { normalizeWatchlistSymbols } from '../rv-ticker-selector.js';

const DAY = 24 * 3600 * 1000;

// Counting mock transport: serves `count` daily bars per ticker spanning the
// full requested window; single page when count <= limit → COMPLETE.
function mockApi({ counts = {}, fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    fetchBarsPageRaw: async (req) => {
      calls.push({ ticker: req.ticker, cursor: req.cursor ?? null });
      if (fail.includes(req.ticker)) {
        const err = new Error('transport down');
        err.status = 500;
        throw err;
      }
      const total = counts[req.ticker] ?? 400;
      const bars = [];
      let t = req.from;
      for (let i = 0; i < total; i += 1) {
        bars.push({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 });
        t += DAY;
      }
      const limit = req.limit || 1000;
      const start = req.cursor ? parseInt(req.cursor, 10) : 0;
      const page = bars.slice(start, start + limit);
      const nextCursor = start + limit < bars.length ? String(start + limit) : null;
      return { data: { bars: page, ...(nextCursor ? { next_cursor: nextCursor } : {}) } };
    },
  };
}

function makeControllers(api) {
  const hist = new HistoricalAnalysisController({ api });
  const rv = new RealValidationController({ histController: hist });
  return { hist, rv };
}

describe('zero-API-call invariants', () => {
  it('normalize / summary / estimate-panel builders never call the transport', () => {
    const api = mockApi();
    normalizeWatchlistSymbols([{ symbol: 'aapl' }, 'MSFT']);
    buildMultiSelectSummary(['AAPL'], 3);
    buildRvEstimatePanelHtml([{ ticker: 'AAPL', valid: true }], { pagesPerTicker: 1, totalEstimatedCalls: 0 });
    expect(api.calls.length).toBe(0);
  });

  it('estimatePerTicker is pure w.r.t. network (empty cache)', () => {
    const api = mockApi();
    const { rv } = makeControllers(api);
    const est = rv.estimatePerTicker(['AAPL', 'MSFT'], '1y');
    expect(api.calls.length).toBe(0);
    expect(est.perTicker).toEqual([
      { ticker: 'AAPL', cached: false, valid: false },
      { ticker: 'MSFT', cached: false, valid: false },
    ]);
    expect(est.freshTickers).toBe(2);
    expect(est.totalEstimatedCalls).toBe(2);
  });

  it('GET HISTORICAL DATA with 3 fresh tickers at 1y spends exactly pagesPerTicker × 3 page calls, sequentially', async () => {
    const api = mockApi({ counts: { AAPL: 400, MSFT: 400, NVDA: 400 } });
    const { hist } = makeControllers(api);
    const order = [];
    await prefetchDatasets(hist, {
      tickers: ['aapl', 'msft', 'nvda'],
      depth: '1y',
      onProgress: ({ phase, ticker }) => { if (phase === 'FETCHING') order.push(ticker); },
    });
    // pagesPerTicker(1y) = ceil(252/1000) = 1 → 3 calls total.
    expect(api.calls.length).toBe(3);
    expect(order).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(api.calls.map((c) => c.ticker)).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('multi-page tickers spend exactly pagesPerTicker calls each', async () => {
    // Force a second page by shrinking the server page size via the request's
    // own limit is fixed at 1000 — instead use depth 'max' (15y ⇒ many pages).
    const api = mockApi({ counts: { AAPL: 2500 } });
    const { hist } = makeControllers(api);
    const res = await prefetchDatasets(hist, { tickers: ['AAPL'], depth: 'max' });
    expect(res.failed.length).toBe(0);
    expect(res.entries[0].status).toBe('COMPLETE');
    expect(api.calls.length).toBe(res.entries[0].apiRequests);
    expect(api.calls.length).toBeGreaterThan(1); // genuinely paginated
  });

  it('second press with everything cached ⇒ 0 additional calls', async () => {
    const api = mockApi();
    const { hist } = makeControllers(api);
    await prefetchDatasets(hist, { tickers: ['AAPL', 'MSFT'], depth: '1y' });
    const afterFirst = api.calls.length;
    const res = await prefetchDatasets(hist, { tickers: ['AAPL', 'MSFT'], depth: '1y' });
    expect(api.calls.length).toBe(afterFirst);
    expect(res.entries.every((e) => e.fromCache && e.ok)).toBe(true);
  });

  it('depth change / estimate refresh while idle ⇒ 0 calls', () => {
    const api = mockApi();
    const { rv, hist } = makeControllers(api);
    for (const depth of ['1y', '3y', '5y', 'max']) {
      estimateApiCallsForDepth(['AAPL', 'MSFT'], depth);
      rv.estimateApiCalls(['AAPL', 'MSFT'], depth);
      rv.estimatePerTicker(['AAPL', 'MSFT'], depth);
      hist.hasValidDataset('AAPL', depth);
    }
    expect(api.calls.length).toBe(0);
  });

  it('all-cached shortcut path spends nothing even when prefetch is invoked with valid cache entries', async () => {
    const api = mockApi();
    const { hist } = makeControllers(api);
    await prefetchDatasets(hist, { tickers: ['AAPL'], depth: '1y' });
    const n = api.calls.length;
    // A PARTIAL entry is NOT valid — must be evicted and refetched (1 call).
    hist.cache.set('MSFT:1y', { status: 'PARTIAL', bars: [{ t: 1 }] , stoppedReason: 'error' });
    await prefetchDatasets(hist, { tickers: ['AAPL', 'MSFT'], depth: '1y' });
    expect(api.calls.length).toBe(n + 1); // only the stale MSFT refetched
    expect(hist.hasValidDataset('MSFT', '1y')).toBe(true);
  });
});
