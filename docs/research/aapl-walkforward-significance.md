# AAPL 5-year walk-forward: are the +1.3%…+5.2% horizon edges real? — 2026-08-23

**Verdict:** prototype

## TL;DR

The AAPL walk-forward run (1,254 candles, 183 signals vs 421 no-signal, edges of +1.3 to +5.2 pp over baseline at 1/3/5/10-day horizons) is **not statistically significant**, and the engine was right to withhold an EDGE verdict. At n = 183 the standard error of a ~50–55% accuracy estimate is ≈ ±3.7 pp, so even the best observed edge (+5.2 pp) lands at z ≈ 1.4 (p ≈ 0.16) with a Wilson-95% lower bound of 48.0% — below any plausible baseline (~50–52%). Detecting these effect sizes reliably needs roughly **≥ 720 signals for a +5.2 pp edge and ≥ 11,000 signals for a +1.3 pp edge** (80% power, α = 0.05 two-sided). The repo's own verdict rules (`scripts/research/run-real-validation.mjs`: EDGE iff accuracy > best baseline AND Wilson-low > baseline AND two-proportion z-test p < 0.05) mechanically fail on every horizon — "INSUFFICIENT EVIDENCE" is the correct output, not a bug. Recommendation: **prototype** — don't adopt the signal strategy yet, but run a cheap spike (pool tickers/horizons, extend history past 5 years, block-bootstrap the multi-day horizons) to find out whether the edge survives at adequate n.

## How it works

**1. What the engine actually computed.** `run-real-validation.mjs` slices each walk-forward backtest per ticker × horizon and applies mechanical verdicts (`verdictFor()`): `INSUFFICIENT_SAMPLE` if signals < 30; `EDGE` only if all three hold — accuracy > best of {dominant-direction, always-up, momentum} baselines, Wilson-95% lower bound > that baseline, and a two-proportion z-test p < 0.05. With 183 signals the 30-signal sample gate passes, so "insufficient evidence" here means the *statistical* EDGE criteria failed (Wilson low ≤ baseline, p ≥ 0.05) — i.e., insufficient evidence *of an edge*, not too little data to evaluate at all.

**2. The binomial arithmetic (computed for this note, n = 183, baseline ≈ 50–52%).**

| Edge | Accuracy | k/183 | Wilson 95% CI | z vs baseline | p |
|------|----------|-------|---------------|----------------|-----|
| +1.3 pp | 51.3% | 94 | [44.2%, 58.5%] | 0.37 | 0.71 |
| +2.5 pp | 52.5% | 96 | [45.2%, 59.6%] | 0.67 | 0.51 |
| +3.5 pp | 53.5% | 98 | [46.3%, 60.6%] | 0.96 | 0.34 |
| +5.2 pp | 55.2% | 101 | [48.0%, 62.2%] | 1.40 | 0.16 |

The Wilson half-width at n = 183 is ≈ ±7.1 pp — wider than every observed edge. Even in the most generous reading (+5.2 pp over a fixed 50% coin-flip), p ≈ 0.10–0.16 depending on one/two-sided choice, and the Wilson lower bound (48.0%) never clears a realistic baseline.

**3. Why this is expected, not anomalous.** A binomial proportion needs n large relative to 1/edge². Power/sample-size math ([3]) says detecting a +5.2 pp improvement over a 52% baseline with 80% power at α = 0.05 (two-sided) requires ≈ **720 signals**; a +1.3 pp edge requires ≈ **11,600 signals**. Five years of daily bars gives only ~1,260 test rows total and the selective gate fires on ~15% of them → 183 signals. The design is structurally underpowered for effects this small; no amount of re-running changes that.

**4. Three aggravating problems the plain binomial ignores.**
- *Multiple comparisons*: four horizons (and multiple variants in Phase 3) were tested on the same data; the family-wise false-positive rate rises with the number of tests, so a Bonferroni-style correction (α → 0.0125) would make the bar *higher* than the single-test bar already missed [4].
- *Overlapping outcomes*: 3/5/10-day directional calls overlap row-to-row, violating the independence the binomial/z-test assumes; the effective sample size is smaller than nominal, and honest inference needs a block bootstrap or HAC adjustment [5].
- *Selection/provenance*: walk-forward parameter selection picked configs per ticker; picking the best-looking horizon post hoc compounds the multiplicity problem — exactly the backtest-overfitting trap documented by Bailey, Borwein & López de Prado [6].

