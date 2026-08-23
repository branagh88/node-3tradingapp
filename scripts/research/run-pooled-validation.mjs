// run-pooled-validation.mjs — Phase 5 POOLED multi-ticker real-data validation.
//
// Extends Phase 4 (run-real-validation.mjs, single-ticker AAPL) to a POOLED
// walk-forward validation of the EXISTING engine (prediction-engine.js /
// pattern-engine.js) over as many of AAPL, MSFT, NVDA, AMZN, META, GOOGL,
// TSLA, GME as real Tickerbot API limits allow.
//
// Pipeline:
//   1. Ensure cached real daily bars per ticker (delegates to fetch-real-bars.mjs,
//      which caches under scripts/research/data/real/ and NEVER re-downloads an
//      existing cache; uses the securely stored credential via the app's own
//      config/storage path — the key is never asked for or hardcoded here).
//   2. Per ticker: strict chronological TRAIN→VAL→TEST via the UNCHANGED
//      walkForwardParameterSearch (point-in-time features, prior-only matching,
//      leak-free normalization — normalization at row i uses only rows < i).
//   3. POOL all tickers' out-of-sample TEST predictions per horizon and compare
//      against pooled baselines (dominant-direction / always-up / 5d momentum),
//      each baseline pooled eligibility-weighted across tickers.
//   4. Report Wilson 95% CI, two-proportion z-test p-value vs best baseline,
//      verdict EDGE / NO EDGE / INSUFFICIENT EVIDENCE (mechanical rules below).
//
// NO tuning: thresholds, engine code, and grid are identical to Phase 3/4 and
// are NOT modified based on results. NO-SIGNAL is allowed and counted.
//
// If the Tickerbot credential is unavailable in this environment, this script
// writes a clear BLOCKED report to docs/research/ and exits 2 — synthetic data
// is never substituted.
//
// Run: node scripts/research/run-pooled-validation.mjs [--skip-fetch]

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable for tests only (never points the real run at synthetic data):
const CACHE_DIR = process.env.POOLED_CACHE_DIR || path.join(HERE, 'data', 'real');
const DOCS_DIR = process.env.POOLED_DOCS_DIR || path.join(HERE, '..', '..', 'docs', 'research');
const TICKER_UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'GME'];
const HORIZONS = [1, 3, 5, 10];
const MIN_SIGNAL_SAMPLE = 30; // pattern-engine DEFAULTS.MIN_SIGNAL_SAMPLE (read live below)

const { walkForwardParameterSearch } = await import('../../prediction-engine.js');
const peMod = await import('../../pattern-engine.js');
const MIN_SIGNAL_SAMPLE_LIVE = peMod.DEFAULTS.MIN_SIGNAL_SAMPLE;
const { validateBarsDataset } = await import('./validate-bars.mjs');
const { zTestTwoProportions } = await import('./run-real-validation.mjs');
// Browser-safe pooled-stats extraction: the math lives in ../../pooled-stats.js;
// this runner re-exports so existing tests (tests/pooled-validation.test.mjs)
// keep importing from here unchanged.
const pooledStats = await import('../../pooled-stats.js');
const { bootstrapCI } = pooledStats;

function pct(n, d = 2) { return n == null ? null : Number((n * 100).toFixed(d)); }

/** Wilson 95% score interval → [loFrac, hiFrac]. (Extracted to pooled-stats.js.) */
export const wilsonInterval = pooledStats.wilsonInterval;

/**
 * Pool per-horizon stats across tickers. Each input cell is one ticker's
 * out-of-sample test-row aggregate from walkForwardParameterSearch.test.horizons[h].
 * Model accuracy pools signaled predictions; baselines pool eligibility-weighted
 * per-ticker baseline rates (so tickers contribute proportionally to their test rows).
 * Pure function — unit-testable.
 */
/** Extracted to pooled-stats.js; re-exported with the LIVE MIN_SIGNAL_SAMPLE threshold. */
export function poolHorizonCells(cells) {
  return pooledStats.poolHorizonCells(cells, { minSignalSample: MIN_SIGNAL_SAMPLE_LIVE });
}

/** Per-dataset metadata line required by the phase spec. */
export function datasetMetadata(ds, integrity) {
  return {
    ticker: ds.ticker,
    source: ds.source ?? 'tickerbot',
    interval: ds.interval ?? '1d',
    oldestDate: integrity.firstDate,
    newestDate: integrity.lastDate,
    candleCount: integrity.candleCount,
    apiRequestCount: ds.apiRequestsUsed ?? ds.pagesFetched ?? null,
    invalidCandles: integrity.invalidOhlcRows,
    missingTradingDayGaps: Array.isArray(integrity.largeGaps) ? integrity.largeGaps.length : null,
    duplicateTimestamps: integrity.duplicateTimestamps,
    fetchedAt: ds.fetchedAt ?? null,
    integrityOk: integrity.ok,
  };
}

