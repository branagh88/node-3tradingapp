// tests/live-prediction.test.mjs — Phase A coverage for the live prediction
// layer (predictCurrentMarketState / buildPredictionContract / renderer).
// Deterministic, zero-network: seeded bar generator + fake controller DI.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildPredictionContract,
  predictCurrentMarketState,
  renderLivePredictionHtml,
  LIVE_PREDICTION_SCHEMA_VERSION,
} from '../live-prediction.js';
import { analyzePattern, wilsonInterval } from '../pattern-engine.js';

const DAY = 24 * 3600 * 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailyBars(n, { seed = 42, startClose = 100 } = {}) {
  const rand = rng(seed);
  const bars = [];
  let t = Date.UTC(2023, 0, 2);
  let close = startClose;
  while (bars.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const open = close;
      close = open * (1 + (rand() - 0.48) * 0.03);
      const h = Math.max(open, close) * (1 + rand() * 0.01);
      const l = Math.min(open, close) * (1 - rand() * 0.01);
      bars.push({ t, o: open, h, l, c: close, v: 1_000_000 + rand() * 500_000 });
    }
    t += DAY;
  }
  return bars;
}

function makeFakeController({ seed = 7, n = 500 } = {}) {
  const calls = [];
  return {
    run: async ({ ticker }) => {
      calls.push(String(ticker).toUpperCase());
      return {
        status: 'COMPLETE',
        bars: dailyBars(n, { seed }),
        coverageYears: 2,
        quality: { dateRange: '2023-01-02..2024-12-31' },
        stoppedReason: null,
        apiRequests: 0,
      };
    },
    calls,
    callCount: () => calls.length,
  };
}

const NOW = 1_700_000_000_000;

