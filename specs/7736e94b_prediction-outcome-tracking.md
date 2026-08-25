# Phase B Implementation Plan — Prediction-Record Persistence & Prospective Outcome Tracking

Session: `7736e94b` · Base: `4f73321` (working tree; Phase A live-prediction engine committed at `297c4e9`)
Read-only inputs inspected: `live-prediction.js`, `prediction-engine.js`, `pattern-engine.js`, `historical-analysis.js`, `market-data.js`, `history-source.js`, `api.js`, `app.js`, `index.html`, `storage.js`, `utils.js`, `server.mjs`, `tests/live-prediction.test.mjs`, `vitest.config.mjs`, `app_docs/b349a20c_live-prediction-phase-a-report.md`.

---

## 0. Hard constraints (non-negotiable)

- **FORBIDDEN features**: calibration of any kind, LLM/ML integration, trading/order execution, broker connectivity, accuracy statistics or aggregate hit-rate reporting, hardcoded ticker symbols anywhere.
- **DO NOT touch** the Android multiselect dropdown fix: `ticker-multiselect.js`, all `.ms-*` CSS in `style.css`, and the popover positioning logic from commits `ec6fc0a`/`8afe452` must remain byte-identical. Do not modify `style.css` at all (existing badge/hint/table classes are sufficient).
- **Preserve all existing functionality.** Every change to existing files is purely additive; existing tests (`29 test files, 262 tests`) must still pass unchanged.
- No scattered `localStorage` calls: only `storage.js` touches `localStorage`; the new repository goes through it.
- No new npm dependencies, no build step, browser-safe modules (no `node:` imports) for anything imported by the app.

## 1. What already exists (confirmed by inspection — reuse, do not re-implement)

| Concern | Existing mechanism | Use it as-is |
|---|---|---|
| Live prediction engine | `predictCurrentMarketState` / `buildPredictionContract` / `renderLivePredictionHtml` in `live-prediction.js` (schemaVersion 1 contract; statuses `OK`, `NO_DATA`, `INSUFFICIENT_HISTORY`, `INSUFFICIENT_EVIDENCE`; gated fields exactly null when not gated in) | Sole source of predictions |
| Pattern math | `analyzePattern`, `wilsonInterval`, `classifySampleSize`, `computeMatchedForwardOutcomes` in `pattern-engine.js` | Untouched |
| Retrieval | `HistoricalAnalysisController.run({ticker, depth})` in `historical-analysis.js` — session-cached per `${TICKER}:${depthId}`, returns `{status, bars, coverageYears, quality, stoppedReason}` with deduped chronological daily ('1d') bars via `dedupeAndSortBars` from `history-source.js` | Zero extra API calls |
| Storage abstraction | `storage.js` → `storage.collection(name)` — id-keyed get/put/remove/clear/count under prefix `market-intelligence:collection:<name>`, try/catch-wrapped localStorage | **The** persistence backend |
| UI wiring pattern | `wireLivePrediction()` / `runLivePrediction()` in `app.js` (~lines 286–367), `guardedWire(...)` boot line, DOM ids inside `#hist-panel`, pure-HTML-string renderers with `esc()` escaping | Copy this pattern |
| Design language | `.badge .badge--ok / .badge--unavailable`, `.hint`, `.error-banner`, plain `<table>` rows, `.btn .btn--primary`, `<hr style="...">` separators | Only these classes |
| Test harness | `tests/live-prediction.test.mjs`: seeded `rng(seed)`, weekday-skipping `dailyBars(n,{seed,startClose})` generator, `makeFakeController()` DI, vitest node environment, http-plugin stub alias | Extend the same fixtures |

**Trading-day/date utilities**: there is **no calendar trading-day utility in the repo** (no weekend/holiday arithmetic anywhere). The Phase A engine's horizon semantics ARE bar-offset based: `computeMatchedForwardOutcomes(bars, matchIndexes, horizons)` computes `bars[i + h].c / bars[i].c - 1`. Therefore Phase B adopts the identical convention:

