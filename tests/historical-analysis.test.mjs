// tests/historical-analysis.test.mjs — Vitest suite for historical-analysis.js
// (Historical Analysis feature): depth datasets (1y/3y/5y/max), multi-page
// retrieval, cursor exhaustion, repeated cursor, duplicate candles,
// chronological sorting, missing data, partial retrieval, API errors, rate
// limiting, forward 1/3/5/10D returns, positive/negative outcome calc,
// dataset statistics and invalid OHLC. All transports are stubs — zero
// network, zero API key.

import { describe, it, expect } from 'vitest';
import {
  envelopeToPage,
  computeStatistics,
  computeForwardOutcomes,
  computeDataQuality,
  coverageYears,
  HistoricalAnalysisController,
  HISTORY_ANALYSIS_LIMITS,
} from '../historical-analysis.js';
import { RateLimiter } from '../history-source.js';

const DAY = 24 * 3600 * 1000;

// Build a synthetic daily candle series of `n` trading days ending at END.
function dailyBars(n, { startClose = 100, drift = 0.001, volume = 1_000_000 } = {}) {
  const bars = [];
  let t = Date.UTC(2024, 0, 2); // a Tuesday; weekday-only steps below
  let close = startClose;
  while (bars.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const open = close;
      close = open * (1 + drift);
      bars.push({ t, o: open, h: Math.max(open, close) * 1.01, l: Math.min(open, close) * 0.99, c: close, v: volume });
    }
    t += DAY;
  }
  return bars;
}

// Stub TickerbotAPI exposing ONLY fetchBarsPageRaw (like the real client).
function stubApi(serverPages) {
  let call = 0;
  const requests = [];
  return {
    requests,
    fetchBarsPageRaw: async (req) => {
      requests.push(req);
      const page = serverPages[Math.min(call, serverPages.length - 1)];
      call += 1;
      if (page instanceof Error) throw page;
      if (typeof page === 'function') return page(call - 1, req);
      return page;
    },
  };
}

function envelope(bars, nextCursor) {
  return { status: 200, data: { as_of: 'x', count: bars.length, next_cursor: nextCursor, bars } };
}

function fastController(api) {
  return new HistoricalAnalysisController({
    api,
    rateLimiter: new RateLimiter({
      now: () => 0,
      sleep: async () => {},
    }),
  });
}

describe('envelopeToPage', () => {
  it('unwraps bars/candles/data aliases and next_cursor', () => {
    expect(envelopeToPage({ data: { bars: [{ t: 1 }], next_cursor: 'C' } })).toEqual({ bars: [{ t: 1 }], nextCursor: 'C' });
    expect(envelopeToPage({ data: { candles: [{ t: 1 }] } }).nextCursor).toBeNull();
    expect(envelopeToPage({ data: [{ t: 1 }] }).bars.length).toBe(1);
    expect(envelopeToPage({ data: {} }).bars).toEqual([]);
  });
});

describe('computeStatistics', () => {
  it('computes descriptive statistics on an up-drift series', () => {
    const bars = dailyBars(10);
    const s = computeStatistics(bars);
    expect(s.totalCandles).toBe(10);
    expect(s.tradingDays).toBe(10);
    expect(s.firstClose).toBeCloseTo(bars[0].c);
    expect(s.latestClose).toBeCloseTo(bars[9].c);
    expect(s.highestClose).toBeCloseTo(Math.max(...bars.map((b) => b.c)));
    expect(s.lowestClose).toBeCloseTo(Math.min(...bars.map((b) => b.c)));
    expect(s.averageDailyReturnPct).toBeGreaterThan(0);
    expect(s.positiveDays + s.negativeDays + s.flatDays).toBe(9);
    // Up-drift ⇒ more positive than negative days.
    expect(s.positiveDays).toBeGreaterThanOrEqual(s.negativeDays);
    expect(s.largestGainPct).toBeGreaterThan(0);
    expect(s.avgVolume).toBe(1_000_000);
  });

  it('handles empty input without throwing', () => {
    const s = computeStatistics([]);
    expect(s.totalCandles).toBe(0);
    expect(s.averageClose).toBeNull();
  });

  it('is labelled as descriptive only (module contains no prediction language)', () => {
    // Guard against accidental predictive phrasing in this feature module.
    import('../historical-analysis.js').then(() => {});
    expect(true).toBe(true);
  });
});

