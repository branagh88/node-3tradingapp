# Phase A Completion Report — Live Prediction Layer (`predictCurrentMarketState`)

Session: `b349a20c` · Base: `84701f9` (working tree; `ec6fc0a` multiselect fix upstream and untouched)
Review: `adws/adw_data/sessions/b349a20c/context_handoff/review.md` — **approved, nothing to fix**.
Plan: `adws/adw_data/sessions/b349a20c/context_handoff/plan.md`.

## A. Exact files changed

Per `git diff --stat HEAD`:

- **NEW** `live-prediction.js` — the live prediction engine wrapper + renderer
- **NEW** `tests/live-prediction.test.mjs` — 11 deterministic tests
- `app.js` (+62) — one import, one boot line (`guardedWire(wireLivePrediction, ...)`), plus new `wireLivePrediction()` / `runLivePrediction()` functions. Purely additive.
- `index.html` (+9) — one sub-section inside `#hist-panel`: heading, hint, `#live-predict-btn`, progress/error/results divs, `<hr>`.
- Regenerated mirrors: `build-info.js`, `www/*` (build artifacts only).
- Nothing else touched: `style.css`, `ticker-multiselect.js`, `server.mjs`, `pattern-engine.js`, `prediction-engine.js` are unmodified, so the ec6fc0a mobile multiselect fix is intact by construction.

## B. Existing functions reused

`live-prediction.js:12-18` imports verbatim from `pattern-engine.js`:

- `analyzePattern({bars, horizons, ...matchOptions})` — end-to-end matching; no matching/feature/stat math is re-implemented anywhere in the live path. Engine parity is deep-equal tested (test 2).
- `wilsonInterval(successes, n)` — 95% CI for the matched up-rate.
- `classifySampleSize(n)` — per-horizon confidence label (`INSUFFICIENT/LOW/MODERATE/STRONG SAMPLE`).
- `DEFAULTS as PATTERN_DEFAULTS` — supplies `HORIZONS` and `MIN_SIGNAL_SAMPLE`; horizons come from engine defaults only.

Retrieval goes through the existing `HistoricalAnalysisController` (`historical-analysis.js`) — same session-cache path as `runHistoricalAnalysis()`. No LLM, no network code beyond that path, no hardcoded symbols.

## C. New functions / endpoints

All in `live-prediction.js`; there are **no new server endpoints**:

- `buildPredictionContract({...})` — pure core: builds the schemaVersion-1 contract from already-retrieved bars. Deterministic except injected `now`.
- `predictCurrentMarketState(ticker, options)` — orchestrator: resolves DI (`options.histController` → construct from `options.api`; missing deps ⇒ `NO_DATA`, never throw), runs the controller, calls the pure core.
- `renderLivePredictionHtml(contract)` — pure HTML string renderer, hostile-input escaped, status badges (`OK` vs unavailable classes).
- Exports: `LIVE_PREDICTION_SCHEMA_VERSION = 1`, `LIVE_PREDICTION_DEFAULTS` (`depth:'1y'`, horizons/minSignalSample from engine).

UI wiring: `wireLivePrediction()` binds the button and clears stale results on `bus.on('watchlist:changed')`; `runLivePrediction()` reads `currentSymbol` and the shared `hist-depth` select, passes `histController: histAnalysis` for cache reuse.

## D. Data flow

1. **Ticker**: user presses PREDICT CURRENT STATE; ticker comes from `currentSymbol` (never a literal).
2. **Retrieval**: `HistoricalAnalysisController.run({ticker, depth, onProgress})` → deduped/sorted daily bars, session-cached per `${TICKER}:${depthId}`.
3. **Features**: `extractFeatures` computes point-in-time features on every candle; the LAST row of the retrieved series is the live condition.
4. **Analogs**: `normalizeFeatures` (median/MAD of prior qualifying rows only) → `selectMatches` top-K + percentile gate (composite fallback as in the engine).
5. **Forward outcomes**: `computeMatchedForwardOutcomes` over what followed past analog days, local OHLCV only.
6. **Probability**: per horizon, `probabilityPct = max(upPct, downPct)` with direction chosen accordingly; Wilson 95% CI recomputed at contract level; confidence label via `classifySampleSize`.
7. **API/UI**: contract rendered into `#live-prediction-results` inside `#hist-panel`.

