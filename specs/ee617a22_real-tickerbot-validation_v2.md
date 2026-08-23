# PHASE 4 (RUN 2) — REAL TICKERBOT DATA EMPIRICAL VALIDATION: COMPLETE OR HONESTLY CLOSE OUT

Repo: `/opt/mesh-viewer-data/branagh88/projects/node-3tradingapp`
Session: `ee617a22`
Prior spec for this session: `specs/ee617a22_real-tickerbot-validation.md` (v1 — already executed)

---

## 0. CURRENT STATE (verified by source inspection, git log, and artifact reads)

Phase 4 was already planned once in this session and the builder EXECUTED it:

- **Commits:** `957d883` ("Phase 4: real-data Tickerbot validation harness …") and
  `21a77e4` ("Refresh build-info stamp to 957d883 for Phase 4 APK"). HEAD is `21a77e4`.
- **Harness exists and is complete:**
  - `scripts/research/fetch-real-bars.mjs` — one-shot cached fetcher over
    `MarketAPI.fetchBarsPageRaw` → `HistorySource.fetchRange` (daily bars,
    default tickers AAPL MSFT NVDA AMZN META GOOGL TSLA GME, cache at
    `scripts/research/data/real/<TICKER>.json`, exits code **2** when no API key).
  - `scripts/research/validate-bars.mjs` — OHLCV integrity checks (ordering,
    OHLC validity, duplicates, weekday-gap detection, zero-close flags).
  - `scripts/research/run-real-validation.mjs` — reads cache only; runs the
    UNCHANGED Phase 3 engine (`walkForwardParameterSearch` +
    `walkForwardBacktest`) per ticker × horizon {1,3,5,10}; slices = all /
    highConfidence (`requireEdge:true`) / forced (`minSignalSample:1`);
    mechanical verdicts (EDGE iff accuracy > best baseline AND Wilson-95% low
    bound > baseline AND two-proportion z-test p < 0.05; INSUFFICIENT_SAMPLE if
    signals < `DEFAULTS.MIN_SIGNAL_SAMPLE`; else NO EDGE); test-window regime
    halves; cross-ticker consistency; provenance block; exported
    `validateResultsSchema()`.
  - `tests/real-data-validation.test.mjs` — vitest suite covering determinism,
    no-future-leakage, walk-forward ordering, train/val/test boundary recording,
    NO-SIGNAL handling, insufficient history, z-test/verdict helpers, validator
    integrity checks, and results-schema validation.
- **Results exist but are BLOCKED:** `scripts/research/results/real-data/
  RESULTS.md` and `real-data-results.json` say `status: "BLOCKED_NO_API_KEY"`,
  commit e23a7ad, zero tickers, explicit no-fabrication statement and exact
  re-run commands. Synthetic Phase 3 results under `scripts/research/results/`
  remain untouched, as required.
- **APK:** `android/app/build/outputs/apk/debug/app-debug.apk` present;
  `build-info.js` stamped at `957d883`; last www-touching commit is `21a77e4`
  (= HEAD), so web assets are fresh relative to HEAD.
- **Working tree:** clean except an irrelevant modified
  `node_modules/.vite/vitest/.../results.json` (build cache — ignore, do not commit).

### Why a second plan

