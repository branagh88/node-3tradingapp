# Phase A Implementation Plan — Live Prediction Layer (`predictCurrentMarketState`)

Repo: `/opt/mesh-viewer-data/branagh88/projects/node-3tradingapp`
Branch tip inspected: `84701f9` (mobile dropdown fix `ec6fc0a` is upstream of HEAD — DO NOT touch anything it changed: `style.css` multiselect popover rules, `index.html` ms-popover/ms-trigger markup, `app.js` `wireMultiselectInstance` positioning behavior).

## 0. Hard constraints (restated)

- Do NOT replace, fork, or modify `pattern-engine.js` or `prediction-engine.js`. The live path CALLS the existing engine.
- No LLM predictions. All numbers come from local historical conditional frequencies over retrieved OHLCV.
- No persistence, no calibration, no trading/order logic, no new storage keys.
- Leave every uncalculable field `null` — never fabricate 0/direction/probability.
- Ticker symbols are NEVER hardcoded; they flow from `assets.getWatchlist()` / `currentSymbol` route param / explicit argument.
- New code stays browser-safe (no `node:` imports), key-free (never references/logs the API key), and honest-language ("conditional historical frequency", never "forecast").

---

## 1. Exact reusable-function map (found during read-only inspection)

### pattern-engine.js (573 lines) — THE engine, imported as-is

| Export | Line(s) | Role in Phase A |
|---|---|---|
| `FEATURE_NAMES` | ~14 | Ordered feature vector definition — reused verbatim for the live condition |
| `DEFAULTS` | ~24 | `MATCH_MODE:'topk'`, `K_FRACTION`, `K_MIN/K_MAX`, `PERCENTILE_GATE`, `MIN_SIGNAL_SAMPLE:30`, `HORIZONS:[1,3,5,10]`, `MIN_MATCHES:30` — thresholds for the evidence gate |
| `extractFeatures(bars)` | ~205 | Point-in-time feature extraction for every candle (strict no-lookahead, SMA50 warm-up gate). Reused on the full retrieved series; the LAST row is the live market state |
| `normalizeFeatures(rows)` | ~262 | Robust z-score (median/MAD of PRIOR qualifying rows only) → `normalized[last]` is the live query vector |
| `weightedDistance(a,b,weights)` | ~300 | Weighted Euclidean similarity incl. per-feature contributions |
| `selectMatches(candidates,opts)` | ~40 | Adaptive top-K + percentile-gate match selection (also legacy threshold mode) |
| `computeCompositeSignatures(rows)` | ~95 | Prior-only quantile conjunction signatures (composite mode) |
| `wilsonInterval(successes,n)` | ~80 | 95% CI for the matched up-rate → live probability interval |
| `classifySampleSize(n)` | ~318 | `'INSUFFICIENT SAMPLE'|'LOW SAMPLE'|'MODERATE SAMPLE'|'STRONG SAMPLE'` — live confidence label input |
| `computeMatchedForwardOutcomes(bars,matchIndexes,horizons)` | ~340 | Per-horizon up/down/avg/median/best/worst over matched days, local OHLCV only |
| **`analyzePattern({bars,...})`** | ~380 | END-TO-END: condition + candidates + selection + composite fallback + top contributing features + forward outcomes. **Phase A calls THIS one function; nothing in Phase A re-implements matching** |

### prediction-engine.js (502 lines) — reused for semantics only (not modified)

- `walkForwardBacktest` / `walkForwardParameterSearch`: already used by `real-validation.js`; NOT part of the live path.
- Its **NO-SIGNAL gate semantics** (usable matched sample `< DEFAULTS.MIN_SIGNAL_SAMPLE` ⇒ emit no signal, `requireEdge` Wilson-CI-contains-50% variant) is the exact precedent Phase A's `INSUFFICIENT_EVIDENCE` status copies.
- `modelScore(bt,h)`: confidence-from-sample-size-and-edge philosophy — Phase A derives a simpler live confidence from `classifySampleSize(matchCount)` + Wilson bounds; do NOT import `modelScore` (it needs a backtest object).

### historical-analysis.js / history-source.js — data path (unchanged)

