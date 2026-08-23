# Phase 4 — Real Tickerbot Data Empirical Validation Report

Generated: 2026-08-23T16:04:36.215Z · commit: e23a7ad

**STATUS: BLOCKED — HARNESS VERIFIED GREEN, AWAITING API KEY (re-checked 2026-08-23, commit 21a77e4).**

Credential re-check (run 2): searched `printenv` (TICKERBOT_API_KEY/TICKERBOT_API_TOKEN),
repo `.env*` files, studio credentials directory, and README/FACTORY/justfile notes —
no key exists anywhere in this dev shell (the key lives only in the app's secure runtime
store on the user device). Gap audit against spec Steps B–F: PASS — fetcher failure
semantics verified (exit 1 only when ALL tickers fail, exit 2 with no key),
validate-bars.mjs CLI runs standalone on cache files, runner handles empty/partial
caches gracefully with an honest blocked message. Full suite green: 9 files /
107 tests passed; `node build-check.mjs` green; APK at HEAD 21a77e4 is fresh
(stamped www matches HEAD). Per the phase constraints:

- No synthetic data was substituted.
- No predictive ability is claimed or implied for real markets.
- All harness code (fetcher, validator, runner, tests) IS shipped and tested;
  synthetic Phase 3 results remain untouched under `scripts/research/results/`.

## How to unblock (one command each)

```bash
# 1. One-time fetch (~6 API pages/ticker, cached forever after):
TICKERBOT_API_KEY=<key> node scripts/research/fetch-real-bars.mjs
# 2. Full real-data validation (reads cache only, zero API calls):
node scripts/research/run-real-validation.mjs
```

This file and `real-data-results.json` will be overwritten with real, evidence-based
numbers when those commands succeed.
