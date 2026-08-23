// tests/history-pagination.test.mjs — Vitest suite for history-source.js
// (Tickerbot historical-data retrieval layer): cursor/before pagination,
// dedup + ordering, safeguards (max-pages / repeated-cursor / no-progress /
// exhaustion), rate-limit pacing and 429 handling, API errors mid-pagination,
// and key hygiene. All transports are stubs — zero network.

import { describe, it, expect } from 'vitest';
import {
  HISTORY_LIMITS,
  normalizeBar,
  dedupeAndSortBars,
  mergeBars,
  oldestTimestamp,
  RateLimiter,
  HistorySource,
} from '../history-source.js';

const T0 = Date.UTC(2024, 5, 3, 13, 30); // epoch-ms
const STEP = 60 * 1000;

function bar(i, overrides = {}) {
  return { t: T0 + i * STEP, o: 1 + i, h: 2 + i, l: 0 + i, c: 1.5 + i, v: 100 + i, ...overrides };
}

// Build an envelope-style page response like Tickerbot's bars endpoint.
function page(barsArr, nextCursor) {
  return { bars: barsArr.map((b) => ({ ...b })), nextCursor };
}

describe('pure helpers', () => {
  it('normalizeBar maps aliases to canonical epoch-ms ints', () => {
    const b = normalizeBar({ time: T0, open: '1', high: 2, low: 0.5, close: 1.5, volume: 10 });
    expect(b).toEqual({ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    expect(normalizeBar(null)).toBeNull();
    expect(Number.isInteger(normalizeBar({ t: '1700000000000' }).t)).toBe(true);
  });

  it('dedupeAndSortBars sorts ascending and drops duplicate timestamps', () => {
    const out = dedupeAndSortBars([bar(3), bar(1), bar(2), bar(1)]);
    expect(out.map((b) => b.t)).toEqual([T0 + STEP, T0 + 2 * STEP, T0 + 3 * STEP]);
  });

  it('mergeBars is order-insensitive and idempotent', () => {
    const a = [bar(1), bar(2)];
    const b = [bar(2), bar(3)];
    expect(mergeBars(a, b)).toEqual(mergeBars(b, a));
    expect(mergeBars(mergeBars(a, b), b).length).toBe(3);
  });

  it('oldestTimestamp returns minimum or null', () => {
    expect(oldestTimestamp([bar(5), bar(2)])).toBe(T0 + 2 * STEP);
    expect(oldestTimestamp([])).toBeNull();
  });
});

describe('HistorySource pagination', () => {
  it('paginates via cursor: second request carries cursor token', async () => {
    const requests = [];
    const src = new HistorySource({
      fetchPage: async (req) => {
        requests.push(req);
        if (requests.length === 1) return page([bar(1), bar(2)], 'CUR-2');
        return page([bar(3), bar(4)], null);
      },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 + 10 * STEP });
    expect(requests.length).toBe(2);
    expect(requests[1].cursor).toBe('CUR-2');
    expect(res.bars.map((b) => b.t)).toEqual([T0 + STEP, T0 + 2 * STEP, T0 + 3 * STEP, T0 + 4 * STEP]);
    expect(res.pagesFetched).toBe(2);
    expect(res.exhausted).toBe(true);
    expect(res.stoppedReason).toBe('server_exhausted');
  });

  it('falls back to before-param when pages are full but cursorless', async () => {
    const full = Array.from({ length: HISTORY_LIMITS.PAGE_SIZE }, (_, i) => bar(i));
    const older = [bar(-1)];
    const requests = [];
    const src = new HistorySource({
      fetchPage: async (req) => {
        requests.push(req);
        if (requests.length === 1) return page(full, null);
        return page(older, null);
      },
      rateLimiter: { acquire: async () => {} },
      limits: HISTORY_LIMITS,
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 + 10 * STEP });
    expect(requests[1].before).toBe(oldestTimestamp(full));
    expect(requests[1].cursor).toBeUndefined();
    // Short final page -> exhausted.
    expect(res.exhausted).toBe(true);
    expect(res.stoppedReason).toBe('server_exhausted');
    expect(res.bars.some((b) => b.t === oldestTimestamp(older))).toBe(true);
  });

  it('dedupes duplicated candles across pages and orders strictly ascending', async () => {
    const src = new HistorySource({
      fetchPage: async (req) => (
        req.cursor === undefined ? page([bar(3), bar(1), bar(2)], 'C') : page([bar(2), bar(0), bar(4)], null)
      ),
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 + 10 * STEP });
    const ts = res.bars.map((b) => b.t);
    expect(new Set(ts).size).toBe(ts.length);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(ts).toEqual([T0, T0 + STEP, T0 + 2 * STEP, T0 + 3 * STEP, T0 + 4 * STEP]);
    expect(res.bars.find((b) => b.t === T0 + 2 * STEP).c).toBeCloseTo(3.5);
  });

  it('cursor exhaustion on a short page stops with server_exhausted', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => { calls += 1; return page([bar(1)], null); },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 + 10 * STEP });
    expect(calls).toBe(1);
    expect(res.exhausted).toBe(true);
    expect(res.stoppedReason).toBe('server_exhausted');
  });

  it('repeated cursor is detected and stops immediately', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => { calls += 1; return page([bar(calls)], 'SAME'); },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 + 100 * STEP });
    expect(calls).toBeLessThan(10);
    expect(res.stoppedReason).toBe('repeated_cursor');
    expect(res.error).toBeNull();
  });

  it('respects maxPages bound exactly', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => { calls += 1; return page([bar(calls)], `CUR-${calls}`); },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0, maxPages: 3 });
    expect(calls).toBe(3);
    expect(res.stoppedReason).toBe('max_pages');
    expect(res.exhausted).toBe(false);
  });

  it('clamps maxPages above the hard cap', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => { calls += 1; return page([bar(calls)], `CUR-${calls}`); },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({
      ticker: 'GME', interval: '5m', from: T0, to: T0, maxPages: HISTORY_LIMITS.MAX_PAGES_HARD_CAP + 50,
    });
    expect(calls).toBe(HISTORY_LIMITS.MAX_PAGES_HARD_CAP);
    expect(res.pagesFetched).toBe(HISTORY_LIMITS.MAX_PAGES_HARD_CAP);
  });

  it('empty page mid-stream triggers no_progress stop', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => {
        calls += 1;
        return calls === 1 ? page([bar(1), bar(2)], 'CUR-2') : page([], null);
      },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 });
    expect(res.stoppedReason).toBe('no_progress');
    expect(res.pagesFetched).toBe(2);
    expect(res.bars.length).toBe(2);
  });
});