- `HistoricalAnalysisController.run({ticker, depth, onProgress})` → `{status:'COMPLETE'|'PARTIAL', bars:[{t,o,h,l,c,v}], stoppedReason, apiRequests, quality, ...}` with session cache keyed `${TICKER}:${depthId}`. This is the ONLY retrieval path (same as `runHistoricalAnalysis()` in app.js). `DEPTH_OPTIONS`, `isDatasetCacheEntryValid`, `hasValidDataset` available for cache checks.
- `history-source.js`: `dedupeAndSortBars`, `normalizeBar`, `RateLimiter` — already applied inside the controller; do not re-apply.

### api.js — transport only (unchanged)

- `TickerbotAPI.fetchBarsPageRaw` feeds HistorySource (already wired inside `HistoricalAnalysisController`). `getHistoricalData` is chart-only and must NOT be used by the live path.

### app.js (1455 lines) — wiring conventions to follow

- Boot pattern: guarded init (`try{...}catch{reportBootError}`) + `guardedWire(fn,label)` per feature.
- Existing live-analysis flow to mirror: `runHistoricalAnalysis()` (retrieves via `histAnalysis.run`, then locally runs `analyzePattern({bars})` + `walkForwardBacktest` when `result.bars.length > 60`) and renderers `renderPatternSection(p)` / `renderBacktestSection(b)` (honest-language hints, `fmtNum`, `esc`, badge classes).
- Event bus: `bus.emit('watchlist:changed')` from `assets.addAsset` (assets.js:161) — live panel refresh can subscribe the same way `wireRealValidation` does.

### index.html — existing prediction surface

- Asset screen `#hist-panel` (lines 267–338): contains `#hist-ticker`, `#hist-depth`, `#hist-analyze`, `#hist-progress/#hist-error/#hist-results`, then HD/RV sub-sections. Phase A adds ONE compact sub-section here (the "existing prediction panel" is this pattern/backtest area of the asset screen).

### Tests — conventions to copy

- `tests/prediction-engine.test.mjs`: seeded `rng(seed)` mulberry32 + `dailyBars(n,{seed,startClose})` weekday-skipping generator; vitest `describe/it/expect`; node environment (`vitest.config.mjs`, native plugin aliased to `tests/fixtures/http-plugin-stub.js`). Reuse this exact fixture generator style (copy into the new test file; do not import across tests).
- `tests/historical-analysis.test.mjs`, `tests/history-pagination.test.mjs`: inject fake `fetchPage` transports for zero-network controller tests.

---

## 2. Deliverables

### D1. New module `live-prediction.js` (repo root, alongside siblings)

Exports:

```js
export const LIVE_PREDICTION_SCHEMA_VERSION = 1;
export const LIVE_PREDICTION_DEFAULTS = {
  depth: '1y',            // DEPTH_OPTIONS id
  horizons: [1, 3, 5, 10],
  minSignalSample: /* = PATTERN_DEFAULTS.MIN_SIGNAL_SAMPLE (imported, not copied) */,
};

/** Pure core: build the structured prediction contract from bars. */
export function buildPredictionContract({ ticker, bars, horizons, minSignalSample, matchOptions }) { ... }

/** Orchestrator: retrieve via EXISTING controller, then pure core. */
export async function predictCurrentMarketState(ticker, options = {}) { ... }
// options: { api?, histController?, depth?, horizons?, minSignalSample?, matchOptions?, onProgress? }

/** Pure HTML renderer (string only, no DOM mutation) for the UI panel. */
export function renderLivePredictionHtml(contract) { ... }
```

`predictCurrentMarketState(ticker, options)` resolution order for dependencies (mirrors `RealValidationController` DI style):

1. `options.histController` (injected — used by tests and by app.js which passes the shared boot-time instance);
2. else construct `new HistoricalAnalysisController({ api: options.api })`;
3. throw a descriptive error if neither is possible (caller catches; UI shows error banner).

Flow:

1. `sym = String(ticker||'').toUpperCase().trim()`; empty ⇒ `NO_DATA` contract, never throw for input issues.
2. `const result = await histController.run({ ticker: sym, depth, onProgress })` — session-cache aware, rate-limited, PARTIAL-honest.
3. If `!Array.isArray(result.bars) || result.bars.length === 0` ⇒ status `NO_DATA`, reason includes `stoppedReason`.
4. Else `contract = buildPredictionContract({ ticker: sym, bars: result.bars, ... })`.

#### The structured prediction contract (single shape, `schemaVersion:1`)

