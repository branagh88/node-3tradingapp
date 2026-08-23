# Phase 8 — Validation Diagnostic/Status Layer (per-ticker states + "Validation Details")

**Repo:** `node-3tradingapp` (vanilla ES modules, no bundler; `npm test` = vitest, `npm run build` = `build-check.mjs` syntax check, `npm run smoke` = `tests/smoke.mjs`).

## 0. Confirmed current data flow (READ & verified — do not re-litigate)

1. **Watchlist store/events:** `assets.js` `AssetsController` persists via `storage.js` under key `watchlist` (`market-intelligence:watchlist` in localStorage). `addAsset()`/`removeAsset()` emit `bus.emit('watchlist:changed', this.getWatchlist())` (utils.js bus).
2. **Selector wiring:** `app.js wireRealValidation()` renders `#rv-tickers` chips from the LIVE watchlist via `renderRvTickerSelector(container, assets.getWatchlist())` on wire-up and on every `watchlist:changed`. `rv-ticker-selector.js` is pure: `normalizeWatchlistSymbols()` uppercases/dedupes/sorts; **there is no hardcoded ticker universe anywhere** (a regression already asserts `'RV_TICKERS' in real-validation.js` exports === false in `tests/real-validation-ui.test.mjs:77`).
3. **Run path:** `app.js showRvCallWarning()` (confirm step with `realValidation.estimateApiCalls`) → `runRealValidation()` reads `.rv-ticker:checked`, `#rv-depth`, `#rv-use-cache` → `realValidation.run({ tickers, depth, useCache, onProgress })`.
4. **Cache-or-fetch:** `real-validation.js RealValidationController.run()` loops tickers; per ticker it calls `this.hist.run({ ticker, depth })` (`historical-analysis.js HistoricalAnalysisController`). That controller returns the in-memory session cache entry when `cache.has(`${SYM}:${depthId}`)` (sets `fromCache=true`), else runs `HistorySource.fetchRange()` (cursor/before pagination, rate limiter) and caches the result. Statuses: COMPLETE vs PARTIAL; `stoppedReason ∈ null|server_exhausted|max_pages|repeated_cursor|no_progress|rate_limited|error`; `error = {name, message, httpStatus}`.
5. **Retry + gating in real-validation.js:** exactly ONE automatic retry per ticker on thrown error or `stoppedReason ∈ {error, rate_limited}` (cache entry evicted before retry so it refetches). Dataset gate: `< 200` candles → skipped as insufficient. Failures land in `skipped[]` as `{ticker, reason}` strings. Progress events emitted per phase: `RETRIEVING`, `RETRYING`, `BACKTESTING`, `POOLING`, `DONE` (plus hist-controller page messages relayed inside RETRIEVING).
6. **Engines:** `walkForwardParameterSearch` (prediction-engine.js) + `poolHorizonCells/wilsonInterval/bootstrapCI` (pooled-stats.js). **These must not change at all.**
7. **UI render:** `real-validation-ui.js renderRealValidationResults(r)` — Datasets table, Skipped table with Retry buttons, pooled desktop table + ≤860px stacked `.rv-card`s (CSS-driven visibility), totals hint line. Retry buttons wired in `app.js wireRvRetryButtons()` (NOTE: its catch currently swallows errors silently — fixed in this plan).
8. **Packaging:** root modules are duplicated verbatim into `www/` (verified identical), and `npx cap sync android` copies `www/` into `android/app/src/main/assets/public/`. Any file change must be copied to `www/` before sync.
9. **Security baseline:** `tests/apk-leak-scan.test.mjs` scans sources + `www/` + debug APK for credential-shaped literals; API key lives only in secure-store.

### Gaps this plan closes

- During a run there is only one linear progress line (`#rv-progress`); no per-ticker state visibility.
- After a run there is no expandable diagnostics area (source, cache state, attempt count, candle count, structured error info).
- `wireRvRetryButtons` catch swallows errors with no user-visible signal.
- Skipped reasons are free-text strings; no structured, sanitized error fields.

---

## 1. Design constraints (hard rules)

