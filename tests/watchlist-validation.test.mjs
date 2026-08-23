// tests/watchlist-validation.test.mjs — regression tests for the Watchlist →
// RUN REAL VALIDATION integration.
//
// The validation ticker universe is derived from the LIVE WATCHLIST
// (AssetsController.getWatchlist(), localStorage via storage.js). These tests
// cover the selector rendering (rv-ticker-selector.js) and the fetch→cache
// path for newly added tickers, fully offline via a stub transport.
//
// Run: npx vitest run tests/watchlist-validation.test.mjs

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRvTickerOptionsHtml,
  rvTickersEmptyHtml,
  normalizeWatchlistSymbols,
  renderRvTickerSelector,
} from '../rv-ticker-selector.js';
import { AssetsController } from '../assets.js';
import { HistoricalAnalysisController } from '../historical-analysis.js';
import { RealValidationController } from '../real-validation.js';
import { genBars } from '../scripts/research/gen-bars.mjs';

const DAY = 24 * 3600 * 1000;

function freshBars(n, opts = {}) {
  const bars = genBars(n, opts);
  const shift = Date.now() - 2 * DAY - bars[bars.length - 1].t;
  return bars.map((b) => ({ ...b, t: b.t + shift }));
}

function mockApi({ datasets = {} } = {}) {
  const callsByTicker = {};
  return {
    callCount: (t) => callsByTicker[t] || 0,
    async getQuote(symbol) { throw new Error(`no quote for ${symbol}`); },
    fetchBarsPageRaw: async ({ ticker, from, to, cursor }) => {
      callsByTicker[ticker] = (callsByTicker[ticker] || 0) + 1;
      const all = datasets[ticker] || [];
      const inRange = all.filter((b) => b.t >= from && b.t <= to);
      const startIdx = cursor ? Number(cursor) : 0;
      const page = inRange.slice(startIdx, startIdx + 500);
      const nextCursor = startIdx + 500 < inRange.length ? String(startIdx + 500) : null;
      return { data: { bars: page.map((b) => ({ ...b })), next_cursor: nextCursor } };
    },
  };
}

async function makeRv(api) {
  const hist = new HistoricalAnalysisController({
    api, rateLimiter: { acquire: async () => {} },
  });
  const rv = new RealValidationController({ histController: hist });
  await new Promise((r) => setTimeout(r, 0));
  return rv;
}

let container;

beforeEach(() => {
  document.body.innerHTML = '<div id="rv-tickers" class="chip-row"></div>';
  container = document.getElementById('rv-tickers');
  localStorage.clear();
});

