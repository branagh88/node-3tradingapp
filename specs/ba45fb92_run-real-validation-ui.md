# PHASE 6 — RUN REAL VALIDATION (UI) — Implementation Plan

Session: `ba45fb92`
Goal: add a **RUN REAL VALIDATION** flow inside the existing Historical Analysis panel
that lets the user pick multiple tickers (AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA,
GME) plus a dataset/range, then runs the EXISTING Phase 3 walk-forward engine per ticker
and the EXISTING Phase 5 pooled statistics over all selected tickers — entirely through
the EXISTING Tickerbot auth/history client and secure-store. Validation/descriptive only:
no engine changes, no new API client, no key exposure, no synthetic data substitution.

**Hard constraints (from prior phases, still in force):**
- `prediction-engine.js` logic is UNCHANGED (`walkForwardBacktest`,
  `walkForwardParameterSearch`, `modelScore`).
- `history-source.js` / `historical-analysis.js` retrieval semantics are UNCHANGED
  (cursor pagination, rate limiter ≤55 req/min + ≥1100 ms gap, honest PARTIAL status).
- The API key never enters the DOM, logs, localStorage config blob, or any artifact.
  It is read ONLY via `secure-store.js` → `TickerbotAPI` as today.
- No synthetic data is ever rendered as market data or substituted when a real fetch fails.
- This planner is read-only except this plan; ALL implementation is the builder's job.

---

## 0. Reconnaissance — files read by the planner (verified current)

| File | Relevance |
|---|---|
| `app.js` | Boot/wiring/router; `wireHistoricalAnalysis()`, `runHistoricalAnalysis()`; `histAnalysis = new HistoricalAnalysisController({ api })`; guarded-wire pattern; secure-store boot read with one retry |
| `historical-analysis.js` | `HistoricalAnalysisController.run({ticker, depth, onProgress})`, in-memory `cache` Map keyed `${SYM}:${depthId}`, `DEPTH_OPTIONS`, `envelopeToPage`, result shape (`bars`, `status`, `pagesFetched`, `apiRequests`, `quality`) |
| `history-source.js` | `HistorySource.fetchRange` (stoppedReason contract, 429 single-retry), `RateLimiter` (injectable clock/sleep), `HISTORY_LIMITS`, `dedupeAndSortBars`/`mergeBars` |
| `api.js` | `TickerbotAPI.fetchBarsPageRaw({ticker,interval,from,to,before,cursor,limit})` transport adapter; `RateLimitError`; key only via `_doFetch` Authorization header |
| `secure-store.js` | `getApiKey/setApiKey/clearApiKey/migrateLegacyApiKey`; Capacitor Preferences native + storage.js web fallback; empty-write overwrite guard |
| `prediction-engine.js` | `walkForwardBacktest({bars, horizons:[1,3,5,10]})`, `walkForwardParameterSearch` (train .6→val .2→test .2, skips param search <150 qualifying rows), `modelScore`, NO-SIGNAL gate at `DEFAULTS.MIN_SIGNAL_SAMPLE` |
| `scripts/research/run-pooled-validation.mjs` | Phase 5 runner: TICKER_UNIVERSE (the exact 8 tickers), HORIZONS `[1,3,5,10]`, exports `poolHorizonCells(cells)` + `wilsonInterval` + `datasetMetadata`; verdict rules EDGE / NO EDGE / INSUFFICIENT EVIDENCE; **imports `node:fs`/`node:child_process` at top level → NOT browser-importable** |
| `scripts/research/run-real-validation.mjs` | exports `zTestTwoProportions(k1,n1,k2,n2)` (+ local `normalCdf`/`erf`); **also imports node builtins → NOT browser-importable** |
| `tests/pooled-validation.test.mjs` | Existing vitest tests importing `poolHorizonCells` from the script — must keep passing after refactor |
| `tests/real-data-validation.test.mjs` | Deterministic seeded-bar test patterns (`genBars(n,{seed,...})`), leakage-poisoning test style |
| `tests/smoke.mjs`, `tests/boot-harness.mjs`, `build-check.mjs` | `npm run smoke` (node asserts), `npm run test:boot` (jsdom boots www/ module graph via HTTP), `npm run build` (`node --check` per top-level module — **new modules must be added to its explicit MODULES list**) |
| `index.html` | `#hist-panel` markup: `#hist-ticker`, `#hist-depth` select, `#hist-analyze` button, `#hist-progress`, `#hist-error`, `#hist-results` |
| `capacitor.config.json`, `package.json` | appId com.petrockstudios.marketintelligence, webDir `www/`; scripts: build/smoke/test/test:boot/build:http/postinstall |
| `specs/ee617a22_real-tickerbot-validation.md` | Phase 4 context & hard gates (BLOCKED-without-key discipline) |
| `scripts/research/fetch-real-bars.mjs` (grep) | cache-hit ⇒ 0 API calls precedent |