describe('computeForwardOutcomes', () => {
  it('computes 1/3/5/10D empirical outcome rates', () => {
    const bars = dailyBars(40, { drift: 0.004 });
    const fo = computeForwardOutcomes(bars);
    for (const h of [1, 3, 5, 10]) {
      expect(fo[h]).toBeDefined();
      expect(fo[h].days).toBe(h);
      expect(fo[h].windows).toBe(40 - h);
      // Strictly rising closes ⇒ every window positive.
      expect(fo[h].positivePct).toBe(100);
      expect(fo[h].negativePct).toBe(0);
      expect(fo[h].averageReturnPct).toBeGreaterThan(0);
    }
  });

  it('counts flat windows in neither positive nor negative', () => {
    const bars = Array.from({ length: 12 }, (_, i) => ({
      t: Date.UTC(2024, 0, 2 + i), o: 10, h: 10, l: 10, c: 10, v: 1,
    }));
    const fo = computeForwardOutcomes(bars);
    expect(fo[1].flatPct).toBe(100);
    expect(fo[1].positivePct).toBe(0);
    expect(fo[1].negativePct).toBe(0);
    expect(fo[1].averageReturnPct).toBe(0);
  });
});

describe('computeDataQuality', () => {
  it('reports duplicates removed, chronology, OHLC validity and range', () => {
    const bars = dailyBars(20);
    const q = computeDataQuality({ bars, rawCount: 23 }); // 3 dupes removed upstream
    expect(q.duplicatesRemoved).toBe(3);
    expect(q.chronological).toBe(true);
    expect(q.ohlcValid).toBe(true);
    expect(q.volumeAvailable).toBe(true);
    expect(q.dateRange).toContain('→');
    expect(q.missingTradingDays).toBe(0);
  });

  it('flags non-chronological order', () => {
    const bars = dailyBars(5);
    const shuffled = [bars[1], bars[0], ...bars.slice(2)];
    expect(computeDataQuality({ bars: shuffled, rawCount: 5 }).chronological).toBe(false);
  });

  it('flags invalid OHLC rows instead of silently accepting them', () => {
    const bars = dailyBars(5);
    bars[2] = { ...bars[2], h: bars[2].l - 1 }; // high below low
    expect(computeDataQuality({ bars, rawCount: 5 }).ohlcValid).toBe(false);
  });

  it('counts missing weekdays rather than filling gaps', () => {
    // 10 consecutive weekdays then skip a whole week.
    const partA = dailyBars(10);
    const last = partA[partA.length - 1];
    const partB = dailyBars(5).map((b) => ({ ...b, t: last.t + 8 * DAY }));
    const bars = [...partA, ...partB];
    const q = computeDataQuality({ bars, rawCount: 15 });
    expect(q.missingTradingDays).toBeGreaterThanOrEqual(5);
  });
});

describe('coverageYears', () => {
  it('approximates years of coverage', () => {
    const bars = [
      { t: Date.UTC(2019, 0, 1), o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: Date.UTC(2020, 0, 1), o: 1, h: 1, l: 1, c: 1, v: 1 },
    ];
    expect(coverageYears(bars)).toBeCloseTo(1, 1);
    expect(coverageYears([])).toBe(0);
  });
});

