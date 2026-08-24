// historical-analysis.js — Historical Analysis feature (asset detail view).
//
// Builds EXCLUSIVELY on history-source.js's abstraction: HistorySource
// (cursor/before pagination, dedup, chronological sort) + RateLimiter
// (≤60 req/min). It NEVER calls TickerbotAPI.getHistoricalData() and never
// re-implements pagination. DAILY ('1d') candles only.
//
// Safety maximum (configurable): 15 years of daily candles ≈ 3,800 candles,
// bounded by a max page count well under HISTORY_LIMITS.MAX_PAGES_HARD_CAP.
// The retrieval stops on: range satisfied, cursor exhaustion, repeated
// cursor, no-progress page, transport error, or rate limiting — every one of
// which yields an explicit PARTIAL dataset rather than silently filled gaps.
//
// All outputs are HISTORICAL DESCRIPTIVE STATISTICS and EMPIRICAL forward
// outcome rates only — no prediction language, no ML, no recommendations.
//
// This module NEVER references or logs the API key.

import { HistorySource, RateLimiter, dedupeAndSortBars, HISTORY_LIMITS } from './history-source.js';

export const HISTORY_ANALYSIS_LIMITS = {
  MAX_YEARS: 15,          // configurable safety maximum
  MAX_CANDLES_SOFT: 3800, // ≈15 years of daily trading days
  MAX_PAGES: 8,           // bounded page count (1000/page ⇒ ≥3800 headroom)
  INTERVAL: '1d',
};

export const DEPTH_OPTIONS = [
  { id: '1y', label: '1 Year', years: 1 },
  { id: '3y', label: '3 Years', years: 3 },
  { id: '5y', label: '5 Years', years: 5 },
  { id: 'max', label: 'Maximum Available', years: HISTORY_ANALYSIS_LIMITS.MAX_YEARS },
];

const DAY_MS = 24 * 3600 * 1000;

// Adapter: TickerbotAPI.fetchBarsPageRaw() -> HistorySource.fetchPage shape.
// Unwraps {bars|data|candles|bare array} envelopes and next_cursor aliases.
export function envelopeToPage(rawResponse) {
  const data = rawResponse?.data ?? rawResponse;
  let barsArr;
  if (Array.isArray(data)) barsArr = data;
  else if (data && typeof data === 'object') {
    barsArr = (Array.isArray(data.bars) && data.bars)
      || (Array.isArray(data.data) && data.data)
      || (Array.isArray(data.candles) && data.candles) || [];
  } else barsArr = [];
  const nextCursor = (data && typeof data === 'object' && !Array.isArray(data))
    ? (data.next_cursor ?? data.cursor ?? null)
    : null;
  return { bars: barsArr, nextCursor };
}

