# Phase 4 — Real Tickerbot Data Empirical Validation Report

Generated: 2026-08-23T17:04:28.434Z · commit: 5581c7d

**STATUS: BLOCKED — NO REAL DATA COULD BE FETCHED.**

The dev environment has **no Tickerbot API key** (the key lives only in the app's secure
runtime store on the user device; `config.loadConfig()` never returns one here, and
`scripts/capture-aapl.mjs` exits 2 for the same reason). Per the phase constraints:

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