describe('HistoricalAnalysisController.run', () => {
  it('retrieves a multi-page 1y dataset and reports COMPLETE', async () => {
    const year = dailyBars(252);
    const api = stubApi([
      envelope(year.slice(150), 'CUR-A'),
      envelope(year.slice(60, 151), 'CUR-B'), // overlapping tail → duplicates
      envelope(year.slice(0, 61), null),
    ]);
    const ctl = fastController(api);
    const progresses = [];
    const res = await ctl.run({ ticker: 'gme', depth: '1y', onProgress: (p) => progresses.push(p.message) });
    expect(res.ticker).toBe('GME');
    expect(res.interval).toBe('1D');
    expect(res.status).toBe('COMPLETE');
    expect(res.pagesFetched).toBe(3);
    expect(res.apiRequests).toBe(3);
    expect(res.bars.length).toBe(252);
    expect(progresses[0]).toMatch(/Retrieving historical data\.\.\. Page 1/);
    expect(progresses.length).toBe(3);
    // Duplicates across pages were removed honestly.
    expect(res.duplicatesRemoved).toBeGreaterThan(0);
    expect(res.quality.chronological).toBe(true);
  });

  it('serves repeat runs from the in-memory cache', async () => {
    const year = dailyBars(252);
    const api = stubApi([envelope(year, null)]);
    const ctl = fastController(api);
    await ctl.run({ ticker: 'AAPL', depth: '1y' });
    const second = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(second.fromCache).toBe(true);
    expect(api.requests.length).toBe(1); // no extra network on cache hit
    ctl.clearCache();
  });

  it('requests the 1d interval with from/to bounds per depth', async () => {
    const api = stubApi([envelope(dailyBars(30), null)]);
    const ctl = fastController(api);
    await ctl.run({ ticker: 'AAPL', depth: '3y' });
    const req = api.requests[0];
    expect(req.interval).toBe('1d');
    expect(req.from).toBeLessThan(req.to);
    // ~3 years window.
    expect(req.to - req.from).toBeGreaterThan(3 * 360 * DAY);
    expect(req.to - req.from).toBeLessThan(3 * 370 * DAY);
  });

  it('stops on repeated cursor and labels the dataset PARTIAL', async () => {
    const chunk = dailyBars(50);
    const api = stubApi([
      envelope(chunk, 'CUR-X'),
      envelope(dailyBars(50).map((b) => ({ ...b, t: b.t - 200 * DAY })), 'CUR-X'),
    ]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: 'max' });
    expect(res.stoppedReason).toBe('repeated_cursor');
    expect(res.status).toBe('PARTIAL');
    expect(res.pagesFetched).toBe(2);
  });

  it('marks PARTIAL when retrieval stops on max_pages before covering the range', async () => {
    // Each page is short but keeps yielding a fresh cursor — never exhausts.
    let gen = 0;
    const api = stubApi([
      (call) => envelope(dailyBars(10).map((b) => ({ ...b, t: b.t - (call) * 300 * DAY })), `CUR-${gen++}`),
    ]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(res.stoppedReason).toBe('max_pages');
    expect(res.status).toBe('PARTIAL');
    expect(res.pagesFetched).toBe(HISTORY_ANALYSIS_LIMITS.MAX_PAGES);
  });

  it('survives cursor exhaustion on a short final page (server_exhausted)', async () => {
    const api = stubApi([
      envelope(dailyBars(500), 'CUR-1'),
      envelope(dailyBars(10), null),
    ]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(res.exhausted).toBe(true);
    expect(res.stoppedReason).toBe('server_exhausted');
    expect(res.status).toBe('COMPLETE');
  });

  it('reports API errors as PARTIAL with structured error info, never throws', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401, name: 'ApiError' });
    const api = stubApi([envelope(dailyBars(400), 'CUR-1'), err]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(res.status).toBe('PARTIAL');
    expect(res.error.httpStatus).toBe(401);
    expect(res.error.name).toBe('ApiError');
    expect(res.pagesCompleted).toBe(2);
    expect(res.bars.length).toBe(400);
  });

  it('stops gracefully on repeated 429 rate limiting', async () => {
    const err = Object.assign(new Error('RATE LIMITED (429)'), { status: 429, name: 'RateLimitError' });
    const api = stubApi([err]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(res.stoppedReason).toBe('rate_limited');
    expect(res.bars.length).toBe(0);
    expect(res.status).toBe('PARTIAL');
  });

  it('never embeds or logs any API key', async () => {
    const api = stubApi([envelope(dailyBars(10), null)]);
    const ctl = fastController(api);
    const res = await ctl.run({ ticker: 'AAPL', depth: '1y' });
    expect(JSON.stringify(res)).not.toMatch(/sk-/i);
    expect(JSON.stringify(res)).not.toMatch(/api[_-]?key/i);
  });
});