```js
{
  schemaVersion: 1,
  ticker: 'AAPL',
  generatedAt: <epoch ms>,
  dataset: {
    status: result.status,               // 'COMPLETE' | 'PARTIAL'
    candles: bars.length,
    coverageYears: result.coverageYears,
    dateRange: result.quality?.dateRange ?? null,
    stoppedReason: result.stoppedReason ?? null,
    depth: '1y',
  },
  status: 'OK' | 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'INSUFFICIENT_EVIDENCE',
  reason: null | string,                 // human-readable, only when status != 'OK'
  condition: { ...FEATURE_NAMES-keyed numbers } | null,   // latest-bar feature vector
  conditionTime: <epoch ms of latest bar> | null,
  analysis: {                            // present iff status==='OK'; verbatim subset of analyzePattern()
    matchCount, matchMode, kUsed, percentileCutoff, maxMatchDistance,
    meetsMinMatches, sampleClassification, compositeSignature, compositeRelaxed,
    topContributingFeatures,             // array of {feature, avgWeightedSquaredDiff}
    activeFeatures,
  },
  horizons: {                            // one entry per requested horizon
    '1': {
      days: 1,
      sampleSize: <matched days with a computable h-day forward return> | 0,
      direction: 'up'|'down'|null,       // null unless gated evidence passes
      probabilityPct: number|null,       // matched majority-direction rate ×100
      wilsonLowPct: number|null, wilsonHighPct: number|null,
      // descriptive mirror of computeMatchedForwardOutcomes(h):
      upPct, downPct, flatPct, averageReturnPct, medianReturnPct,
      bestReturnPct, worstReturnPct,     // each null when sampleSize===0
      classification: classifySampleSize(sampleSize),
    }, ...
  },
  disclaimer: 'Conditional historical frequency over matched past analogs — NOT a prediction, forecast, or recommendation.',
}
```

Status decision tree (all inside `buildPredictionContract`, pure):

- `bars` empty ⇒ `NO_DATA`.
- `analyzePattern({ bars, ...matchOptions })` returns `ok:false` with `reason:'INSUFFICIENT_HISTORY'` (latest bar lacks a complete vector, i.e. < ~51+ bars) ⇒ `INSUFFICIENT_HISTORY`.
- Otherwise engine succeeded; per horizon `h`: let `o = forwardOutcomes[h]`; `usable = o.sampleSize`. Copy descriptive stats. Then the gate, copying prediction-engine's NO-SIGNAL semantics:
  - if `usable < minSignalSample` ⇒ `direction/probabilityPct/wilson*` stay `null` and the whole contract status becomes `INSUFFICIENT_EVIDENCE` with reason naming the thinnest horizon (descriptive stats remain populated);
  - `direction = o.upPct > o.downPct ? 'up' : o.downPct > o.upPct ? 'down' : null` (exact tie ⇒ null, still `INSUFFICIENT_EVIDENCE`);
  - reconstruct counts from percentages: `ups = Math.round(o.upPct*usable/100)`; `probabilityPct = max(upPct,downPct)` for the decided direction; `[lo,hi] = wilsonInterval(direction==='up'?ups:usable-ups, usable)` ⇒ `wilsonLowPct/wilsonHighPct`.
- Contract status is `OK` only when EVERY requested horizon cleared the gate; otherwise the weakest-gate status wins (`INSUFFICIENT_EVIDENCE` beats `OK`). Uncalculable fields are `null` everywhere — including inside an otherwise-populated contract.

#### Leakage protection (explicit, tested)

- Features/vectors come from `extractFeatures`/`normalizeFeatures` inside `analyzePattern`, which are point-in-time by construction (row *i* uses only bars[0..i]; normalization statistics use only PRIOR qualifying rows). Phase A adds zero new math.
- The live query bar is the LAST retrieved bar; horizons describe what followed PAST analog days only. Nothing about the live bar's own future exists in the computation.
- Test enforces: prediction computed on `bars.slice(0, k)` is byte-identical whether or not later bars exist/mutate (prefix-invariance), mirroring `tests/prediction-engine.test.mjs` "mutating future bars never changes match sets".

### D2. `predictCurrentMarketState` exposure following existing app architecture