> **"h trading days" ≡ "the h-th subsequent daily candle after the condition candle in the deduped, chronologically sorted '1d' series."** No calendar date math is invented. Weekends/holidays are implicitly excluded because they produce no candles. This is the repo's existing date utility: bar timestamps (`t`, epoch ms) + index offsets over `dedupeAndSortBars` output.

## 2. Canonical prediction-record schema (`schemaVersion: 1`)

New module **`prediction-record.js`** — pure functions only (no DOM, no `localStorage`, no `node:` imports), so both the browser repository and `server.mjs` can import it.

```js
export const PREDICTION_RECORD_SCHEMA_VERSION = 1;
export const RECORD_LIFECYCLE = { PENDING:'pending', RESOLVED:'resolved', INSUFFICIENT:'insufficient_outcome_data' };
export const OUTCOME_STATUS  = { PENDING:'pending', RESOLVED:'resolved', INSUFFICIENT:'insufficient_outcome_data' };

// identityKey is DETERMINISTIC and DERIVED, never random:
//   `${ticker}|${new Date(conditionTime).toISOString().slice(0,10)}|v${PREDICTION_RECORD_SCHEMA_VERSION}`
export function computeRecordIdentity(ticker, conditionTime) // -> string|null
export function isValidPredictionContract(contract)          // see §4 validity gate
export function buildPredictionRecord(contract, entryClose, createdAtMs) // -> record (deep-cloned inputs)
export function validatePredictionRecord(record)             // -> {ok, errors[]} shape validator
```

Record shape produced by `buildPredictionRecord`:

```js
{
  id: '<identityKey>',                 // storage.collection keys on `id`
  schemaVersion: 1,
  ticker: 'AAPL',                      // upper-trimmed, from contract
  lifecycleStatus: 'pending',          // 'pending' | 'resolved' | 'insufficient_outcome_data'
  createdAt: <epoch ms>,
  updatedAt: <epoch ms>,
  prediction: {                        // ⛔ FROZEN AT CREATION — never mutated again
    generatedAt,                       // contract.generatedAt
    contractStatus: 'OK',
    dataset: { status, candles, coverageYears, dateRange, stoppedReason, depth },
    conditionTime,                     // epoch ms of the condition (latest) bar
    condition: { ...contract.condition },       // full 20-feature vector
    analysis: { matchCount, matchMode, kUsed, percentileCutoff, maxMatchDistance,
                meetsMinMatches, sampleClassification, compositeSignature,
                compositeRelaxed, topContributingFeatures, activeFeatures },
    horizons: {                        // ONLY gated-in horizons carry direction/probability
      '1': { days, direction, probabilityPct, wilsonLowPct, wilsonHighPct,
             sampleSize, classification },
      // '3','5','10' same shape
    },
    disclaimer: '<verbatim contract disclaimer>',
  },
  marketState: {
    depth,                             // retrieval depth used
    entryClose,                        // close of the condition bar (captured at creation)
    conditionBarTime: conditionTime,
  },
  methodology: {                       // provenance snapshot for reproducibility
    engine: 'pattern-engine',
    liveEngineSchemaVersion: LIVE_PREDICTION_SCHEMA_VERSION,   // = 1
    horizons: [1,3,5,10],
    minSignalSample,                   // from LIVE_PREDICTION_DEFAULTS at creation
    matchMode, kUsed, percentileCutoff, maxMatchDistance,
    compositeSignature, compositeRelaxed,
    sampleClassification,
  },
  outcomes: {                          // ✅ the ONLY mutable section
    '1': null | {
      status: 'resolved'|'insufficient_outcome_data',
      horizonDays: 1,
      targetBarTime,                   // epoch ms of bars[condIdx+h] (null if insufficient)
      outcomeClose,                    // bars[condIdx+h].c            (null if insufficient)
      returnPct,                       // (outcomeClose/entryClose-1)*100, 2dp (null if insufficient)
      outcomeDirection: 'up'|'down'|'flat',                                  (null if insufficient)
      predictedDirection: 'up'|'down', // copied from prediction.horizons[h]
      correct: true|false,             // outcomeDirection === predictedDirection (null if insufficient)
      recordedAt: <epoch ms>,
    },
    // '3','5','10' same; null until first evaluation
  },
}
```

