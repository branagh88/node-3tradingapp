// history-source.js — Tickerbot historical-data retrieval layer.
//
// Cursor/`before` pagination over GET /v2/tickers/{sym}/bars/{interval} with:
//   - infinite-loop safeguards (max-pages bound, repeated-cursor detection,
//     no-progress guard, server-exhausted completion),
//   - client-side rate limiting to ≤60 req/min (sliding 60 s window capped at
//     55 requests + a ≥1100 ms minimum gap between consecutive requests),
//   - chronological ordering + candle deduplication,
//   - bounded-by-default fetching (5 pages ≈ 5,000 bars); deep/backfill
//     fetches are explicit opt-in via maxPages (≤ hard cap),
//   - cache-ready merge helpers (pure, deterministic, idempotent).
//
// THIS MODULE NEVER SELF-TRIGGERS. Nothing here runs on asset open; some
// future caller (cache warmer / pattern engine) must invoke it deliberately.
// Chart loading continues to go through TickerbotAPI.getHistoricalData().
//
// The module depends only on an injected transport function (`fetchPage`),
// defaulting to the API client's `fetchBarsPageRaw` adapter, so it can be
// tested with zero network. It NEVER references or logs the API key.

import { RateLimitError } from './api.js';

export const HISTORY_LIMITS = {
  MAX_PAGES_DEFAULT: 5,      // bounded default fetch (asset-open-safe)
  MAX_PAGES_HARD_CAP: 200,   // absolute ceiling even for explicit deep fetches
  PAGE_SIZE: 1000,           // server maximum per cursor/page
  MIN_REQUEST_GAP_MS: 1100,  // ≈54 req/min worst case, under the 60/min cap
  WINDOW_MS: 60_000,
  WINDOW_MAX: 55,            // sliding-window ceiling below 60
};

// Normalize one raw bar row into the canonical {t,o,h,l,c,v} shape
// (epoch-ms integer timestamp). Returns null for unusable rows.
export function normalizeBar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tRaw = raw.t ?? raw.time ?? raw.timestamp;
  // Accept epoch-ms numbers and numeric strings (e.g. from JSON strings);
  // anything else goes through the Date parser.
  const tNum = (typeof tRaw === 'number' || (typeof tRaw === 'string' && /^\d+$/.test(tRaw.trim())))
    ? Number(tRaw)
    : new Date(tRaw ?? Date.now()).getTime();
  const t = Math.floor(tNum);
  if (!Number.isFinite(t)) return null;
  return {
    t,
    o: Number(raw.o ?? raw.open ?? 0),
    h: Number(raw.h ?? raw.high ?? 0),
    l: Number(raw.l ?? raw.low ?? 0),
    c: Number(raw.c ?? raw.close ?? 0),
    v: Number(raw.v ?? raw.volume ?? 0),
  };
}

