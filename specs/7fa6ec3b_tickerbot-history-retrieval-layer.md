# Plan — Tickerbot Historical-Data Retrieval Layer (paginated, rate-limited, cache-ready)

Session: 7fa6ec3b · Repo: node-3tradingapp

## Goal

Add a dedicated historical-data retrieval layer for the future pattern/probability
engine: cursor/`before` pagination over `GET /v2/tickers/{sym}/bars/{interval}`,
chronological ordering + candle dedup, infinite-loop safeguards, client-side
rate limiting to ≤60 req/min, bounded (never unlimited-on-open) fetching, and a
cache-ready shape — WITHOUT changing any current chart behavior, the API-key
storage system, or the quote endpoint.

## Ground truth found during planning (builder: trust this, verify lightly)

### Current wiring

- `api.js:582-700` — `TickerbotAPI.getHistoricalData(ticker, range='1D', resolution='5m')`.
  Builds `/v2/tickers/{SYM}/bars/{interval}?from=<epoch-ms>&to=<epoch-ms>&limit=1000`
  via `RANGE_MAP` (1D→5m, 5D→15m, 1M/3M/1Y→1d). Single page only. Unwraps the
  documented envelope `{as_of, ticker, interval, count, next_cursor,
  bars:[{t,o,h,l,c,v}]}` (tolerantly also `data`/`candles` keys or bare array),
  maps to `{time (epoch SECONDS), open, high, low, close, volume}`, publishes
  TEMP-DIAGNOSTICS on bus event `history:diagnostics`, logs with `redactUrl()`.
  On ANY error it publishes diagnostics and returns `[]` (never throws to charts).
- `charts.js:99-146` — `ChartController._loadCandles()` is the ONLY chart caller:
  TTL cache (`candleCache`), stale-response guard, status-bar errors via
  `apiErrorMessage`. This file must NOT change behavior.
- Transport: `api.js` `_doFetch(path)` (~line 200-460) attaches
  `Authorization: Bearer <key>` from `this.config.apiKey` (line ~242-243),
  redacts it in every log line, races native `Http.request` against a timeout,
  throws `ApiError` subclasses incl. `RateLimitError` ('rate_limit', HTTP 429)
  at `api.js:164-167, 398`.
- Runtime resolution: web → same-origin proxy `server.mjs` `/v2/*` →
  `https://api.tickerbot.io` (Bearer preserved, no key stored server-side);
  Capacitor native → absolute URL via bundled `vendor/http-plugin.js`.
- Build flow: root ES modules are source of truth; `npm run build`
  (`build-check.mjs`) syntax-checks AND copies root files into `www/`;
  `npx cap sync android` then copies `www/` into the APK. NEVER hand-edit
  `www/*` or `android/app/src/main/assets/public/*`.

### Do-not-touch (explicit constraints)

- **API-key storage**: `secure-store.js`, `config.js` `loadConfig()`/`saveConfig()`,
  the runtime-key merge in `app.js`, Settings UI. Zero edits.
- **Quote endpoint**: `api.js getQuote()` (~line 490-572) and its envelope unwrap;
  `server.mjs` proxy. Zero edits.
- **Chart behavior**: `charts.js` stays byte-identical unless a change is
  strictly mechanical (none is expected). `getHistoricalData` keeps its exact
  signature `(ticker, range, resolution)`, return shape, diagnostics events,
  and console log lines.
- **Pattern engine**: `pattern-engine.js` / `prediction-engine.js` are NOT
  touched and receive NO probability/prediction logic in this task.

### Tickerbot facts already established in-repo (docs/probes)

- Bars endpoint params: `from`/`to`/`asof`/`before`/`limit` (max 1000 per page);
  response envelope carries `next_cursor` (null on last page).
  Source: `adws/adws_data/sessions/7f478e92/context_handoff/scout_findings.md`,
  `.workbench/researcher-search-endpoint.md` (cursor pagination pattern:
  pass previous `next_cursor` back as opaque query param), live probes
  `GET /v2/sandbox/tickers/GME/bars/{interval}?limit=N` → 200 with that envelope.
- Free plan: **60 requests/minute** → client-side throttle required.
- Anonymous keyless access exists only via `/v2/sandbox/*` (latest day only);
  real history needs the user's runtime key. Never fake or bundle a key.

## Design

### New file: `history-source.js` (repo root)