Rules encoded in `buildPredictionRecord`: deep-clone every input (no shared references), `Object.freeze` nothing at this stage (repository freezes resolved records logically via update rules), all outcome leaves start as `null`, `predictedDirection` mirrored verbatim from the contract's gated rows (never recomputed).

## 3. New module `prediction-repository.js`

Browser module. Backend is **swappable via constructor injection**; default backend adapts the EXISTING `storage.collection('prediction-records')` from `storage.js`. Zero direct `localStorage` access outside `storage.js`.

```js
import { storage } from './storage.js';

function localCollectionBackend() {
  const col = storage.collection('prediction-records');
  return {
    getAll: () => col.getAll(),
    get: (id) => col.get(id),
    put: (record) => col.put(record),
    count: () => col.count(),
  };
}

export class PredictionRepository {
  constructor({ backend = localCollectionBackend(), now = Date.now } = {}) { ... }
  createPrediction(contract, { entryClose })     // -> record | null
  getPrediction(id)                              // -> record | undefined (defensive deep clone out)
  listPredictions({ ticker, lifecycleStatus } = {})  // -> array, newest first by conditionTime desc then createdAt desc
  getPendingPredictions({ ticker } = {})         // -> lifecycleStatus === 'pending'
  recordPredictionOutcome(id, bars, { now } = {})    // -> record | null
  finalizeAsInsufficientOutcomeData(id, { now } = {}) // -> record | null
}
export default PredictionRepository;
```

Method contracts:

- **createPrediction(contract, {entryClose})**
  - Rejects (returns `null`, stores nothing) any contract failing the §4 validity gate or a non-finite/non-positive `entryClose`.
  - Computes `id = computeRecordIdentity(...)`. If a record with that `id` exists → return the EXISTING record unchanged (idempotent duplicate protection, §6). Never creates a second record for the same identity.
  - Otherwise stores a fresh record via `backend.put`.
- **getPrediction(id)** returns a structural deep clone (callers can never mutate stored state through a returned reference).
- **listPredictions / getPendingPredictions** filter clones of stored records; optional `ticker` matches exact uppercase symbol.
- **recordPredictionOutcome(id, bars, {now})** — §5 rules. `bars` MUST be the deduped chronological daily series containing the condition bar (locate index by `findIndex(b => b.t === record.marketState.conditionBarTime)`). Returns `null` if id unknown or record terminal.
- **finalizeAsInsufficientOutcomeData(id, {now})** — terminal transition, §5 step 3.

## 4. Validity gate — persist only valid predictions

`isValidPredictionContract(contract)` returns true iff ALL hold:

1. `contract.schemaVersion === LIVE_PREDICTION_SCHEMA_VERSION (1)`
2. `contract.status === 'OK'` (weakest-link status across horizons — anything else means at least one horizon was never gated in)
3. `contract.ticker` non-empty after upper/trim
4. `contract.conditionTime` is a finite number
5. At least one entry in `contract.horizons` has a non-null `direction` (`'up'|'down'`) with finite `probabilityPct`

Rejected statuses map to explicit reasons logged via `logger.debug` (from `utils.js`): `NO_DATA`, `INSUFFICIENT_HISTORY`, `INSUFFICIENT_EVIDENCE` → not persisted; nothing is fabricated to make them persistable.

## 5. Point-in-time integrity rules

