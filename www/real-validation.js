// real-validation.js — Phase 6 RUN REAL VALIDATION controller (browser-safe).
//
// Orchestrates the EXISTING Phase 3 walk-forward engine and Phase 5 pooled
// statistics over a user-selected multi-ticker universe, reusing the EXISTING
// HistoricalAnalysisController for retrieval (cursor pagination, rate limiter,
// honest PARTIAL status, in-memory session cache). This module NEVER creates a
// second API client, never calls fetch directly, never imports the key store,
// never reads or logs the API key. All computation after retrieval is local.
//
// Validation/descriptive only — no synthetic data is ever fabricated when a
// real fetch fails; failures land in `skipped` with a reason.

import { DEPTH_OPTIONS } from './historical-analysis.js';
import { poolHorizonCells, wilsonInterval, bootstrapCI } from './pooled-stats.js';
import { DEFAULTS as PATTERN_DEFAULTS } from './pattern-engine.js';
import { walkForwardParameterSearch } from './prediction-engine.js';
import {
  RV_STATES,
  applyRvEvent,
  createTickerStatus,
  safeErrorInfo,
} from './rv-status.js';

// NOTE: the validation ticker universe is NOT hardcoded here anymore.
// It comes from the live Watchlist (assets.getWatchlist(), localStorage via
// storage.js); see rv-ticker-selector.js + index.html #rv-tickers.
export const RV_HORIZONS = [1, 3, 5, 10];

const TRADING_DAYS_PER_YEAR = 252;
const PAGE_SIZE_ASSUMPTION = 1000; // HISTORY_LIMITS.PAGE_SIZE
const MIN_DATASET_BARS = 200;      // Phase 5 minimum candles to include a dataset

/**
 * Pure: estimate pages-per-ticker × tickers for a depth id.
 * @returns {{ pagesPerTicker: number, totalEstimatedCalls: number }}
 */
export function estimateApiCallsForDepth(tickers, depthId) {
  const opt = DEPTH_OPTIONS.find((d) => d.id === depthId) || DEPTH_OPTIONS[0];
  const days = Math.ceil(opt.years * TRADING_DAYS_PER_YEAR);
  const pagesPerTicker = Math.max(1, Math.ceil(days / PAGE_SIZE_ASSUMPTION));
  return {
    pagesPerTicker,
    totalEstimatedCalls: pagesPerTicker * (Array.isArray(tickers) ? tickers.length : 0),
  };
}

/** Pure: human warning string for the pre-run confirm step. */
export function formatCallWarning({ totalEstimatedCalls, cachedTickers = 0, freshTickers = 0, depthId = '1y' }) {
  return `Estimated API calls: ${totalEstimatedCalls} `
    + `(fresh tickers: ${freshTickers}, cached tickers: ${cachedTickers}, `
    + `dataset: ${depthId}). Free tier is rate-limited — cached datasets cost 0 calls.`;
}

export class RealValidationController {
  /**
   * @param {object} opts
   * @param {import('./historical-analysis.js').HistoricalAnalysisController} opts.histController
   *        The EXISTING controller — reused for retrieval + its session cache.
   * @param {Function} [opts.onEvent] optional ({type, ...}) telemetry sink (no key data).
   */
  constructor({ histController, onEvent } = {}) {
    if (!histController) throw new Error('RealValidationController requires a histController');
    this.hist = histController;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
  }

  _emit(evt) {
    if (this.onEvent) {
      try { this.onEvent(evt); } catch { /* listeners must not break the run */ }
    }
  }

  /** How many selected tickers are already cached at this depth (0 extra calls). */
  cachedCount(tickers, depthId) {
    let n = 0;
    for (const t of tickers || []) {
      if (this.hist.cache.has(`${String(t).toUpperCase()}:${depthId}`)) n += 1;
    }
    return n;
  }