// ---------------------------------------------------------------------------
// Phase 10: cache-validity helpers (ADDITIVE ONLY). A cached dataset is valid
// (safe to reuse at zero API cost) only when retrieval finished COMPLETE with
// a non-empty bars array. Missing or PARTIAL entries are stale → evict+refetch.
// ---------------------------------------------------------------------------
export function isDatasetCacheEntryValid(entry) {
  return !!entry && entry.status === 'COMPLETE'
    && Array.isArray(entry.bars) && entry.bars.length > 0;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function pct(n) {
  return n == null ? null : Number((n * 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// Descriptive statistics (strictly historical — no prediction language).
// ---------------------------------------------------------------------------
export function computeStatistics(bars) {
  const out = {
    totalCandles: bars.length,
    tradingDays: bars.length, // daily candles ≈ trading days
    firstClose: null, latestClose: null,
    highestClose: null, lowestClose: null, averageClose: null,
    averageDailyReturnPct: null,
    positiveDays: 0, negativeDays: 0, flatDays: 0,
    positiveDaysPct: null, negativeDaysPct: null, flatDaysPct: null,
    largestGainPct: null, largestLossPct: null,
    avgVolume: null, maxVolume: null, minVolume: null,
  };
  if (!bars.length) return out;
  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v).filter((v) => Number.isFinite(v) && v > 0);
  out.firstClose = closes[0];
  out.latestClose = closes[closes.length - 1];
  out.highestClose = Math.max(...closes);
  out.lowestClose = Math.min(...closes);
  out.averageClose = mean(closes);
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && Number.isFinite(closes[i])) rets.push(closes[i] / closes[i - 1] - 1);
  }
  const avgRet = mean(rets);
  out.averageDailyReturnPct = pct(avgRet);
  for (const r of rets) {
    if (r > 0) out.positiveDays += 1;
    else if (r < 0) out.negativeDays += 1;
    else out.flatDays += 1;
  }
  if (rets.length) {
    out.positiveDaysPct = pct(out.positiveDays / rets.length);
    out.negativeDaysPct = pct(out.negativeDays / rets.length);
    out.flatDaysPct = pct(out.flatDays / rets.length);
    out.largestGainPct = pct(Math.max(...rets));
    out.largestLossPct = pct(Math.min(...rets));
  }
  if (volumes.length) {
    out.avgVolume = Math.round(mean(volumes));
    out.maxVolume = Math.max(...volumes);
    out.minVolume = Math.min(...volumes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empirical FORWARD OUTCOMES for horizons [1D, 3D, 5D, 10D].
// Positive/negative/flat outcome rates over ALL overlapping historical
// windows — empirical frequencies only, explicitly NOT predictive.
// Returns { horizonDays: { days, windows, positivePct, negativePct,
//                          flatPct, averageReturnPct } }.
// ---------------------------------------------------------------------------
export function computeForwardOutcomes(bars, horizons = [1, 3, 5, 10]) {
  const results = {};
  for (const h of horizons) {
    const stats = { days: h, windows: 0, positive: 0, negative: 0, flat: 0, positivePct: null, negativePct: null, flatPct: null, averageReturnPct: null };
    const rets = [];
    for (let i = 0; i + h < bars.length; i += 1) {
      const base = bars[i].c;
      const later = bars[i + h].c;
      if (!(base > 0) || !Number.isFinite(later)) continue;
      const r = later / base - 1;
      rets.push(r);
      stats.windows += 1;
      if (r > 0) stats.positive += 1;
      else if (r < 0) stats.negative += 1;
      else stats.flat += 1;
    }
    if (stats.windows > 0) {
      stats.positivePct = pct(stats.positive / stats.windows);
      stats.negativePct = pct(stats.negative / stats.windows);
      stats.flatPct = pct(stats.flat / stats.windows);
      stats.averageReturnPct = pct(mean(rets));
    }
    delete stats.positive;
    delete stats.negative;
    delete stats.flat;
    results[h] = stats;
  }
  return results;
}

// ---------------------------------------------------------------------------
// DATA QUALITY audit. Never fills gaps silently — missing trading days are
// COUNTED and reported.
// ---------------------------------------------------------------------------
export function computeDataQuality({ bars, rawCount }) {
  const q = {
    candles: bars.length,
    duplicatesRemoved: Math.max(0, (rawCount ?? bars.length) - bars.length),
    missingTradingDays: null,
    chronological: false,
    ohlcValid: false,
    volumeAvailable: false,
    oldestDate: null,
    newestDate: null,
    dateRange: null,
  };
  if (!bars.length) return q;
  q.chronological = bars.every((b, i) => i === 0 || bars[i - 1].t <= b.t);
  // Strict OHLC validity: finite, high>=low, high>=open/close, low<=open/close.
  q.ohlcValid = bars.every((b) => Number.isFinite(b.o) && Number.isFinite(b.h)
    && Number.isFinite(b.l) && Number.isFinite(b.c)
    && b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c);
  q.volumeAvailable = bars.some((b) => Number.isFinite(b.v) && b.v > 0);
  const oldest = new Date(bars[0].t);
  const newest = new Date(bars[bars.length - 1].t);
  q.oldestDate = oldest.toISOString().slice(0, 10);
  q.newestDate = newest.toISOString().slice(0, 10);
  q.dateRange = `${q.oldestDate} → ${q.newestDate}`;
  // Missing weekdays between oldest and newest (calendar approximation —
  // reported, never filled).
  let weekdayCount = 0;
  const cursor = new Date(oldest.getTime());
  while (cursor.getTime() <= newest.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) weekdayCount += 1;
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  q.missingTradingDays = Math.max(0, weekdayCount - bars.length);
  return q;
}

// Coverage in years between oldest and newest candle.
export function coverageYears(bars) {
  if (!bars || bars.length < 2) return 0;
  return Number(((bars[bars.length - 1].t - bars[0].t) / (365.25 * DAY_MS)).toFixed(2));
}

// ---------------------------------------------------------------------------
// Controller: retrieval orchestration + in-memory cache + progress reporting.
// ---------------------------------------------------------------------------
export class HistoricalAnalysisController {
  /**
   * @param {object} opts
   * @param {object} opts.api TickerbotAPI instance (uses ONLY fetchBarsPageRaw).
   * @param {RateLimiter} [opts.rateLimiter]
   * @param {object} [opts.limits] HISTORY_ANALYSIS_LIMITS overrides.
   */
  constructor({ api, rateLimiter, limits = HISTORY_ANALYSIS_LIMITS, historyLimits } = {}) {
    this.api = api;
    this.limits = limits;
    this.rateLimiter = rateLimiter;
    this.historyLimits = historyLimits;
    // In-memory cache keyed by `${TICKER}:${depthId}` — fine for a UI session.
    this.cache = new Map();
  }



  /**
   * Run a historical analysis. Never throws for retrieval issues — failures
   * are encoded in the returned result (status PARTIAL + error fields).
   * @param {Function} [opts.onProgress] ({ page, message }) => void
   */
  async run({ ticker, depth = '1y', onProgress } = {}) {
    const sym = String(ticker || '').toUpperCase();
    const opt = DEPTH_OPTIONS.find((d) => d.id === depth) || DEPTH_OPTIONS[0];
    const cacheKey = `${sym}:${opt.id}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      cached.fromCache = true;
      return cached;
    }

    const to = Date.now();
    const from = to - opt.years * 365.25 * DAY_MS;
    const maxPages = Math.min(
      this.limits.MAX_PAGES,
      HISTORY_LIMITS.MAX_PAGES_HARD_CAP,
    );

    let pagesCompleted = 0;
    let totalRawRows = 0;
    const src = new HistorySource({
      fetchPage: async (req) => {
        pagesCompleted += 1;
        if (typeof onProgress === 'function') {
          try { onProgress({ page: pagesCompleted, message: `Retrieving historical data... Page ${pagesCompleted}` }); } catch { /* progress must not break retrieval */ }
        }
        const page = envelopeToPage(await this.api.fetchBarsPageRaw({ ...req, interval: this.limits.INTERVAL }));
        totalRawRows += Array.isArray(page.bars) ? page.bars.length : 0;
        return page;
      },
      ...(this.rateLimiter ? { rateLimiter: this.rateLimiter } : {}),
      limits: { ...HISTORY_LIMITS, ...(this.historyLimits || {}) },
    });

    const retrieval = await src.fetchRange({
      ticker: sym,
      interval: this.limits.INTERVAL,
      from,
      to,
      maxPages,
    });

    const bars = retrieval.bars; // already deduped + chronologically sorted by HistorySource
    // Range satisfied? Oldest candle at/before requested window start (+3d tol).
    const rangeSatisfied = bars.length > 0 && bars[0].t <= from + 3 * DAY_MS;
    // COMPLETE only when the server ran out of data (or the loop ended with no
    // anomaly AND the range is covered). ANY other stop — error, rate_limited,
    // repeated_cursor, no_progress, max_pages — is honestly labeled PARTIAL,
    // even if enough candles happened to arrive before the failure.
    const complete = retrieval.exhausted
      || retrieval.stoppedReason === 'server_exhausted'
      || (!retrieval.stoppedReason && rangeSatisfied);
    const status = complete ? 'COMPLETE' : 'PARTIAL';

    const result = {
      ticker: sym,
      depth: opt.id,
      depthLabel: opt.label,
      status,
      interval: '1D',
      from,
      to,
      stoppedReason: retrieval.stoppedReason,
      exhausted: retrieval.exhausted,
      pagesFetched: retrieval.pagesFetched,
      pagesCompleted,
      apiRequests: retrieval.pagesFetched,
      duplicatesRemoved: Math.max(0, totalRawRows - bars.length),
      coverageYears: coverageYears(bars),
      bars,
      statistics: computeStatistics(bars),
      forwardOutcomes: computeForwardOutcomes(bars),
      quality: computeDataQuality({ bars, rawCount: totalRawRows }),
      error: retrieval.error
        ? { name: retrieval.error.name || 'Error', message: String(retrieval.error.message || ''), httpStatus: retrieval.error.status ?? null }
        : null,
      fromCache: false,
    };

    result.quality.duplicatesRemoved = result.duplicatesRemoved;
    result.quality.status = status;

    this.cache.set(cacheKey, result);
    return result;
  }

  /** Phase 10: true when `${TICKER}:${depthId}` holds a COMPLETE, non-empty dataset. */
  hasValidDataset(ticker, depthId) {
    const sym = String(ticker || '').toUpperCase();
    return isDatasetCacheEntryValid(this.cache.get(`${sym}:${depthId}`));
  }

  clearCache() { this.cache.clear(); }
}

export default HistoricalAnalysisController;