// Deduplicate bars by timestamp and sort strictly ascending. Deterministic
// and idempotent; first occurrence of a duplicated t wins.
export function dedupeAndSortBars(bars) {
  const byT = new Map();
  for (const raw of (bars || [])) {
    const bar = raw && raw.t !== undefined && raw.o !== undefined ? raw : normalizeBar(raw);
    if (!bar) continue;
    if (!byT.has(bar.t)) byT.set(bar.t, bar);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// Cache-ready merge: dedup union of existing + incoming, sorted ascending.
// Order-insensitive and idempotent — mergeBars(a, b) === mergeBars(b, a).
export function mergeBars(existing, incoming) {
  return dedupeAndSortBars([...(existing || []), ...(incoming || [])]);
}

// Oldest (minimum) epoch-ms timestamp among normalized bars, or null.
export function oldestTimestamp(bars) {
  let min = null;
  for (const bar of (bars || [])) {
    const t = typeof bar?.t === 'number' ? bar.t : normalizeBar(bar)?.t;
    if (typeof t === 'number' && (min === null || t < min)) min = t;
  }
  return min;
}

// Client-side rate limiter: sliding window (windowMax per windowMs) plus a
// minimum gap between consecutive acquisitions. Clock and sleep are injectable
// so tests run instantly without real timers.
export class RateLimiter {
  constructor({ windowMs = HISTORY_LIMITS.WINDOW_MS, windowMax = HISTORY_LIMITS.WINDOW_MAX,
    minGapMs = HISTORY_LIMITS.MIN_REQUEST_GAP_MS, now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.windowMs = windowMs;
    this.windowMax = windowMax;
    this.minGapMs = minGapMs;
    this.now = now;
    this.sleep = sleep;
    this._timestamps = [];
    this._lastAcquire = null;
    this._chain = Promise.resolve(); // serialize concurrent acquire() calls
  }

  // Resolves only when a request slot is available.
  acquire() {
    const call = this._chain.then(() => this._acquireInner());
    // Keep the chain alive even if a waiter rejects (it never should).
    this._chain = call.catch(() => {});
    return call;
  }

  async _acquireInner() {
    for (;;) {
      const nowTs = this.now();
      // Expire timestamps outside the sliding window.
      while (this._timestamps.length && nowTs - this._timestamps[0] >= this.windowMs) {
        this._timestamps.shift();
      }
      const gapWait = this._lastAcquire !== null
        ? Math.max(0, this._lastAcquire + this.minGapMs - nowTs)
        : 0;
      const windowFull = this._timestamps.length >= this.windowMax;
      const oldest = this._timestamps.length ? this._timestamps[0] : null;
      const windowWait = windowFull && oldest !== null
        ? Math.max(1, this.windowMs - (nowTs - oldest))
        : 0;
      const wait = Math.max(gapWait, windowWait);
      if (wait === 0) {
        this._timestamps.push(nowTs);
        this._lastAcquire = nowTs;
        return;
      }
      await this.sleep(wait);
    }
  }
}

// Orchestrator: fetches a full historical range page by page with safeguards.
export class HistorySource {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchPage async ({ ticker, interval, from, to, before?, cursor?, limit })
   *   -> { bars: [{t,o,h,l,c,v}], nextCursor: string|null } — errors propagate.
   * @param {RateLimiter} [opts.rateLimiter]
   * @param {object} [opts.limits] HISTORY_LIMITS-style overrides.
   */
  constructor({ fetchPage, rateLimiter, limits = HISTORY_LIMITS } = {}) {
    if (typeof fetchPage !== 'function') throw new Error('HistorySource requires a fetchPage function');
    this.fetchPage = fetchPage;
    this.rateLimiter = rateLimiter || new RateLimiter(limits);
    this.limits = limits;
  }

  /**
   * Fetch up to maxPages pages of bars for [from, to]. Never throws for
   * transport/pagination issues — failures are reported via stoppedReason.
   * @returns {Promise<{ bars: Array, pagesFetched: number, exhausted: boolean,
   *   stoppedReason: string|null, error: Error|null }>}
   *   stoppedReason ∈ null | 'server_exhausted' | 'max_pages' | 'repeated_cursor'
   *                  | 'no_progress' | 'rate_limited' | 'error'
   */
  async fetchRange({ ticker, interval, from, to, maxPages = HISTORY_LIMITS.MAX_PAGES_DEFAULT }) {
    const cap = Math.min(
      Math.max(1, Math.floor(Number(maxPages) || HISTORY_LIMITS.MAX_PAGES_DEFAULT)),
      this.limits.MAX_PAGES_HARD_CAP,
    );
    const result = { bars: [], pagesFetched: 0, exhausted: false, stoppedReason: null, error: null };
    const seenCursors = new Set();
    let cursor = undefined;   // opaque token from next_cursor
    let before = undefined;   // before-fallback (epoch-ms)
    let prevOldest = null;

    for (;;) {
      if (result.pagesFetched >= cap) {
        result.stoppedReason = 'max_pages';
        break;
      }
      try {
        await this.rateLimiter.acquire();
      } catch (err) {
        result.stoppedReason = 'error';
        result.error = err;
        break;
      }
      let page;
      try {
        const res = await this.fetchPage({
          ticker, interval, from, to, limit: this.limits.PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(before !== undefined ? { before } : {}),
        });
        page = {
          bars: dedupeAndSortBars(res?.bars ?? []),
          nextCursor: res?.nextCursor ?? res?.next_cursor ?? null,
        };
      } catch (err) {
        if (err instanceof RateLimitError || (err && err.kind === 'rate_limit')) {
          // One delayed retry for the SAME page; second 429 stops gracefully.
          try {
            await this.sleep(this.limits.MIN_REQUEST_GAP_MS * 4);
            await this.rateLimiter.acquire();
            const res = await this.fetchPage({
              ticker, interval, from, to, limit: this.limits.PAGE_SIZE,
              ...(cursor !== undefined ? { cursor } : {}),
              ...(before !== undefined ? { before } : {}),
            });
            page = {
              bars: dedupeAndSortBars(res?.bars ?? []),
              nextCursor: res?.nextCursor ?? res?.next_cursor ?? null,
            };
          } catch (retryErr) {
            result.stoppedReason = retryErr instanceof RateLimitError || retryErr?.kind === 'rate_limit'
              ? 'rate_limited' : 'error';
            result.error = retryErr;
            break;
          }
        } else {
          result.stoppedReason = 'error';
          result.error = err;
          break;
        }
      }

      result.pagesFetched += 1;
      const pageOldest = oldestTimestamp(page.bars);

      // No-progress guard: empty page, or cursor/before did not advance.
      if (page.bars.length === 0 || (pageOldest !== null && pageOldest === prevOldest)) {
        result.stoppedReason = 'no_progress';
        break;
      }
      prevOldest = pageOldest;
      result.bars = mergeBars(result.bars, page.bars);

      if (!page.nextCursor) {
        // No cursor and a short final page: the server is done.
        if (page.bars.length < this.limits.PAGE_SIZE || to == null) {
          result.exhausted = true;
          result.stoppedReason = 'server_exhausted';
          break;
        }
        // Full page without a cursor: older data may still exist inside the
        // window — fall back to the documented `before` mechanism.
        before = pageOldest;
        continue;
      }
      // Repeated-cursor safeguard: stop immediately on any repeat.
      if (seenCursors.has(page.nextCursor)) {
        result.stoppedReason = 'repeated_cursor';
        break;
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    result.bars = dedupeAndSortBars(result.bars);
    return result;
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