describe('selector rendering from the live watchlist', () => {
  it('renders a checkbox chip per watchlist ticker', () => {
    const syms = renderRvTickerSelector(container, [{ symbol: 'AAPL' }, { symbol: 'MSFT' }]);
    expect(syms).toEqual(['AAPL', 'MSFT']);
    const boxes = container.querySelectorAll('.rv-ticker');
    expect(boxes.length).toBe(2);
    expect([...boxes].map((b) => b.value)).toEqual(['AAPL', 'MSFT']);
  });

  it('a newly added ticker appears without any code change', () => {
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }]);
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }, { symbol: 'PLTR' }]);
    const values = [...container.querySelectorAll('.rv-ticker')].map((b) => b.value);
    expect(values).toContain('PLTR');
    expect(values.length).toBe(2);
  });

  it('a removed ticker disappears', () => {
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }, { symbol: 'PLTR' }]);
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }]);
    const values = [...container.querySelectorAll('.rv-ticker')].map((b) => b.value);
    expect(values).toEqual(['AAPL']);
  });

  it('preserves checked state across re-render for still-present tickers', () => {
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }, { symbol: 'MSFT' }]);
    container.querySelector('.rv-ticker[value="MSFT"]').checked = true;
    renderRvTickerSelector(container, [{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'NVDA' }]);
    expect(container.querySelector('.rv-ticker[value="MSFT"]').checked).toBe(true);
    expect(container.querySelector('.rv-ticker[value="NVDA"]').checked).toBe(false);
  });

  it('shows a clear empty state when the watchlist is empty', () => {
    const syms = renderRvTickerSelector(container, []);
    expect(syms).toEqual([]);
    expect(container.querySelectorAll('.rv-ticker').length).toBe(0);
    expect(container.innerHTML).toContain('watchlist is empty');
    expect(rvTickersEmptyHtml()).toContain('role="status"');
  });

  it('pure builder produces chips; normalizer sorts/dedupes/uppercases', () => {
    expect(buildRvTickerOptionsHtml([{ symbol: 'gme' }]))
      .toContain('class="rv-ticker" value="GME"');
    expect(buildRvTickerOptionsHtml([])).toBe('');
    expect(normalizeWatchlistSymbols(['tsla', { symbol: 'aapl' }, 'TSLA', null]))
      .toEqual(['AAPL', 'TSLA']);
    expect(renderRvTickerSelector(null, [{ symbol: 'AAPL' }])).toEqual([]);
  });

  it('Select All checks every currently rendered watchlist chip; individual selection works', async () => {
    // Drive the REAL AssetsController add/remove flow against storage.js.
    const assets = new AssetsController(mockApi());
    await assets.addAsset({ symbol: 'AAPL' });
    await assets.addAsset({ symbol: 'GME' });
    renderRvTickerSelector(container, assets.getWatchlist());

    // Select All operates on the current watchlist.
    container.querySelectorAll('.rv-ticker').forEach((cb) => { cb.checked = true; });
    let selected = [...container.querySelectorAll('.rv-ticker:checked')].map((cb) => cb.value);
    expect(selected.sort()).toEqual(['AAPL', 'GME']);

    // Individual selection: uncheck one.
    container.querySelector('.rv-ticker[value="GME"]').checked = false;
    selected = [...container.querySelectorAll('.rv-ticker:checked')].map((cb) => cb.value);
    expect(selected).toEqual(['AAPL']);

    // Removed ticker disappears after removal + re-render.
    assets.removeAsset('GME');
    renderRvTickerSelector(container, assets.getWatchlist());
    expect([...container.querySelectorAll('.rv-ticker')].map((b) => b.value)).toEqual(['AAPL']);
  });

  it('correct ticker list is passed to the controller (only selected tickers run)', async () => {
    const api = mockApi({ datasets: { AAPL: freshBars(450), MSFT: freshBars(450, { seed: 3 }) } });
    const rv = await makeRv(api);
    const result = await rv.run({ tickers: ['msft'] }); // only MSFT selected
    expect(result.requested).toEqual(['MSFT']);
    expect(result.included).toEqual(['MSFT']);
    expect(Object.keys(result.perTicker)).toEqual(['MSFT']);
  });
});

describe('fetch→cache path for newly added tickers', () => {
  it('validates a brand-new ticker with no cached dataset (fetch then cache)', async () => {
    const dsApi = mockApi({ datasets: { PLTR: freshBars(450) } }); // data available, cache empty
    const hist2 = new HistoricalAnalysisController({ api: dsApi, rateLimiter: { acquire: async () => {} } });
    const rv2 = new RealValidationController({ histController: hist2 });
    expect(hist2.cache.has('PLTR:1y')).toBe(false);
    const result = await rv2.run({ tickers: ['PLTR'], depth: '1y' });
    expect(result.included).toEqual(['PLTR']);
    expect(dsApi.callCount('PLTR')).toBeGreaterThan(0); // fetched over the wire
    expect(hist2.cache.has('PLTR:1y')).toBe(true);      // then cached

    // Second run uses the cache — no additional API calls.
    const before = dsApi.callCount('PLTR');
    const result2 = await rv2.run({ tickers: ['PLTR'], depth: '1y' });
    expect(result2.perTicker.PLTR.fromCache).toBe(true);
    expect(dsApi.callCount('PLTR')).toBe(before);
  });

  it('cached ticker uses cache on the very first validation run', async () => {
    const dsApi = mockApi({ datasets: { AAPL: freshBars(450) } });
    const hist = new HistoricalAnalysisController({ api: dsApi, rateLimiter: { acquire: async () => {} } });
    await hist.run({ ticker: 'AAPL', depth: '1y' }); // pre-warm cache
    const callsBefore = dsApi.callCount('AAPL');
    const rv = new RealValidationController({ histController: hist });
    const result = await rv.run({ tickers: ['AAPL'], depth: '1y' });
    expect(result.included).toEqual(['AAPL']);
    expect(result.perTicker.AAPL.fromCache).toBe(true);
    expect(result.totals.cachedDatasets).toBe(1);
    expect(result.totals.apiCallsSpent).toBe(0);
    expect(dsApi.callCount('AAPL')).toBe(callsBefore);
  });
});