The v1 spec's hard gate fired: **no Tickerbot API key exists in the dev shell**
(the key lives only in the app's on-device secure runtime store). Everything
buildable without real data WAS built. The remaining goal of "empirical
validation" can only advance along two paths:

1. A credential is found/provisioned → run the pipeline for real numbers.
2. Still no credential → formally verify the shipped harness end-to-end and
   leave the BLOCKED report as the honest final state.

Both are acceptable outcomes of THIS plan. Never substitute synthetic data,
never fabricate numbers.

## 1. SCOPE & CONSTRAINTS

- In scope: running existing scripts, `scripts/research/data/real/` caches,
  regenerating `scripts/research/results/real-data/*`, new tests ONLY if a gap
  audit (W3) finds one, build-info stamp / `www/` refresh / APK rebuild IF and
  only if repo content changed this run.
- Read-only logic: `prediction-engine.js`, `pattern-engine.js`, `api.js`,
  `history-source.js`, `historical-analysis.js`. No algorithm changes, no tuning.
- Untouchable: `scripts/research/results/RESULTS.md`,
  `scripts/research/results/compare-results.json` (synthetic record).
- Security: never echo/log/commit the API key; if one is found, export it only
  for the duration of the fetch command (follow security-hygiene practice).
- Honesty rule unchanged: `NO EDGE` and `BLOCKED` are both valid endings.

## 2. WORK ITEMS

### W1 — Step A credential gate (repeat, exhaustively)

Search, in order:
1. Env: `TICKERBOT_API_KEY`, `TICKERBOT_API_TOKEN` (`printenv | grep -i tickerbot`).
2. `.env` files reachable via `just`'s dotenv-load (repo root, `adws/`).
3. Studio credentials: files under `~/.pi/studio/credentials/` mentioning
   tickerbot/api (grep file NAMES and contents without printing secret values).
4. README / FACTORY.md / justfile notes about where a key lives.

Decision:
- **Found** → proceed to W2 (real run). Export for the fetch invocation only.
- **Not found** → skip to W3/W4 (verification + close-out). Do NOT stall, do NOT
  fabricate. This is the expected path based on current evidence.

### W2 — Real run (ONLY if W1 finds a key)

Execute exactly the documented pipeline:

```bash
TICKERBOT_API_KEY=<key> node scripts/research/fetch-real-bars.mjs   # exit 0 required
node scripts/research/validate-bars.mjs                             # integrity report
node scripts/research/run-real-validation.mjs                       # writes results/real-data/*
```

Then:
1. Confirm `results/real-data/real-data-results.json` now has non-empty
   `tickers[]`, passes its own `validateResultsSchema()`, and every verdict cell
   follows the mechanical rules (spot-check ≥ 2 cells by hand against the JSON).
2. Regenerated `RESULTS.md` must include: data-integrity table, per-ticker ×
   horizon × slice tables, Wilson CIs, baselines, edge-vs-baseline pp, p-values,
   regime halves, cross-ticker consistency, provenance (commit, config, date
   ranges, request counts), and an evidence-based yes/no answer to "does the
   engine beat simple baselines out-of-sample?" — including a plain "NO EDGE"
   if that's what the data says.
3. Re-run `npm test` (new cache fixtures may exercise new runner paths).

### W3 — Gap audit against the v1 spec (required regardless)

Walk `specs/ee617a22_real-tickerbot-validation.md` item by item (Steps B–F) and
verify each deliverable exists and behaves as specified. Known-good from recon:
fetcher, validator, runner, tests, blocked report. Specifically double-check:
- `validate-bars.mjs` CLI entry point actually runs standalone on a fixture
  (v1 asked for "exported functions + CLI").
- Fetcher failure semantics: per-ticker failures recorded, exit 1 only when ALL
  fail (header comment claims this — verify the code path).
- Runner handles a PARTIAL cache (some tickers fetched, some failed) gracefully.
If any gap is real, fix minimally with an additive change + test; otherwise
record the audit as PASS (no code changes needed).

### W4 — Full verification pass (required regardless)

1. `npm test` — entire suite green.
2. `node build-check.mjs` — green.
3. If NOTHING in `www/`-feeding sources or `build-info.js` changed during this
   run and HEAD is still `21a77e4`: APK is fresh, SKIP the Android rebuild and
   say so explicitly. If anything changed: refresh `build-info.js` stamp to the
   new HEAD FIRST, sync Capacitor (`npx cap sync android`), assemble debug APK,
   then VERIFY post-build that the bundled `www/build-info.js` commit matches
   HEAD (unzip/grep the APK) and record the verified commit in RESULTS.md
   provenance.
4. Update `scripts/research/results/real-data/RESULTS.md` header status line to
   reflect the true final state: either real numbers (W2 ran) or
   "BLOCKED — harness verified, awaiting key" with the same two re-run commands.

### W5 — Close-out report

Whatever the outcome, the final RESULTS.md must answer plainly:
- If real run: EDGE or NO EDGE per the mechanical rules, with numbers.
- If blocked: exactly what is missing (key provisioning), what IS ready
  (harness + tests verified green on commit <HEAD>), and the precise commands
  to finish later. No predictive claims without real-data evidence.

## 3. VERIFICATION CHECKLIST (builder self-check before reporting done)

- [ ] W1 search performed and documented (where looked, what found).
- [ ] Either real results regenerated and schema-valid, or BLOCKED artifacts confirmed accurate.
- [ ] `npm test` green; `node build-check.mjs` green.
- [ ] APK freshness decision made explicitly (rebuilt+verified, or correctly skipped).
- [ ] Synthetic results directory byte-identical to pre-run state.
- [ ] No secret ever printed or committed; `git diff --cached` reviewed before each commit.
- [ ] Working tree has no stray modifications beyond intended artifacts (ignore/leave node_modules vite cache alone).

## 4. SUGGESTED COMMIT SEQUENCE

1. (only if W2 ran) `Add real Tickerbot datasets and regenerated real-data validation results`
2. (only if gaps fixed) `Close Phase 4 gap-audit fixes: <detail>`
3. (only if rebuilt) `Refresh build-info stamp and debug APK for Phase 4 close-out`
4. Always last: any RESULTS.md status-line correction, e.g.
   `Mark Phase 4 real-data validation verified-blocked pending API key`

## 5. NOTES FOR THE BUILDER

- The v1 plan text remains the authoritative description of methodology; THIS
  plan supersedes it only in scope (complete/verify vs. build-from-scratch).
- Expected duration without a key is short: audit + test/build runs + maybe a
  status-line edit. Do not invent extra work.
- If the operator provisions a key mid-run, prefer W2 over closing out blocked.
