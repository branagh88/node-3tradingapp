// tests/rv-status.test.mjs — Phase 8 per-ticker validation status layer.
//
// Fully OFFLINE & DETERMINISTIC: stub transport over gen-bars fixtures
// (same patterns as tests/real-validation-ui.test.mjs). No network,
// no credentials. Tests the rv-status reducer/sanitizers/markup builders
// plus their integration with RealValidationController diagnostics.

import { describe, it, expect, vi } from 'vitest';
import { genBars } from '../scripts/research/gen-bars.mjs';
import {
  RV_STATES,
  createTickerStatus,
  applyRvEvent,
  safeErrorInfo,
  rvStateBadgeHtml,
  rvStatusStripHtml,
  buildValidationDetailsHtml,
  formatRvRetryError,
} from '../rv-status.js';
import { RealValidationController } from '../real-validation.js';
import { HistoricalAnalysisController } from '../historical-analysis.js';
import { renderRealValidationResults } from '../real-validation-ui.js';

const DAY = 24 * 3600 * 1000;

// Engine-failure injection: only active while globalThis.__rvTestEngineFail.
vi.mock('../prediction-engine.js', async (importOriginal) => {
  const mod = await importOriginal();
  const orig = mod.walkForwardParameterSearch;
  return {
    ...mod,
    walkForwardParameterSearch: (args) => {
      if (globalThis.__rvTestEngineFail) {
        const e = new Error('engine boom');
        e.name = 'EngineError';
        throw e;
      }
      return orig(args);
    },
  };
});

function freshBars(n, opts = {}) {
  const bars = genBars(n, opts);
  const shift = Date.now() - 2 * DAY - bars[bars.length - 1].t;
  return bars.map((b) => ({ ...b, t: b.t + shift }));
}

function rateLimitErr() {
  const e = new Error('429');
  e.name = 'RateLimitError';
  e.kind = 'rate_limit';
  e.status = 429;
  return e;
}

