# Phase 4 — Real Tickerbot Data Empirical Validation (Plan)

Session: `ee617a22`
Goal: answer, with evidence from REAL Tickerbot historical candles, whether the existing
Phase 3 pattern engine (`prediction-engine.js`) beats simple baselines out-of-sample.
**Validation only.** No algorithm redesign, no parameter tuning against the final test
set, no synthetic substitution, no user-facing claim changes.

## Context (verified in repo)

- `prediction-engine.js` — `walkForwardBacktest({bars, horizons, ...})` (point-in-time
  features via `pattern-engine.extractFeatures`, prior-only DB matches, adaptive top-K +
  percentile gate, composite mode, NO-SIGNAL gate at `DEFAULTS.MIN_SIGNAL_SAMPLE`,
  Wilson CI, three baselines: dominant / always-up / momentum), plus
  `walkForwardParameterSearch` (train 60% → validation 20% → test 20%) and
  `modelScore` (LOW/MODERATE/HIGH confidence). **Do not change its logic.**
- `history-source.js` — `HistorySource.fetchRange({ticker, interval, from, to,
  maxPages})` with cursor pagination over `GET /v2/tickers/{sym}/bars/{interval}`
  (page size 1000, hard cap 200 pages ≈ 200k bars), client rate limiter
  (≤55 req/min, ≥1100 ms gap), `dedupeAndSortBars`, `mergeBars`.
- `api.js` — `MarketAPI.fetchBarsPageRaw({ticker, interval, from, to, before, cursor,
  limit})` is the transport adapter for HistorySource. Key lives ONLY in the runtime
  secure store on device; `config.loadConfig()` never returns it.
- `scripts/capture-aapl.mjs` — existing precedent for a Node runner that loads stored
  creds (localStorage shim) and **exits code 2 honestly when no key exists** rather than
  fabricating data.
- `scripts/research/gen-bars.mjs` — synthetic fixtures (Phase 3). Its header already
  anticipates this phase: "the same compare.mjs can consume cached real bars from
  data/<TICKER>.json".
- `scripts/research/results/RESULTS.md` + `compare-results.json` — SYNTHETIC results.
  Must remain untouched; real-data results go to a separate directory.
- Tests live in `tests/*.test.mjs` (vitest, `npm test`). Build = `node build-check.mjs`.
  Android project present (`android/`, Capacitor); APK stamping via `build-info.js`
  (`BUILD_INFO.commit`).

**Known environment constraint:** the dev shell has no `TICKERBOT_API_KEY` env var and no
persisted key (`capture-aapl.mjs` would exit 2 today). The plan therefore has a hard gate
at Step A: if no key can be located, STOP after shipping the harness/tests and report the
blocker honestly — never substitute synthetic data.

## Step A — Locate credentials (gate)

- Check, in order: `TICKERBOT_API_KEY` / `TICKERBOT_API_TOKEN` env vars;
  `~/.pi/studio/credentials/` or sibling studio credential files mentioning tickerbot;
  any untracked local key file documented in README/justfile.
- If found: export for the fetch run only (never echo, never commit, never print).
- If not found: build everything below anyway (fetch script exits 2 with a clear
  message, exactly like `capture-aapl.mjs`), run tests/build/APK steps, write
  RESULTS.md as a BLOCKED report explaining precisely what is missing and what command
  to re-run once a key is provisioned. Do NOT fabricate results.

## Step B — One-shot real-data fetcher with cache

New file `scripts/research/fetch-real-bars.mjs`:

- CLI: `node scripts/research/fetch-real-bars.mjs [--force] [TICKER...]`
  default tickers: AAPL MSFT NVDA AMZN META GOOGL TSLA GME.
