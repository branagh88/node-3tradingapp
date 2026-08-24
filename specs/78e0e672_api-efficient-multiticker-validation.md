# PHASE 10 — API-Efficient Multi-Ticker Historical Data + Validation Workflow

Repo: `/opt/mesh-viewer-data/branagh88/projects/node-3tradingapp`
Vanilla ES-module browser app (no bundler), Vitest for tests, Capacitor Android wrapper.

---

## 0. HARD CONSTRAINTS (read first)

**FORBIDDEN — do not modify, do not re-export-wrapped versions, do not "fix":**
- `prediction-engine.js` — walk-forward engine
- `pattern-engine.js` — pattern detection
- `pooled-stats.js` — Wilson/bootstrap pooling statistics
- Any statistical methodology anywhere (horizons `[1,3,5,10]`, MIN_DATASET_BARS=200 gate,
  PARTIAL/COMPLETE semantics of retrieval, seed values, CI math)
- `api.js` request signing/key handling

Allowed to touch: `app.js`, `real-validation.js` (orchestration ONLY, not stats),
`historical-analysis.js` (ONLY additive cache-validity helpers — see §4),
`rv-ticker-selector.js`, `index.html`, `style.css`, new files, new tests.
A README/CHANGELOG note is desirable — the builder may add it; the planner did not.

**Zero-API-call invariants (the point of this phase):**
No network request may originate from: adding/removing a watchlist ticker, opening the
Historical Analysis panel, opening either multi-select popover, toggling checkboxes,
changing the depth `<select>`, or computing/displaying estimates. Requests happen ONLY on
an explicit button press (`GET HISTORICAL DATA` or `FETCH & RUN`) or `RUN REAL VALIDATION`
after its confirm gate.

---

## 1. CURRENT STATE (verified by inspection)

### Event-driven Watchlist → validation-selector sync (MUST BE PRESERVED EXACTLY)
- `assets.js` lines ~161, ~176: `bus.emit('watchlist:changed', this.getWatchlist())`.
- `app.js` `wireRealValidation()` (~line 296): `bus.on('watchlist:changed', () => renderRvTickerOptions())`,
  wrapped in try/catch. Also `wireHistoricalAnalysis()` re-renders on every panel open
  (`openBtn` click handler calls `renderRvTickerOptions()` when `#hist-panel` was hidden).
- `renderRvTickerOptions()` (`app.js` ~line 322) → `renderRvTickerSelector(container, assets.getWatchlist())`
  from `rv-ticker-selector.js`, which preserves prior checked-state across re-renders
  (reads `.rv-ticker:checked` before replacing innerHTML) and sorts/dedupes symbols.
- Recent commit `48fa639` fixed exactly this subscription — do not regress it.

### Cache layer (THE one and only cache — no second system)
- `HistoricalAnalysisController` (`historical-analysis.js`): in-memory `this.cache = new Map()`
  keyed `` `${SYMBOL}:${depthId}` `` (depthId ∈ `1y|3y|5y|max`). `run()` returns the cached
  object with `fromCache=true` on hit; `apiRequests` counts pages spent otherwise.
  Instantiated ONCE in `app.js` (~line 133): `histAnalysis = new HistoricalAnalysisController({ api })`.
- `RealValidationController` (`real-validation.js`) receives that SAME instance as
  `histController` and reads `this.hist.cache.has(...)` in `cachedCount()` /
  `estimateApiCalls()`. So Charts-panel Historical Analysis and Validation already share one cache.

### Retrieval / rate-limit / estimation
- `history-source.js`: `HistorySource` cursor/`before` pagination + `RateLimiter`
  (55 req sliding window + 1100 ms gap), one delayed retry on 429, honest stop reasons.