Environment note verified: dev shell has no real Tickerbot credential; every test in this
plan MUST run fully mocked/offline. A real run happens only on-device with a user-entered key.

---

## 1. Architecture overview

```
index.html            #hist-panel gains: ticker multi-select chips, dataset select,
                      #hist-run-validation button, #rv-progress area, #rv-results
app.js                wires the new controls; delegates to RealValidationController
real-validation.js    NEW controller (browser-safe): orchestration, call estimation,
                      cached-vs-fresh policy, per-ticker retries, progress events
pooled-stats.js       NEW pure-stats module (browser-safe): wilsonInterval,
                      zTestTwoProportions(+erf/normalCdf), poolHorizonCells,
                      bootstrapCI (overlapping-horizon-aware), seeded PRNG
historical-analysis.js  UNCHANGED (reused for retrieval + its per-ticker cache)
prediction-engine.js    UNCHANGED (walkForwardParameterSearch per ticker)
scripts/research/run-pooled-validation.mjs  REFACTORED to import+re-export the stats
                      functions from ../pooled-stats.js (behavior identical; existing
                      tests keep passing unchanged)
build-check.mjs       MODULES list += 'real-validation.js', 'pooled-stats.js'
tests/real-validation-ui.test.mjs   NEW deterministic mocked tests (vitest)
tests/apk-leak-scan.test.mjs        NEW artifact/APK secret-scan test (vitest)
```

Why `pooled-stats.js`: both research runners that currently hold these functions import
`node:` builtins at top level, so the browser cannot import them. Extraction (not
duplication) is required; the scripts re-export so `tests/pooled-validation.test.mjs`
keeps passing without edits.

---

## 2. Work breakdown

### Task 1 — Extract `pooled-stats.js` (browser-safe pure stats)

Create `pooled-stats.js` (ES module, zero imports) containing, moved verbatim where possible:

- `wilsonInterval(correct, n)` — from `run-pooled-validation.mjs`.
- `zTestTwoProportions(k1, n1, k2, n2)` + private `normalCdf`/`erf` — from
  `run-real-validation.mjs`.
- `poolHorizonCells(cells, { minSignalSample } = {})` — from `run-pooled-validation.mjs`,
  with ONE change: accept an injected options object so the verdict rules are testable;
  default behavior byte-for-byte identical to today (read MIN_SIGNAL_SAMPLE default =
  30 locally instead of importing pattern-engine DEFAULTS — pass it in explicitly from
  callers to stay identical).
- NEW `bootstrapCI(values, { iterations = 1000, blockSize, seed = 42 })`:
  moving-block bootstrap over the out-of-sample per-signal returns/correctness series.
  - `blockSize` defaults to `max(horizonDays, 5)`; caller passes horizonDays so CIs for
    3D/5D/10D horizons respect serial overlap of adjacent windows.
  - Uses a seeded PRNG (`mulberry32(seed)`, implemented inline) so results are fully
    deterministic across runs — REQUIRED for the mocked tests.
  - Returns percentile interval `{ lowPct, highPct, iterations, blockSize, seed }` or nulls
    for empty input.
- Export everything named; no side effects; no DOM/network access.

