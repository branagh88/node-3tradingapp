# PHASE 3 PLAN — Improve & Validate the Historical Pattern Prediction Engine

Repo: `/opt/mesh-viewer-data/branagh88/projects/node-3tradingapp`
Session: `f6a12529`

---

## 0. CURRENT STATE (documented from source inspection)

### How the Phase 2 model works today

**Data flow:** `app.js` → `HistoricalAnalysisController.run()` (`historical-analysis.js`)
→ paginated daily candles via `HistorySource` + `RateLimiter` (Tickerbot API,
cursor pagination, dedup, chronological sort) → for datasets > 60 bars it runs
locally:

1. `patternEngine.analyzePattern({ bars })` (`pattern-engine.js`) — latest-bar
   condition analysis.
2. `predictionEngine.walkForwardBacktest({ bars, horizons: [1,3,5,10] })`
   (`prediction-engine.js`) — out-of-sample evaluation.

**Feature extraction** (`extractFeatures`, pattern-engine.js): 20 features per
candle (`FEATURE_NAMES`): return1d/3d/5d/10d, bodyPct, upperWickPct,
lowerWickPct, highLowRangePct, volume, volumeVsAvg20, distFromSma5/10/20/50,
distFromEma9/21, consecutiveUpDown, volatility5d/10d, rsi14. A candle qualifies
only when ALL 20 are computable point-in-time (needs i ≥ 50). Every feature at
index i uses only bars[0..i] — strict no-lookahead, verified by existing tests.

**Normalization** (`normalizeFeatures`): robust z-score; for day i, center =
median and scale = 1.4826·MAD computed over ALL PRIOR qualifying days only.
No leakage.

**Matching** (`weightedDistance` + `analyzePattern`): weighted Euclidean
distance = sqrt(mean over used features of (w·(za−zb))²) in z-space.
**Every prior qualifying day with distance ≤ MAX_DISTANCE = 1.5 becomes a
match.** MIN_MATCHES = 30.

**Forward outcomes** (`computeMatchedForwardOutcomes`): for each matched day
and horizon h ∈ {1,3,5,10}, close[i+h]/close[i]−1; reports up%, down%,
avg/median/best/worst return, sample size + honest classification
(classifySampleSize: <10 INSUFFICIENT, <30 LOW, <100 MODERATE, else STRONG).

**Backtest** (`walkForwardBacktest`, prediction-engine.js): chronological
split of qualifying rows at splitRatio=0.7 → older rows form the database,
newer rows are the test set. For each test row: match ONLY against PRIOR
database rows within maxDistance, majority-vote direction (ups vs downs among
matched forward moves), compare to actual direction. Baseline = "always
predict up" (= observed up-rate on test rows). Reports per-horizon accuracy,
positive/negative signal precision, avg return after positive signal.

### WHY ~964 matches out of 1,254 (diagnosis to confirm empirically)

1. **RMS distance over 20 features is far too forgiving at 1.5.** The
   threshold bounds the *average* per-feature squared z-deviation, so a day
   can deviate by ~1.5σ on average across all 20 features and still qualify.
   For roughly Gaussian features, P(distance ≤ 1.5) is very large — matching
   most of the distribution is expected behavior, not a bug.
2. **Massive feature redundancy collapses effective dimensionality.**
   distFromSma5/10/20/50 + distFromEma9/21 are near-collinear (6 features
   measuring one thing); volatility5d/10d likewise; return3d ≈ f(return1d,
   return5d); bodyPct/wicks/range are one candle-anatomy group. Redundancy
   means a few shared factors dominate the distance and individual features
   add almost no discrimination.
3. **Robust z-scores compress outliers**, further concentrating distances
   near the bulk mean.
4. **Threshold-and-count matching has no selectivity pressure**: there is no
   top-K cap, no percentile criterion, no requirement that matches be *more*
   similar than typical. The result: nearly every historical day is declared
   "similar" and the conditional statistics converge to unconditional
   statistics → accuracy ≈ base rate ≈ baseline (~51–55%).

The builder must re-derive these numbers empirically (distance distribution
percentiles on real data) before choosing the fix, but the plan below assumes
this diagnosis and replaces fixed-threshold matching with selective matching.

---

## 1. SCOPE & CONSTRAINTS (restated from task)

- Files in scope: `pattern-engine.js`, `prediction-engine.js`, `app.js`
  (rendering only), new research/backtest scripts under `scripts/research/`,
  new tests under `tests/`, optional fixture module under `tests/fixtures/`.