One new ES module — the retrieval layer. It owns pagination, ordering,
dedup, safeguards, rate limiting, and merging. It depends ONLY on an injected
transport function (default: the API client's page fetcher) so tests can stub
it with zero network. It exports pure helpers separately from the orchestrator
so a future cache/pattern engine can reuse them without touching networking.

Exports:

```js
export const HISTORY_LIMITS = {
  MAX_PAGES_DEFAULT: 5,      // bounded default fetch (asset-open-safe)
  MAX_PAGES_HARD_CAP: 200,   // absolute ceiling even for explicit deep fetches
  PAGE_SIZE: 1000,           // server maximum per cursor/page
  MIN_REQUEST_GAP_MS: 1100,  // ≈54 req/min worst case, under the 60/min cap
  WINDOW_MS: 60_000,
  WINDOW_MAX: 55,            // sliding-window ceiling below 60
};

// Pure helpers (no I/O):
export function normalizeBar(raw) -> {t, o, h, l, c, v}   // epoch-ms ints
export function dedupeAndSortBars(bars) -> bars            // Map by t, ascending
export function mergeBars(existing, incoming) -> bars      // dedup union, sorted — cache-ready
export function oldestTimestamp(bars) -> number|null

// Rate limiting (injectable clock for tests):
export class RateLimiter {
  constructor({ windowMs, windowMax, minGapMs, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) })
  async acquire()   // resolves only when a request slot is available
}

// Orchestrator:
export class HistorySource {
  constructor({ fetchPage, rateLimiter = new RateLimiter(HISTORY_LIMITS), limits = HISTORY_LIMITS })
  // fetchPage: async ({ ticker, interval, from, to, before?, cursor?, limit }) ->
  //   { bars:[{t,o,h,l,c,v}], nextCursor: string|null }

  async fetchRange({ ticker, interval, from, to, maxPages = HISTORY_LIMITS.MAX_PAGES_DEFAULT })
  // -> { bars: sortedDeduped[], pagesFetched, exhausted, stoppedReason }
  // stoppedReason ∈ null | 'max_pages' | 'repeated_cursor' | 'no_progress' | 'server_exhausted'
}
```

#### Pagination algorithm (`fetchRange`)

1. Page 1: `fetchPage({ ticker, interval, from, to, limit: PAGE_SIZE })`.
2. Continue while `nextCursor !== null` AND not exhausted AND under `maxPages`:
   - If the server returned a truthy `next_cursor`, send it back as `cursor`
     (documented opaque-token mechanism).
   - If `next_cursor` is null/absent but the last page came back full
     (`bars.length === PAGE_SIZE`) and older data may still exist inside the
     requested window, fall back to the `before` mechanism:
     `before = oldestTimestamp(pageBars)` (epoch-ms). Stop when a `before` page
     yields an oldest timestamp equal to the previous one (no progress).
3. Accumulate raw bars into one array; call `dedupeAndSortBars` once at the end
   (and rely on per-page dedup inside `mergeBars` semantics if memory matters —
   simple concat is fine at these sizes).

#### Infinite-loop safeguards (ALL mandatory)

- `maxPages`: hard stop at the caller-supplied page budget (≤ `MAX_PAGES_HARD_CAP`); result flagged `stoppedReason:'max_pages'`.
- Repeated-cursor set: remember every `nextCursor` seen; if one repeats, STOP immediately with `'repeated_cursor'`.
- No-progress guard: if a page returns 0 bars, or its oldest `t` equals the previous page's oldest `t` (cursor didn't advance), STOP with `'no_progress'`.
- Server-exhausted: `next_cursor === null` after a short page → `'server_exhausted'` (normal completion).
- Every safeguard sets `exhausted/stoppedReason` in the result instead of throwing — callers can distinguish "complete history" from "stopped early".

#### Rate limiting

- One `RateLimiter` instance per `HistorySource`; `acquire()` is awaited before EVERY `fetchPage`.
- Sliding 60 s window capped at 55 requests PLUS a minimum 1100 ms gap between consecutive requests → comfortably ≤60 req/min regardless of burst patterns.
- On HTTP 429 (`RateLimitError` from `_doFetch`): catch at the page level, wait `minGapMs * 4`, retry that page ONCE; second 429 stops pagination with `stoppedReason:'rate_limited'` and returns what was gathered so far. Never crash the caller.

#### Bounded-by-default / no auto-unlimited download

- Default `maxPages = MAX_PAGES_DEFAULT (5)` → at most ~5,000 bars per call, ~5 requests, well within the rate window.
- Deep/backfill fetches are opt-in: callers must explicitly pass a larger `maxPages` (≤ hard cap). NOTHING in this task wires such a call into any UI path — asset open continues to hit `getHistoricalData()` exactly as today.
- Document in the module header: "this module never self-triggers; some future caller (cache warmer / pattern engine) must invoke it deliberately."

#### Cache-ready design (structure only, NO persistence in this task)

- All state lives in the return value (`{bars, pagesFetched, exhausted, stoppedReason}`); no module-level mutable caches.
- `mergeBars(existing, incoming)` is deterministic, idempotent, order-insensitive — exactly the operation an incremental local cache (later session) will apply: `merged = mergeBars(cachedBars, freshPage.bars)`.
- `normalizeBar` gives one canonical row shape so cached rows and live rows compare equal.

### Change 2: `api.js` — minimal, behavior-preserving refactor