1. **Original prediction fields are write-once.** After `buildPredictionRecord`, `prediction.*`, `marketState.*`, `methodology.*`, `id`, `ticker`, `createdAt` are immutable for the life of the record. `recordPredictionOutcome` writes ONLY to `outcomes.<h>` and updates `lifecycleStatus` + `updatedAt`. (Enforced by test 11.)
2. **Outcome-only updates.** Per horizon h (bar-offset semantics, §1):
   - Let `ci` = index of the condition bar in `bars`, `entry = bars[ci].c` (must equal `marketState.entryClose`; if the located close differs from the stored one, do NOT rewrite history — leave that horizon untouched and log a warning).
   - If `ci + h < bars.length` and `bars[ci+h].c > 0` → resolve the horizon: `targetBarTime = bars[ci+h].t`, `outcomeClose = bars[ci+h].c`, `returnPct = Number(((outcomeClose/entry)-1)*100 .toFixed(2))`, `outcomeDirection = ret>0?'up':ret<0?'down':'flat'`, `correct = (outcomeDirection === predictedDirection)`. Once set, an `outcome.status==='resolved'` leaf is FINAL and never recomputed.
   - Else (fewer than h subsequent candles exist yet) → leaf becomes `{status:'insufficient_outcome_data', horizonDays:h, ...all value fields null, recordedAt:now}`. This leaf stays REPLACABLE by later evaluations while the record is pending (more candles may arrive); it is not yet terminal.
3. **Immutable once resolved (terminal).** Lifecycle transitions: `pending → resolved` when EVERY horizon leaf is `status:'resolved'`; `pending → insufficient_outcome_data` only via `finalizeAsInsufficientOutcomeData` (locks all unresolved leaves as final `insufficient_outcome_data`). Both terminal states reject all further mutation: `recordPredictionOutcome` and `finalizeAsInsufficientOutcomeData` return the stored record untouched (no `updatedAt` bump).
4. **No retroactive edits.** There is no update/delete API on the repository surface for prediction content. (The underlying `storage.collection.remove` exists but is NOT exposed here.)
5. **Leakage firewall.** The stored prediction depends only on data up to `conditionTime`. Mutating or appending bars AFTER the condition bar can never change `prediction.*` of an already-created record (test 17).

### Documented outcome-price selection rule

> Outcome price for horizon h = the **close** of the h-th subsequent daily candle after the condition candle in the deduped, chronologically sorted '1d' series retrieved through `HistoricalAnalysisController` (same series the engine consumed). Entry price = the **close** of the condition candle. Rationale: mirrors `computeMatchedForwardOutcomes` (`bars[i+h].c / bars[i].c − 1`) exactly, so a prospective outcome is measured the same way the historical frequencies were. Intraday prices, highs/lows, and calendar-day targets are never used.

## 6. Duplicate-prediction protection strategy

- Identity = `(ticker, condition-bar UTC date, schemaVersion)` → deterministic `identityKey` string; no randomness, no timestamps in identity.
- Same ticker re-predicted on the same trading day (same latest candle) yields the SAME identity even if `generatedAt` differs → `createPrediction` returns the pre-existing record unchanged (idempotent). Count stays 1.
- Once terminal, the identity is permanently locked: a resolved/insufficient record is never replaced or duplicated.
- A genuinely new condition (next trading session ⇒ new `conditionTime` date) legitimately creates a new record.
- Note: identity uses the condition-bar DATE (UTC ISO `YYYY-MM-DD`), not full ms precision, because repeated intraday runs against a cached daily dataset share one condition bar; the date form is stable across timezone shifts of the epoch value.

## 7. Horizon semantics (exact parity with Phase A)

- Horizons come from `LIVE_PREDICTION_DEFAULTS.horizons` (= `pattern-engine.DEFAULTS.HORIZONS` = `[1,3,5,10]`). Phase B adds NO new horizons and NO calendar arithmetic.
- "h trading days forward" = `bars[conditionIndex + h]` in the same deduped daily series — precisely the index arithmetic of `computeMatchedForwardOutcomes`. Tests 15–16 pin this parity, including a weekend-gap synthetic series proving candle-offset (not calendar-day) semantics.

## 8. Minimal UI addition (existing design language only)

Additive changes in `app.js` + `index.html`, mirroring the Phase A wiring pattern:

- **index.html** — inside `#hist-panel`, directly below `#live-prediction-results`, insert:
  ```html
  <hr style="margin:16px 0;border:none;border-top:1px solid var(--border,#ddd);">
  <h3>Prediction Records</h3>
  <p class="hint">Persists each valid current-state analysis and tracks its prospective outcomes over the following sessions. Conditional historical frequency only — NOT a forecast.</p>
  <div class="field-row">
    <button id="pred-records-btn" type="button" class="btn btn--primary">SAVE / REFRESH PREDICTION RECORD</button>
  </div>
  <div id="pred-records-progress" class="hint" hidden></div>
  <div id="pred-records-error" class="error-banner" hidden></div>
  <div id="pred-records-results"></div>
  ```
- **app.js** — additive:
  - Import `PredictionRepository`, `renderPredictionRecordsHtml` (renderer lives in `prediction-repository.js` or a small `prediction-records-ui.js` pure renderer exported for tests).
  - Boot: `guardedWire(wirePredictionRecords, ...)` next to the Phase A wire call; one shared module-level `const predictionRepo = new PredictionRepository()`.
  - `wirePredictionRecords()`: bind button; clear `#pred-records-results` on `bus.on('watchlist:changed')` (same stale-result guard as Phase A).
  - `runSaveOrRefreshPredictionRecord()`:
    1. Guard: `currentSymbol` + `histAnalysis` present, else error banner (copy Phase A wording style).
    2. Run `predictCurrentMarketState(symbol, { histController: histAnalysis, depth })` (session cache ⇒ zero extra API calls).
    3. If contract invalid → show hint "Not persisted: <status> — <reason>" and store nothing.
    4. If valid: obtain `entryClose` from the cached series — `const r = await histAnalysis.run({ ticker: symbol, depth }); const condIdx = r.bars.findIndex(b => b.t === contract.conditionTime); entryClose = r.bars[condIdx]?.c` (cache hit, no network).
    5. `predictionRepo.createPrediction(contract, { entryClose })`, then `predictionRepo.recordPredictionOutcome(id, r.bars)` to opportunistically resolve any horizons whose future candles have since arrived.
    6. Render ALL records for `currentSymbol` into `#pred-records-results`.
- **Renderer `renderPredictionRecordsHtml(records)`** (pure string, hostile-input escaped like `escHtml`/`esc`):
  - One block per record: `badge badge--ok` for `resolved`, `badge badge--unavailable` for `pending`/`insufficient_outcome_data`; ticker, condition date, lifecycle.
  - Per-horizon table rows: `Horizon | Predicted (direction @ probability%) | Outcome (direction, ±return% on target date) | Hit? (✓/✗/—)`. Pending horizons show `—`; insufficient horizons show the literal label `insufficient_outcome_data`.
  - Disclaimer line verbatim from the record.
  - **NO aggregate accuracy percentage, hit counts, or summary score anywhere.** Each row's ✓/✗ is an individual outcome indicator, not a statistic.
  - Tickers rendered come exclusively from record data; zero literals.

## 9. API endpoints (additive, following existing server architecture)

`server.mjs` currently dispatches exactly two route kinds before static serving: `/v2*` proxy and OPTIONS preflight, with `corsHeaders()` and JSON errors. Add ONE parallel branch, same conventions (JSON responses, `corsHeaders()`, explicit method checks, 404 JSON — never masked by the HTML fallback):