  /**
   * Pre-run estimate honoring cache contents.
   * @returns {{ pagesPerTicker, totalEstimatedCalls, cachedTickers, freshTickers }}
   */
  estimateApiCalls(tickers, depthId) {
    const list = Array.isArray(tickers) ? tickers : [];
    const { pagesPerTicker } = estimateApiCallsForDepth(list, depthId);
    const cachedTickers = this.cachedCount(list, depthId);
    const freshTickers = list.length - cachedTickers;
    return {
      pagesPerTicker,
      totalEstimatedCalls: pagesPerTicker * freshTickers,
      cachedTickers,
      freshTickers,
    };
  }

  /**
   * Run validation over multiple tickers. Per-ticker failure does NOT abort
   * siblings: exactly ONE automatic retry per ticker whose retrieval stopped
   * with error/rate_limited; permanent failures land in `skipped`.
   *
   * @param {object} p
   * @param {string[]} p.tickers selected ticker symbols
   * @param {string} [p.depth] DEPTH_OPTIONS id (default '1y')
   * @param {boolean} [p.useCache=true]
   * @param {Function} [p.onProgress] ({ phase, ticker?, message }) => void
   */
  async run({ tickers, depth = '1y', useCache = true, onProgress } = {}) {
    const startedAt = new Date().toISOString();
    const requested = (Array.isArray(tickers) ? tickers : [])
      .map((t) => String(t || '').toUpperCase()).filter(Boolean);
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const report = (evt) => { progress(evt); this._emit(evt); };

    const retrieved = [];
    const skipped = [];
    const perTicker = {};
    // Phase 8: per-ticker diagnostic bookkeeping (observational only — the
    // retrieval sequence, retry policy, gate and report shape are unchanged).
    const diagState = { map: new Map(requested.map((t) => [t, createTickerStatus(t)])) };
    const diagEvent = (evt) => {
      try { report(evt); } catch { /* diagnostics must never break the run */ }
      try { diagState.map = applyRvEvent(diagState.map, evt); } catch { /* ignore */ }
    };
    let apiCallsSpent = 0;
    let cachedDatasets = 0;

    let idx = 0;
    for (const sym of requested) {
      idx += 1;
      // --- Retrieval via the EXISTING controller (cache-aware). ---
      report({ phase: 'RETRIEVING', ticker: sym, index: idx, total: requested.length,
        message: `Retrieving ${sym}… (${idx}/${requested.length})` });
      let result = null;
      let attempts = 0;
      // Observational cache-state event — hist.run itself still decides.
      diagEvent({ phase: this.hist.cache.has(`${sym}:${depth}`) ? 'CACHE_HIT' : 'FETCHING', ticker: sym });
      attempts += 1;
      diagEvent({ phase: 'ATTEMPT', ticker: sym, attempts });
      try {
        result = await this.hist.run({
          ticker: sym,
          depth,
          onProgress: ({ message }) => report({
            phase: 'RETRIEVING', ticker: sym, index: idx, total: requested.length, message,
          }),
        });
      } catch (err) {
        result = null;
        // One automatic re-attempt before giving up on this ticker only.
        report({ phase: 'RETRYING', ticker: sym, message: `${sym} retrieval failed once — retrying…` });
        attempts += 1;
        diagEvent({ phase: 'ATTEMPT', ticker: sym, attempts });
        try {
          result = await this.hist.run({ ticker: sym, depth, useCache });
          if (result) diagEvent({ phase: 'RETRIEVED', ticker: sym,
            fromCache: !!result.fromCache, candles: Array.isArray(result.bars) ? result.bars.length : 0,
            stoppedReason: result.stoppedReason ?? null,
            httpStatus: Number.isFinite(result.error?.httpStatus) ? result.error.httpStatus : null,
            errorName: result.error?.name ?? null, attempts });
        } catch (err2) {
          const sanitized = safeErrorInfo({ ticker: sym, operation: 'fetch_history', err: err2, attempts, hasCache: false });
          console.warn('[RV] ticker failed', sanitized);
          diagEvent({ phase: 'TICKER_FAILED', ticker: sym, failure: sanitized });
          skipped.push({
            ticker: sym,
            reason: `retrieval failed twice: ${(err2 && err2.name) || 'Error'}: ${
              String((err2 && err2.message) || err2)}`,
          });
          continue; // siblings continue — never abort the batch
        }
      }

      if (!result) {
        skipped.push({ ticker: sym, reason: 'retrieval returned no result' });
        continue;
      }

      apiCallsSpent += result.fromCache ? 0 : (result.apiRequests || 0);
      if (result.fromCache) cachedDatasets += 1;
      diagEvent({ phase: 'RETRIEVED', ticker: sym,
        fromCache: !!result.fromCache, status: result.status,
        candles: Array.isArray(result.bars) ? result.bars.length : 0,
        apiRequests: result.apiRequests || 0,
        stoppedReason: result.stoppedReason ?? null,
        errorName: result.error?.name ?? null,
        httpStatus: Number.isFinite(result.error?.httpStatus) ? result.error.httpStatus : null,
        attempts });

      // Honest failure states → one retry, then skip. Never fabricate bars.
      if (result.stoppedReason === 'error' || result.stoppedReason === 'rate_limited') {
        report({ phase: 'RETRYING', ticker: sym, message: `${sym} retrieval stopped (${result.stoppedReason}) — retrying…` });
        attempts += 1;
        diagEvent({ phase: 'ATTEMPT', ticker: sym, attempts });
        try {
          // Evict the failed PARTIAL result from the session cache so the
          // single re-attempt actually refetches instead of replaying cache.
          this.hist.cache.delete(`${sym}:${depth}`);
          const retry = await this.hist.run({ ticker: sym, depth });
          apiCallsSpent += retry.apiRequests || 0;
          result = retry;
        } catch { /* fall through to skip handling below */ }
        if (result.stoppedReason === 'error' || result.stoppedReason === 'rate_limited') {
          const sanitized = safeErrorInfo({ ticker: sym, operation: 'fetch_history', err: result.error || null,
            stoppedReason: result.stoppedReason, attempts: 2, hasCache: false });
          console.warn('[RV] ticker failed', sanitized);
          diagEvent({ phase: 'TICKER_FAILED', ticker: sym, failure: sanitized });
          skipped.push({ ticker: sym, reason: `retrieval stopped: ${result.stoppedReason}` });
          continue;
        }
      }

      // Dataset gate: <200 candles → excluded (Phase 5 minimum), no substitution.
      if (!Array.isArray(result.bars) || result.bars.length < MIN_DATASET_BARS) {
        diagEvent({ phase: 'TICKER_DONE', ticker: sym, outcome: 'insufficient_data',
          candles: result.bars ? result.bars.length : 0, attempts });
        skipped.push({
          ticker: sym,
          reason: `insufficient history: ${result.bars ? result.bars.length : 0} candles (<${MIN_DATASET_BARS})`,
        });
        continue;
      }

      retrieved.push(sym);

      // --- Engine execution (UNCHANGED engines), UI paints between tickers. ---
      report({ phase: 'BACKTESTING', ticker: sym, message: `Walk-forward on ${sym}…` });
      diagEvent({ phase: 'BACKTESTING', ticker: sym });
      await Promise.resolve(); // yield so the browser can paint
      let search;
      try {
        search = walkForwardParameterSearch({ bars: result.bars, horizons: [...RV_HORIZONS] });
      } catch (err) {
        // The ticker was optimistically added to `retrieved` before the engine
        // ran — remove it so pooling only sees engines that succeeded.
        const ri = retrieved.indexOf(sym);
        if (ri !== -1) retrieved.splice(ri, 1);
        const sanitized = safeErrorInfo({ ticker: sym, operation: 'walk_forward', err, attempts, hasCache: true });
        console.warn('[RV] ticker failed', sanitized);
        diagEvent({ phase: 'TICKER_FAILED', ticker: sym, failure: { ...sanitized, candles: result.bars.length } });
        skipped.push({
          ticker: sym,
          reason: `walk-forward failed: ${(err && err.name) || 'Error'}: ${String((err && err.message) || err)}`,
        });
        continue;
      }

      const horizons = {};
      const correctnessSeries = {};
      for (const h of RV_HORIZONS) {
        const cell = search.test?.horizons?.[h] || null;
        horizons[h] = cell;
        // Chronologically-concatenated per-signal correctness for overlap-aware CI.
        correctnessSeries[h] = Array.isArray(cell?.correctnessSeries)
          ? cell.correctnessSeries.slice()
          : buildCorrectnessProxy(cell);
      }
      perTicker[sym] = {
        status: result.status,
        candles: result.bars.length,
        dateRange: result.quality?.dateRange || null,
        apiRequests: result.apiRequests || 0,
        fromCache: !!result.fromCache,
        chosenConfig: search.chosen || null,
        paramSearchSkipped: !!search.paramSearchSkipped,
        note: search.note || null,
        horizons,
        correctnessSeries,
      };
      diagEvent({ phase: 'TICKER_DONE', ticker: sym, outcome: 'complete',
        candles: result.bars.length, attempts, fromCache: !!result.fromCache });
    }

    // --- Pooling across included tickers. ---
    report({ phase: 'POOLING', message: 'Pooling horizons…' });
    await Promise.resolve();
    const pooled = {};
    for (const h of RV_HORIZONS) {
      const cells = retrieved.map((s) => perTicker[s].horizons[h]);
      const pool = poolHorizonCells(cells, { minSignalSample: PATTERN_DEFAULTS.MIN_SIGNAL_SAMPLE });
      // Overlap guard: bootstrap CI over concatenated chronological test signals.
      const series = [];
      for (const s of retrieved) series.push(...(perTicker[s].correctnessSeries[h] || []));
      const boot = bootstrapCI(series, { horizonDays: h, seed: 42, iterations: 1000 });
      // Display annotation only — never mutates the mechanical verdict.
      let overlapAwareEdge = false;
      if (pool.verdict === 'EDGE' && h > 1 && boot && boot.lowPct != null
        && pool.bestBaselinePct != null) {
        overlapAwareEdge = boot.lowPct > pool.bestBaselinePct;
      } else if (pool.verdict === 'EDGE') {
        overlapAwareEdge = true; // h=1 windows do not overlap serially
      }
      pooled[h] = { ...pool, bootstrapCI: boot, overlapAwareEdge };
    }

    // --- Per-ticker diagnostics (Phase 8) — derived from the SAME reducer
    // helpers used by the live UI so the logic is tested once. ---
    const diagnostics = {};
    for (const [sym, st] of diagState.map.entries()) {
      diagnostics[sym] = {
        ticker: sym,
        finalState: st.state || RV_STATES.READY,
        source: st.fromCache ? 'session cache' : 'fresh fetch',
        fromCache: !!st.fromCache,
        hasCache: !!st.fromCache,
        attempts: st.attempts,
        candles: st.candles,
        stoppedReason: st.stoppedReason,
        httpStatus: st.httpStatus,
        operation: st.operation,
        stage: st.stage,
      };
    }

    const finishedAt = new Date().toISOString();
    const out = {
      requested,
      depth,
      retrieved,
      included: retrieved.slice(),
      skipped,
      perTicker,
      pooled,
      diagnostics,
      totals: {
        apiCallsSpent,
        cachedDatasets,
        freshDatasets: retrieved.filter((s) => !perTicker[s]?.fromCache).length,
      },
      disclaimer: 'Descriptive historical evaluation over real retrieved datasets — NOT a forecast.',
      startedAt,
      finishedAt,
    };
    report({ phase: 'DONE', message: 'Validation complete.', result: out });
    return out;
  }

  clearCache() { this.hist.clearCache(); }
}

/**
 * Fallback correctness proxy when the engine cell does not carry an explicit
 * per-signal series: reconstructs a deterministic 0/1 sequence matching the
 * cell's correct/predictions counts (all successes first — conservative for
 * block-bootstrap width because successes cluster).
 */
function buildCorrectnessProxy(cell) {
  if (!cell || !Number.isFinite(cell.predictions)) return [];
  const n = cell.predictions;
  const k = Math.min(n, Math.max(0, cell.correct ?? 0));
  const out = new Array(n).fill(0);
  for (let i = 0; i < k; i += 1) out[i] = 1;
  return out;
}

export default RealValidationController;