- Extract the single-page bars request out of `getHistoricalData` into a new
  private method `async _fetchBarsPage(ticker, interval, params)` that builds
  `/v2/tickers/{SYM}/bars/{interval}?…` and returns `{ data, meta }` from
  `_doFetch` unchanged. `getHistoricalData` calls it with today's exact params
  (`from`, `to`, `limit: '1000'`). Its observable behavior — request URL,
  mapping, diagnostics object fields, bus events, console lines, `[]`-on-error —
  MUST be identical; existing `tests/historical-data.test.mjs` (11 tests) must
  pass unmodified.
- Add a thin adapter the `HistorySource` default-wires to:
  ```js
  fetchBarsPageRaw({ ticker, interval, from, to, before, cursor, limit })
  ```
  which appends `before`/`cursor` query params only when defined, calls
  `_doFetch`, and lets errors propagate (the source handles them). Keep all
  logging through the existing `redactUrl` pattern.
- Also provide the identical mirror in `www/api.js`? **NO** — do not edit
  `www/api.js` by hand; `npm run build` re-mirrors it.

### Files to create / modify (complete list)

| File | Action | What |
|---|---|---|
| `history-source.js` | CREATE | Retrieval layer per Design above |
| `api.js` | MODIFY | Extract `_fetchBarsPage`; add `fetchBarsPageRaw` adapter; header comment update |
| `tests/history-pagination.test.mjs` | CREATE | Vitest suite (below) |
| `tests/historical-data.test.mjs` | UNCHANGED | Must still pass green |
| `charts.js`, `secure-store.js`, `config.js`, `server.mjs`, `pattern-engine.js`, `prediction-engine.js`, `app.js`, `assets.js` | UNCHANGED | Constraint files |

(`www/*` and `android/.../public/*` refresh via build commands only.)

## Tests (`tests/history-pagination.test.mjs`, Vitest, style-match `tests/historical-data.test.mjs`)

Stub transport records every requested path/params; no network. Cover:

1. **Pagination via cursor**: two-page envelope (`next_cursor` then null) → 2 requests, second carries `cursor=<token>`; bars concatenated.
2. **Pagination via `before` fallback**: pages without `next_cursor` but full size → subsequent requests carry `before=<oldest t>`; stops when `before` stops advancing.
3. **Ordering + dedup**: feed interleaved/out-of-order/duplicated `t` values across pages → result strictly ascending, unique `t`, correct OHLCV mapping.
4. **Cursor exhaustion**: `next_cursor:null` short page → `exhausted:true`, `stoppedReason:'server_exhausted'`, exactly N requests.
5. **Repeated cursor**: server always returns the same `next_cursor` → stops at detection, `stoppedReason:'repeated_cursor'`, no runaway.
6. **Max-pages bound**: endless distinct cursors + `maxPages:3` → exactly 3 requests, `'max_pages'`.
7. **Hard cap**: `maxPages > MAX_PAGES_HARD_CAP` is clamped to the cap.
8. **No-progress**: empty page mid-stream → stop, `'no_progress'`.
9. **Rate limit pacing**: injected fake `now`/`sleep` → gap ≥ `minGapMs` between acquires; window count never exceeds `WINDOW_MAX`.
10. **429 handling**: first page 429s → one delayed retry succeeds; double 429 → graceful stop with partial bars, `'rate_limited'`, error surfaced in result not thrown.
11. **API/network error mid-pagination**: page 2 rejects with `ApiError('timeout')` → returns page-1 bars, `stoppedReason:'error'`, no throw.
12. **Key hygiene**: assert no logged string in the module contains the stub key value (scan captured console/error args), mirroring the redaction guarantees of `api.js`.

## Verification steps (run in order)

1. Unit tests: `npx vitest run` — new suite green AND existing
   `tests/historical-data.test.mjs` (11 tests) green unmodified.
2. Build + mirror: `npm run build` — syntax-check passes; confirms `www/` re-mirrored (git status shows updated `www/api.js`, `build-info.js`).
3. Smoke contract: `npm run smoke` — passes (incl. `isConfigured()` placeholder assertions untouched).
4. Boot harness: `npm run test:boot` — app boots in jsdom with no new errors.
5. Dev-server manual spot check (optional but recommended): `node server.mjs`
   → open the app, load GME 1D chart, confirm console lines
   `HISTORY REQUEST START …`, `HISTORY RESPONSE RECEIVED …`,
   `HISTORY PARSE COMPLETE bars=N` appear EXACTLY as before (one bars request
   per timeframe switch, no extra paginated requests fired on asset open).
6. Regression grep: `grep -rn "apiKey" history-source.js` → zero hits; confirm
   no new code logs Authorization values (all URL logging via `redactUrl`).
7. Android: `npx cap sync android && cd android && ./gradlew assembleDebug` —
   BUILD SUCCESSFUL; fresh debug APK at
   `android/app/build/outputs/apk/debug/app-debug.apk`. Report its path/timestamp.

## Out of scope (do NOT do)

- Any probability/pattern computation or wiring into `pattern-engine.js`.
- localStorage/IndexedDB persistence of bars (design leaves hooks only).
- Changes to quote endpoint, key storage, Settings UI, or `charts.js` logic.
- Automatic background/unbounded downloads on asset open.