- **NO changes** to prediction algorithms or statistical methodology: `prediction-engine.js`, `pooled-stats.js`, `pattern-engine.js`, `indicators.js` are untouched. Inside `real-validation.js`, only event emission, attempt counting, cache-state detection, and structured diagnostic bookkeeping are added — the retrieval sequence, retry policy, dataset gate (200), pooling math, and report shape stay behaviorally identical.
- **No credentials/tokens** ever enter UI or logs. The new sanitizer renders ONLY structured fields: `{ticker, operation/stage, httpStatus (number|null), stoppedReason, attempts, hasCache}`. It must NEVER render `err.message`, headers, URLs, or raw response bodies. (Existing precedent: `history-diagnostics.js` shows auth PRESENT/MISSING only.)
- **No silent error swallowing:** every failure path surfaces in UI (status strip ERROR state / details row / `#rv-error` banner) AND via `console.warn('[RV]', …)` with the sanitized object. Fix `wireRvRetryButtons`' empty catch.
- **Backwards compatibility:** existing exports, function signatures, report shape, DOM ids, and all current tests keep working. New capabilities are additive (optional fields / optional second argument).
- All new HTML goes through `esc()` from `utils.js`. All pure builders live in importable modules for offline jsdom Vitest testing (repo convention).
- No hardcoded ticker list may be introduced anywhere (keep the `RV_TICKERS`-not-exported regression passing).

---

## 2. Files to change (exact list)