- `historical-analysis.js`: `DEPTH_OPTIONS`, `envelopeToPage`, MAX_PAGES=8, interval `'1d'`.
- `real-validation.js`: `estimateApiCallsForDepth()` (pure), `formatCallWarning()` (pure),
  `cachedCount()`, `estimateApiCalls()` (already cache-aware: `pagesPerTicker × freshTickers`),
  per-ticker failure isolation with ONE automatic retry each, `skipped[]` reasons,
  `MIN_DATASET_BARS=200` gate. **Never fabricates bars; siblings continue on failure.**

### Existing UI
- `index.html` `#hist-panel`: single-ticker section (`#hist-depth`, `#hist-analyze`,
  `ANALYZE HISTORICAL DATA`) + RUN REAL VALIDATION section (`#rv-tickers` chip-row rendered
  by `renderRvTickerSelector`, `#rv-select-all`, `#rv-depth`, `#rv-use-cache`, `#rv-run`,
  `#rv-call-warning`, `#rv-progress`, `#rv-status`, `#rv-error`, `#rv-results`).
- `real-validation-ui.js`: pure result renderers incl. per-ticker `data-rv-retry` buttons;
  desktop table vs ≤860px stacked cards (CSS-only switch, both always in DOM).
- `style.css`: three `@media (max-width: 860px)` blocks (~lines 600, 648, 766).
- `app.js` `showRvCallWarning()`: current CONFIRM state — always shows estimate + Confirm/Cancel.
- Single-ticker Charts candles go through `charts.js` → `api.getHistoricalData()` (line ~110)
  — a DIFFERENT path, untouched by this phase.

---

## 2. DESIGN DECISIONS (binding)

1. **One cache.** Everything reuses `HistoricalAnalysisController.cache`. No localStorage,
   no IndexedDB, no second Map, no new batch endpoint. Multi-ticker = a sequential loop of
   per-ticker `histAnalysis.run({ ticker, depth })` calls through the existing rate limiter.
2. **Cache validity rule (new, additive).** Export from `historical-analysis.js`:
   ```js
   export function isDatasetCacheEntryValid(entry) {
     return !!entry && entry.status === 'COMPLETE'
       && Array.isArray(entry.bars) && entry.bars.length > 0;
   }
   ```
   Add `hasValidDataset(ticker, depthId)` on the controller:
   `return isDatasetCacheEntryValid(this.cache.get(\`${sym}:${depthId}\`))`.
   Semantics: **valid → reuse; missing or PARTIAL (stale/incomplete) → fetch.**
   A PARTIAL cached entry is evicted (`this.hist.cache.delete(key)`) BEFORE the next fetch
   attempt so it actually refetches instead of replaying a bad hit. The existing eviction
   in `real-validation.js`'s error/retry branch already does this pattern — generalize it.
3. **Stale handling placement.** `RealValidationController.run()` gets a minimal guard right
   before the first `this.hist.run(...)` per ticker: if `useCache !== false &&
   !this.hist.hasValidDataset(sym, depth)` → `this.hist.cache.delete(`${sym}:${depth}`)`.
   No other change to `run()`; engines, gating, retry counts, diagnostics untouched.
4. **Reusable compact multi-select.** One component definition, TWO independent instances:
   - Validation tickers (replaces the bare always-expanded chip row as the *collapsed*
     default view; chips remain the popover content so `renderRvTickerSelector` keeps working).
   - Historical-data retrieval tickers (new section, identical behavior + its own button).
   Implemented as pure string builders in a NEW file `ticker-multiselect.js` + wiring in
   `app.js`. Popover = absolutely-positioned div toggled by a trigger button; closes on
   outside click / Escape; checkbox list inside is still `.rv-ticker` inputs scoped to their
   own container (update selectors to be container-scoped — see §5).
5. **Compact summary format (pure function, exact strings):**
   - 0 selected → `Select tickers…`
   - 1–3 selected → comma-joined uppercase symbols: `AAPL, MSFT, NVDA`
   - >3 selected → first two + counter: `AAPL, MSFT +3` (i.e. `${first}, ${second} +${n-2}`)
   - Whole watchlist selected → `${n} tickers selected`
   Exported as `buildMultiSelectSummary(selectedSymbols, totalSymbols)` from
   `ticker-multiselect.js`; unit-tested byte-for-byte.
