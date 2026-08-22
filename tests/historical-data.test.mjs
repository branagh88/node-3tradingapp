// tests/historical-data.test.mjs — regression tests for getHistoricalData()
// (api.js): GET /v2/tickers/{ticker}/bars/{interval} with a range→interval map
// (1D→5m, 5D→15m, 1M/3M/1Y→1d), from/to epoch-ms params, limit=1000, and
// tolerant unwrap of the documented Tickerbot bars envelope
// {as_of, ticker, interval, count, next_cursor, bars:[{t,o,h,l,c,v}]}
// (t in epoch-ms), plus a bare-array variant.
//
// These tests must FAIL before the endpoint rewrite and PASS after it.
//
// Run: npx vitest run tests/historical-data.test.mjs

import { describe, it, expect } from 'vitest';
import { MarketAPI, ApiError } from '../api.js';

const DAY_MS = 24 * 3600 * 1000;

// Deterministic epoch-ms timestamps (ascending, well inside the 5d window).
const T0 = Date.UTC(2024, 5, 3, 13, 30); // 1717416600000
const T1 = T0 + 5 * 60 * 1000;
const T2 = T0 + 10 * 60 * 1000;
const T3 = T0 + 15 * 60 * 1000;

function makeApi() {
  return new MarketAPI({
    apiKey: 'test-key',
    settings: { timeoutMs: 5000 },
  });
}

// Stub the transport: records every requested path so the request-shape
// assertions can inspect method/path/query without any network access,
// then resolves with the given raw payload (deep-copied, like fetch json()).
function stubFetch(api, payload) {
  const calls = [];
  api._doFetch = async (path) => {
    calls.push(String(path));
    return {
      data: JSON.parse(JSON.stringify(payload)),
      meta: { status: 200, url: String(path), strategy: 'stub', strategyErrors: [], timestamp: Date.now() },
    };
  };
  return calls;
}

function makeBars(times, basePrice = 24.6) {
  return times.map((t, i) => ({
    t,
    o: basePrice + i,
    h: basePrice + i + 1,
    l: basePrice + i - 0.5,
    c: basePrice + i + 0.25,
    v: 1000 + i * 10,
  }));
}

describe('getHistoricalData request shape', () => {
  it('GME 1D hits GET /v2/tickers/GME/bars/5m with from/to epoch-ms and limit=1000', async () => {
    const api = makeApi();
    const before = Date.now();
    const calls = stubFetch(api, { bars: makeBars([T0, T1]) });

    await api.getHistoricalData('gme', '1D');

    expect(calls.length).toBe(1);
    const url = new URL('https://stub.test' + calls[0]);
    expect(url.pathname).toBe('/v2/tickers/GME/bars/5m');
    const q = url.searchParams;
    expect(q.get('limit')).toBe('1000');
    const from = Number(q.get('from'));
    const to = Number(q.get('to'));
    // epoch-ms integers, sane ordering, and anchored around "now".
    expect(Number.isInteger(from)).toBe(true);
    expect(Number.isInteger(to)).toBe(true);
    expect(from).toBeLessThan(to);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(Date.now());
    // Same-Date.now() computation ⇒ exact 1-day span for 1D.
    expect(to - from).toBe(DAY_MS);
  });

  it('AAPL 1M maps to the 1d interval over a ~30 day window', async () => {
    const api = makeApi();
    const calls = stubFetch(api, { bars: makeBars([T0, T1]) });

    await api.getHistoricalData('aapl', '1M');

    expect(calls.length).toBe(1);
    const url = new URL('https://stub.test' + calls[0]);
    expect(url.pathname).toBe('/v2/tickers/AAPL/bars/1d');
    const q = url.searchParams;
    expect(q.get('limit')).toBe('1000');
    expect(Number(q.get('to')) - Number(q.get('from'))).toBe(30 * DAY_MS);
  });

  it.each([
    ['5D', '15m', 5 * DAY_MS],
    ['3M', '1d', 90 * DAY_MS],
    ['1Y', '1d', 365 * DAY_MS],
  ])('%s maps to %s interval with correct window', async (range, interval, ms) => {
    const api = makeApi();
    const calls = stubFetch(api, { bars: makeBars([T0, T1]) });

    await api.getHistoricalData('GME', range);

    const url = new URL('https://stub.test' + calls[0]);
    expect(url.pathname).toBe(`/v2/tickers/GME/bars/${interval}`);
    expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(ms);
    expect(url.searchParams.get('limit')).toBe('1000');
  });
});