- Shared validation: import pure helpers from `prediction-record.js` (safe: no browser/node-specific imports).
- Node-side file store: `data/prediction-records.json` (array of records), created lazily via `fs.mkdir(path.dirname(f), {recursive:true})`; read/write wrapped in try/catch returning `500 {error:'prediction_store_error'}`. Builder should append `data/` to `.gitignore` if one exists (check; create no other config).
- Routes (dispatch BEFORE the static handler, alongside `/v2`):
  - `GET  /api/predictions?ticker=&status=` → `{records:[...]}` filtered (status ∈ lifecycle values)
  - `GET  /api/predictions/:id` → `{record}` | `404 {error:'not_found'}`
  - `POST /api/predictions` body `{contract, entryClose}` → validates with `isValidPredictionContract` + `validatePredictionRecord`; invalid ⇒ `422 {error:'invalid_prediction_contract', detail}`; duplicate id ⇒ `200 {record:<existing>, duplicate:true}` (idempotent, mirrors §6)
  - `POST /api/predictions/:id/outcome` body `{bars}` or `{final:true}` → applies §5 rules; `404` unknown id, `409 {error:'immutable_record'}` if terminal-and-mutating (per §5.3 return-existing semantics the server answers terminal no-ops with `200 {record, noop:true}`)
- The server store is independent programmatic access; the browser app continues to use its local-repository default. Both validate through the same pure `prediction-record.js` rules so schemas cannot drift.
- Blocked-path guard (`isBlockedPath`) untouched; `node_modules`/dotfile protections intact.

## 10. Files to touch (complete list)

| File | Change |
|---|---|
| `prediction-record.js` | **NEW** — pure schema/identity/validity/build/validate helpers (§2, §4) |
| `prediction-repository.js` | **NEW** — repository + swappable backend + `renderPredictionRecordsHtml` (or split renderer into `prediction-records-ui.js`; either is fine, pick one and keep exports stable) |
| `tests/prediction-repository.test.mjs` | **NEW** — the 19 cases (§11), reusing the seeded-generator/fake-DI patterns from `tests/live-prediction.test.mjs` |
| `app.js` | Additive: imports, module-level repo instance, `wirePredictionRecords`/`runSaveOrRefreshPredictionRecord`, boot line. Nothing removed. |
| `index.html` | Additive: the §8 sub-section. Nothing else moved. |
| `server.mjs` | Additive: `/api/predictions*` branch (§9). `/v2` proxy, CORS, static serving untouched. |
| `.gitignore` | Append `data/` only if such entries exist in the file's style; otherwise skip (runtime-created dir, harmless untracked). |
| `www/*`, `build-info.js` | Regenerated artifacts via `npm run build` (Phase A practice) — build output, not hand edits. |

Never touched: `live-prediction.js`, `pattern-engine.js`, `prediction-engine.js`, `historical-analysis.js`, `history-source.js`, `api.js`, `storage.js`, `utils.js`, `style.css`, `ticker-multiselect.js`, `android/`, `apk/`.

## 11. Deterministic tests — exactly 19 cases (`tests/prediction-repository.test.mjs`)

Zero-network, seeded fixtures (`dailyBars`, fake controllers) per the Phase A harness. All 19 must be individual `it()` blocks:

1. **Happy-path creation**: valid `OK` contract + `entryClose` → record with every §2 field present, `lifecycleStatus:'pending'`, all six outcome leaves `null`, deterministic id matching `computeRecordIdentity`.
2. **Persist-gate NO_DATA**: `buildPredictionContract({ticker:'', bars:[]})` → `createPrediction` returns `null`; `repo.count()===0` (in-memory backend).
3. **Persist-gate INSUFFICIENT_HISTORY**: short-series contract → rejected, nothing stored.
4. **Persist-gate INSUFFICIENT_EVIDENCE**: contract with all directions null (minSignalSample raised) → rejected.
5. **Round-trip isolation**: `getPrediction(id)` deep-equals created record; mutating the returned object does not alter storage.
6. **Listing filters**: seed 3 records (2 tickers × statuses) → `listPredictions({ticker})` and `{lifecycleStatus}` each return exactly the right subset, ordered newest-first.
7. **Duplicate protection**: `createPrediction` twice with same ticker/conditionTime (different `generatedAt`) → identical id, original record returned unchanged, count 1.
8. **Distinct conditions**: next session's contract (one new candle appended) → new distinct record; count 2.
9. **Outcome math**: predicted up, `bars[ci+3].c` known → leaf has exact `targetBarTime`, `outcomeClose`, `returnPct` (2dp), `correct:true`; other horizons untouched.
10. **Correctness matrix**: up/up→true, down/down→true, up/down→false, exact-flat close→`outcomeDirection:'flat'`,`correct:false` (four sub-asserts, one block, hand-built tiny bars around a fixed condition index).
11. **Prediction immutability on outcome write**: snapshot `JSON.stringify(prediction+marketState+methodology)` before/after `recordPredictionOutcome` → byte-identical; only `outcomes`, `lifecycleStatus`, `updatedAt` differ.
12. **Terminal immutability**: after full resolution, `recordPredictionOutcome(..., moreBars)` and `finalizeAsInsufficientOutcomeData` return the record unchanged (same `updatedAt`, deep-equal) — resolved is frozen.
13. **Per-horizon insufficient**: evaluate with only ci+2 candles available → horizons 3/5/10 leaves are `status:'insufficient_outcome_data'` with all-null value fields, horizon 1 resolved, lifecycle still `pending`.
14. **Finalize-insufficient locks**: `finalizeAsInsufficientOutcomeData` on a partly-resolved record → remaining leaves locked insufficient, lifecycle `insufficient_outcome_data`, later evaluation no-op.
15. **Horizon-parity with the engine**: same bars fed to `analyzePattern`'s `computeMatchedForwardOutcomes` and to `recordPredictionOutcome` → identical entry/target closes per horizon (cross-check `returnPct` against `averageReturnPct` construction from a single-match series).
16. **Candle-offset vs calendar semantics**: synthetic series skipping weekends (weekday generator) → horizon-3 target timestamp equals the 3rd subsequent CANDLE's `t`, which is NOT `conditionTime + 3×24h` when a weekend intervenes.
17. **Leakage regression**: (a) create record from `bars.slice(0,k)`; append/mutate future bars ×5 price / ×20 volume; stored `prediction.*` unchanged; (b) `recordPredictionOutcome` computed from post-condition bars never alters `prediction.*`; (c) re-run `buildPredictionContract` on the extended prefix — the ORIGINAL stored prediction still equals the prefix-time contract. Mirrors Phase A prefix-invariance discipline at the persistence layer.
18. **Swappable backend + storage hygiene**: an injected in-memory Map backend behaves identically (all CRUD paths); plus a source-scan assertion grepping `prediction-repository.js`/`prediction-record.js`/`app.js` additions for direct `localStorage` references → none (only `storage.js`).
19. **Renderer contract**: `renderPredictionRecordsHtml` renders predicted vs outcome per horizon, escapes `<script>` payloads in ticker-like strings, shows `pending`/`insufficient_outcome_data` badges, and contains no accuracy-statistics wording (assert absence of `/accuracy/i`, no aggregate percentage element).

Run: `npx vitest run tests/prediction-repository.test.mjs`, then the full suite `npx vitest run` (must remain ≥262 passing + 19 new, zero regressions), `npm run build && node build-check.mjs` (exit 0).

## 12. Verification checklist for the builder

1. `npx vitest run` — all green including the 19 new cases.
2. `npm run build` and `node build-check.mjs` — BUILD PASS, exit 0; `www/` mirrors regenerated.
3. Manual smoke (`npm run dev`): select asset → GET HISTORICAL DATA → PREDICT CURRENT STATE → SAVE/REFRESH PREDICTION RECORD shows a pending record; re-pressing on the same day does not duplicate it; pressing again after future sessions exist resolves available horizons.
4. `git diff --stat HEAD` — only the files listed in §10.
5. Confirm `ticker-multiselect.js` and `.ms-*` CSS are untouched (`git diff --name-only` must not list them).

## 13. Explicitly out of scope (forbidden)

Calibration, probability recalibration/backtesting-driven tuning, LLM/AI integration, trade execution/brokers/alerts on outcomes, accuracy dashboards or aggregate stats, hardcoded tickers, new horizons, calendar trading calendars, IndexedDB/remote sync backends beyond the §9 endpoints, Capacitor/APK work, changes to the Android dropdown fix.