| File | Change type |
|---|---|
| `rv-status.js` | **NEW** — pure state machine + sanitizers + markup builders |
| `real-validation.js` | EDIT — richer progress/diagnostic events + `report.diagnostics` (no logic change) |
| `real-validation-ui.js` | EDIT — add details/status builders; extend results renderer additively |
| `app.js` | EDIT — status strip rendering during run, details injection after run, fix swallowed retry errors |
| `index.html` | EDIT — add `#rv-status` container between `#rv-progress` and `#rv-results` (~line 261) |
| `style.css` | EDIT — styles for status badges + collapsed `<details>` (desktop + ≤860px stacked pattern like `.rv-cards`) |
| `www/*` | COPY of each changed module above (verbatim, matching today's duplication convention) |
| `tests/rv-status.test.mjs` | **NEW** — regression tests (Section 5) |

Do NOT touch: `historical-analysis.js`, `history-source.js`, `api.js`, `assets.js`, `storage.js`, `utils.js`, any engine/stats module, `android/` platform project source (sync regenerates assets).

---

## 3. Implementation spec

### 3.1 NEW `rv-status.js`

Exports:

```js
export const RV_STATES = Object.freeze({
  READY: 'READY', FETCHING_HISTORY: 'FETCHING HISTORY', USING_CACHE: 'USING CACHE',
  VALIDATING: 'VALIDATING', COMPLETE: 'COMPLETE',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA', ERROR: 'ERROR',
});

export function createTickerStatus(ticker)
// → { ticker, state: 'READY', attempts: 0, fromCache: false, candles: null,
//     stoppedReason: null, httpStatus: null, stage: null }

export function applyRvEvent(statusMap, evt)
// PURE reducer over a plain Map (or object) keyed by uppercase ticker.
// Returns a NEW map (do not mutate input). Maps controller events (3.2):
//   {phase:'CACHE_HIT'|'FETCHING', ticker}      → USING_CACHE | FETCHING_HISTORY
//   {phase:'RETRIEVED', ticker, ...meta}        → keeps FETCHING_HISTORY/USING_CACHE,
//                                                 records attempts/fromCache/candles
//   {phase:'BACKTESTING', ticker}               → VALIDATING
//   {phase:'TICKER_DONE', ticker, outcome}      → COMPLETE | INSUFFICIENT_DATA
//   {phase:'TICKER_FAILED', ticker, failure}    → ERROR (+ sanitized fields)
// Unknown phases/tickers are ignored (return input unchanged), never throw.

export function safeErrorInfo({ ticker, operation, err, stoppedReason, attempts, hasCache })
// → { ticker, operation,            // 'fetch_history' | 'walk_forward' | 'pool'
//     stage,                        // 'transport' | 'http' | 'rate_limited' |
//                                   // 'pagination' | 'engine' | 'unknown'
//     httpStatus,                   // number|null — NEVER a header/body value
//     stoppedReason,                // pass-through of history-source reason|null
//     attempts, hasCache }
// Derives stage/httpStatus ONLY from structured properties
// (err.status, err.kind, err.name, stoppedReason). Never touches err.message,
// never stringifies the error object.

export function rvStateBadgeHtml(state)
// <span class="rv-status-badge rv-status-badge--{slug}">{esc(state)}</span>

export function rvStatusStripHtml(statusList)
// One row per ticker: chip + badge. Used live during the run (#rv-status).

export function buildValidationDetailsHtml(diagnosticsArray)
// Collapsed per-run block:
// <details class="rv-details"><summary>Validation Details</summary>
//   <table class="table rv-details-table">
//     Ticker | State | Source (fresh fetch | session cache) | Cache present |
//     Attempts | Candles | Stopped reason | HTTP status | Stage | Operation
//   </table>
// </details>
// Rendered COLLAPSED (no `open` attribute). Rows sorted by ticker.
// When a row has an ERROR/INSUFFICIENT state, append a nested
// <details class="rv-details__error"> with ONLY safeErrorInfo fields
// (label:value pairs). Every dynamic value passes through esc().
```

Stage derivation table (document it in the file):

| Input | stage | httpStatus |
|---|---|---|
| `err instanceof RateLimitError` or `err.kind==='rate_limit'` or stoppedReason `rate_limited` | `rate_limited` | err.status ?? null |
| stoppedReason ∈ repeated_cursor/no_progress/max_pages/server_exhausted | `pagination` | null |
| stoppedReason `error` w/ numeric `err.status` | `http` | err.status |
| stoppedReason `error` without status | `transport` | null |
| walk-forward throw (err.name present) | `engine` | null |
| anything else | `unknown` | null |

### 3.2 EDIT `real-validation.js`

Additive only. Per-ticker loop gains local bookkeeping:

- `let attempts = 0;` reset at top of each ticker iteration; increment immediately before EACH `this.hist.run(...)` call (initial, throw-retry, stoppedReason-retry).
- Before first `hist.run`: compute `const cacheKey = `${sym}:${depth}`;` and emit
  `report({ phase: this.hist.cache.has(cacheKey) ? 'CACHE_HIT' : 'FETCHING', ticker: sym })`
  (purely observational — do NOT change which call path runs; `hist.run` itself decides cache-vs-fetch).
- After a successful `hist.run` return: emit
  `report({ phase:'RETRIEVED', ticker: sym, fromCache: !!result.fromCache, status: result.status, candles: Array.isArray(result.bars)? result.bars.length : 0, apiRequests: result.apiRequests || 0, stoppedReason: result.stoppedReason ?? null, errorName: result.error?.name ?? null, httpStatus: Number.isFinite(result.error?.httpStatus) ? result.error.httpStatus : null, attempts })`.
- On skip paths, additionally emit structured events (keep pushing the EXISTING human-readable entries into `skipped[]` unchanged):
  - retrieval failed twice → `TICKER_FAILED` with `safeErrorInfo({operation:'fetch_history', err: err2, attempts, hasCache:false})`
  - stoppedReason still bad after retry → `TICKER_FAILED` `{operation:'fetch_history', stoppedReason, attempts: 2, hasCache: false}`
  - <200 candles → `TICKER_DONE` `{outcome:'insufficient_data', candles, attempts}`
  - walk-forward threw → `TICKER_FAILED` with `safeErrorInfo({operation:'walk_forward', err, attempts, hasCache:true})`
- Successful completion → `TICKER_DONE` `{outcome:'complete', candles, attempts, fromCache}`.
- Accumulate `diagnostics[sym] = { ticker: sym, finalState, source: fromCache?'session cache':'fresh fetch', hasCache, attempts, candles, stoppedReason, httpStatus, operation, stage }` (via the SAME reducer helpers from `rv-status.js` so logic is tested once; importing `./rv-status.js` here is fine — no cycle, rv-status imports nothing from controllers).
- Add `diagnostics` to the returned `out` object (new optional field; nothing else in `out` changes).
- Import `RateLimitError`? NO — avoid importing api.js into the controller; derive rate-limit info from `stoppedReason === 'rate_limited'` and `err.kind`/`err.name` string checks inside `safeErrorInfo` instead (keeps dependency graph unchanged).
- Add ONE `console.warn('[RV] ticker failed', sanitizedObject)` on TICKER_FAILED (sanitized fields only — satisfies "no silent swallowing" in logs too).

### 3.3 EDIT `real-validation-ui.js`

- Import builders from `./rv-status.js`.
- Extend `renderRealValidationResults(r, options = {})`: if `r.diagnostics` exists (object or array), append AFTER the Datasets/Skipped tables and BEFORE "Pooled horizons": `buildValidationDetailsHtml(...)`. Signature stays backward compatible (existing tests call it with one arg).
- Optionally annotate the Datasets-table Status cell with `rvStateBadgeHtml(finalState)` when diagnostics exist (plain-text status remains for compat).
- No other renderer changes; pooled table/cards untouched.

### 3.4 EDIT `app.js`

- Import `applyRvEvent`, `createTickerStatus`, `rvStatusStripHtml` from `./rv-status.js`.
- In `wireRealValidation()`: grab `#rv-status` element; hide it in `showRvCallWarning()` cancel/reset paths.
- In `runRealValidation()`: initialize a status map (`READY`) for all selected tickers before the run; render `#rv-status` via `rvStatusStripHtml` inside `onProgress` (coalesce with the existing text update); hide the strip when phase === 'DONE' (results + details take over).
- In `catch` of `runRealValidation()`: also render current statuses so any ticker stuck mid-state shows ERROR context (set non-completed tickers that were in-flight to ERROR with `stage:'unknown'` — via reducer, not ad-hoc mutation).
- **Fix swallowed error in `wireRvRetryButtons`**: replace bare `btn.disabled = false;` catch with: unhide `#rv-error`, set sanitized message (`safeErrorInfo` fields + `err.name`), `console.warn('[RV] retry failed', sanitized)`; re-enable button. Do NOT render raw `err.message`.

### 3.5 EDIT `index.html`

After line 261 (`<div id="rv-progress" hidden></div>`), insert:
```html
<div id="rv-status" class="rv-status" role="status" aria-live="polite" hidden></div>
```

### 3.6 EDIT `style.css`

Follow the existing `.rv-cards` pattern (base styles + `@media (max-width: 860px)` overrides near lines 624–692):
- `.rv-status` rows wrap flexibly; `.rv-status-badge--ready/fetching-history/using-cache/validating/complete/insufficient-data/error` distinct colors (reuse CSS vars: ok green for COMPLETE, warn amber for in-flight states, dim for READY, danger red for ERROR/INSUFFICIENT DATA).
- `.rv-details` collapsed by default; monospace-ish values; `.rv-details-table` wraps in `.rv-table-wrap` for desktop overflow safety; on ≤860px convert rows to stacked label/value pairs mirroring `.rv-card__row`.

### 3.7 Sync to `www/`

Copy each edited/new root module verbatim to `www/` (same filenames): `rv-status.js`, `real-validation.js`, `real-validation-ui.js`, `app.js`, `index.html`, `style.css`. Verify with `diff -q` per file (today they are byte-identical; keep it that way). `npx cap sync android` happens in the APK verification step only.

---

## 4. Regression tests to ADD — NEW file `tests/rv-status.test.mjs`

Conventions: follow `tests/real-validation-ui.test.mjs` — `@vitest-environment jsdom`, stub transport implementing `fetchBarsPageRaw` contract over `genBars` fixtures (`scripts/research/gen-bars.mjs`), zero network, zero credentials. Reuse the `makeStubApi`/`makeController` patterns (copy locally; do not refactor shared helpers).

Describe blocks (all must pass under `npm test`):

1. **Reducer transitions (happy path)**: seed map with two tickers; feed `FETCHING → RETRIEVED(fromCache=false) → BACKTESTING → TICKER_DONE(complete)`; assert exact sequence FETCHING HISTORY → VALIDATING → COMPLETE, attempts increments, candle count recorded, other ticker stays READY.
2. **USING CACHE**: pre-seed `hist.cache.set('AAPL:1y', cachedResult)`; run controller over `['AAPL']`; assert CACHE_HIT event observed and final state COMPLETE with source 'session cache' and apiCallsSpent 0.
3. **INSUFFICIENT DATA**: stub dataset of 150 bars → final state INSUFFICIENT_DATA, skipped reason contains 'insufficient history', diagnostics row has candles=150.
4. **ERROR after double transport failure**: `failFirstPageOf`-style stub throwing twice for AAPL → final state ERROR, attempts===2, stage 'transport', siblings (MSFT) still COMPLETE, batch did not abort.
5. **Rate-limited then retry success**: stub throws `RateLimitError` once (kind 'rate_limit') then serves pages → COMPLETE, attempts===2, stage cleared/null on success; and a second case where both attempts hit 429 → ERROR with stage 'rate_limited'.
6. **Engine failure**: make `walkForwardParameterSearch` throw via vi.mock (or inject a bar payload that triggers the engine's guard) → ERROR with operation 'walk_forward', stage 'engine'.
7. **Sanitizer security**: construct `const err = new Error('GET https://x/v2 failed Authorization: Bearer sk-supersecrettoken123456'); err.name='TransportError';` assert `JSON.stringify(safeErrorInfo({...}))` contains neither 'Bearer', 'sk-', nor 'https'; contains only whitelisted keys (exact key-set assertion).
8. **Markup builders**: `buildValidationDetailsHtml` output starts with `<details class="rv-details">` withOUT `open`; contains Source, Cache, Attempts, Candles columns; error sub-block shows 'HTTP status: 429' style labels; all values esc()-ed (feed a ticker `"<img src=x>"` — wait, tickers come from checkboxes; still assert esc on a fixture value like `A&B` → rendered as `A&amp;B`). `rvStatusStripHtml` renders one badge per ticker.
9. **Renderer backward compat**: `renderRealValidationResults(reportWithoutDiagnostics)` output identical to current expectations (no `<details` present); with diagnostics → contains exactly one `rv-details` block placed before 'Pooled horizons'.
10. **No hardcoded universe regression**: extend the existing assertion spirit — assert `rv-status.js` and the updated `real-validation.js` contain no exported ticker array (string-scan source or check exports keys).
11. **Retry-button error surfacing** (jsdom): simulate `wireRvRetryButtons` catch path (or extract its error-handling into a small exported helper in app.js if app.js isn't directly importable offline — PREFER extracting a tiny pure helper `formatRvRetryError(err)` into `rv-status.js` so it is unit-testable; app.js calls it).

Also UPDATE `tests/apk-leak-scan.test.mjs` HEX_WHITELIST/PATTERNS **only if** the scan false-positives on new code (it should not — no long hex or key-shaped literals will be added).

Acceptance: `npm test` fully green including ALL pre-existing suites (watchlist-validation, real-validation-ui, real-data-validation, apk-leak-scan, etc.).

---

## 5. Verification steps (builder executes in order)

1. `npm test` — all suites green (old + new).
2. `npm run build` — every module parses (`node --check` sweep includes new `rv-status.js` automatically since it scans top-level .js).
3. `npm run smoke` — offline dev checks pass.
4. Manual web sanity (optional but recommended): `npm run dev`, add 2 tickers to Watchlist, run validation with 1 short-depth selection; confirm status strip cycles and details block appears collapsed.
5. Sync web sources: copy the six changed files into `www/` (verbatim; `diff -q` each against root copies).
6. Fresh debug APK via the android-developer flow (skill: `android-build`): `npm run build:http` if vendor plugin needs rebuild, then `npx cap sync android`, then gradle `assembleDebug` (studio SDK; on a machine without SDK produce/skip per skill guidance and say so explicitly in the report). Output: `android/app/build/outputs/apk/debug/app-debug.apk`.
7. APK packaged-content checks (unzip the APK, inspect `assets/public/`):
   - Contains: `app.js`, `assets.js`, `storage.js` (watchlist integration), **`rv-ticker-selector.js`**, **`real-validation.js`**, **`real-validation-ui.js`**, **`rv-status.js`**, updated `index.html` + `style.css` (grep for `rv-details` / `rv-status` markers proves freshness).
   - Responsive stacked-card UI still packaged: grep APK `assets/public/style.css` for `.rv-card` AND new `.rv-status-badge`.
   - **No credentials**: `npm test` runs `tests/apk-leak-scan.test.mjs` against the built APK — must be clean (no key/token literals).
   - **No hardcoded RV_TICKERS**: grep unpacked `assets/public/*.js` for `RV_TICKERS` — zero matches (selector stays watchlist-driven).
8. Report results honestly: if the Android SDK is unavailable in this environment, deliver the synced Capacitor project + www/ and mark `apk_built=false` with next steps, rather than faking step 6.

## 6. Out of scope (do NOT do)

- Any change to engines/statistics, retrieval pagination, rate limiter, or retry POLICY (counts/plumbing of retries is observable now, not altered).
- Persisting diagnostics across sessions (localStorage) — session-only, in-memory.
- Touching `history-diagnostics.js` (separate temporary overlay for chart loads; leave as-is).
- Removing or renaming any existing DOM id, export, CSS class, or report field.