function loadCachedDatasets() {
  if (!existsSync(CACHE_DIR)) return [];
  return readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(path.join(CACHE_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter((d) => d && Array.isArray(d.bars) && d.bars.length > 0)
    .sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
}

function gitShort() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(); }
  catch { return 'unknown'; }
}

function buildBlockedDoc({ attempted, reason }) {
  return {
    status: 'BLOCKED_NO_CREDENTIAL',
    phase: 'Phase 5 — Pooled real-data validation',
    generatedAt: new Date().toISOString(),
    gitCommit: gitShort(),
    tickerUniverseRequested: TICKER_UNIVERSE,
    tickersTested: [],
    reason,
    methodology: {
      design: 'Pooled multi-ticker chronological walk-forward of the UNCHANGED '
        + 'prediction-engine.walkForwardParameterSearch (train 60% → validation 20% → test 20% '
        + 'per ticker); pooled out-of-sample TEST predictions compared with eligibility-weighted '
        + 'baselines (dominant direction, always-up, trailing-5d momentum).',
      leakageControls: [
        'point-in-time features only (row i uses bars ≤ i)',
        'training/database strictly before prediction date (chronological split)',
        'normalization at row i uses only prior rows (engine-internal, unchanged)',
        'parameters chosen on validation rows only; test evaluated once',
        'no threshold or algorithm changes were made after seeing results',
      ],
      poolingRules: [
        'pool = sum of all tickers’ out-of-sample signaled TEST predictions per horizon',
        'baselines pooled eligibility-weighted across tickers',
        `verdict INSUFFICIENT EVIDENCE if pooled signals < ${MIN_SIGNAL_SAMPLE_LIVE}`,
        'EDGE iff pooled accuracy > best pooled baseline AND Wilson-95%-low > baseline AND p < 0.05',
        'otherwise NO EDGE; NO-SIGNAL rows are allowed and never counted as errors',
      ],
    },
    datasets: [],
    pooledResults: null,
    note: 'This file will be overwritten with empirical numbers when real cached data exists.',
  };
}

function buildReportMd(doc) {
  const L = [];
  L.push('# Phase 5 — Pooled Multi-Ticker Real-Data Walk-Forward Validation\n');
  L.push(`Generated: ${doc.generatedAt} · commit: ${doc.gitCommit}\n`);
  L.push('## Question\n');
  L.push('> Across a POOL of liquid tickers’ out-of-sample predictions, does the EXISTING '
    + 'pattern/prediction engine beat simple baselines with statistical significance?\n');
  if (doc.status === 'BLOCKED_NO_CREDENTIAL') {
    L.push('## STATUS: BLOCKED — credential unavailable in this dev environment\n');
    L.push(`**${doc.reason}**\n`);
    L.push('- No real Tickerbot data could be downloaded; **nothing was fabricated** and no '
      + 'synthetic data was substituted.');
    L.push('- No predictive claim is made.');
    L.push('- The harness IS shipped (`scripts/research/run-pooled-validation.mjs`) and unit-tested; '
      + 'it will produce the full empirical report automatically once data is cached:\n');
    L.push('```bash\n  TICKERBOT_API_KEY=… node scripts/research/fetch-real-bars.mjs\n'
      + '  node scripts/research/run-pooled-validation.mjs\n```\n');
    L.push(`## Tickers requested (none tested)\n${doc.tickerUniverseRequested.map((t) => `- ${t}`).join('\n')}`);
    return L.join('\n') + '\n';
  }
  L.push('## Methodology\n');
  for (const m of doc.methodology.leakageControls) L.push(`- Leakage control: ${m}.`);
  for (const m of doc.methodology.poolingRules) L.push(`- Pooling: ${m}.`);
  L.push('\n## Datasets Tested\n');
  L.push('| Ticker | Source | Interval | Oldest | Newest | Candles | API reqs | Invalid | Gaps>5d | Dups | OK |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of doc.datasets) {
    L.push(`| ${d.ticker} | ${d.source} | ${d.interval} | ${d.oldestDate} | ${d.newestDate} | `
      + `${d.candleCount} | ${d.apiRequestCount} | ${d.invalidCandles} | ${d.missingTradingDayGaps} | `
      + `${d.duplicateTimestamps} | ${d.integrityOk} |`);
  }
  L.push(`\nTickers tested: **${doc.tickersTested.join(', ') || 'NONE'}**; `
    + `skipped/failed: ${JSON.stringify(doc.tickersSkipped)}.\n`);
  L.push('## Pooled Out-of-Sample Results\n');
  L.push('| H | Signals | Correct | Acc% | Wilson95 | Dom% | Up% | Mom% | Edge pp | p | Verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [h, s] of Object.entries(doc.pooledResults)) {
    L.push(`| ${h}D | ${s.predictions} | ${s.correct} | ${s.accuracyPct ?? '—'} | `
      + `${s.wilsonLowPct == null ? '—' : `[${s.wilsonLowPct}, ${s.wilsonHighPct}]`} | `
      + `${s.baselineDominantAccuracyPct ?? '—'} | ${s.baselineAlwaysUpAccuracyPct ?? '—'} | `
      + `${s.baselineMomentumAccuracyPct ?? '—'} | ${s.edgeVsBestBaselinePp ?? '—'} | `
      + `${s.significance ? s.significance.pValue : '—'} | **${s.verdict}** |`);
  }
  for (const [h, s] of Object.entries(doc.pooledResults)) {
    L.push(`\n**${h}D:** ${s.verdictReason}`);
  }
  L.push('\n## Overall Verdict\n');
  L.push(doc.finalAnswer);
  return L.join('\n') + '\n';
}