- app.js: import `predictCurrentMarketState, renderLivePredictionHtml` from `./live-prediction.js`; add `wireLivePrediction()` called via `guardedWire(wireLivePrediction, '[boot] wireLivePrediction')` next to `wireHistoricalAnalysis`.
- `wireLivePrediction()` binds button `#live-predict-btn` (see D3) → `runLivePrediction()`:
  - ticker source: `currentSymbol` (route param, same as `runHistoricalAnalysis`) — never a literal;
  - depth source: `#hist-depth` select (shared with historical analysis);
  - passes the shared boot instances: `{ histController: histAnalysis }`;
  - guards: no `histAnalysis` ⇒ `#live-prediction-error` banner (pattern of `runHistoricalAnalysis`);
  - progress text in `#live-prediction-progress`; results into `#live-prediction-results` via `renderLivePredictionHtml(contract)` with `esc()` on all interpolated strings;
  - wraps in try/catch → error banner with name/status/message (same HTML pattern as existing handlers).
- No server.mjs change: `server.mjs` is a static server + `/v2/*` passthrough proxy; the app has no first-party REST routes and adding one would be new architecture, not "following existing architecture". The "API" surface is the exported async function consumed through the existing controller/DI pattern.

### D3. Minimal UI wiring (index.html + app.js only)

Inside `#hist-panel`, immediately AFTER the `#hist-results` div and BEFORE the `<hr>` that starts the "Historical data" section, insert:

```html
<hr ...>
<h3>Current Market State Prediction</h3>
<p class="hint">Runs the SAME local pattern engine against the latest retrieved candle. Conditional historical frequency only — NOT a forecast.</p>
<div class="field-row">
  <button id="live-predict-btn" type="button" class="btn btn--primary">PREDICT CURRENT STATE</button>
</div>
<div id="live-prediction-progress" class="hint" hidden></div>
<div id="live-prediction-error" class="error-banner" hidden></div>
<div id="live-prediction-results"></div>
```

Renderer output (`renderLivePredictionHtml`):

- `status==='OK'`: badge `badge--ok` "OK", condition summary list (reuse the field set from `renderPatternSection`: RSI14, distFromSma20/Ema21, 1D/5D return, vol, streak, volumeVsAvg20), match metadata line, and a per-horizon table: Horizon | Direction | Probability | Wilson 95% CI | Sample (n + classification) | Avg/Median return.
- `status==='INSUFFICIENT_EVIDENCE'` / `INSUFFICIENT_HISTORY` / `NO_DATA`: badge `badge--unavailable` with the status text, the `reason` line, and a table whose numeric cells render `—` (via existing `fmtNum(null)` behavior) — the insufficient-evidence state is a first-class rendered state, not an error.
- Disclaimer hint at the bottom, always.

Zero changes to `style.css` (reuse existing badge/hint/error-banner/table classes). Zero changes to any multiselect/popover markup or CSS (ec6fc0a territory).

### D4. Watchlist single-ticker consumption (no hardcoded symbols)

- `predictCurrentMarketState(ticker, ...)` takes the ticker as its FIRST parameter — that IS the watchlist integration: callers pass `asset.symbol` from `assets.getWatchlist()` entries or `currentSymbol` from the route.
- app.js additionally subscribes: `bus.on('watchlist:changed', () => { /* clear stale #live-prediction-results for the previous symbol */ })` inside `wireLivePrediction` (same sync pattern as `wireRealValidation`), so a removed ticker's stale live prediction is never shown for a different symbol.
- A watchlist card needs no new controls in Phase A: opening an asset (`#/asset/SYMBOL`, cards already navigate via `data-open-symbol`, assets.js:209–211) lands on the panel wired to that symbol.
- Module-level rule enforced by test: no uppercase ticker literals anywhere in `live-prediction.js`.

### D5. Tests — new file `tests/live-prediction.test.mjs` (12 points)

Fixture strategy (deterministic, zero network): copy the `rng(seed)` mulberry32 + `dailyBars(n,{seed,startClose})` helper style from `tests/prediction-engine.test.mjs` (weekday-skipping OHLCV series); inject a fake `histController` implementing `run({ticker})` returning `{status:'COMPLETE', bars: dailyBars(500,{seed}), coverageYears:2, quality:{dateRange:'x'}, stoppedReason:null}` and a call counter. No `fetch`, no API key, no jsdom needed (renderer is a pure string function).

The 12 required test points:

1. **Contract shape**: happy-path contract (seeded 500 bars) has `schemaVersion===1`, every documented key present, `disclaimer` non-empty, `dataset.candles===500`, `status==='OK'`.
2. **Engine parity (no fork)**: `contract.analysis.matchCount/topContributingFeatures` and `contract.horizons[h].upPct/downPct/averageReturnPct` deep-equal the corresponding fields of `analyzePattern({bars})` for the same fixture — proves the live path calls the existing engine untouched.
3. **Probability arithmetic**: for each gated-in horizon, `probabilityPct === max(upPct,downPct)` and `[wilsonLowPct,wilsonHighPct]` equals `wilsonInterval(roundedMajorityCount, sampleSize)` recomputed independently in the test.
4. **Direction tie ⇒ null**: construct bars whose top-K analogs yield `upPct===downPct` (or force via `minSignalSample` edge) ⇒ `direction===null`, status `INSUFFICIENT_EVIDENCE`, probability fields `null` (never 0/50 fabricated).
5. **Insufficient history**: 70-bar fixture (< SMA50 warm-up + RSI window headroom for the latest bar) ⇒ `status==='INSUFFICIENT_HISTORY'`, `condition===null`, all `analysis/horizons` numeric fields `null`, no throw.
6. **No data**: empty bars / controller returning `{bars:[]}` ⇒ `NO_DATA` with reason mentioning `stoppedReason`; missing ticker string ⇒ `NO_DATA`, never a throw.
7. **Evidence gate**: `minSignalSample: Infinity` option ⇒ every horizon's direction/probability/Wilson `null`, descriptive up/down/avg stats STILL populated from `computeMatchedForwardOutcomes`, status `INSUFFICIENT_EVIDENCE`.
8. **Leakage / prefix-invariance**: `buildPredictionContract` on `bars.slice(0,k)` equals the contract on full `bars` truncated comparison at index k (mutate bars after k ×20 volume/×5 price first) — prediction at bar k is independent of later bars.
9. **Determinism**: two invocations on identical fixtures produce `JSON.stringify`-equal contracts (fixed clock: accept a `now` injection or assert on all fields except `generatedAt`).
10. **Null discipline sweep**: walk every leaf of an insufficient-evidence contract; assert no field is `undefined`, and every non-computable numeric field is exactly `null` (not `0`, not `NaN`, not `''`).
11. **Cache-aware retrieval**: fake controller's `run` call count stays 1 across two consecutive `predictCurrentMarketState('MSFT')` calls (session-cache hit), and a second ticker triggers exactly one more call — proves reuse of `HistoricalAnalysisController`, no second client, no hardcoded symbol (both tickers come from arguments).
12. **Renderer + watchlist integration**: `renderLivePredictionHtml(okContract)` contains direction/probability cells and the disclaimer; `renderLivePredictionHtml(insufficientContract)` contains the `INSUFFICIENT_EVIDENCE` badge text, the reason, and `—` placeholders; both escape a hostile ticker string (`'<img>'`) inertly; and a grep-style assertion that `live-prediction.js` source contains no `/[A-Z]{2,5}/` standalone ticker constant (symbols only ever arrive via parameters).

### D6. Validation steps (builder runs, in order)

1. `npx vitest run` — full suite green including the 12 new tests (existing suites untouched).
2. `npm run smoke` — offline smoke contract still passes.
3. `npm run build` — `node build-check.mjs` syntax/module-graph check passes with the new module imported by app.js.
4. End-to-end fixture demo (manual or scripted): serve the app (`npm run dev`), open `#/asset/<any-watchlist-symbol>`, open Historical Analysis, press GET HISTORICAL DATA once, then PREDICT CURRENT STATE — confirm the panel renders either OK rows or an INSUFFICIENT-EVIDENCE badge with reasons, and that a second press costs 0 API requests (session cache). Optionally capture the rendered HTML into `docs/` notes — but no committed fixture output files are required.
5. Confirm `git diff --stat` touches ONLY: `live-prediction.js` (new), `tests/live-prediction.test.mjs` (new), `app.js`, `index.html`. Any diff inside `style.css` popover rules, `ticker-multiselect.js`, or `server.mjs` is a regression against the constraints.

## 3. Suggested implementation order

1. `live-prediction.js` pure core `buildPredictionContract` + renderer (no imports beyond pattern-engine/historical-analysis).
2. `tests/live-prediction.test.mjs` points 1–10 (pure; fastest feedback).
3. Orchestrator `predictCurrentMarketState` + tests 11–12.
4. index.html section + app.js `wireLivePrediction`/`runLivePrediction`.
5. Full validation D6.

Estimated scope: 1 new module (~250 lines), 1 new test file (~350 lines), ~60 lines app.js, ~15 lines index.html. No other files.