Refactor `scripts/research/run-pooled-validation.mjs`: delete its local copies of
`wilsonInterval`/`poolHorizonCells` internals and do
`import { poolHorizonCells, wilsonInterval } from '../../pooled-stats.js';`
plus `export { poolHorizonCells, wilsonInterval };` (keeps `tests/pooled-validation.test.mjs`
green). Same treatment for `zTestTwoProportions` in `run-real-validation.mjs`
(re-export). Do not change any verdict thresholds or math.

### Task 2 — `real-validation.js` controller

New file `real-validation.js`. Exports:

```js
export const RV_TICKERS = ['AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','GME'];
export const RV_HORIZONS = [1, 3, 5, 10];

// Pure helpers (unit-testable):
estimateApiCalls(tickers, depthId)          // pages-per-ticker estimate × tickers
formatCallWarning(estimate, tickers)        // human string for pre-run confirm

export class RealValidationController {
  constructor({ histController, onEvent })  // histController = EXISTING HistoricalAnalysisController
  async run({ tickers, depth, useCache = true, onProgress })
}
```

Behavior:

1. **Retrieval — reuse, never re-implement.** For each selected ticker call the injected
   `histController.run({ ticker, depth, onProgress })`. This reuses HistorySource
   pagination, RateLimiter, dedup/sort, PARTIAL/COMPLETE honesty, AND its session cache
   (`fromCache === true` on hits ⇒ **0 additional API calls for cached tickers**).
   No second client, no direct `fetch`, no key access anywhere in this module.