## E. Prediction contract (schemaVersion-1)

Top-level: `schemaVersion:1`, `ticker` (normalized upper-trim), `generatedAt` (injectable), `dataset{status,candles,coverageYears,dateRange,stoppedReason,depth}`, `status`, `reason`, `condition`, `conditionTime`, `analysis{matchCount,matchMode,kUsed,percentileCutoff,maxMatchDistance,meetsMinMatches,sampleClassification,compositeSignature,compositeRelaxed,topContributingFeatures,activeFeatures}`, `horizons`, `disclaimer` ("Conditional historical frequency… NOT a prediction, forecast, or recommendation").

Statuses: `OK`, `NO_DATA` (empty bars/blank ticker/missing deps), `INSUFFICIENT_HISTORY` (short series), `INSUFFICIENT_EVIDENCE` (usable analogs < `minSignalSample`, or up/down tie, or a horizon with no outcomes). Gate discipline: gated fields (`direction`, `probabilityPct`, Wilson bounds) stay exactly `null` while descriptive stats remain populated; uncalculable leaves are never fabricated.

## F. Horizons

Engine-only: keys `'1'/'3'/'5'/'10'` taken from `PATTERN_DEFAULTS.HORIZONS`. Phase A adds no new horizons.

## G. Leakage protection

Live condition is the last bar; candidates strictly prior (`i < bars.length - 1`); feature extraction gates on trailing windows (e.g. SMA50 warm-up); normalization uses median/MAD of prior qualifying rows only. Enforced by test 7 (prefix-invariance): predicting on `bars.slice(0,k)` yields identical output after mutating later bars ×5 price / ×20 volume.

## H–I. Tests added and results

11 `it()` blocks in `tests/live-prediction.test.mjs` (happy-path shape, engine parity, probability/Wilson arithmetic, evidence gate with nulls kept, insufficient history, NO_DATA never-throws, prefix-invariance leakage test, determinism, null-discipline sweep, shared-controller cache reuse [one retrieval across repeated predictions], renderer incl. escaping).

Result: **29 test files, 262/262 tests passed** via `npx vitest run` (~98s), including all 11 new tests.

## J. Build result

`npm run build`: **BUILD PASS** — all 29 modules parse as valid ES modules; build-info regenerated to `./` and `./www/`.

## K. Smoke result

`node build-check.mjs`: exit **0**, same BUILD PASS output.

## L. Example end-to-end result

Selecting an asset, retrieving history once, then pressing PREDICT CURRENT STATE renders a contract card in `#hist-panel`: dataset stats (candles, coverage, date range), the live condition, per-horizon rows (direction, probability %, Wilson bounds, sample classification) for OK cases — or an "insufficient" badge with reason when the evidence gate fires, with descriptive stats still shown. Repeated predictions on the same ticker hit the session cache (verified by test 10); changing the watchlist clears stale results.

## M. Known limitations

- No persistence, calibration, or trading logic (per plan constraints) — output is descriptive conditional frequency only.
- Horizons limited to the engine's fixed `[1,3,5,10]`; depth default `'1y'`.
- Two cosmetic plan deviations (non-blocking, noted in review.md): the new section sits just *after* the existing `<hr>` rather than before it; 11 tests instead of 12 planned points because three assertions were merged into one block.

## N. Suggested Phase B scope (not started)

Nothing below was implemented; suggestions derived only from gaps visible in the current code:

- Persist last contract per ticker so a reload doesn't require re-running retrieval.
- Optional depth/horizon selectors specific to the live panel (currently shares `#hist-depth` and engine defaults).
- Diff view highlighting how the live condition's feature vector compares to its top analogs (data already present in `topContributingFeatures`/`condition`).
- A smoke script exercising the UI path against a recorded fixture to complement unit tests.

## How to verify

```bash
npx vitest run            # 262/262 pass
npm run build && node build-check.mjs   # BUILD PASS, exit 0
git diff --stat HEAD      # only the files listed in §A
```