6. **Charts single-ticker flow untouched.** `charts.js`, `MarketData`, quote paths,
   `getHistoricalData` — no edits. "Shared between Charts and Validation" means the
   Historical Analysis panel (which lives under the chart view) and Validation share the
   ONE `histAnalysis` cache, which they already do; this phase adds the explicit prefetch
   that fills it.

---

## 3. FILES TO CREATE

| File | Contents |
|---|---|
| `ticker-multiselect.js` | Pure builders, zero imports beyond `esc` from `utils.js`: `buildMultiSelectSummary(selected, total)`, `buildMultiSelectTriggerHtml(summaryText)`, `buildMultiSelectPopoverHtml(optionsHtml, {idPrefix})`, `buildRvEstimatePanelHtml(perTickerStatus, est)` (see §5.3). No DOM access, no fetch. |
| `tests/watchlist-sync-regression.test.mjs` | See §6. |
| `tests/ticker-multiselect.test.mjs` | Summary/popover pure-builder tests. |
| `tests/api-efficiency-zero-calls.test.mjs` | Mocked transport call-counter tests. |
| `tests/cache-reuse-shared.test.mjs` | Cross-feature cache reuse tests. |
| `tests/prefetch-progress.test.mjs` | Per-ticker progress/failure isolation/[Retry Failed]. |
| `tests/rv-cache-first-gate.test.mjs` | All-cached bypass + FETCH & RUN gate tests. |
| `tests/multiselect-mobile.test.mjs` | Markup-level mobile-safety assertions. |

## 4. FILE CHANGES (existing)

### `historical-analysis.js` — ADDITIVE ONLY
- Add `isDatasetCacheEntryValid(entry)` (exported pure fn) and `hasValidDataset(ticker, depth)`
  method (§2.2). Nothing else. No change to `run()`, stats, limits.

### `real-validation.js` — ORCHESTRATION ONLY
- Add `estimatePerTicker(tickers, depthId)`: returns
  `{ perTicker: [{ ticker, cached, valid }], ...estimateApiCalls(...) }` where
  `valid = this.hist.hasValidDataset(t, depthId)`. Pure w.r.t. network.
- In `run()`: insert the stale-eviction guard of §2.3 (one line + comment). NOTHING else.

### `rv-ticker-selector.js` — PRESERVE, EXTEND
- Keep `buildRvTickerOptionsHtml`, `renderRvTickerSelector`, `normalizeWatchlistSymbols`,
  `rvTickersEmptyHtml` signatures and behavior byte-compatible (watchlist sync depends on it).
- Optionally factor chip markup through `buildRvTickerOptionsHtml` inside
  `renderRvTickerSelector` so there is one chip template (behavior identical).

### `app.js`
- Container-scoped selectors: replace global `document.querySelectorAll('.rv-ticker')` /
  `.rv-ticker:checked` in `wireRealValidation`, `selectAll` handler, `selectedRvTickers()`
  with scoping to `#rv-tickers` (and the new retrieval container). Two instances must not
  see each other's checkboxes.
- `wireRealValidation()`: keep `renderRvTickerOptions()` + `bus.on('watchlist:changed', ...)`
  EXACTLY; add: popover open/close wiring, Select All + new **Clear All** (uncheck all in
  `#rv-tickers` only), summary refresh on container `change` events, estimate-panel refresh
  on `change` (selection or `#rv-depth`) — refresh is local-only, zero fetches.
- `showRvCallWarning()` → cache-first gate (§5.4).
- New `runHistoricalDataPrefetch()` + `wireHistoricalRetrieval()` (§5.2).
- Estimate panel renderer hookup (§5.3).

### `index.html`
Inside `#hist-panel`:
1. Validation block: wrap `#rv-tickers` in the popover structure; add trigger button
   `#rv-ms-trigger` (summary lives here), hidden popover `#rv-ms-popover`, `Clear all`
   button `#rv-clear-all` beside `#rv-select-all`; add estimate container
   `<div id="rv-estimate" hidden></div>` above `#rv-call-warning`.