async function main() {
  const skipFetch = process.argv.includes('--skip-fetch');

  // Step 1: ensure cached real data (fetch-real-bars handles credential +
  // caching discipline; it never re-downloads an existing cache).
  if (!skipFetch) {
    console.log('[pooled] ensuring cached real bars (existing caches are reused, not re-downloaded)…');
    try {
      execFileSync(process.execPath, [path.join(HERE, 'fetch-real-bars.mjs'), ...TICKER_UNIVERSE],
        { stdio: 'inherit' });
    } catch (err) {
      const code = err?.status;
      if (code === 2) {
        const reason = 'No Tickerbot API credential available in this dev environment '
          + '(secure runtime store empty; env TICKERBOT_API_KEY unset). Per phase rules: BLOCKED — '
          + 'no synthetic data substituted, no claims made.';
        console.error(`[pooled] BLOCKED: ${reason}`);
        mkdirSync(DOCS_DIR, { recursive: true });
        const doc = buildBlockedDoc({ attempted: TICKER_UNIVERSE, reason });
        writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.json'), JSON.stringify(doc, null, 2));
        const md = buildReportMd(doc);
        writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.md'), md);
        console.log(md);
        process.exit(2);
      }
      console.error(`[pooled] fetch step exited ${code}; continuing with whatever cache exists.`);
    }
  }

  // Step 2: load + validate cached datasets.
  const datasets = loadCachedDatasets();
  if (!datasets.length) {
    const reason = 'No cached real Tickerbot datasets found and fetching did not succeed.';
    console.error(`[pooled] BLOCKED: ${reason}`);
    mkdirSync(DOCS_DIR, { recursive: true });
    const doc = buildBlockedDoc({ attempted: TICKER_UNIVERSE, reason });
    writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.json'), JSON.stringify(doc, null, 2));
    const md = buildReportMd(doc);
    writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.md'), md);
    console.log(md);
    process.exit(2);
  }

  const tested = [];
  const skipped = [];
  const perTicker = {};
  const pooledInputs = Object.fromEntries(HORIZONS.map((h) => [h, []]));
  const meta = [];

  for (const ds of datasets) {
    const integrity = validateBarsDataset(ds);
    meta.push(datasetMetadata(ds, integrity));
    if (!integrity.ok || ds.bars.length < 200) {
      skipped.push({ ticker: ds.ticker, reason: !integrity.ok
        ? `integrity hard-fail: ${integrity.hardErrors.join('; ')}`
        : `only ${ds.bars.length} candles (<200 minimum)` });
      continue;
    }
    process.stdout.write(`[pooled] walk-forward on ${ds.ticker} (${ds.bars.length} bars)…\n`);
    try {
      const search = walkForwardParameterSearch({ bars: ds.bars, horizons: HORIZONS });
      if (!search.test || search.test.ok === false) {
        skipped.push({ ticker: ds.ticker, reason: search.test?.message || search.note || 'insufficient history' });
        continue;
      }
      tested.push(ds.ticker);
      perTicker[ds.ticker] = {
        chosenConfig: search.chosen,
        scheme: search.scheme ?? null,
        paramSearchSkipped: !!search.paramSearchSkipped,
        horizons: Object.fromEntries(HORIZONS.map((h) => {
          const s = search.test.horizons[h];
          return [h, {
            predictions: s.predictions, correct: s.correct, noSignals: s.noSignals,
            upSignals: s.upSignals, downSignals: s.downSignals,
            eligibleRows: s.eligibleRows, accuracyPct: s.accuracyPct,
            wilsonLowPct: s.wilsonLowPct, wilsonHighPct: s.wilsonHighPct,
            baselineDominantAccuracyPct: s.baselineDominantAccuracyPct,
            baselineAlwaysUpAccuracyPct: s.baselineAlwaysUpAccuracyPct,
            baselineMomentumAccuracyPct: s.baselineMomentumAccuracyPct,
            edgeVsBestBaselinePp: s.edgeVsBestBaselinePp,
          }];
        })),
      };
      for (const h of HORIZONS) pooledInputs[h].push(search.test.horizons[h]);
    } catch (err) {
      skipped.push({ ticker: ds.ticker, reason: String(err?.message || err) });
    }
  }

  // Step 3: pool.
  const pooledResults = Object.fromEntries(HORIZONS.map((h) => [h, poolHorizonCells(pooledInputs[h])]));
  const edgeHorizons = HORIZONS.filter((h) => pooledResults[h].verdict === 'EDGE');
  const insuffCount = HORIZONS.filter((h) => pooledResults[h].verdict === 'INSUFFICIENT EVIDENCE').length;
  let finalAnswer;
  if (!tested.length) {
    finalAnswer = '**INSUFFICIENT EVIDENCE** — no ticker could be tested on real data.';
  } else if (edgeHorizons.length === 0) {
    finalAnswer = insuffCount === HORIZONS.length
      ? '**INSUFFICIENT EVIDENCE** — pooled signal volume never reached the pre-registered minimum.'
      : '**NO EDGE** — at no horizon does the pooled out-of-sample prediction set beat the best '
        + 'simple baseline with Wilson-95%-low above the baseline and p < 0.05. This is an '
        + 'acceptable outcome; no thresholds or algorithm changes were made in response.';
  } else if (edgeHorizons.length === HORIZONS.length) {
    finalAnswer = '**EDGE** — pooled out-of-sample accuracy beats the best simple baseline at ALL '
      + 'tested horizons (Wilson-95% low above baseline, p < 0.05). No tuning was applied to obtain this.';
  } else {
    finalAnswer = `**MIXED** — EDGE at horizon(s) ${edgeHorizons.join(', ')}D only; other horizons show `
      + 'NO EDGE or insufficient evidence. Treat cautiously without independent confirmation.';
  }

  const doc = {
    status: 'COMPLETE',
    phase: 'Phase 5 — Pooled real-data validation',
    generatedAt: new Date().toISOString(),
    gitCommit: gitShort(),
    tickerUniverseRequested: TICKER_UNIVERSE,
    tickersTested: tested,
    tickersSkipped: skipped.map((s) => s.ticker),
    skipReasons: skipped,
    methodology: {
      design: 'Pooled multi-ticker chronological walk-forward of the UNCHANGED '
        + 'prediction-engine.walkForwardParameterSearch (train 60% → validation 20% → test 20% '
        + 'per ticker); pooled out-of-sample TEST predictions compared with eligibility-weighted '
        + 'baselines (dominant direction, always-up, trailing-5d momentum).',
      leakageControls: [
        'point-in-time features only (row i uses bars ≤ i)',
        'training/database strictly before prediction date (chronological split)',
        'normalization at row i uses only prior rows (engine-internal, unchanged)',
        'parameters chosen on validation rows only; test evaluated once',
        'no threshold or algorithm changes were made after seeing results; NO-SIGNAL allowed',
      ],
      poolingRules: [
        'pool = sum of all tickers’ out-of-sample signaled TEST predictions per horizon',
        'baselines pooled eligibility-weighted across tickers',
        `verdict INSUFFICIENT EVIDENCE if pooled signals < ${MIN_SIGNAL_SAMPLE_LIVE}`,
        'EDGE iff pooled accuracy > best pooled baseline AND Wilson-95%-low > baseline AND p < 0.05',
        'otherwise NO EDGE; NO-SIGNAL rows are allowed and never counted as errors',
      ],
    },
    datasets: meta,
    perTicker: {},
    pooledResults,
    totalApiRequestsUsed: meta.reduce((a, m) => a + (m.apiRequestCount || 0), 0),
    finalAnswer,
    provenance: {
      cacheDir: 'scripts/research/data/real/',
      cachingDiscipline: 'datasets cached once on disk; identical data never re-downloaded',
      syntheticDataUsed: false,
    },
  };
  doc.perTicker = perTicker;
  doc.schemaNote = 'per-ticker details in perTicker; full raw stats preserved';

  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.json'), JSON.stringify(doc, null, 2));
  const md = buildReportMd(doc);
  writeFileSync(path.join(DOCS_DIR, 'pooled-real-data-validation.md'), md);
  console.log(`[pooled] wrote docs/research/pooled-real-data-validation.{md,json}; `
    + `tested=[${tested}] verdicts=${JSON.stringify(Object.fromEntries(HORIZONS.map((h) => [h, pooledResults[h].verdict])))}`);
  console.log(md);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
