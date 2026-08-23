# Plan — Finish & Ship Historical Analysis (tests → build → APK)

Session: 57331f34 · Repo: node-3tradingapp (Market Intelligence, vanilla ES modules + Capacitor Android)

## Executive summary of current state (verified by recon, do NOT redo)

The Historical Analysis feature is **already implemented and wired end-to-end in the web layer**:

- `history-source.js` (258 L): `HistorySource` cursor/before pagination with repeated-cursor,
  no-progress, max-pages safeguards; `RateLimiter` with injectable `now`/`sleep`; dedup+sort helpers.
- `historical-analysis.js` (302 L): `envelopeToPage`, `computeStatistics`, `computeForwardOutcomes`
  (1/3/5/10D), `computeDataQuality`, `coverageYears`, `HistoricalAnalysisController`
  (depths 1y/3y/5y/max, daily candles, in-memory cache, PARTIAL/COMPLETE status, onProgress).
- `app.js`: imports controller, boots it safely (`histAnalysis`), `wireHistoricalAnalysis()`,
  `runHistoricalAnalysis()` with progress/error/results, `renderHistoricalResults()` renders
  DATASET badge (PARTIAL DATASET label), STATISTICS, FORWARD OUTCOMES table ("NOT a forecast"
  wording), DATA QUALITY section.
- `index.html`: `#hist-analysis-btn`, `#hist-panel`, `#hist-depth` select with
  1 Year / 3 Years / 5 Years / Maximum Available, `#hist-progress`, `#hist-error`,
  `#hist-results`. All present.
- `build-check.mjs`: already lists both new modules AND already mirrors all web sources into
  `www/` (Capacitor webDir) during `npm run build`. No extra sync script needed.
- `tests/historical-analysis.test.mjs` (298 L): covers envelope unwrap, statistics, forward
  outcomes, data quality, coverageYears, multi-page retrieval, cache hit, per-depth from/to
  bounds, repeated cursor → PARTIAL, max_pages → PARTIAL, server_exhausted → COMPLETE,
  API error → PARTIAL w/ structured error, 429 rate-limit stop, no-key-leak assertion.
- `www/` is currently STALE: it lacks `historical-analysis.js` and has old app.js/index.html.
  This is fixed automatically by `npm run build` (see above) — do not hand-copy.
- Verified passing right now: `npm run smoke` (SMOKE PASS) and `npm run test:boot`
  (BOOT HARNESS PASS). Do not regress them.

## ROOT CAUSE of the previous "wedged" runs (verified by execution, fix first)

**`npm test` hangs forever (exit 124 after 300 s) on `tests/historical-analysis.test.mjs`.**

Cause: `fastController(api)` in that test file constructs

```js
new RateLimiter({ now: () => 0, sleep: async () => {} })
```

With a frozen clock (`now` always returns 0), `RateLimiter._acquireInner()` computes
`gapWait = max(0, lastAcquire + 1100 - now) = 1100` on every iteration and awaits a no-op sleep;
time never advances ⇒ **infinite busy loop** on the SECOND and every subsequent `acquire()`.
Any multi-page test therefore never terminates. Single-page suites (e.g. quote-envelope) pass
fine — confirmed by running them.

### Fix (Task 1 — REQUIRED before anything else)

In `tests/historical-analysis.test.mjs`, replace `fastController`'s rate limiter with a
deterministic advancing fake clock, e.g.:

```js
function fastController(api) {
  let fakeNow = 0;
  return new HistoricalAnalysisController({
    api,
    rateLimiter: new RateLimiter({
      now: () => fakeNow,
      sleep: async () => { fakeNow += 10_000; }, // advance virtual time instantly
    }),
  });
}
```

This keeps unit tests instant (no real timers) and exercises limiter logic deterministically.
Do NOT change `RateLimiter` production semantics for this — the injectable-clock design is
already correct; only the test wiring was wrong. If any OTHER test file uses a frozen
`now: () => <const>` with a no-op sleep, apply the same advancing-clock pattern there
(check `tests/history-pagination.test.mjs` too when running the full suite).

## Tasks

### Task 1 — Fix the test hang (see above)
File: `tests/historical-analysis.test.mjs` (and same pattern anywhere else it occurs).
Acceptance: `timeout 120 npx vitest run tests/historical-analysis.test.mjs` exits 0 with all
tests green.