2. New "Historical data" sub-section between the single-ticker block and the validation
   block: heading, its own trigger `#hd-ms-trigger` + popover `#hd-ms-popover` (chips
   rendered from the SAME live watchlist), estimate mirror `#hd-estimate`, and primary
   button `<button id="hd-fetch" class="btn btn--primary">GET HISTORICAL DATA</button>`
   with `#hd-progress`, `#hd-status` (reuses `.rv-status` strip styles), `#hd-error`.

### `style.css`
- `.ms-*` popover styles: trigger looks like a select; popover absolute, `max-height: 40vh;
  overflow-y: auto; min-width: 220px; max-width: calc(100vw - 32px); box-sizing: border-box;`.
- Inside BOTH existing `@media (max-width: 860px)` blocks (append to the ones at ~line 766):
  popover becomes `position: fixed; left: 16px; right: 16px; width: auto;` so it can never
  overflow a phone viewport; `.chip-row` gets `flex-wrap: wrap`.
- Status-strip and retry-button styles are REUSED (`#hd-status` gets class `rv-status`).

---

## 5. FEATURE SPEC (acceptance criteria)

### 5.1 Event-driven sync preserved (regression-locked)
Adding a ticker in the Watchlist → `watchlist:changed` → BOTH multiselect option lists
re-render from `assets.getWatchlist()` immediately (panel open or closed), previously
checked symbols stay checked, removed symbols disappear, new symbols appear unchecked,
alphabetical order, empty-watchlist hint preserved. The `bus.on` subscription in
`wireRealValidation` remains registered exactly once, unchanged in shape.

### 5.2 Explicit GET HISTORICAL DATA (zero calls until pressed)
Clicking `GET HISTORICAL DATA`:
- Computes `est = realValidation.estimateApiCalls(selected, depth)`. If
  `est.freshTickers === 0` → toast/hint "All selected tickers are already cached — 0 API
  requests needed." and NO requests fire.
- Else loops selected tickers SEQUENTIALLY (rate limiter serializes anyway): per ticker,
  evict-if-invalid (§2.3), `await histAnalysis.run({ ticker, depth })`, paint per-ticker
  strip entry (`✓ AAPL · COMPLETE · 251 candles · cached|N reqs` / `✗ MSFT · reason`).
- Failure of ticker B NEVER removes or invalidates ticker A's cached/successful data
  (controller cache untouched on sibling failure — assert in tests).