- For each ticker:
  - Skip if cache exists (`scripts/research/data/real/<TICKER>.json`) unless `--force`;
    log "cache hit" so repeated runs cost zero API calls.
  - Build a `MarketAPI` from stored config/key (reuse the localStorage-shim +
    `storage.migrate()` pattern from `scripts/capture-aapl.mjs`; also accept the env
    key from Step A by passing it into MarketAPI directly).
  - Fetch daily bars (`interval: '1d'`) via `new HistorySource({fetchPage:
    api.fetchBarsPageRaw.bind(api)}).fetchRange({ticker, interval:'1d', from: <epoch-ms
    ~15 years back>, to: now, maxPages: HISTORY_LIMITS.MAX_PAGES_HARD_CAP})`. At 1000
    bars/page this is ≤6 pages/ticker → ≤48 requests total for 8 tickers, one time ever.
    The built-in RateLimiter keeps us under the free-plan limits automatically.
  - On per-ticker failure (401/403/429/network): record failure metadata for that
    ticker, continue with the others, exit non-zero only if ALL fail.
  - Write cache JSON: `{ ticker, source:'tickerbot', interval:'1d', fetchedAt,
    apiRequestsUsed, bars: [{t,o,h,l,c,v}...] }` under
    `scripts/research/data/real/`. Add that directory to `.gitignore` if large
    (builder's call based on size) but DO commit small caches if they fit — they make
    research reproducible without API calls.
- Print a per-ticker summary line: ticker, candle count, first/last date, requests used.

## Step C — Real-data integrity validator

New file `scripts/research/validate-bars.mjs` (exported functions + CLI):

- Per dataset assert/report: ticker, interval, date range (min/max t), candle count,
  strictly chronological ordering, OHLC validity (h ≥ max(o,c), l ≤ min(o,c), all > 0),
  volume presence (> 0 on ≥95% of rows; flag otherwise), duplicate timestamps count,
  missing weekday gaps > 5 trading days (list them), and suspicious zero-close rows.
- Emit a machine-readable verdict per ticker into the results JSON; hard-fail the
  pipeline for a ticker only on ordering violations or invalid OHLC (those corrupt
  features); warn-and-continue for gaps/duplicates (dedupeAndSortBars already dedupes).
- Unit-test these checks in Step F.

## Step D — Real-data validation runner

New file `scripts/research/run-real-validation.mjs`:

- Loads cached real bars (never fetches), runs per ticker:
  1. `walkForwardParameterSearch({bars, horizons:[1,3,5,10]})` — parameter choice stays
     confined to TRAIN→VALIDATION segments inside the engine (already leakage-safe);
     the chosen config is then evaluated ONCE on test rows by the search itself.
     Record `chosen`, `validationScores`, scheme boundaries.
  2. With the chosen config frozen, `walkForwardBacktest({bars, horizons:[1,3,5,10],
     ...chosen})` for the headline numbers.
  3. Two additional gated views of the SAME test rows (no re-tuning):
     - HIGH-CONFIDENCE slice: rerun with `requireEdge: true` (Wilson CI must exclude
       50% before a signal counts) — this is the engine's stricter signal definition.
     - SAMPLE-GATE slice: filter reported stats to horizon rows where matched sample
       ≥ `DEFAULTS.MIN_SIGNAL_SAMPLE` (the engine already emits NO-SIGNAL below it;
       report coverage/accuracy of what remains vs. forced predictions).
- Per ticker × horizon × slice record: eligibleRows, predictions, noSignals, coveragePct,
  accuracyPct, positive/negative accuracy, avg & median return after positive signal,
  win rate (share of up-signals whose h-day return > 0 AND down-signal returns < 0 —
  compute from recorded per-row outcomes), Wilson CI, each baseline accuracy,
  model-minus-best-baseline pp, and a binomial significance check (two-sided exact-ish
  normal approximation z-test of accuracy vs best-baseline accuracy with n = signals;
  report p-value; mark significant only if p < 0.05 AND edge > 0).
- Verdict per ticker/horizon (explicit rules, applied mechanically):
  - `INSUFFICIENT_SAMPLE` if signals < `DEFAULTS.MIN_SIGNAL_SAMPLE` (30);
  - else `EDGE` iff accuracy > best baseline AND Wilson 95% CI lower bound > best
    baseline accuracy AND p < 0.05;
  - else `NO EDGE`.
  Accuracy above 50% alone NEVER yields EDGE.
- Cross-ticker consistency section: how many ticker/horizon cells are EDGE vs NO EDGE;
  whether edges concentrate in one ticker/horizon; split the test window into halves
  (older half vs newer half of test rows) to expose regime dependence; note sample
  sizes driving any apparent effect.
- Provenance block in output JSON: every ticker's source, interval, fetchedAt/date
  range/candle count, train/validation/test boundary bar indexes and dates, full engine
  `config`, horizons, total API requests used to build the caches, git commit of the run.

## Step E — Results artifacts

Directory `scripts/research/results/real-data/` (new; synthetic results untouched):

- `real-data-results.json` — everything from Step D including provenance.
- `RESULTS.md` — human report: methodology recap, data-integrity table, per-ticker ×
  horizon tables (all / high-confidence / sample-gate slices), consistency analysis,
  and an evidence-based final answer to: "Does the Phase 3 engine provide a
  statistically defensible improvement over simple baselines on real Tickerbot data?"
  If blocked (no key): RESULTS.md documents the blocker and exact re-run instructions,
  with NO fabricated numbers. If real data shows no edge: say so plainly.
- Do NOT modify `scripts/research/results/RESULTS.md` or `compare-results.json`.

## Step F — Automated tests

New file `tests/real-data-validation.test.mjs` (vitest, offline, deterministic):

- **No future leakage:** reuse the established mutation trick from
  `tests/prediction-engine.test.mjs` ("mutating future bars never changes match sets")
  against the runner's per-row prediction routine — perturbing bars AFTER a prediction
  date must not alter that date's signal.
- **Chronological walk-forward behavior:** on a crafted series, every match index <
  every test index; splitIndex monotone in splitRatio.
- **Train/test separation:** `walkForwardParameterSearch` chosen-config evaluation uses
  test rows strictly after validation end (assert boundary indexes/dates recorded in
  output schema).
- **Determinism:** running the validation pipeline twice on the same cached fixture
  produces byte-identical JSON (stringify-compare, excluding timestamps — inject a clock
  or exclude `fetchedAt`/`generatedAt` fields from the comparison).
- **NO-SIGNAL handling:** datasets engineered so matched samples fall below
  MIN_SIGNAL_SAMPLE produce `noSignals` counted, zero predictions, `coveragePct < 100`,
  null accuracy — never a fabricated direction.
- **Insufficient history:** bars shorter than the engine minimum (< 20 qualifying rows)
  yield `ok:false` with message, not a crash or fake stats.
- **Real-data schema validation:** a `validateResultsSchema(results)` helper (exported
  from the runner or validator module) asserts required keys/types for every
  ticker/horizon/slice entry (accuracy within [0,100] or null, counts non-negative,
  wilsonLow ≤ accuracy ≤ wilsonHigh when present, verdict ∈ {EDGE, NO EDGE,
  INSUFFICIENT_SAMPLE}); test it against a tiny committed inline fixture (not a real
  payload) and against malformed inputs.
- Also unit-test `validate-bars.mjs` checks: valid OHLC passes; inverted high/low
  fails; duplicate timestamps detected; weekend-only gaps ignored.

## Step G — Run everything

1. `npm test` (existing suite + new tests) — all green.
2. `npm run build` (`node build-check.mjs`) — green.
3. If Step A found a key: run Steps B→E for real. Otherwise leave the harness ready.
4. Android build (environment IS available: `android/gradlew`, `local.properties`,
   android-build skill exist):
   - Rebuild web assets into `www/` as the skill prescribes, sync Capacitor
     (`npx cap sync android` or the skill's justfile targets), assemble debug APK.
   - Refresh `build-info.js` stamp FIRST (commit hash of HEAD including this phase's
     commits) so the APK is not stale — verify post-build that the APK's bundled
     `build-info.js`/`www` content matches current HEAD (unzip/grep the APK or check
     the www copy synced), and state the verified commit in RESULTS.md provenance.

## Constraints restated for the builder

- Read-only w.r.t. `prediction-engine.js`, `pattern-engine.js`, `api.js`,
  `history-source.js` logic. New files + additive exports only elsewhere.
- No edits to user-facing claims (README app copy, UI text) — validation phase only.
- Never print/log/commit the API key; follow security-hygiene practices.
- Minimize API calls: one cached fetch per ticker; all research runs read cache.
- Synthetic results directory remains untouched and clearly separated from
  `results/real-data/`.
- Report honestly. `NO EDGE` is an acceptable, expected outcome (synthetic Phase 3
  already showed none); do not tune, slice, or reframe to manufacture one.

## Suggested commit sequence

1. `Add real-data fetch/cache harness for Tickerbot history`
2. `Add real-data integrity validator`
3. `Add real-data walk-forward validation runner and schema tests`
4. `Add real-data validation results (or blocked-report) under results/real-data`
5. `Refresh www + build-info stamp; rebuild debug APK`
