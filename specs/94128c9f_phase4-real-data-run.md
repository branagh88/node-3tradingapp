# PHASE 4 — REAL TICKERBOT DATA EMPIRICAL VALIDATION (execution / retry plan)

Session: 94128c9f · Repo: node-3tradingapp · Planned from HEAD `5581c7d`
("Mark Phase 4 real-data validation verified-blocked pending API key").

## 0. Situation (read this first — do NOT rebuild what exists)

Phase 4 was already **built and shipped** in prior sessions (`957d883` harness,
`21a77e4` APK refresh, `5581c7d` close-out). Recon confirms ALL deliverables of
the original prompt exist and are tested:

| Prompt item | Where it lives | Status |
|---|---|---|
| One-shot cached fetcher (item 17 API discipline) | `scripts/research/fetch-real-bars.mjs` | shipped; exits 0/1/2; cache-skip unless `--force`; ≤~6 pages/ticker |
| Data integrity validator (item 2) | `scripts/research/validate-bars.mjs` | shipped + CLI; ordering/OHLC/volume/dups/gaps checks |
| Walk-forward real-data runner (items 3–11) | `scripts/research/run-real-validation.mjs` | shipped; reads ONLY cache; slices all/highConfidence/forced; mechanical verdicts (INSUFFICIENT_SAMPLE <30 signals; EDGE iff acc > best baseline AND Wilson-95% low > baseline AND z-test p<0.05); cross-ticker consistency; provenance; schema self-check; writes `scripts/research/results/real-data/{RESULTS.md,real-data-results.json}` |
| Tests (item 12) | `tests/real-data-validation.test.mjs` | 15 tests, all passing (verified this session): determinism, no-future-leakage (poisoned-bars), walk-forward monotonicity, split boundaries, NO-SIGNAL, insufficient history, integrity checks, schema validation incl. blocked shape |
| Synthetic results preserved (item 11) | `scripts/research/results/RESULTS.md`, `compare-results.json` | untouched; must remain byte-identical |
| Current report state | `scripts/research/results/real-data/RESULTS.md` | **BLOCKED** — harness green, no Tickerbot API key anywhere in dev shell |