function makeStubApi({ datasets, pageSize = 500, failFirstPageOf = null, failCount = 1, errFactory = null }) {
  const failedTickers = {};
  const callsByTicker = {};
  const api = {
    callCount: (ticker) => (ticker ? (callsByTicker[ticker] || 0) : Object.values(callsByTicker).reduce((a, b) => a + b, 0)),
    fetchBarsPageRaw: async ({ ticker, from, to, cursor }) => {
      callsByTicker[ticker] = (callsByTicker[ticker] || 0) + 1;
      if (failFirstPageOf && ticker === failFirstPageOf) {
        failedTickers[ticker] = (failedTickers[ticker] || 0) + 1;
        if (failedTickers[ticker] <= failCount) throw errFactory ? errFactory() : (() => { const e = new Error('transport boom'); e.name = 'TransportError'; return e; })();
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
  // No-op rate limiter + tiny rate-limit retry delay → instant tests.
  const hist = new HistoricalAnalysisController({
    api,
    rateLimiter: { acquire: async () => {} },
    historyLimits: { RATE_LIMIT_RETRY_MS: 1 },
  });
  return new RealValidationController({ histController: hist });
}

describe('rv-status reducer transitions', () => {
  it('happy path: FETCHING HISTORY → VALIDATING → COMPLETE with attempts/candles recorded', () => {
    const map = new Map([['AAPL', createTickerStatus('AAPL')], ['MSFT', createTickerStatus('MSFT')]]);
    let m = applyRvEvent(map, { phase: 'FETCHING', ticker: 'AAPL' });
    expect(m.get('AAPL').state).toBe(RV_STATES.FETCHING_HISTORY);
    expect(m.get('MSFT').state).toBe(RV_STATES.READY);
    m = applyRvEvent(m, { phase: 'RETRIEVED', ticker: 'AAPL', fromCache: false, candles: 430, attempts: 1 });
    expect(m.get('AAPL').candles).toBe(430);
    expect(m.get('AAPL').attempts).toBe(1);
    m = applyRvEvent(m, { phase: 'BACKTESTING', ticker: 'AAPL' });
    expect(m.get('AAPL').state).toBe(RV_STATES.VALIDATING);
    m = applyRvEvent(m, { phase: 'TICKER_DONE', ticker: 'AAPL', outcome: 'complete', candles: 430, attempts: 1 });
    expect(m.get('AAPL').state).toBe(RV_STATES.COMPLETE);
    expect(m.get('AAPL').attempts).toBe(1);
    expect(m.get('MSFT').state).toBe(RV_STATES.READY); // untouched sibling
    // Pure reducer: input map never mutated.
    expect(map.get('AAPL').state).toBe(RV_STATES.READY);
  });

  it('CACHE_HIT → USING_CACHE; TICKER_FAILED → ERROR with sanitized fields; unknown events ignored', () => {
    let map = new Map([['X', createTickerStatus('X')]]);
    map = applyRvEvent(map, { phase: 'CACHE_HIT', ticker: 'X' });
    expect(map.get('X').state).toBe(RV_STATES.USING_CACHE);
    map = applyRvEvent(map, { phase: 'TICKER_FAILED', ticker: 'X', failure: safeErrorInfo({ ticker: 'X', operation: 'fetch_history', stoppedReason: 'error', attempts: 2, hasCache: false }) });
    expect(map.get('X').state).toBe(RV_STATES.ERROR);
    expect(map.get('X').stage).toBe('transport');
    expect(map.get('X').attempts).toBe(2);
    expect(applyRvEvent(map, { phase: 'NOPE', ticker: 'X' })).toBe(map);
    expect(applyRvEvent(map, { phase: 'FETCHING', ticker: 'ZZZZ' })).toBe(map);
    expect(applyRvEvent(null, { phase: 'FETCHING', ticker: 'X' })).toBe(null);
  });
});

describe('controller diagnostic integration', () => {
  it('USING CACHE: pre-seeded cache → CACHE_HIT event, COMPLETE with session-cache source, 0 API calls', async () => {
    const api = makeStubApi({ datasets: { AAPL: freshBars(450, { seed: 7 }) } });
    const rv = makeController(api);
    await rv.hist.run({ ticker: 'AAPL', depth: '1y' }); // warm the cache
    const callsAfterWarm = api.callCount();
    const events = [];
    const r = await rv.run({ tickers: ['AAPL'], depth: '1y', onProgress: (e) => events.push(e) });
    expect(events.some((e) => e.phase === 'CACHE_HIT' && e.ticker === 'AAPL')).toBe(true);
    expect(r.diagnostics.AAPL.finalState).toBe(RV_STATES.COMPLETE);
    expect(r.diagnostics.AAPL.source).toBe('session cache');
    expect(r.diagnostics.AAPL.fromCache).toBe(true);
    expect(api.callCount()).toBe(callsAfterWarm);
    expect(r.totals.apiCallsSpent).toBe(0);
  }, 120_000);

  it('INSUFFICIENT DATA: 150 bars → INSUFFICIENT_DATA state, skipped reason mentions insufficient history', async () => {
    const api = makeStubApi({ datasets: { GME: freshBars(150, { seed: 9 }) } });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['GME'], depth: '1y' });
    expect(r.diagnostics.GME.finalState).toBe(RV_STATES.INSUFFICIENT_DATA);
    expect(r.skipped[0].reason).toMatch(/insufficient history/);
    expect(r.diagnostics.GME.candles).toBe(150);
  }, 60_000);

  it('ERROR after double transport failure: ERROR state, attempts 2, stage transport, sibling COMPLETE, batch continues', async () => {
    const datasets = { AAPL: freshBars(430, { seed: 21 }), MSFT: freshBars(430, { seed: 22 }) };
    const dead = makeStubApi({ datasets, failFirstPageOf: 'AAPL', failCount: 999 });
    const rv = makeController(dead);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
      var r = await rv.run({ tickers: ['AAPL', 'MSFT'], depth: '1y' });
    } finally {
      console.warn = origWarn;
    }
    expect(r.diagnostics.AAPL.finalState).toBe(RV_STATES.ERROR);
    expect(r.diagnostics.AAPL.attempts).toBe(2);
    expect(r.diagnostics.AAPL.stage).toBe('transport');
    expect(r.diagnostics.MSFT.finalState).toBe(RV_STATES.COMPLETE);
    expect(r.included).toEqual(['MSFT']);
    // No silent swallowing: sanitized console.warn fired (no raw messages).
    expect(warns.some(([tag, obj]) => tag === '[RV] ticker failed' && obj && obj.ticker === 'AAPL' && obj.stage === 'transport')).toBe(true);
    expect(JSON.stringify(warns)).not.toContain('transport boom');
  }, 240_000);

  it('rate-limited once then success → COMPLETE with attempts 2 and cleared stage', async () => {
    const api = makeStubApi({ datasets: { TSLA: freshBars(430, { seed: 31 }) }, failFirstPageOf: 'TSLA', failCount: 2, errFactory: rateLimitErr });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['TSLA'], depth: '1y' });
    expect(r.included).toEqual(['TSLA']);
    expect(r.diagnostics.TSLA.finalState).toBe(RV_STATES.COMPLETE);
    expect(r.diagnostics.TSLA.attempts).toBe(2);
    expect(r.diagnostics.TSLA.stage).toBe(null);
    expect(api.callCount('TSLA')).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it('rate-limited on both attempts → ERROR stage rate_limited with HTTP status 429', async () => {
    const api = makeStubApi({ datasets: { NVDA: freshBars(430, { seed: 41 }) }, failFirstPageOf: 'NVDA', failCount: 999, errFactory: rateLimitErr });
    const rv = makeController(api);
    const r = await rv.run({ tickers: ['NVDA'], depth: '1y' });
    expect(r.diagnostics.NVDA.finalState).toBe(RV_STATES.ERROR);
    expect(r.diagnostics.NVDA.stage).toBe('rate_limited');
    expect(r.diagnostics.NVDA.httpStatus).toBe(429);
    expect(r.diagnostics.NVDA.attempts).toBe(2);
  }, 240_000);

  it('engine failure → ERROR with operation walk_forward and stage engine', async () => {
    globalThis.__rvTestEngineFail = true;
    try {
      const api = makeStubApi({ datasets: { AAPL: freshBars(430, { seed: 51 }) } });
      const rv = makeController(api);
      const r = await rv.run({ tickers: ['AAPL'], depth: '1y' });
      expect(r.diagnostics.AAPL.finalState).toBe(RV_STATES.ERROR);
      expect(r.diagnostics.AAPL.operation).toBe('walk_forward');
      expect(r.diagnostics.AAPL.stage).toBe('engine');
      expect(r.skipped[0].reason).toMatch(/walk-forward failed/);
    } finally {
      globalThis.__rvTestEngineFail = false;
    }
  }, 240_000);
});