- After the loop, failures render a `[Retry failed]` ghost button that re-runs ONLY the
  failed tickers through the same path, then re-paints. Successes are never refetched
  (they're valid cache hits now).
- Partial/insufficient results are reported honestly (reuse `stoppedReason` text); no
  fabricated bars.

### 5.3 Pre-fetch estimate panel (pure, instant)
Rendered into `#rv-estimate` (and mirrored `#hd-estimate`) whenever selection or depth
changes and on popover close — WITHOUT any fetch:
```
Per-ticker status:
 ✓ AAPL — cached (COMPLETE, 0 requests needed)
 ✗ MSFT — needs data (~8 requests)
New API requests required: 8
```
Data source: `realValidation.estimatePerTicker(selected, depth)` +
`estimateApiCallsForDepth()`. Numbers come from the PURE page estimator times fresh count —
identical formula to today (`pagesPerTicker × freshTickers`). Zero network.

### 5.4 RUN REAL VALIDATION cache-first gate
Replace the body of `showRvCallWarning()`'s estimate branch:
- If `est.freshTickers === 0` (all selected valid-cached at depth): skip the confirm dialog
  entirely, call `runRealValidation()` directly (progress strip shows CACHE_HIT per ticker;
  totals report 0 API calls).
- Else: confirmation dialog titled **FETCH & RUN** showing the existing
  `formatCallWarning({...est, depthId})` line PLUS `New API requests required: ${est.totalEstimatedCalls}`
  and the per-ticker mini-list from §5.3. Buttons: `FETCH & RUN` (proceeds to
  `runRealValidation()`) and `Cancel` (current cancel behavior). `formatCallWarning` itself
  is NOT modified (it's exported/tested); the extra line is appended in `app.js`.
- `#rv-use-cache` unchecked ⇒ behave exactly as today (always confirm, ignore cache):
  pass `useCache:false` through; the stale-eviction guard of §2.3 must check `useCache`.

### 5.5 Compact multi-select UX (both instances)
- Collapsed default: trigger shows summary per §2.5. Clicking toggles popover.
- Inside popover: `Select all` / `Clear all` row + existing chip checkboxes (from
  `renderRvTickerSelector` — same function, same container ids `#rv-tickers` /
  `#hd-tickers`).
- Selection changes update summary + estimate panels instantly (local DOM only).
- Outside click and Escape close the popover; focus returns to trigger (a11y:
  `aria-expanded` on trigger, `role="group"` kept on the chip container).
- ≤860px: fixed-position full-width-minus-margins popover (§4 style.css); verify no
  horizontal overflow at 360px-wide viewport conceptually via markup assertions.

### 5.6 What must NOT regress
- Single-ticker `ANALYZE HISTORICAL DATA` flow (`runHistoricalAnalysis`) unchanged.
- Charts candle loading (`charts.js`) unchanged.
- Per-ticker diagnostics layer (Phase 8 `rv-status.js` reducer, `#rv-status` strip),
  `data-rv-retry` merge-rerun logic, pooled-results rendering (`real-validation-ui.js`)
  unchanged except that they keep working with the new gate.
- Retry semantics: exactly one automatic retry per failing ticker inside
  `RealValidationController.run()` — untouched.

---

## 6. TESTS (Vitest, jsdom; follow existing patterns in `tests/*.test.mjs`)

Transport mocking: construct controllers with injected fake `api.fetchBarsPageRaw`
(counting calls) exactly like `tests/history-pagination.test.mjs` /
`tests/historical-analysis.test.mjs` do. Never hit network.

1. **`tests/watchlist-sync-regression.test.mjs`**
   - jsdom: render selector, simulate `bus.emit('watchlist:changed', newList)` via the same
     subscription shape as `app.js` (import `renderRvTickerSelector` directly and/or reuse
     harness from `tests/watchlist-selector-sync.test.mjs`).
   - Assert: checked state preserved across re-render; removed symbol gone; added symbol
     unchecked; sorted; empty-watchlist hint. Assert subscription registered exactly once
     (no duplicate handlers) after the refactor.
2. **`tests/ticker-multiselect.test.mjs`**
   - `buildMultiSelectSummary`: exact strings for 0 / 1 / 2 / 3 / 4 / whole-watchlist cases
     (`'AAPL, MSFT +2'`, `'5 tickers selected'`, …). Escaping of odd symbols.
   - Popover markup: `aria-expanded`, id-prefix uniqueness, chips inside container.
3. **`tests/api-efficiency-zero-calls.test.mjs`** (call-counter on mocked `fetchBarsPageRaw`)
   - `normalizeWatchlistSymbols` / `renderRvTickerSelector` / summary build / popover open /
     `estimatePerTicker` / estimate-panel HTML ⇒ counter stays 0.
   - `GET HISTORICAL DATA` with 3 fresh tickers at `1y` ⇒ exactly
     `pagesPerTicker × 3` page calls (mock server returning cursors), sequential order.
   - Second press with everything cached ⇒ 0 additional calls.
   - Depth change / checkbox toggle during idle ⇒ 0 calls.
4. **`tests/cache-reuse-shared.test.mjs`**
   - One `HistoricalAnalysisController` shared by a `RealValidationController` and a direct
     `run()` (simulating the analysis panel): after analysis populates cache,
     `estimatePerTicker` reports cached; validation `run()` spends 0 API calls and report
     `totals.cachedDatasets === n`, `apiCallsSpent === 0`; `fromCache===true` rows render
     "(cached, 0 API calls)".
   - PARTIAL cached entry (stoppedReason `'error'`) ⇒ `hasValidDataset` false ⇒ evicted and
     refetched on next explicit action.
5. **`tests/prefetch-progress.test.mjs`**
   - Fake api where ticker #2 rejects: tickers 1,3 succeed and are IN cache afterwards;
     failure isolated to #2; progress events sequence sane; `[Retry failed]` path re-invokes
     only #2 and on success all three valid. Bars arrays of successful tickers are
     reference-equal before/after sibling failure (not discarded).
6. **`tests/rv-cache-first-gate.test.mjs`**
   - All cached ⇒ `showRvCallWarning` path triggers `runRealValidation` without building a
     confirm dialog (expose decision as a pure helper, e.g. `shouldBypassConfirm(est)` in
     `app.js` exports or `real-validation.js`, and unit-test it: `{freshTickers:0}` → true).
   - Mixed ⇒ dialog content includes `FETCH & RUN`, `New API requests required: N`, Cancel
     resets. `useCache=false` ⇒ never bypasses.
7. **`tests/multiselect-mobile.test.mjs`**
   - Markup assertions: popover elements carry the mobile CSS classes; no inline
     `width:` greater than viewport units on popover/trigger; `box-sizing: border-box`
     class present; chip-row wraps (class assertions — CSS itself is verified by the
     smoke/build steps and manual device check).

Run: `npm test` must pass with zero network access.

---

## 7. IMPLEMENTATION ORDER (one builder, no questions)

1. `historical-analysis.js`: add `isDatasetCacheEntryValid` + `hasValidDataset` (+ unit
   coverage inside `tests/cache-reuse-shared.test.mjs`).
2. `ticker-multiselect.js` pure builders + `tests/ticker-multiselect.test.mjs`.
3. `real-validation.js`: `estimatePerTicker` + stale-eviction guard (+ tests 4, 6).
4. `index.html` + `style.css`: popover structure, retrieval section, estimate containers.
5. `app.js`: scope selectors, wire both multiselect instances, estimate refresh,
   cache-first gate in `showRvCallWarning`, `runHistoricalDataPrefetch` + `[Retry failed]`.
6. Remaining test files (1, 3, 5, 7).
7. Full verification ladder (§8).

Manual device sanity (builder, optional but recommended): emulator/browser at 360×800 —
popover fits, no horizontal scroll on validation panel, summary readable.

## 8. FINAL VERIFICATION & DELIVERY STEPS (mandatory, in order)

Run from repo root; judge by exit status:
```bash
npm test                 # vitest run — all green
npm run build            # node build-check.mjs
npm run smoke            # node tests/smoke.mjs
npx cap sync android
cd android && ./gradlew assembleDebug && cd ..
```
Security/quality scans (must come back clean):
```bash
# credential-leak scan of changed sources (no keys/tokens in repo JS/HTML/CSS)
grep -rniE "(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}" \
  --include='*.js' --include='*.mjs' --include='*.html' --include='*.css' \
  . --exclude-dir=node_modules --exclude-dir=android --exclude-dir=www
# hardcoded ticker-universe scan (validation universe must come from the watchlist only)
grep -rn "RV_TICKERS" --include='*.js' --include='*.html' . \
  --exclude-dir=node_modules --exclude-dir=android --exclude-dir=www || true
```
Any hit must be resolved by the builder before delivery (expected: zero hits).
Then copy the fresh APK into the project-root collection dir:
```bash
cp android/app/build/outputs/apk/debug/app-debug.apk apk/node-3tradingapp-debug.apk
```

## 9. OUT OF SCOPE
- Server/proxy changes, new API endpoints, batching, persistence across sessions,
  background cache warming, changes to pooled verdict computation or disclaimer wording,
  iOS target.