### Task 2 — Run and repair the FULL test suite
- `timeout 600 npm test` must exit 0. If other spec files fail
  (`api-key-persistence.spec.js`, `watchlist-add-flow.spec.js`,
  `historical-data.test.mjs`, `history-pagination.test.mjs`,
  `quote-envelope.test.mjs`), fix the TESTS/fixtures only where they are broken by the
  feature; do not weaken assertions about no-API-key-leak or pagination safety.
- Add missing coverage if cheap (the prompt asks for these; most exist already):
  invalid-OHLC rows reaching statistics (exists via computeDataQuality test),
  partial-data labeling (exists), chronological sorting (exists). Only add a test if a
  required case is genuinely uncovered; keep additions small and offline.

### Task 3 — Build verification chain (run in this order, each must pass)
1. `npm run build` — syntax-checks all modules AND refreshes `www/` (this is what puts
   `historical-analysis.js` + current `app.js`/`index.html` into Capacitor's webDir).
   Confirm afterwards: `ls www/historical-analysis.js` exists and
   `diff -q app.js www/app.js` is empty.
2. `npm run smoke` — expect SMOKE PASS.
3. `npm run test:boot` — expect BOOT HARNESS PASS (exercises asset screen incl. hist panel).
4. `npx cap sync android`.

### Task 4 — Fresh debug APK
Environment: JAVA_HOME is NOT set globally; JDKs live at
`/opt/mesh-viewer-data/toolchains/jdk-17.0.20+8` and `/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8`.
Use JDK 17 first (`export JAVA_HOME=/opt/mesh-viewer-data/toolchains/jdk-17.0.20+8`),
fall back to 21 if Gradle complains. SDK path is pinned in `android/local.properties`.
Android Studio project properties may also need `org.gradle.java.home` if env export alone
is insufficient — prefer env var, avoid editing gradle files unless required.

```bash
cd android && ./gradlew assembleDebug
```

Record mtime + size before/after to prove freshness:
`stat -c '%y %s' android/app/build/outputs/apk/debug/app-debug.apk`

### Task 5 — APK content verification
```bash
unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep -E \
  'assets/public/(historical-analysis\.js|app\.js|index\.html|history-source\.js)'
```
- Must contain `assets/public/historical-analysis.js`, `history-source.js`, and CURRENT
  `app.js`/`index.html` (verify by extracting and grepping for `hist-analysis-btn` /
  `runHistoricalAnalysis`).
- API-key leak check:
  `unzip -p ... assets/public/*.js | grep -iE 'sk-[a-z0-9]|tickerbot_api_key\s*=|apiKey\s*[:=]\s*["'"'"'][A-Za-z0-9]'`
  must find nothing (the app fetches the key at runtime from Preferences storage only).

### Task 6 — Commit & push
- Stage ONLY the files this task touched (feature modules, tests, www/ mirror outputs,
  android project changes from cap sync, apk output if tracked — check `git status`;
  `node_modules/.vite` cache noise seen in status should NOT be committed if not already tracked).
- Suggested message: `Finish historical analysis: fix rate-limiter test clock, ship web+APK build`
- `git push origin HEAD` (remote: origin = github.com/branagh88/node-3tradingapp). Record push
  result honestly even if auth fails.

## DO NOT TOUCH (regression guards)
- `secure-store.js`, API-key persistence (`setApiKey`/`clearApiKey`), `normalizeQuote()`,
  ticker search, watchlist + Add to Watchlist, existing candlestick chart
  (`charts.js` Lightweight-Charts-v5 API — CDN is correctly pinned to v5.x),
  Tickerbot authentication, `api.js` request/auth paths.
- Never log/display/embed the API key anywhere, including test output and APK assets.

## Final report checklist (builder must answer ALL)
files changed · implementation completed · tests passed · build result · smoke result ·
boot result · cap sync result · APK path · APK size · APK verification (contents + no key) ·
git commit hash · GitHub push status.

## Known risks
- Vitest 4 removed the `basic` reporter — always use default reporter (`npx vitest run <file>`),
  not `--reporter=basic` (fails with ERR_LOAD_URL).
- `npm test` previously hung ≥300 s; always wrap vitest in `timeout` so a regression can't
  wedge the session again.
- Gradle may need several minutes on first configuration after cap sync; use a generous
  bash timeout (~900 s).