describe('sanitizer security', () => {
  it('safeErrorInfo NEVER leaks message/URLs/tokens; exact key-set', () => {
    const err = new Error('GET https://x/v2 failed Authorization: Bearer sk-supersecrettoken123456');
    err.name = 'TransportError';
    const info = safeErrorInfo({ ticker: 'AAPL', operation: 'fetch_history', err, attempts: 2, hasCache: false });
    const s = JSON.stringify(info);
    expect(s).not.toContain('Bearer');
    expect(s).not.toContain('sk-');
    expect(s).not.toContain('https');
    expect(Object.keys(info).sort()).toEqual(
      ['attempts', 'errorName', 'hasCache', 'httpStatus', 'operation', 'stage', 'stoppedReason', 'ticker'].sort(),
    );
    expect(info.errorName).toBe('TransportError'); // structured name only
  });

  it('stage derivation table', () => {
    expect(safeErrorInfo({ operation: 'fetch_history', stoppedReason: 'rate_limited', err: rateLimitErr() }).stage).toBe('rate_limited');
    expect(safeErrorInfo({ operation: 'fetch_history', stoppedReason: 'max_pages' }).stage).toBe('pagination');
    expect(safeErrorInfo({ operation: 'fetch_history', stoppedReason: 'repeated_cursor' }).stage).toBe('pagination');
    const e403 = new Error('x'); e403.status = 403;
    const http = safeErrorInfo({ operation: 'fetch_history', stoppedReason: 'error', err: e403 });
    expect(http.stage).toBe('http');
    expect(http.httpStatus).toBe(403);
    expect(safeErrorInfo({ operation: 'fetch_history', stoppedReason: 'error', err: new Error('x') }).stage).toBe('transport');
    const eng = new Error('x'); eng.name = 'RangeError';
    expect(safeErrorInfo({ operation: 'walk_forward', err: eng }).stage).toBe('engine');
    expect(safeErrorInfo({}).stage).toBe('unknown');
  });

  it('formatRvRetryError is sanitized', () => {
    const err = new Error('Authorization: Bearer sk-secret123 https://api.example.com failed');
    err.name = 'TransportError';
    const msg = formatRvRetryError(err);
    expect(msg).not.toContain('Bearer');
    expect(msg).not.toContain('sk-');
    expect(msg).not.toContain('https');
    expect(msg).toContain('TransportError');
  });
});