describe('getHistoricalData parsing — documented bars envelope', () => {
  it('GME: {bars:[{t,o,h,l,c,v}]} unwraps into multiple chronologically ordered OHLCV candles', async () => {
    const api = makeApi();
    stubFetch(api, {
      as_of: new Date(T3).toISOString(),
      ticker: 'GME',
      interval: '5m',
      count: 4,
      next_cursor: null,
      bars: makeBars([T0, T1, T2, T3]),
    });

    const candles = await api.getHistoricalData('GME', '1D');

    // Failing-if-empty guard: a silent empty series must regress here.
    expect(Array.isArray(candles)).toBe(true);
    expect(candles.length).toBeGreaterThan(0);
    expect(candles).toHaveLength(4);
    // Chronologically ordered by time.
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
    }
    // Numeric prices on every candle (o/h/l/c/v).
    for (const c of candles) {
      expect(typeof c.open).toBe('number');
      expect(typeof c.high).toBe('number');
      expect(typeof c.low).toBe('number');
      expect(typeof c.close).toBe('number');
      expect(typeof c.volume).toBe('number');
      expect(Number.isNaN(c.open + c.high + c.low + c.close)).toBe(false);
    }
    // First/last timestamps preserved — epoch-ms t becomes epoch SECONDS.
    expect(candles[0].time).toBe(Math.floor(T0 / 1000));
    expect(candles[candles.length - 1].time).toBe(Math.floor(T3 / 1000));
    // Values survive the unwrap/mapping untouched.
    expect(candles[0]).toMatchObject({ open: 24.6, high: 25.6, low: 24.1, close: 24.85, volume: 1000 });
    expect(candles[3].close).toBeCloseTo(27.85, 5);
  });

  it('AAPL: same envelope parses identically for the 1M timeframe (1d bars)', async () => {
    const api = makeApi();
    stubFetch(api, { ticker: 'AAPL', interval: '1d', count: 4, bars: makeBars([T0, T1, T2, T3], 123.45) });

    const candles = await api.getHistoricalData('AAPL', '1M');

    expect(candles).toHaveLength(4);
    expect(candles[0].open).toBeCloseTo(123.45, 5);
    expect(candles[candles.length - 1].time).toBe(Math.floor(T3 / 1000));
  });

  it('bare-array variant (no envelope) still parses into candles', async () => {
    const api = makeApi();
    stubFetch(api, makeBars([T0, T1, T2]));

    const candles = await api.getHistoricalData('GME', '1D');

    expect(candles.length).toBe(3);
    expect(candles[0].time).toBe(Math.floor(T0 / 1000));
    expect(candles[0].close).toBeCloseTo(24.85, 5);
    expect(candles[2].high).toBeCloseTo(27.6, 5);
  });
});

describe('getHistoricalData edge & failure paths', () => {
  it('unknown/absent range falls back to the 1D mapping (5m, 1-day window)', async () => {
    const api = makeApi();
    const calls = stubFetch(api, { bars: makeBars([T0]) });

    await api.getHistoricalData('GME', 'NOT_A_RANGE');

    const url = new URL('https://stub.test' + calls[0]);
    expect(url.pathname).toBe('/v2/tickers/GME/bars/5m');
    expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(DAY_MS);
  });

  it('envelope present but bars array empty → returns [] (documented empty series)', async () => {
    const api = makeApi();
    stubFetch(api, { ticker: 'GME', interval: '5m', count: 0, bars: [] });

    const candles = await api.getHistoricalData('GME', '1D');

    expect(Array.isArray(candles)).toBe(true);
    expect(candles).toHaveLength(0);
  });

  it('transport failure (HTTP 500 ApiError) degrades to [] and never throws', async () => {
    const api = makeApi();
    api._doFetch = async () => {
      throw new ApiError('server', 'TICKERBOT SERVER ERROR', 500);
    };

    const candles = await api.getHistoricalData('GME', '1D');

    expect(Array.isArray(candles)).toBe(true);
    expect(candles).toHaveLength(0);
  });
});