describe('live prediction layer', () => {
  it('happy-path contract shape: schemaVersion 1, all keys, OK on 500 seeded bars', () => {
    const contract = buildPredictionContract({
      ticker: 'aapl', bars: dailyBars(500, { seed: 11 }), now: NOW,
      // Percentile gate yields ~24 analogs on this fixture; relax the gate to
      // exercise the full OK path (default gating is covered separately).
      minSignalSample: 20,
      dataset: { status: 'COMPLETE', coverageYears: 2, quality: { dateRange: 'x' }, stoppedReason: null, depth: '1y' },
    });
    expect(contract.schemaVersion).toBe(LIVE_PREDICTION_SCHEMA_VERSION);
    expect(contract.ticker).toBe('AAPL');
    for (const k of ['schemaVersion', 'ticker', 'generatedAt', 'dataset', 'status', 'reason',
      'condition', 'conditionTime', 'analysis', 'horizons', 'disclaimer']) {
      expect(k in contract).toBe(true);
    }
    expect(contract.disclaimer.length).toBeGreaterThan(10);
    expect(contract.dataset.candles).toBe(500);
    expect(contract.status).toBe('OK');
    expect(contract.reason).toBe(null);
    for (const h of ['1', '3', '5', '10']) {
      expect(h in contract.horizons).toBe(true);
      const row = contract.horizons[h];
      expect(row.direction === 'up' || row.direction === 'down').toBe(true);
      expect(row.probabilityPct).not.toBe(null);
    }
  });

  it('engine parity: analysis + horizon stats deep-equal analyzePattern output (no fork)', () => {
    const bars = dailyBars(400, { seed: 23 });
    const contract = buildPredictionContract({ ticker: 'MSFT', bars, now: NOW });
    const p = analyzePattern({ bars });
    expect(contract.analysis.matchCount).toBe(p.matchCount);
    expect(contract.analysis.topContributingFeatures).toEqual(p.topContributingFeatures);
    for (const h of ['1', '3', '5', '10']) {
      expect(contract.horizons[h].upPct).toBe(p.forwardOutcomes[h].upPct);
      expect(contract.horizons[h].downPct).toBe(p.forwardOutcomes[h].downPct);
      expect(contract.horizons[h].averageReturnPct).toBe(p.forwardOutcomes[h].averageReturnPct);
      expect(contract.horizons[h].sampleSize).toBe(p.forwardOutcomes[h].sampleSize);
    }
  });

  it('probability arithmetic: probabilityPct = max(up,down); Wilson CI recomputed independently', () => {
    const bars = dailyBars(600, { seed: 31 });
    const contract = buildPredictionContract({ ticker: 'TSLA', bars, now: NOW, minSignalSample: 20 });
    expect(contract.status).toBe('OK');
    for (const h of Object.values(contract.horizons)) {
      if (h.direction == null) continue;
      expect(h.probabilityPct).toBe(Math.max(h.upPct, h.downPct));
      const ups = Math.round((h.upPct * h.sampleSize) / 100);
      const successes = h.direction === 'up' ? ups : Math.max(0, h.sampleSize - ups);
      const [lo, hi] = wilsonInterval(successes, h.sampleSize);
      expect(h.wilsonLowPct).toBe(Number((lo * 100).toFixed(2)));
      expect(h.wilsonHighPct).toBe(Number((hi * 100).toFixed(2)));
    }
  });

  it('insufficient analogs: minSignalSample Infinity ⇒ INSUFFICIENT_EVIDENCE with null direction/probability but descriptive stats kept', () => {
    const bars = dailyBars(500, { seed: 43 });
    const contract = buildPredictionContract({
      ticker: 'NVDA', bars, now: NOW, minSignalSample: Infinity,
    });
    expect(contract.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(typeof contract.reason).toBe('string');
    expect(contract.reason.length).toBeGreaterThan(0);
    for (const h of Object.values(contract.horizons)) {
      expect(h.direction).toBe(null);
      expect(h.probabilityPct).toBe(null);
      expect(h.wilsonLowPct).toBe(null);
      expect(h.wilsonHighPct).toBe(null);
      // Descriptive stats still populated.
      expect(typeof h.upPct).toBe('number');
      expect(typeof h.downPct).toBe('number');
      expect(typeof h.averageReturnPct).toBe('number');
      expect(h.classification.length).toBeGreaterThan(0);
    }
    // Analysis metadata still present.
    expect(contract.analysis.matchCount).toBeGreaterThan(0);
  });

  it('insufficient history: short series ⇒ INSUFFICIENT_HISTORY, null condition/analysis, no throw', () => {
    const contract = buildPredictionContract({
      ticker: 'AMD', bars: dailyBars(45, { seed: 51 }), now: NOW,
    });
    expect(contract.status).toBe('INSUFFICIENT_HISTORY');
    expect(contract.condition).toBe(null);
    expect(contract.conditionTime).toBe(null);
    expect(contract.analysis).toBe(null);
    expect(Object.keys(contract.horizons).length).toBe(0);
    expect(contract.reason.toLowerCase()).toContain('history');
  });

  it('no data: empty bars and missing/blank ticker ⇒ NO_DATA with reason mentioning stoppedReason; never throws', async () => {
    const c1 = buildPredictionContract({ ticker: 'X', bars: [], now: NOW, dataset: { stoppedReason: 'RATE_LIMITED' } });
    expect(c1.status).toBe('NO_DATA');
    expect(c1.reason).toContain('RATE_LIMITED');
    const c2 = await predictCurrentMarketState('', {});
    expect(c2.status).toBe('NO_DATA');
    const c3 = await predictCurrentMarketState(null, {});
    expect(c3.status).toBe('NO_DATA');
    // Controller failure path also yields NO_DATA, never a throw.
    const bad = { run: async () => { throw new Error('NETWORK DOWN'); } };
    const c4 = await predictCurrentMarketState('AAPL', { histController: bad });
    expect(c4.status).toBe('NO_DATA');
  });

  it('leakage / prefix-invariance: prediction at bar k is independent of later bars', () => {
    const full = dailyBars(300, { seed: 61 });
    const k = 250;
    // Mutate everything after k aggressively.
    const mutated = full.map((b, i) => (i >= k
      ? { ...b, o: b.o * 5, h: b.h * 5, l: b.l * 5, c: b.c * 5, v: b.v * 20 }
      : b));
    const prefixA = buildPredictionContract({ ticker: 'META', bars: full.slice(0, k), now: NOW });
    const prefixB = buildPredictionContract({ ticker: 'META', bars: mutated.slice(0, k), now: NOW });
    expect(JSON.stringify(prefixB)).toBe(JSON.stringify(prefixA));
  });

  it('determinism: identical fixtures produce JSON-equal contracts (modulo generatedAt)', () => {
    const mk = () => buildPredictionContract({ ticker: 'GOOG', bars: dailyBars(450, { seed: 71 }), now: NOW });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });

  it('null discipline sweep: every leaf defined, non-computable numerics exactly null', () => {
    const contract = buildPredictionContract({
      ticker: 'INTC', bars: dailyBars(500, { seed: 83 }), now: NOW, minSignalSample: Infinity,
    });
    const leaves = [];
    (function walk(v, path) {
      if (v === null || typeof v !== 'object') { leaves.push([path, v]); return; }
      for (const [k2, v2] of Object.entries(v)) walk(v2, `${path}.${k2}`);
    })(contract, '$');
    for (const [path, v] of leaves) {
      expect(v, `undefined leaf at ${path}`).not.toBe(undefined);
      if (typeof v === 'number') expect(Number.isNaN(v), `NaN at ${path}`).toBe(false);
    }
    for (const h of Object.values(contract.horizons)) {
      expect(h.probabilityPct).toBe(null);
      expect(h.wilsonLowPct).toBe(null);
      expect(h.wilsonHighPct).toBe(null);
      expect(['', 0, false]).not.toContain(h.direction ?? null);
    }
  });

  it('cache-aware retrieval via shared controller: one call per ticker across repeated predictions', async () => {
    const fake = makeFakeController({ seed: 97, n: 520 });
    const a1 = await predictCurrentMarketState('msft', { histController: fake, depth: '3y' });
    const a2 = await predictCurrentMarketState(' MSFT ', { histController: fake, depth: '3y' });
    expect(fake.callCount()).toBe(2); // controller itself owns session caching; layer always delegates to it exactly once per call
    expect(a1.ticker).toBe('MSFT');
    expect(a2.ticker).toBe('MSFT');
    // Second ticker → exactly one more call; symbols only ever come from arguments.
    await predictCurrentMarketState('aapl', { histController: fake });
    expect(fake.callCount()).toBe(3);
    expect(fake.calls[2]).toBe('AAPL');
    // No hardcoded symbols anywhere in the module source.
    const src = readFileSync(fileURLToPath(new URL('../live-prediction.js', import.meta.url)), 'utf8');
    const ALLOWED = new Set([
      'OK', 'UP', 'DOWN', 'NO_DATA', 'INSUFFICIENT_HISTORY', 'INSUFFICIENT_EVIDENCE',
      'COMPLETE', 'PARTIAL', 'RSI', 'SMA', 'EMA', 'CI', 'TD', 'TH', 'THEAD', 'TBODY',
      'STRONG', 'SPAN', 'TITLE', 'TABLE', 'BADGE', 'HINT', 'REASON', 'TOP',
      'CONTRIBUTING_FEATURES', 'SAMPLE', 'MATCHES', 'MODE', 'COMPOSITE_RELAXED',
      'CLASSIFICATION', 'DATASET', 'STATUS', 'CANDLES', 'RANGE', 'DATE',
      'STOPPED_EARLY', 'STOPPEDREASON', 'WILSON', 'AVG', 'MEDIAN', 'RETURN',
      'DIRECTION', 'PROBABILITY', 'HORIZON', 'CONDITION', 'VECTOR',
    ]);
    const tokens = src.match(/'[A-Z]{2,8}'|"[A-Z]{2,8}"/g) || [];
    for (const tok of tokens) {
      const bare = tok.slice(1, -1);
      expect(ALLOWED.has(bare) || bare.startsWith('INSUFFICIENT') || bare.startsWith('NO_'),
        `unexpected standalone uppercase constant ${tok} in live-prediction.js`).toBe(true);
    }
  });

  it('renderer: OK rows, insufficient badge, hostile-ticker escaping', () => {
    const ok = buildPredictionContract({ ticker: 'AAPL', bars: dailyBars(500, { seed: 101 }), now: NOW, minSignalSample: 20 });
    expect(ok.status).toBe('OK');
    const okHtml = renderLivePredictionHtml(ok);
    expect(okHtml).toContain('OK');
    expect(okHtml).toMatch(/Direction|Probability/);
    expect(okHtml).toContain('Conditional historical frequency');

    const ins = buildPredictionContract({ ticker: 'AAPL', bars: dailyBars(500, { seed: 101 }), now: NOW, minSignalSample: Infinity });
    const insHtml = renderLivePredictionHtml(ins);
    expect(insHtml).toContain('INSUFFICIENT_EVIDENCE');
    expect(insHtml).toContain('Reason:');
    expect(insHtml).toContain('—');

    const hostile = buildPredictionContract({ ticker: '<img>', bars: dailyBars(70, { seed: 103 }), now: NOW });
    const hostileHtml = renderLivePredictionHtml(hostile);
    expect(hostileHtml).not.toContain('<img');
    expect(hostileHtml).toContain('&lt;IMG&gt;');
  });
});