2. **Cached-vs-fresh policy.**
   - `useCache=true` (default): tickers already in `histController.cache` are reported as
     `(cached, 0 API calls)` and skipped network-wise.
   - Per-ticker dataset summary recorded regardless of source: candle count
     (`result.bars.length`), date range (`result.quality.dateRange`),
     `apiRequests` actually spent, `fromCache`, `status` (COMPLETE/PARTIAL).
   - PARTIAL datasets: INCLUDE if `bars.length >= 200` (matches Phase 5's minimum) with a
     visible "PARTIAL" flag; EXCLUDE below 200 with reason (mirrors Phase 5 skip list).
3. **API-call minimization & pre-run warning (pure function, UI calls before running).**
   - `estimateApiCalls(tickers, depthId)`: pages ≈ ceil(tradingDays(depth)/1000) using
     DEPTH_OPTIONS years × ~252 trading days; return `{ pagesPerTicker, totalEstimatedCalls,
     cachedTickers, freshTickers }` given the controller's known cache contents.
   - Before any fetch, the UI MUST show: estimated calls, how many tickers will hit cache,
     and a confirm step (Task 4). Free-tier discipline: default depth `1y` (≈1 page/ticker),
     cache-first, one shared RateLimiter, and per-ticker failure does NOT abort siblings.
4. **Engine execution (UNCHANGED engines).** Per included ticker:
   ```js
   const search = walkForwardParameterSearch({ bars: ds.bars, horizons: [1,3,5,10] });
   ```
   Strict chronological separation is inherited from the engine (point-in-time features,
   prior-only DB matches, train→val→test split; param search self-skips below 150 qualifying
   rows and uses conservative defaults — record `paramSearchSkipped` + `note`).
   Collect `search.test.horizons[h]` cells exactly like Phase 5 does.
5. **Pooling + statistical safeguards.** For each horizon h ∈ [1,3,5,10]:
   - `pooled = poolHorizonCells(cells)` (eligibility-weighted baselines, Wilson CI,
     two-proportion z vs best baseline, mechanical verdicts EDGE / NO EDGE /
     INSUFFICIENT EVIDENCE).
   - OVERLAP GUARD: for h > 1 additionally compute
     `bootstrapCI(perSignalCorrectness[h], { blockSize: max(h,5), seed: fixed })` over each
     ticker's signaled test rows concatenated chronologically; report the wider of
     (Wilson, bootstrap) interval as the displayed CI and require BOTH lows above baseline
     for an "EDGE" *display annotation* (never mutate poolHorizonCells' verdict itself —
     verdict stays mechanically identical to Phase 5; the bootstrap widens the displayed
     interval and adds `overlapAwareEdge: true/false` per horizon).
   - INSUFFICIENT EVIDENCE whenever pooled signals < `DEFAULTS.MIN_SIGNAL_SAMPLE`.
6. **Retry-on-failure.** A ticker whose retrieval stops with `stoppedReason ∈
   {'error','rate_limited'}` gets exactly ONE automatic re-attempt (fresh
   `histController.run` call — the RateLimiter's built-in 429 backoff still applies);
   if it fails again, record `{ ticker, reason }` in `skipped` and continue. Engine throws
   are caught per ticker → skipped list (Phase 5 pattern). Never fabricate bars.
7. **Result object** (returned + passed to `onProgress` events):
   `{ requested, retrieved[], included[], skipped[], perTicker{sym:{chosenConfig,
   paramSearchSkipped, horizons}}, pooled{h:{...poolHorizonCells, bootstrapCI,
   overlapAwareEdge}}, totals:{apiCallsSpent, cachedDatasets, freshDatasets},
   startedAt, finishedAt }`.

All computation is synchronous/local after retrieval; no network calls inside the engine.

### Task 3 — Wire-up in `app.js`

- Import `RealValidationController` (+ pure helpers) from `./real-validation.js`;
  instantiate once during boot next to `histAnalysis`:
  `rv = api && histAnalysis ? new RealValidationController({ histController: histAnalysis }) : null;`
  inside its own try/guardedWire so failure cannot break boot (existing pattern).
- Extend `wireHistoricalAnalysis()` (or a sibling `wireRealValidation()` registered via
  `guardedWire`) to bind the new controls; guard against missing elements exactly like the
  current code does.
- Route/state hygiene: reuse `currentSymbol` only as a convenience default; multi-ticker
  selection is independent of which asset screen is open. Reset panel state in
  `renderAssetScreen` alongside the existing `hist-ticker` reset.

### Task 4 — Markup in `index.html` (inside `#hist-panel`)

Add BELOW the existing analyze row (do not disturb the existing ANALYZE button):

```html
<div class="field-row">
  <!-- ticker chips: one <label><input type="checkbox" class="rv-ticker" value="AAPL">AAPL</label> ×8 -->
  <div id="rv-tickers" class="chip-row" role="group" aria-label="Tickers"></div>
  <label class="field"><span>Dataset range</span>
    <select id="rv-depth" class="select"><!-- same option values as #hist-depth --></select>
  </label>
  <label class="field"><span>Use cached datasets</span>
    <input type="checkbox" id="rv-use-cache" checked>
  </label>
  <button id="rv-select-all" type="button" class="btn btn--sm btn--ghost">Select all</button>
  <button id="rv-run" type="button" class="btn btn--primary">RUN REAL VALIDATION</button>
</div>
<div id="rv-call-warning" class="hint" hidden></div>      <!-- pre-run estimate + Confirm/Cancel -->
<div id="rv-progress" hidden></div>                        <!-- state line + per-ticker checklist -->
<div id="rv-error" class="error-banner" hidden></div>
<div id="rv-results"></div>
```

Populate `#rv-tickers` statically in HTML (8 checkboxes, none pre-checked) — no dynamic
fetch needed; keep `esc()` discipline for anything rendered dynamically.

### Task 5 — Progress UI states & error handling (`app.js` render helpers)

State machine rendered into `#rv-progress` (single line + per-ticker mini-list):
1. `IDLE` — button enabled, warning hidden.
2. `CONFIRM` — warning box visible: estimated API calls, cached-vs-fresh counts,
   "Confirm" proceeds / "Cancel" resets. (Free-tier minimization gate.)
3. `RETRIEVING(sym, page)` — "Retrieving AAPL… page 2 (3/8 tickers)" (from
   `histAnalysis.onProgress` passthrough); cached tickers show "(cached)" instantly.
4. `BACKTESTING(sym)` — "Walk-forward on MSFT…" (engine is sync; wrap in
   `await Promise.resolve()` between tickers so the UI paints).
5. `POOLING` — "Pooling horizons…".
6. `DONE` — hide progress, render results section (below).
7. `ERROR` — `#rv-error` shows name/status/message (reuse the existing error-banner
   pattern from `runHistoricalAnalysis`); per-ticker failures appear in the results
   "skipped" table WITH a per-ticker RETRY button that reruns just that ticker and
   re-pools (call `controller.run({ tickers:[failedSym], depth })` then merge).

Results rendering (`renderRealValidationResults(r)` in app.js, following the existing
section style): datasets table (ticker · status · candles · oldest/newest · API reqs ·
cached?), skipped table, pooled table per horizon (signals, accuracy %, Wilson CI,
overlap-aware bootstrap CI, baselines D/U/M, edge pp, p-value, VERDICT badge), plus the
standard disclaimer paragraph ("descriptive historical evaluation — NOT a forecast").
Reuse `esc()`/`fmtNum()`; escape EVERYTHING interpolated.

### Task 6 — Security checklist (implement + document in code comments)

- [ ] Key flows only: secure-store → TickerbotAPI `_doFetch` header. New modules NEVER
      import `secure-store.js` or read `config.apiKey` directly.
- [ ] No key/value in DOM: no input renders the key (existing rule); validation results
      contain no URLs with query params (bars requests put params in query string — ensure
      only ticker/date metadata is displayed, or run any shown URL through the existing
      `redactUrl()` pattern).
- [ ] No key in logs: extend the existing "never log key" rule; grep new code for
      `console.log/logger` usage containing response bodies.
- [ ] No key persisted outside Preferences/storage.js namespaced key (unchanged behavior).
- [ ] Results objects/artifacts carry only public market data + counters.
- [ ] APK leak-scan test (Task 7) enforces: no `sk-`/`Bearer `/long-hex-token-looking
      literals in `www/**` build output or unzipped APK assets.

### Task 7 — Tests (all deterministic, mocked, NO real API key)

New `tests/real-validation-ui.test.mjs` (vitest, offline):

Fixtures: `genBars(n, { seed })` from `scripts/research/gen-bars.mjs` (already used by
`real-data-validation.test.mjs`); fake transport implementing the
`fetchBarsPageRaw({ticker,interval,cursor/before,...})` contract returning sliced fixture
pages (pattern exists in `tests/fixtures/http-plugin-stub.js` era tests — see
`history-pagination.test.mjs` for the page-stub shape). Build a real
`HistoricalAnalysisController` over a stub `api` object exposing ONLY `fetchBarsPageRaw`
(with injectable-clock `RateLimiter` via constructor opts so tests are instant).

Cases (each `it(...)`):
1. Multi-ticker selection: controller runs 3 selected tickers, ignores unselected ones;
   per-ticker summaries present.
2. Cache reuse: second run with same tickers makes ZERO additional `fetchPage` calls
   (spy counter), reports `fromCache` + `cachedDatasets`.
3. Call estimation: `estimateApiCalls(['AAPL','MSFT'], '1y')` matches expected pages
   (252×2/1000 → ceil ⇒ e.g. 2 calls total) and warning string contains the number.
4. Pre-run warning math respects cache: cached tickers excluded from fresh estimate.
5. Chronological integrity: for generated bars, `perTicker[sym].horizons[1]` exists and
   `splitIndex` lies strictly before test rows (assert `databaseRows > 0 &&
   testRows > 0` and determinism: two runs byte-equal excluding timestamps).
6. Pooling parity: `poolHorizonCells` imported from `pooled-stats.js` produces IDENTICAL
   output to the values asserted in existing `tests/pooled-validation.test.mjs` cases
   (guards the refactor), including verdict strings EDGE / NO EDGE / INSUFFICIENT EVIDENCE.
7. Overlap-aware CI: for h=10, `bootstrapCI` is deterministic under a fixed seed (same
   input twice ⇒ same interval) and its width ≥ Wilson width on a noisy series;
   blockSize defaults to ≥ horizon.
8. Retry-on-failure: stub transport throws once for MSFT page 1 then succeeds ⇒ run
   completes with MSFT included and exactly one extra attempt recorded; permanent
   failure ⇒ MSFT in `skipped` with reason and other tickers still validated.
9. Insufficient history: 50-bar ticker lands in `skipped` (<200 candles), never crashes,
   no fabricated bars.
10. Verdict gating: engineered cell inputs produce each verdict string through the
    controller's pooled output (thin wrapper over case 6 inputs).

New `tests/apk-leak-scan.test.mjs` (vitest):
- Scans every file under `www/` (the actual Capacitor webDir) for credential-shaped
  literals: `/sk-[A-Za-z0-9]{16,}/`, `/Bearer\s+[A-Za-z0-9._-]{20,}/`,
  `/[a-f0-9]{32,}/gi` (excluding known vendor hashes whitelist constant in the test),
  and `api[_-]?key\s*[:=]\s*['"][^'"]{8,}` — FAIL on match.
- If `android/app/build/outputs/apk/debug/app-debug.apk` exists, unzip to a temp dir
  (`execFileSync('unzip', ...)` guarded — SKIP (not fail) with a clear message when the
  APK or unzip binary is absent) and apply the same regexes to extracted
  `assets/**` text-ish files; also assert `assets/public/` mirrors www scan result.
- Also scans the new modules `real-validation.js` / `pooled-stats.js` directly.

Keep `tests/pooled-validation.test.mjs` untouched and passing (re-export strategy).

### Task 8 — Build registration & verification steps

- Add `'real-validation.js'` and `'pooled-stats.js'` to `MODULES` in `build-check.mjs`.
- Builder verification sequence (in order):
  ```bash
  npm test                 # vitest incl. new tests, all offline/mock
  npm run build            # node --check on all top-level modules
  npm run smoke            # existing offline asserts still green
  npm run test:boot        # jsdom boot of www/ — proves new wiring doesn't blank the app
  npx cap sync android     # copy web assets into android shell
  ./gradlew assembleDebug  # from android/ ; produces app-debug.apk
  # APK content verification:
  unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep assets/public
  unzip -p android/app/build/outputs/apk/debug/app-debug.apk assets/public/real-validation.js | head
  npx vitest run tests/apk-leak-scan.test.mjs   # now scans the freshly built APK too
  ```
  Note: root `.js` files are served as-is (no bundler); `www/` must contain updated
  copies after `npx cap sync android` — verify `www/real-validation.js` exists post-sync.
- If gradle/Android SDK is unavailable in the environment, complete everything else and
  report the APK steps as BLOCKED with exact command output — do not fake success.

### Out of scope (explicitly)

- Any change to engine math, thresholds, or verdict rules.
- Persistent (cross-session) disk cache beyond the existing in-memory session cache —
  future phase.
- Running a real validation in CI (no credentials there, by design).
- README/CHANGELOG updates — if desired, builder may add them as a separate commit
  (planner is not allowed to touch them).

## Suggested implementation order
1. `pooled-stats.js` extraction + runner re-exports + parity test green.
2. `real-validation.js` controller + its mocked tests.
3. `index.html` markup + `app.js` wiring + progress/results rendering.
4. Leak-scan test; `build-check.mjs` registration.
5. Full verification sequence incl. Android/APK.

## Acceptance criteria
- All 8 tickers selectable; RUN REAL VALIDATION executes retrieval → walk-forward →
  pooling → rendered verdict table, using only existing clients/auth/cache.
- Second consecutive run performs zero new API calls for cached tickers and says so.
- Pre-run warning shows estimated API calls before any fetch; Cancel aborts cleanly.
- Pooled table shows per-horizon verdicts (EDGE / NO EDGE / INSUFFICIENT EVIDENCE) with
  Wilson AND overlap-aware bootstrap CIs at 3D/5D/10D.
- Any single-ticker failure leaves others validated, is listed as skippable/retryable,
  and no synthetic data ever appears.
- `npm test`, `npm run build`, `npm run smoke`, `npm run test:boot` all green;
  leak-scan passes against `www/` and (when present) the debug APK.