**5. What would change the answer.** Either (a) more signals — pool the five tickers' test rows, extend history beyond 5 years, or modestly relax selectivity while keeping MIN_SIGNAL_SAMPLE discipline — or (b) a bigger true edge, which we can't manufacture. To clear the current rule set at n = 183 you'd need accuracy ≈ 63%+ (so the Wilson low clears ~56%), which nothing in Phase 3 approached.

## Fit for our stack

This is a research-methodology question inside our Node/Vitest analytics stack, not a rendering/gameplay concern — everything needed is already in-repo: `prediction-engine.js` (walkForwardParameterSearch / walkForwardBacktest, wilsonInterval), `pattern-engine.js` DEFAULTS.MIN_SIGNAL_SAMPLE = 30, `run-real-validation.mjs` (z-test + Wilson + verdict rules), plus `RESULTS.md`'s honest headline that "no configuration reliably beats simple baselines." Two caveats from the repo itself: (1) the published Phase 3 numbers came from seeded *synthetic* fixtures (no Tickerbot key in dev), so they validate methodology, not live-market edge; (2) the reported 183 + 421 = 604 evaluated rows vs 1,254 candles implies ~half the rows are excluded (train split, horizon warm-up/truncation, NO-SIGNAL gating) — coverage accounting should be stated explicitly in future reports. No changes to app code, Phaser/Tauri surfaces, or dependencies are implied.

## Effort & risk

**Effort (small, contained to scripts/research):** ~1 day spike — (a) cache 15–20 years of daily bars for the five tickers via the existing `fetch-real-bars.mjs` path; (b) pool test-row predictions across tickers per horizon to multiply n toward the ~720+ range; (c) add a moving-block bootstrap (resample contiguous blocks of days) alongside the z-test for h = 3/5/10; (d) report family-wise-corrected p-values across the four horizons. No engine changes required; `verdictFor()` stays as-is.

**Risk:** low — read-only analysis scripts and result JSON. The real risk is *interpretive*: treating +5.2 pp on 183 samples as a shippable edge would be textbook backtest overfitting [6]. If the pooled/bootstrap spike still shows Wilson-low ≤ baseline, the honest verdict downgrades to **drop** (or keep as a disclosure-only demo); if Wilson-low clears the baseline at n ≥ ~700, upgrade to adopt behind the existing gates.

## Sources

1. Binomial proportion confidence interval (Wilson score interval) — https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval *(primary reference for the CI used verbatim in the engine)*
2. Two-proportion Z-test — https://en.wikipedia.org/wiki/Two-proportion_Z-test *(primary reference; the exact test implemented in `run-real-validation.mjs`)*
3. Power (statistics) / sample-size determination — https://en.wikipedia.org/wiki/Power_(statistics) *(basis for the ≥720 / ≈11,600 signal requirements)*
4. Multiple comparisons problem — https://en.wikipedia.org/wiki/Multiple_comparisons_problem *(why testing 4 horizons inflates false positives; Bonferroni correction)*
5. Bootstrapping (statistics) — block bootstrap for time series / dependent data — https://en.wikipedia.org/wiki/Bootstrapping_(statistics) *(required because overlapping multi-day outcomes violate independence)*
6. Bailey, Borwein, López de Prado, Zhu — *Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance*, Notices of the AMS 61(5), 2014 — https://www.ams.org/notices/201405/rnoti-p458.pdf *(primary source; why small-sample "edges" selected post hoc rarely survive out-of-sample)*
7. In-repo evidence: `scripts/research/run-real-validation.mjs` (verdict rules), `scripts/research/results/RESULTS.md` (Phase 3 honest headline), `tests/prediction-engine.test.mjs` (MIN_SIGNAL_SAMPLE gating)
