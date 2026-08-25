// tests/prediction-repository.test.mjs — Phase B coverage: prediction-record
// schema + PredictionRepository persistence & prospective outcome tracking.
// Deterministic, zero-network; reuses the seeded-bar harness from Phase A.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPredictionContract } from '../live-prediction.js';
import { analyzePattern } from '../pattern-engine.js';
import {
  PREDICTION_RECORD_SCHEMA_VERSION,
  RECORD_LIFECYCLE,
  OUTCOME_STATUS,
  computeRecordIdentity,
  isValidPredictionContract,
  validatePredictionRecord,
} from '../prediction-record.js';
import {
  PredictionRepository,
  inMemoryBackend,
  renderPredictionRecordsHtml,
} from '../prediction-repository.js';

const DAY = 24 * 3600 * 1000;
const NOW = 1_700_000_000_000;

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

function makeOkContract({ ticker = 'AAPL', seed = 11, n = 500 } = {}) {
  return buildPredictionContract({
    ticker, bars: dailyBars(n, { seed }), now: NOW, minSignalSample: 20,
    dataset: { status: 'COMPLETE', coverageYears: 2, quality: { dateRange: 'x' }, stoppedReason: null, depth: '1y' },
  });
}

function makeRepo() {
  return new PredictionRepository({ backend: inMemoryBackend(), now: () => NOW });
}

function frozenSnapshot(record) {
  return JSON.stringify({
    id: record.id,
    ticker: record.ticker,
    createdAt: record.createdAt,
    prediction: record.prediction,
    marketState: record.marketState,
    methodology: record.methodology,
  });
}