describe('markup builders', () => {
  it('buildValidationDetailsHtml: collapsed details, required columns, esc(), error sub-block', () => {
    const html = buildValidationDetailsHtml([
      { ticker: 'A&B', finalState: 'COMPLETE', source: 'fresh fetch', hasCache: true, attempts: 1, candles: 430, stoppedReason: null, httpStatus: null, stage: null, operation: null },
      { ticker: 'XYZ', finalState: 'ERROR', source: 'fresh fetch', hasCache: false, attempts: 2, candles: 0, stoppedReason: 'rate_limited', httpStatus: 429, stage: 'rate_limited', operation: 'fetch_history', errorName: 'RateLimitError' },
    ]);
    expect(html.startsWith('<details class="rv-details">')).toBe(true);
    expect(html).not.toContain('<details class="rv-details" open');
    expect(html).toContain('>Source<');
    expect(html).toContain('>Cache present<');
    expect(html).toContain('>Attempts<');
    expect(httpSafeCandleCheck(html));
    expect(html).toContain('HTTP status');
    expect(html).toContain('429');
    expect(html).toContain('A&amp;B'); // esc applied to fixture values
    expect(html).not.toContain('<img');
    // Rows sorted by ticker.
    expect(html.indexOf('A&amp;B')).toBeLessThan(html.indexOf('XYZ'));
  });

  it('rvStatusStripHtml renders one badge per ticker', () => {
    const html = rvStatusStripHtml([createTickerStatus('AAPL'), createTickerStatus('MSFT')]);
    expect((html.match(/class="rv-status-badge rv-status-badge--/g) || []).length).toBe(2);
    expect(html).toContain('AAPL');
    expect(html).toContain('MSFT');
    expect(rvStateBadgeHtml(RV_STATES.ERROR)).toContain('rv-status-badge--error');
  });

  function httpSafeCandleCheck(html) { return html.includes('>Candles<'); }
});

describe('renderer backward compatibility', () => {
  const baseReport = {
    requested: ['AAPL'], included: ['AAPL'], skipped: [],
    perTicker: { AAPL: { status: 'COMPLETE', candles: 430, dateRange: 'r', apiRequests: 2, fromCache: false, horizons: {}, correctnessSeries: {} } },
    pooled: {},
    totals: { apiCallsSpent: 2, cachedDatasets: 0, freshDatasets: 1 },
    disclaimer: 'd',
  };

  it('report WITHOUT diagnostics renders no details block', () => {
    const html = renderRealValidationResults(baseReport);
    expect(html).not.toContain('<details class="rv-details"');
  });

  it('report WITH diagnostics adds exactly one details block before Pooled horizons', () => {
    const r = { ...baseReport, diagnostics: { AAPL: { ticker: 'AAPL', finalState: 'COMPLETE', source: 'fresh fetch', hasCache: true, attempts: 1, candles: 430, stoppedReason: null, httpStatus: null, stage: null, operation: null } } };
    const html = renderRealValidationResults(r);
    expect((html.match(/<details class="rv-details">/g) || []).length).toBe(1);
    expect(html.indexOf('rv-details')).toBeLessThan(html.indexOf('Pooled horizons'));
  });
});

describe('no hardcoded ticker universe', () => {
  it('rv-status.js and real-validation.js export no RV_TICKERS array', async () => {
    const rs = await import('../rv-status.js');
    expect('RV_TICKERS' in rs).toBe(false);
    const rv = await import('../real-validation.js');
    expect('RV_TICKERS' in rv).toBe(false);
    const fs = await import('node:fs');
    for (const f of ['rv-status.js', 'real-validation.js']) {
      expect(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).not.toMatch(/RV_TICKERS\s*=/);
    }
  });
});