- OUT of scope / untouched: `history-source.js`, `historical-analysis.js`,
  retrieval/pagination logic, chart code, alerts, notifications, storage,
  api.js auth, config.js, unrelated UI sections.
- No new market-data provider. Multi-ticker data comes through the EXISTING
  `TickerbotAPI` config (user's saved URL/key via existing architecture), or
  deterministic seeded fixtures if the dev environment has no live access.
- Never tune on the final test set. Any parameter selection happens inside a
  chronological train→validation window that precedes the reported test window.
- Honest reporting over pretty numbers: "no meaningful edge found" is an
  acceptable final result and must be reported as such.
- The builder must NOT stop after implementing the first idea: run actual
  backtests comparing variants (threshold-only vs top-K vs ablations vs
  composite conditions) across tickers and record measured numbers before
  fixing defaults.

---

## 2. IMPLEMENTATION WORK ITEMS

### W1 — Selective matching (Improvement 1) — `pattern-engine.js`

Add a principled matching strategy alongside (not replacing API compat of)
the distance function:

- **Top-K nearest neighbors**: rank all prior qualifying days by weighted
  distance; take the K nearest. New defaults: `matchMode: 'topk'`,
  `K_ADAPTIVE_MIN = 40`, `K_MAX = 200`.
- **Adaptive K**: K scales with database size, e.g.
  `K = clamp(round(dbSize * kFraction), K_ADAPTIVE_MIN, K_MAX)` with
  `kFraction ≈ 0.05` — data-dependent, not hard-coded counts.
- **Percentile gate**: additionally require candidate distance ≤ the p-th
  percentile of the current day's candidate-distance distribution
  (default p = 0.05) — combines absolute similarity with relative rarity.
- Keep `maxDistance` as an OPTIONAL hard ceiling applied after ranking (raise
  its default or make null so top-K governs).
- Expose in the result: `matchMode`, `K used`, `percentile cutoff`,
  `maxMatchDistance`, and per-match distances (already exposed).
- Update `analyzePattern()` to accept the new options; keep old
  threshold-only mode available via `matchMode: 'threshold'` for A/B tests.

Acceptance: on a ~1,250-candle synthetic set, default settings yield tens of
matches (not hundreds); match count varies with data character.

### W2 — Feature ablation harness (Improvement 2) — `scripts/research/ablation.mjs`

New Node script (repo has no bundler; plain ESM node script run with
`node scripts/research/ablation.mjs <bars.json>`):

- Loads bars (from fixture file or JSON dump), defines FEATURE GROUPS:
  momentum returns {return1d..10d}, candle anatomy {bodyPct, wicks, range},
  volume {volume, volumeVsAvg20}, MA distances {distFromSma*, distFromEma*},
  streak {consecutiveUpDown}, volatility {volatility5d,10d}, RSI {rsi14}.
- Runs `walkForwardBacktest` (or the new W6 harness) once per ablation:
  full baseline + each single-group removal.
- Emits a table: variant | OOS directional accuracy | edge vs baseline |
  coverage | n. Writes results to stdout and optionally a JSON file for the
  final report.
- Also support per-FEATURE leave-one-out when groups are inconclusive.

Feature weights may be pruned (feature removed from FEATURE_NAMES usage via
weights=0 or an explicit `activeFeatures` option — prefer an explicit
`activeFeatures` array param threaded through extractFeatures/normalize/
distance so normalization stats stay consistent).

### W3 — Composite condition scoring (Improvement 3) — `pattern-engine.js`

Add an alternative/complementary matcher capturing multi-feature
conjunctions:

- **Discretized condition signature**: bucket key features into regimes
  (e.g., RSI14 into ≤30/30-45/45-55/55-70/>70; SMA20 distance quintile from
  past-only distribution; volumeVsAvg20 into low/normal/high; 5d-return sign
  × magnitude tercile; volatility tercile). Signature = conjunction tuple.
- Matches = prior days with IDENTICAL signature (optionally relaxed to
  allow 1 differing component when sample too small).
- Implement as `matchMode: 'composite'`; combine with top-K fallback:
  use composite matches when count ≥ minMatches, else fall back to top-K.
- Evaluate empirically (W7) whether composite beats pure top-K OOS;
  retain whichever honestly performs better (or report parity).

### W4 — Sample-size gating + NO SIGNAL (Improvements 4 & 7) — `prediction-engine.js`

Restructure backtest/signal output around a decision pipeline:

```
features → matches → confidence/sample evaluation
        → { signal: 'UP'|'DOWN', probabilityPct, matchedCount,
            baselinePct, edgePp, ci95, sampleClass, evidence }
        | { signal: 'NONE', reason: 'INSUFFICIENT_SAMPLE' | 'NO_EDGE'
                                  | 'AMBIGUOUS', ... }
```

Rules:
- If qualifying match sample < `MIN_SIGNAL_SAMPLE` (default 30):
  `signal:'NONE', reason:'INSUFFICIENT_SAMPLE'`. NEVER emit a probability.
- Compute Wilson 95% CI on the matched up-rate; if CI includes 50% (or the
  baseline rate) beyond tolerance, either downgrade to NONE with
  `reason:'NO_EDGE'` or label confidence LOW — decide via W7 experiments;
  minimum: never display "high confidence" without CI excluding baseline.
- Probability display always accompanied by matchedCount and classification.
- Track per-test-row decisions so the backtest reports UP/DOWN/NONE counts
  and separate metrics ON SIGNALS ONLY (signal coverage %).

### W5 — Baselines & richer metrics (Improvements 5 & 6) — `prediction-engine.js`

Extend backtest aggregates per horizon AND overall:

- Baseline A: always predict historically dominant direction (up if
  test-window up-rate ≥ 50%, else down).
- Baseline B: unconditional positive rate (always-up accuracy).
- Baseline C: momentum baseline — predict sign of trailing 5d return.
- Metrics per strategy (model + A + B + C): directional accuracy,
  positive-signal precision, negative-signal precision, #positive/#negative
  signals, coverage (% of test rows with a signal), avg & median forward
  return conditioned on signal, hit rate, edge vs best simple baseline in pp,
  sample size, Wilson CI half-width, and (if cheaply computable from bars)
  max adverse excursion over the h-day window after signals.
- Headline answer surfaced in output object:
  `edgeVsBestBaselinePp` + boolean `beatsBaselines`.

### W6 — Walk-forward parameter selection (Improvement 8) — new
`walkForwardParameterSearch()` in `prediction-engine.js` (+ script wrapper)

- Chronological three-segment scheme over qualifying rows:
  TRAIN (oldest ~60%) → VALIDATION (next ~20%) → TEST (final ~20%).
  Grid search (K/kFraction/percentile/matchMode/activeFeatures/weights)
  scored ONLY on validation rows; the winning configuration is frozen and
  evaluated ONCE on TEST. Test results are what gets reported.
- Optionally roll this scheme across multiple folds (expanding train window)
  and report per-fold test results + aggregate, which also demonstrates
  stability.
- Document the selected-parameter provenance in the returned object
  (`paramSearch: { grid, validationScores, chosen }`) so the final report can
  state exactly how parameters were chosen.
- Guard: if TRAIN+VALIDATION too small (< ~150 qualifying rows), skip search
  and use documented conservative defaults, labeled as such.

### W7 — EMPIRICAL COMPARISON LOOP (mandatory — do not skip)

Create `scripts/research/compare.mjs` orchestrating everything and RUN it:

1. Acquire bars for AAPL, GME, MSFT, NVDA, AMZN:
   - First try the existing app path: instantiate TickerbotAPI with saved
     config exactly as the app does (see `api.js`, secure-store/config wiring;
     HistoricalAnalysisController already wraps it). If network/auth works in
     this environment, cache responses to `scripts/research/data/<TICKER>.json`
     (gitignored or committed — builder's call, note it).
   - If unavailable, generate deterministic seeded synthetic bars per ticker
     profile (reuse the mulberry32 approach from tests) and CLEARLY document
     in the final report that automated numbers come from fixtures, plus any
     manual/live numbers obtained another way.
2. Run, per ticker: Phase 2 baseline config → threshold-only tightened →
   top-K variants → percentile gate → composite mode → each ablation →
   winner via walk-forward param search.
3. Record every variant's OOS numbers in a results table (JSON + markdown).
4. Choose final defaults from MEASURED results. If no variant reliably beats
   baselines across tickers, ship the most honest configuration and say so.

### W8 — Honest model score + UI (Improvement 9) — `app.js`, `pattern-engine.js`

- Add a `modelScore` block to analysis/backtest output:
  `{ signal, probabilityPct, matchedCount, baselinePct, observedEdgePp,
     oosValidationStatus: 'POSITIVE'|'NEGATIVE'|'INCONCLUSIVE',
     confidence: 'LOW'|'MODERATE'|'HIGH' }` where confidence derives from
  sample class AND CI excluding baseline AND consistent OOS folds — never
  from raw percentage alone.
- Update `renderPatternSection` / `renderBacktestSection` in `app.js`:
  - Show signal-or-NO-SIGNAL prominently; NO SIGNAL renders as a neutral
    badge with the reason.
  - Probability lines show "(n=X historical matches · MODERATE SAMPLE)".
  - Backtest table adds baseline columns (A/B/C) and model edge row.
  - Keep all existing disclaimer/hint language style ("historical
    conditional frequency, not a forecast").
- Do not touch other UI sections.

### W9 — Tests — `tests/pattern-engine.test.mjs` (extend) + new
`tests/prediction-engine.test.mjs`

Required coverage:
- **Leakage**: appending future bars doesn't change past features (exists —
  extend to composite signatures and adaptive-K matching: match sets for day i
  unchanged by mutating/truncating future bars; normalization prefix property
  extends to activeFeatures subsets).
- **Selective matching**: top-K returns exactly min(K, available) nearest;
  ordering by distance; percentile gate excludes common distances;
  changing K/threshold monotonically affects match count; determinism
  (same input → identical match sets & outcomes, run twice).
- **Sample-size handling**: 1–9 matches ⇒ no probability emitted /
  INSUFFICIENT; tiny-sample "100%" impossible; classifySampleSize boundaries.
- **Baselines**: compute dominant-direction, always-up, momentum baselines
  against hand-verifiable synthetic cases; edge arithmetic correct.
- **Walk-forward**: split respects time order (exists — extend to 3-way
  param search: assert chosen params derive only from validation scores and
  test segment indices > validation > train); parameter search skipped on
  small data.
- **NO SIGNAL**: insufficient-sample and no-edge reasons reachable; forced
  prediction never occurs below thresholds.
- **Regression**: all existing tests in `tests/*.mjs` keep passing untouched
  semantics (existing assertions about DEFAULTS.MAX_DISTANCE etc. may need
  updating ONLY if defaults change — update them to the new documented
  defaults, don't delete coverage).

Run: `npm test` (vitest) must pass fully; `npm run smoke` and
`npm run test:boot` should still pass.

### W10 — Build & APK verification

1. `npm run build` (build-check.mjs regenerates build-info + mirrors sources
   into www/ — MUST be run after JS changes so www/ and android assets sync).
2. Android debug APK via existing process:
   `cd android && ./gradlew assembleDebug` (postinstall gradle patch already
   in place). Copy/refresh artifact as the repo convention shows
   (`apk/market-intelligence-debug.apk`). Note: repo history shows gradle
   diagnostics in `apk/` — if gradle fails for environmental reasons,
   document exact error and attempted fixes rather than claiming success.
3. Final report includes: files changed, methodology summary, leakage audit
   table, before/after metrics table (Phase 2 numbers given below as the
   "before"), signal coverage (UP/DOWN/NONE %), sample sizes behind major
   signals, per-ticker results, full test-suite result, build result, APK
   status.

Phase 2 reference numbers (the "before" column):

| Metric          | Phase 2      |
|-----------------|--------------|
| Similar matches | 964 / 1254   |
| Overall OOS acc | 51.77%       |
| 1D              | 50.57%       |
| 3D              | 50.29%       |
| 5D              | 51.16%       |
| 10D             | 55.13%       |

---

## 3. LEAKAGE AUDIT CHECKLIST (builder must verify each and state it)

- Features: index i uses only bars[0..i] ✔ (keep; extend tests to new modes).
- Normalization: median/MAD from strictly-prior rows only ✔ (preserve when
  adding activeFeatures; percentile cutoffs must also use prior-day distance
  distributions only).
- Matching: candidates strictly i < testIdx ✔.
- Forward outcomes: close-to-close ahead of match date, used only as labels.
- Parameter selection: grid scored on validation segment only; test touched
  once ✔ (assert in tests).
- Composite signature buckets: quantile edges derived from PRIOR data only
  (recompute per test day from past rows — do not fit buckets on full series).
- Baselines: computed on the same test windows they're compared against, but
  they use no fitting at all — acceptable; document.

## 4. EXECUTION ORDER

W1+W4 core engine changes → W9 tests for those → W5+W6 → W2/W3/W7 research
loop and empirical decisions → freeze defaults from measurements → W8 UI →
full suite + build + APK → final report with honest numbers.

Estimated diff footprint: pattern-engine.js (+~200 lines), prediction-engine.js
(+~300), app.js render sections (~80), scripts/research/* (new), tests
(+~400), no retrieval-layer changes.