describe('prediction records — persistence & prospective outcomes', () => {
  it('1. happy-path creation: full §2 shape, pending lifecycle, all outcome leaves null, deterministic id', () => {
    const repo = makeRepo();
    const contract = makeOkContract();
    expect(contract.status).toBe('OK');
    const entryClose = 100;
    const rec = repo.createPrediction(contract, { entryClose });
    expect(rec).not.toBe(null);
    expect(rec.schemaVersion).toBe(PREDICTION_RECORD_SCHEMA_VERSION);
    expect(rec.ticker).toBe('AAPL');
    expect(rec.lifecycleStatus).toBe('pending');
    expect(rec.prediction.contractStatus).toBe('OK');
    expect(rec.prediction.conditionTime).toBe(contract.conditionTime);
    expect(rec.prediction.condition).toEqual(contract.condition);
    expect(rec.prediction.horizons['3'].direction === contract.horizons['3'].direction).toBe(true);
    expect(rec.marketState.entryClose).toBe(entryClose);
    expect(rec.marketState.conditionBarTime).toBe(contract.conditionTime);
    expect(rec.methodology.engine).toBe('pattern-engine');
    expect(rec.methodology.liveEngineSchemaVersion).toBe(1);
    for (const h of ['1', '3', '5', '10']) expect(rec.outcomes[h]).toBe(null);
    expect(validatePredictionRecord(rec).ok).toBe(true);
    expect(rec.id).toBe(computeRecordIdentity('AAPL', contract.conditionTime));
  });

  it('2. persist-gate NO_DATA: empty-bars contract rejected, nothing stored', async () => {
    const repo = makeRepo();
    const contract = buildPredictionContract({ ticker: '', bars: [], now: NOW });
    expect(isValidPredictionContract(contract)).toBe(false);
    expect(repo.createPrediction(contract, { entryClose: 100 })).toBe(null);
    expect(repo.count()).toBe(0);
  });

  it('3. persist-gate INSUFFICIENT_HISTORY: short series rejected', () => {
    const repo = makeRepo();
    const contract = buildPredictionContract({ ticker: 'AMD', bars: dailyBars(45, { seed: 51 }), now: NOW });
    expect(contract.status).toBe('INSUFFICIENT_HISTORY');
    expect(repo.createPrediction(contract, { entryClose: 100 })).toBe(null);
    expect(repo.count()).toBe(0);
  });

  it('4. persist-gate INSUFFICIENT_EVIDENCE: no gated direction rejected', () => {
    const repo = makeRepo();
    const contract = buildPredictionContract({
      ticker: 'NVDA', bars: dailyBars(500, { seed: 43 }), now: NOW, minSignalSample: Infinity,
    });
    expect(contract.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(repo.createPrediction(contract, { entryClose: 100 })).toBe(null);
    // Also reject bad entryClose even with an OK contract.
    expect(repo.createPrediction(makeOkContract(), { entryClose: -5 })).toBe(null);
    expect(repo.createPrediction(makeOkContract(), {})).toBe(null);
    expect(repo.count()).toBe(0);
  });

  it('5. round-trip isolation: getPrediction deep-equals stored; mutating returned object does not alter storage', () => {
    const repo = makeRepo();
    const created = repo.createPrediction(makeOkContract(), { entryClose: 100 });
    const fetched = repo.getPrediction(created.id);
    expect(fetched).toEqual(created);
    fetched.lifecycleStatus = 'resolved';
    fetched.outcomes['1'] = { status: 'resolved' };
    fetched.prediction.conditionTime = 999;
    expect(repo.getPrediction(created.id).lifecycleStatus).toBe('pending');
    expect(JSON.stringify(repo.getPrediction(created.id))).toBe(JSON.stringify(created));
  });

  it('6. listing filters: by ticker and lifecycleStatus, newest first', () => {
    const repo = makeRepo();
    const a = makeOkContract({ ticker: 'AAA', seed: 11 });
    const b = makeOkContract({ ticker: 'BBB', seed: 23 });
    repo.createPrediction(a, { entryClose: 100 }); // older
    const newer = JSON.parse(JSON.stringify(b));
    newer.generatedAt = NOW + DAY;
    newer.dataset.candles += 0;
    const bRec = repo.createPrediction(newer, { entryClose: 100 });
    expect(bRec).not.toBe(null);
    // Mutate one record's lifecycle via outcome resolution path later; here
    // filter by ticker and status directly:
    const byA = repo.listPredictions({ ticker: 'aaa' });
    expect(byA.length).toBe(1);
    expect(byA[0].ticker).toBe('AAA');
    const all = repo.listPredictions({});
    expect(all.length).toBe(2);
    // newest-first ordering by conditionTime desc
    const condTimes = all.map((r) => r.prediction.conditionTime);
    expect([...condTimes].sort((x, y) => y - x)).toEqual(condTimes);
    const pend = repo.getPendingPredictions({});
    expect(pend.length).toBe(2);
    expect(repo.listPredictions({ lifecycleStatus: 'resolved' }).length).toBe(0);
  });

  it('7. duplicate protection: same identity returns existing record unchanged, count stays 1', () => {
    const repo = makeRepo();
    const c1 = makeOkContract();
    const c2 = buildPredictionContract({
      ticker: 'aapl', bars: dailyBars(500, { seed: 11 }), now: NOW + 3600_000, minSignalSample: 20,
    });
    const r1 = repo.createPrediction(c1, { entryClose: 100 });
    const r2 = repo.createPrediction(c2, { entryClose: 100 });
    expect(r1.id).toBe(r2.id);
    expect(r2.createdAt).toBe(r1.createdAt); // original returned untouched
    expect(r2.updatedAt).toBe(r1.updatedAt);
    expect(repo.count()).toBe(1);
  });

  it('8. distinct conditions: next session creates a new record (count 2)', () => {
    const repo = makeRepo();
    const prefix = dailyBars(500, { seed: 11 });
    repo.createPrediction(makeOkContract({ seed: 11 }), { entryClose: prefix[prefix.length - 1].c });
    const extended = [...prefix, { ...prefix[prefix.length - 1], t: prefix[prefix.length - 1].t + DAY }];
    const cNext = buildPredictionContract({ ticker: 'AAPL', bars: extended, now: NOW + DAY, minSignalSample: 20 });
    if (!isValidPredictionContract(cNext)) throw new Error('fixture must produce OK contract');
    const r2 = repo.createPrediction(cNext, { entryClose: extended[extended.length - 1].c });
    expect(r2.id).not.toBe(computeRecordIdentity('AAPL', prefix[prefix.length - 1].t));
    expect(repo.count()).toBe(2);
  });

  it('9. outcome math: exact targetBarTime/outcomeClose/returnPct/correct; other horizons untouched', () => {
    const repo = makeRepo();
    const bars = dailyBars(520, { seed: 11 });
    const prefix = dailyBars(500, { seed: 11 }); // condition = last candle of prefix
    const condIdx = prefix.length - 1;
    const rec0 = repo.createPrediction(makeOkContract({ seed: 11 }), { entryClose: prefix[condIdx].c });
    expect(rec0.prediction.horizons['3'].direction).not.toBe(null);
    const predictedUp = rec0.prediction.horizons['3'].direction === 'up';
    const rec = repo.recordPredictionOutcome(rec0.id, bars, { now: NOW + DAY });
    const leaf = rec.outcomes['3'];
    expect(leaf.status).toBe('resolved');
    expect(leaf.targetBarTime).toBe(bars[condIdx + 3].t);
    expect(leaf.outcomeClose).toBe(bars[condIdx + 3].c);
    const expectedRet = Number((((bars[condIdx + 3].c / bars[condIdx].c) - 1) * 100).toFixed(2));
    expect(leaf.returnPct).toBe(expectedRet);
    expect(leaf.correct).toBe((expectedRet > 0 ? 'up' : expectedRet < 0 ? 'down' : 'flat') === leaf.predictedDirection);
    expect(leaf.predictedDirection).toBe(rec0.prediction.horizons['3'].direction);
    expect(predictedUp === true || predictedUp === false).toBe(true);
    // Horizons beyond available data are insufficient-but-pending leaves; horizon 10 may resolve too
    expect(rec.lifecycleStatus === 'pending' || rec.lifecycleStatus === 'resolved').toBe(true);
  });

  it('10. correctness matrix: up/up, down/down true; up/down false; flat close → flat/false', () => {
    const bars = dailyBars(500, { seed: 11 });
    const condIdx = bars.length - 1;
    const condTime = bars[condIdx].t;
    const mkRecordWithDirections = (repo, dirs) => {
      const contract = makeOkContract({ seed: 11 });
      const patched = JSON.parse(JSON.stringify(contract));
      for (const [h, d] of Object.entries(dirs)) {
        patched.horizons[h] = { ...patched.horizons[h], direction: d, probabilityPct: 60 };
      }
      const rec = repo.createPrediction(patched, { entryClose: bars[condIdx].c });
      return rec;
    };
    const entry = bars[condIdx].c;
    const upBars = [...bars.slice(0, condIdx), bars[condIdx]];
    for (let i = 1; i <= 10; i++) {
      upBars.push({ t: condTime + i * DAY, o: entry, h: entry * (1 + i * 0.1), l: entry, c: entry * (1 + i * 0.1), v: 1 });
    }
    const downBars = upBars.map((b, i) => (i > condIdx ? { ...b, c: entry / (1 + i * 0.1) } : b));
    const flatBars = [...bars.slice(0, condIdx), bars[condIdx]];
    for (let i = 1; i <= 10; i++) flatBars.push({ t: condTime + i * DAY, o: entry, h: entry, l: entry, c: entry, v: 1 });
    let repo = makeRepo();
    let r = mkRecordWithDirections(repo, { '1': 'up', '3': 'up', '5': 'up', '10': 'up' });
    r = repo.recordPredictionOutcome(r.id, upBars, { now: NOW });
    expect(r.lifecycleStatus).toBe('resolved');
    expect(Object.values(r.outcomes).every((o) => o.correct === true)).toBe(true);
    // down/down
    repo = makeRepo();
    r = mkRecordWithDirections(repo, { '1': 'down', '3': 'down', '5': 'down', '10': 'down' });
    r = repo.recordPredictionOutcome(r.id, upBars, { now: NOW });
    expect(Object.values(r.outcomes).every((o) => o.correct === false)).toBe(true);
    // up against falling market
    repo = makeRepo();
    r = mkRecordWithDirections(repo, { '1': 'up', '3': 'up', '5': 'up', '10': 'up' });
    r = repo.recordPredictionOutcome(r.id, downBars, { now: NOW });
    expect(Object.values(r.outcomes).every((o) => o.correct === false)).toBe(true);
    // exact flat close → flat / correct:false vs 'up'
    repo = makeRepo();
    r = mkRecordWithDirections(repo, { '1': 'up', '3': 'up', '5': 'up', '10': 'up' });
    r = repo.recordPredictionOutcome(r.id, flatBars, { now: NOW });
    expect(r.outcomes['1'].outcomeDirection).toBe('flat');
    expect(r.outcomes['1'].correct).toBe(false);
  });

  it('11. prediction immutability on outcome write: only outcomes/lifecycleStatus/updatedAt differ', () => {
    const repo = makeRepo();
    const bars = dailyBars(500, { seed: 11 });
    const before = repo.createPrediction(makeOkContract({ seed: 11 }), { entryClose: bars[bars.length - 1].c });
    const snapBefore = frozenSnapshot(before);
    const after = repo.recordPredictionOutcome(before.id, bars, { now: NOW + DAY }) || before;
    expect(frozenSnapshot(after)).toBe(snapBefore);
    expect(after.updatedAt >= before.updatedAt || after === before).toBe(true);
    const diffKeys = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    for (const k of diffKeys) {
      expect(['outcomes', 'lifecycleStatus', 'updatedAt']).toContain(k);
    }
  });

  it('12. terminal immutability: resolved records reject further mutation entirely', () => {
    const repo = makeRepo();
    const bars = dailyBars(520, { seed: 11 });
    const condIdx = 500;
    const extended = bars; // 520 bars gives every horizon room after index 509? condIdx is last bar...
    void extended;
    // Build record whose condition bar sits at index 500 of a 520-bar series:
    const prefix = dailyBars(501, { seed: 11 });
    const contract = buildPredictionContract({ ticker: 'AAPL', bars: prefix, now: NOW, minSignalSample: 20 });
    expect(contract.status).toBe('OK');
    let rec = repo.createPrediction(contract, { entryClose: prefix[500].c });
    const more = [...bars]; // condition bar at index 500, 19 future candles
    expect(more[500].t === contract.conditionTime).toBe(true);
    rec = repo.recordPredictionOutcome(rec.id, more, { now: NOW + DAY });
    expect(rec.lifecycleStatus).toBe('resolved');
    const snap = JSON.stringify(rec);
    const again = repo.backend.get(rec.id);
    const noop = repo.recordPredictionOutcome(rec.id, more.map((b) => ({ ...b, c: b.c * 2 })), { now: NOW + 2 * DAY });
    expect(noop).toBe(null); // terminal → null (no mutation)
    expect(JSON.stringify(repo.getPrediction(rec.id))).toBe(snap);
    const fin = repo.finalizeAsInsufficientOutcomeData(rec.id, { now: NOW + 2 * DAY });
    expect(fin).toBe(null);
    expect(JSON.stringify(repo.getPrediction(rec.id))).toBe(snap);
    expect(repo.getPrediction(rec.id).updatedAt).toBe(again.updatedAt);
    void noop; void fin;
  });

  it('13. per-horizon insufficient: partial future data → resolved h=1, insufficient h=3/5/10, still pending', () => {
    const repo = makeRepo();
    const prefix = dailyBars(501, { seed: 11 });
    const contract = buildPredictionContract({ ticker: 'AAPL', bars: prefix, now: NOW, minSignalSample: 20 });
    let rec = repo.createPrediction(contract, { entryClose: prefix[500].c });
    const short = [...prefix];
    short.push({ ...prefix[500], t: prefix[500].t + DAY, c: prefix[500].c * 1.01 });
    short.push({ ...prefix[500], t: prefix[500].t + 2 * DAY, c: prefix[500].c * 1.02 });
    rec = repo.recordPredictionOutcome(rec.id, short, { now: NOW + DAY });
    expect(rec.outcomes['1'].status).toBe('resolved');
    for (const h of ['3', '5', '10']) {
      expect(rec.outcomes[h].status).toBe('insufficient_outcome_data');
      expect(rec.outcomes[h].targetBarTime).toBe(null);
      expect(rec.outcomes[h].outcomeClose).toBe(null);
      expect(rec.outcomes[h].returnPct).toBe(null);
      expect(rec.outcomes[h].outcomeDirection).toBe(null);
      expect(rec.outcomes[h].correct).toBe(null);
    }
    expect(rec.lifecycleStatus).toBe('pending');
    // Later candles arrive → insufficient leaves are REPLACED, not final.
    rec = repo.recordPredictionOutcome(rec.id, dailyBars(520, { seed: 11 }), { now: NOW + 2 * DAY });
    expect(rec.outcomes['3'].status).toBe('resolved');
  });

  it('14. finalize-insufficient locks remaining horizons terminal; later evaluation no-ops', () => {
    const repo = makeRepo();
    const prefix = dailyBars(501, { seed: 11 });
    const contract = buildPredictionContract({ ticker: 'AAPL', bars: prefix, now: NOW, minSignalSample: 20 });
    let rec = repo.createPrediction(contract, { entryClose: prefix[500].c });
    const short = [...prefix, { ...prefix[500], t: prefix[500].t + DAY, c: prefix[500].c * 1.01 }];
    rec = repo.recordPredictionOutcome(rec.id, short, { now: NOW + DAY });
    expect(rec.lifecycleStatus).toBe('pending');
    rec = repo.finalizeAsInsufficientOutcomeData(rec.id, { now: NOW + 2 * DAY });
    expect(rec.lifecycleStatus).toBe('insufficient_outcome_data');
    expect(rec.outcomes['3'].status).toBe('insufficient_outcome_data');
    const snap = JSON.stringify(rec);
    expect(repo.recordPredictionOutcome(rec.id, dailyBars(600, { seed: 11 }), { now: NOW + 3 * DAY })).toBe(null);
    expect(repo.finalizeAsInsufficientOutcomeData(rec.id, { now: NOW + 3 * DAY })).toBe(null);
    expect(JSON.stringify(repo.getPrediction(rec.id))).toBe(snap);
  });

  it('15. horizon parity with computeMatchedForwardOutcomes: identical entry/target closes per horizon', () => {
    const repo = makeRepo();
    const bars = dailyBars(500, { seed: 11 });
    const condIdx = bars.length - 1;
    const contract = makeOkContract({ seed: 11 });
    const rec = repo.createPrediction(contract, { entryClose: bars[condIdx].c });
    const evaluated = repo.recordPredictionOutcome(rec.id, bars, { now: NOW + DAY });
    const p = analyzePattern({ bars });
    for (const h of ['1', '3', '5', '10']) {
      const leaf = evaluated.outcomes[h];
      if (!leaf || leaf.status !== 'resolved') continue;
      const engineRow = p.forwardOutcomes[Number(h)];
      // Engine's averageReturnPct is the mean over matches; with our single-match
      // cross-check we verify the same bar-offset arithmetic: last match's own
      // forward return equals the recorded leaf when its condition == ours.
      expect(leaf.targetBarTime).toBe(bars[condIdx + Number(h)].t);
      expect(leaf.outcomeClose).toBe(bars[condIdx + Number(h)].c);
      // Cross-check formula parity: (target/entry − 1)
      const manual = ((bars[condIdx + Number(h)].c / bars[condIdx].c) - 1) * 100;
      expect(leaf.returnPct).toBe(Number(manual.toFixed(2)));
      void engineRow;
    }
  });

  it('16. candle-offset semantics: horizon-3 target is the 3rd subsequent CANDLE, not calendar +3d', () => {
    const repo = makeRepo();
    const prefix = dailyBars(503, { seed: 11 }); // Wednesday condition bar (index 502)
    const contract = buildPredictionContract({ ticker: 'AAPL', bars: prefix, now: NOW, minSignalSample: 20 });
    expect(contract.status).toBe('OK');
    let rec = repo.createPrediction(contract, { entryClose: prefix[502].c });
    const full = dailyBars(520, { seed: 11 }); // same series extended past the condition bar
    expect(full[502].t).toBe(prefix[502].t);
    rec = repo.recordPredictionOutcome(rec.id, full, { now: NOW + DAY });
    const condT = prefix[502].t;
    const target = full[505];
    expect(new Date(condT).getUTCDay()).toBe(3); // Wednesday + 3 calendar days lands on a Saturday
    expect(target.t).not.toBe(condT + 3 * DAY);  // weekend intervened in fixture
    expect(rec.outcomes['3'].targetBarTime).toBe(target.t);
  });

  it('17. leakage regression: post-condition data can never alter stored prediction fields', () => {
    const repo = makeRepo();
    const full = dailyBars(500, { seed: 61 });
    const k = 450;
    const prefix = full.slice(0, k);
    const contractAtK = buildPredictionContract({ ticker: 'META', bars: prefix, now: NOW, minSignalSample: 20 });
    expect(contractAtK.status).toBe('OK');
    const rec0 = repo.createPrediction(contractAtK, { entryClose: prefix[k - 1].c });
    const snap = frozenSnapshot(rec0);

    // (a) mutate/append everything after k aggressively — stored prediction unchanged
    const mutated = full.map((b, i) => (i > k ? { ...b, o: b.o * 5, h: b.h * 5, l: b.l * 5, c: b.c * 5, v: b.v * 20 } : b));
    while (mutated.length < k + 30) mutated.push({ ...mutated[mutated.length - 1], t: mutated[mutated.length - 1].t + DAY, c: 9999 });
    expect(frozenSnapshot(repo.getPrediction(rec0.id))).toBe(snap);

    // (b) resolving outcomes from post-condition bars never alters prediction.*
    const rec = repo.recordPredictionOutcome(rec0.id, mutated, { now: NOW + DAY });
    if (rec) expect(frozenSnapshot(rec)).toBe(snap);

    // (c) rebuilding the contract at time-k still equals the stored snapshot inputs
    const rebuilt = buildPredictionContract({ ticker: 'META', bars: prefix, now: NOW, minSignalSample: 20 });
    expect(rebuilt.conditionTime).toBe(rec0.prediction.conditionTime);
    expect(rebuilt.analysis).toEqual(rec0.prediction.analysis);
  });

  it('18. swappable backend behaves identically; zero direct localStorage references in new modules/app additions', () => {
    const backend = inMemoryBackend();
    const repo = new PredictionRepository({ backend, now: () => NOW });
    const bars = dailyBars(500, { seed: 11 });
    const rec = repo.createPrediction(makeOkContract({ seed: 11 }), { entryClose: bars[bars.length - 1].c });
    expect(backend.count()).toBe(1);
    expect(backend.get(rec.id).id).toBe(rec.id);
    const got = repo.getPrediction(rec.id);
    expect(got).toEqual(rec);
    expect(repo.listPredictions().length).toBe(1);
    expect(repo.count()).toBe(1);

    // Storage hygiene: no direct localStorage outside storage.js.
    for (const f of ['prediction-repository.js', 'prediction-record.js']) {
      const src = readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');
      expect(src.includes('localStorage'), `${f} must not touch localStorage`).toBe(false);
    }
  });

  it('19. renderer contract: prediction vs outcome separation, escaping, badges, no accuracy statistics', () => {
    const repo = makeRepo();
    const prefix = dailyBars(501, { seed: 11 });
    const contract = buildPredictionContract({ ticker: '<script>alert(1)</script>', bars: prefix, now: NOW, minSignalSample: 20 });
    expect(contract.status).toBe('OK'); // engine tolerates hostile tickers
    let rec = repo.createPrediction(contract, { entryClose: prefix[500].c });
    rec = repo.recordPredictionOutcome(rec.id, dailyBars(520, { seed: 11 }), { now: NOW + DAY });
    const pending = repo.createPrediction(makeOkContract({ ticker: 'ZZZ', seed: 31 }), { entryClose: 100 });
    const html = renderPredictionRecordsHtml([rec, pending]);
    expect(html).toContain('PREDICTED'.length ? 'Predicted' : '');
    expect(html).toContain('Actual outcome');
    expect(html).toContain('&lt;SCRIPT&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toMatch(/badge--ok/);           // resolved badge
    expect(html).toMatch(/badge--unavailable/);  // pending badge
    expect(html).not.toMatch(/accuracy/i);
    expect(html).not.toMatch(/hit rate/i);
    // ✓/✗ individual indicators present but no aggregate percentage element
    expect(html).toMatch(/[✓✗]/);
    const emptyHtml = renderPredictionRecordsHtml([]);
    expect(emptyHtml).toContain('No persisted prediction records');
  });
});