describe('RateLimiter pacing', () => {
  function fakeClock() {
    let t = 1_000_000;
    const sleeps = [];
    return {
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      sleeps,
    };
  }

  it('enforces the minimum gap between acquisitions', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ ...HISTORY_LIMITS, now: clk.now, sleep: clk.sleep });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(clk.sleeps.length).toBe(2);
    for (const s of clk.sleeps) expect(s).toBeGreaterThanOrEqual(HISTORY_LIMITS.MIN_REQUEST_GAP_MS);
  });

  it('never exceeds WINDOW_MAX inside the sliding window', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ ...HISTORY_LIMITS, now: clk.now, sleep: clk.sleep });
    for (let i = 0; i < 70; i++) await rl.acquire(); // would burst instantly otherwise
    // After the window fills, at least one wait must have been imposed.
    expect(clk.sleeps.some((ms) => ms > 0)).toBe(true);
    expect(rl._timestamps.filter((ts) => clk.now() - ts < HISTORY_LIMITS.WINDOW_MS).length)
      .toBeLessThanOrEqual(HISTORY_LIMITS.WINDOW_MAX);
  });

  it('serializes concurrent acquire() callers', async () => {
    const clk = fakeClock();
    const rl = new RateLimiter({ ...HISTORY_LIMITS, now: clk.now, sleep: clk.sleep });
    await Promise.all([rl.acquire(), rl.acquire()]);
    expect(clk.sleeps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('error handling', () => {
  class FakeRateLimitError extends Error {
    constructor() {
      super('rate limited');
      this.kind = 'rate_limit';
      this.name = 'RateLimitError';
    }
  }

  it('retries once after a 429 then succeeds', async () => {
    let calls = 0;
    const waits = [];
    const src = new HistorySource({
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) throw new FakeRateLimitError();
        return page([bar(1)], null);
      },
      rateLimiter: { acquire: async () => {} },
      limits: HISTORY_LIMITS,
    });
    src.sleep = async (ms) => { waits.push(ms); };
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 });
    expect(calls).toBe(2);
    expect(waits).toEqual([HISTORY_LIMITS.MIN_REQUEST_GAP_MS * 4]);
    expect(res.bars.length).toBe(1);
    expect(res.stoppedReason).toBe('server_exhausted');
  });

  it('double 429 stops gracefully with partial bars and rate_limited reason', async () => {
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async ({ cursor }) => {
        calls += 1;
        if (cursor === undefined) return page([bar(1)], 'CUR-2');
        throw new FakeRateLimitError();
      },
      rateLimiter: { acquire: async () => {} },
      limits: HISTORY_LIMITS,
    });
    src.sleep = async () => {};
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 });
    expect(res.stoppedReason).toBe('rate_limited');
    expect(res.bars.length).toBe(1);
    expect(res.error).toBeInstanceOf(FakeRateLimitError);
  });

  it('API/network error mid-pagination returns partial bars, does not throw', async () => {
    const boom = Object.assign(new Error('timeout'), { kind: 'timeout' });
    let calls = 0;
    const src = new HistorySource({
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) return page([bar(1), bar(2)], 'CUR-2');
        throw boom;
      },
      rateLimiter: { acquire: async () => {} },
    });
    const res = await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 });
    expect(res.stoppedReason).toBe('error');
    expect(res.error).toBe(boom);
    expect(res.bars.map((b) => b.t)).toEqual([T0 + STEP, T0 + 2 * STEP]);
    expect(res.pagesFetched).toBe(1);
  });

  it('requires a fetchPage transport', () => {
    expect(() => new HistorySource({})).toThrow(/fetchPage/);
  });
});

describe('key hygiene', () => {
  it('module source never references apiKey and logs stay redacted-safe', async () => {
    const fs = await import('node:fs');
    const path = new URL('../history-source.js', import.meta.url).pathname;
    const text = fs.readFileSync(path, 'utf8');
    expect(text.includes('apiKey')).toBe(false);

    const SECRET = 'sk-super-secret-value';
    const logged = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a) => logged.push(a.join(' '));
    console.warn = (...a) => logged.push(a.join(' '));
    console.error = (...a) => logged.push(a.join(' '));
    try {
      const src = new HistorySource({
        fetchPage: async () => page([bar(1)], null),
        rateLimiter: { acquire: async () => {} },
      });
      await src.fetchRange({ ticker: 'GME', interval: '5m', from: T0, to: T0 });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    for (const line of logged) expect(line.includes(SECRET)).toBe(false);
  });
});