The ONLY missing input is a Tickerbot API key (free-plan monthly cap; the key
normally lives only in the app's secure runtime store on the user device).
This plan's job: **re-check for a provisioned key; if present run the real
pipeline end-to-end; if absent re-verify the blocked state honestly and stop.**
No algorithm changes. No synthetic substitution. No tuning against test data.
No user-facing claim changes either way.

## 1. Work steps

### W1 — Credential re-check (document where you looked)
Search in order, printing NEVER the value itself (only found/not-found):
1. `printenv | grep -iE 'tickerbot'` → `TICKERBOT_API_KEY` / `TICKERBOT_API_TOKEN`.
2. Repo `.env*` files (only `.env.sample` exists today; sample has no Tickerbot entry).
3. App secure-store config via `node -e "import('./config.js').then(async m=>{const {loadConfig}=await import('./storage.js').then(()=>m);})"` — simplest: run `TICKERBOT_API_KEY= TICKERBOT_API_TOKEN= node scripts/research/fetch-real-bars.mjs AAPL --dry` … actually the fetcher already resolves stored config first; just run W3 step 1 for one ticker and observe exit code.
4. Studio credentials dir `/home/appuser/.pi/agent/studio/credentials` (list filenames only).

Record the outcome (where looked, what found) in the final report header.
If NOT FOUND → go to W5 (blocked-path verification). If FOUND → W2.

### W2 — Real fetch (ONLY if key found)
```bash
TICKERBOT_API_KEY=<key> node scripts/research/fetch-real-bars.mjs
```
- Default tickers: AAPL MSFT NVDA AMZN META GOOGL TSLA GME, interval `1d`, ~15y back.
- Expect exit 0 (all cached/fetched). Exit 1 = some failed → proceed with
  successes; document which tickers are absent and why. Exit 2 = key rejected
  → fall through to W5 path.
- Verify cache files appear under `scripts/research/data/real/<TICKER>.json`.
- Spot-check ONE ticker standalone:
  `node scripts/research/validate-bars.mjs scripts/research/data/real/AAPL.json`
- Do NOT re-fetch existing caches (budget discipline); `--force` only if a
  cache file is corrupt per the validator.

### W3 — Run validation (reads cache only, zero API calls)
```bash
node scripts/research/run-real-validation.mjs
```
Then verify outputs:
- `scripts/research/results/real-data/real-data-results.json`: `status:"COMPLETE"`,
  `schemaValid:true`, one entry per ticker with `dataIntegrity.ok:true`,
  horizons `{all, highConfidence, forced}` × {1,3,5,10}, per-cell coverage/
  accuracy/±accuracy/winRate/avg+median return/Wilson CI/baselines/edge pp/
  significance/verdict, `crossTickerConsistency` populated,
  `provenance.caches[].dateRange|candleCount|apiRequestsUsed` filled.
- `RESULTS.md` regenerated with real numbers and a Final Answer chosen by the
  pre-registered rules in the script (NO / PARTIALLY YES / NOT DEFENSIBLY).
- Sanity-review verdicts manually for at least one EDGE cell (if any):
  accuracy > best baseline, Wilson low > baseline, p<0.05. If the script ever
  claims EDGE on any other basis, that is a bug — fix the runner/report, not
  the engine.

### W4 — Post-run consistency & regression pass (required in BOTH paths)
1. `npm test` — entire suite green (was 9 files / 107 tests).
2. `node build-check.mjs` — green.
3. Confirm synthetic results untouched:
   `git status --short scripts/research/results/` must show ONLY
   `results/real-data/*` modified (in W2/W3 path) or nothing new.
4. If ANY file feeding `www/` (app sources, `build-info.js`) changed during
   this run: update `build-info.js` stamp to new HEAD FIRST, `npx cap sync android`,
   assemble debug APK, then VERIFY post-build `unzip -p android/app/build/outputs/apk/debug/*.apk | grep -a <HEAD>` style check on bundled `www/build-info.js` matches HEAD, record commit in report provenance. If nothing changed and HEAD is still `5581c7d`: APK is fresh — SKIP rebuild and say so explicitly.
   (Build env check first: `ls android/gradlew` exists ⇒ attempt; else skip.)

### W5 — Blocked path (no key): re-verify, don't invent work
1. Re-run `npm test` + `node build-check.mjs` to confirm still green at HEAD.
2. Re-run `node scripts/research/run-real-validation.mjs` — it should exit 2
   and rewrite the BLOCKED artifacts with current timestamp/commit. Confirm
   the two unblock commands remain correct in RESULTS.md.
3. Confirm blocked JSON validates against the blocked-shape test (already in suite).
4. Update RESULTS.md header status line with the NEW re-check date/commit.
   Do not fabricate numbers, do not loosen verdict rules, do not touch the engine.

### W6 — Close-out
Final `scripts/research/results/real-data/RESULTS.md` must answer plainly:
- Real run: the evidence-based FINAL ANSWER (EDGE cells enumerated with ticker,
  horizon, n, accuracy, CI, baseline delta, p-value; breadth/isolation analysis;
  explicit statement whether user-facing claims may or may not change — default
  remains: do NOT change them in this phase).
- Blocked: exactly what's missing (key provisioning), what IS ready (harness +
  107-test suite + build green at commit <HEAD>), and the two commands to finish.

## 2. Hard constraints (unchanged from prompt)
- Existing Phase 3 prediction engine (`prediction-engine.js`, `pattern-engine.js`)
  MUST NOT be modified. If a defect forces a change, it must be justified,
  additive, separately committed, and disclosed in the report.
- Never optimize parameters against the test set; the runner's frozen-config
  walk-forward scheme stays as-is.
- Cache once, reuse forever; never repeat identical fetches.
- Synthetic results under `scripts/research/results/` stay byte-identical.
- Secrets: never echo the key into logs, results, git, or this repo.

## 3. Verification checklist
- [ ] W1 search documented (paths checked, outcome).
- [ ] Either COMPLETE results (schemaValid true, integrity ok per ticker) or accurate refreshed BLOCKED artifacts.
- [ ] Any claimed EDGE manually re-checked against its own numbers.
- [ ] `npm test` green; `node build-check.mjs` green.
- [ ] APK freshness decision made explicitly (rebuilt+stamp-verified, or correctly skipped).
- [ ] Synthetic results directory unmodified.
- [ ] `git diff --cached` reviewed before each commit; no secrets staged.

## 4. Suggested commits
1. (W2/W3 ran) `Add real Tickerbot datasets and regenerate Phase 4 real-data validation results`
2. (any runner/report bug fixed) `Fix real-data runner <detail> (engine unchanged)`
3. (rebuilt) `Refresh build-info stamp and debug APK for Phase 4`
4. always: `Update Phase 4 real-data validation report (<COMPLETE|blocked re-check>)`

## 5. Notes for builder
- Expected duration WITHOUT a key: ~20–30 min (tests take ~5 min; vitest
  real-data spec alone ~30 s). With a key: add fetch (~6 req/ticker) + run.
- The runner exits non-zero when blocked — that is CORRECT behavior, not a failure.
- Prior plans for context: `specs/ee617a22_real-tickerbot-validation.md` (v1,
  authoritative methodology) and `_v2` (gap-audit/close-out, executed). This
  plan supersedes neither's methodology; it is the retry/execution pass.
