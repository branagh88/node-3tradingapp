// run-real-validation.mjs — Phase 4 REAL-DATA empirical validation runner.
//
// Reads ONLY cached real Tickerbot bars from scripts/research/data/real/
// (fetched once by fetch-real-bars.mjs — never fetches, zero API calls),
// runs the EXISTING Phase 3 engine (walkForwardParameterSearch +
// walkForwardBacktest) unchanged, and writes evidence-based results to
// scripts/research/results/real-data/.
//
// Slices per ticker × horizon (same test rows, no re-tuning):
//   all             — default engine run (NO-SIGNAL gate active)
//   highConfidence  — requireEdge:true (Wilson CI must exclude 50%)
//   forced          — minSignalSample:1 (contrast: shows what the gate buys)
// The SAMPLE-GATE view is the default run itself (the engine emits NO-SIGNAL
// below MIN_SIGNAL_SAMPLE); each horizon cell reports meetsSampleGate.
//
// Verdict rules (applied mechanically, never "accuracy > 50% ⇒ edge"):
//   INSUFFICIENT_SAMPLE if signals < DEFAULTS.MIN_SIGNAL_SAMPLE;
//   EDGE iff accuracy > best baseline AND Wilson-95% low bound > best baseline
//   AND two-sided z-test p < 0.05; else NO EDGE.
//
// Run: node scripts/research/run-real-validation.mjs

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'data', 'real');
const RESULTS_DIR = path.join(HERE, 'results', 'real-data');
const HORIZONS = [1, 3, 5, 10];

const { walkForwardParameterSearch, walkForwardBacktest } = await import('../../prediction-engine.js');
const pe = await import('../../pattern-engine.js');
const { validateBarsDataset } = await import('./validate-bars.mjs');
// Browser-safe pooled-stats extraction: the math lives in ../../pooled-stats.js;
// this runner re-exports so existing tests keep importing from here unchanged.
const pooledStats = await import('../../pooled-stats.js');

function pct(n, d = 2) { return n == null ? null : Number((n * 100).toFixed(d)); }

/** Two-sided two-proportion z-test (normal approximation). Returns p-value.
 *  Extracted to pooled-stats.js (browser-safe); re-exported here. */
export const zTestTwoProportions = pooledStats.zTestTwoProportions;
export const normalCdf = pooledStats.normalCdf;
export const erf = pooledStats.erf;

/** Mechanical verdict per ticker/horizon from an "all"-slice stats object. */
export function verdictFor(s) {
  const signals = (s.upSignals || 0) + (s.downSignals || 0);
  if (signals < pe.DEFAULTS.MIN_SIGNAL_SAMPLE) {
    return { verdict: 'INSUFFICIENT_SAMPLE', reason: `${signals} signals < ${pe.DEFAULTS.MIN_SIGNAL_SAMPLE} minimum` };
  }
  const baselines = [s.baselineDominantAccuracyPct, s.baselineAlwaysUpAccuracyPct,
    s.baselineMomentumAccuracyPct].filter((v) => v != null);
  const best = baselines.length ? Math.max(...baselines) : null;
  if (best == null || s.accuracyPct == null || s.wilsonLowPct == null) {
    return { verdict: 'NO EDGE', reason: 'missing accuracy/baseline/CI inputs' };
  }
  const test = zTestTwoProportions(s.correct, signals, Math.round((best / 100) * signals), signals);
  const pOk = test != null && test.pValue < 0.05;
  if (s.accuracyPct > best && s.wilsonLowPct > best && pOk) {
    return { verdict: 'EDGE', reason: `accuracy ${s.accuracyPct}% > best baseline ${best}%, `
      + `Wilson low ${s.wilsonLowPct}% > baseline, p=${test?.pValue}`, pValue: test?.pValue };
  }
  return { verdict: 'NO EDGE', reason: `fails EDGE criteria (acc=${s.accuracyPct}%, bestBase=${best}%, `
    + `wilsonLow=${s.wilsonLowPct}%, p=${test ? test.pValue : 'n/a'})`, pValue: test?.pValue ?? null };
}

/** Reduce one walkForwardBacktest horizon stat into the reported schema. */
function summarize(horizonStats, h, meetsSampleGate) {
  const s = horizonStats;
  const signals = (s.upSignals || 0) + (s.downSignals || 0);
  const out = {
    days: h,
    eligibleRows: s.eligibleRows,
    predictions: s.predictions,
    correct: s.correct,
    noSignals: s.noSignals,
    coveragePct: s.coveragePct,
    accuracyPct: s.accuracyPct,
    upSignals: s.upSignals,
    downSignals: s.downSignals,
    positiveAccuracyPct: s.positiveAccuracyPct,
    negativeAccuracyPct: s.negativeAccuracyPct,
    // Win rate of direction calls on signaled rows (up-calls followed by a
    // positive h-day close OR down-calls followed by a negative one) — equals
    // directional accuracy on signaled rows because the engine records exactly
    // these outcomes; reported explicitly for the research schema.
    winRatePct: s.predictions ? pct(s.correct / s.predictions) : null,
    avgReturnAfterPositivePct: s.avgReturnAfterPositivePct,
    medianReturnAfterPositivePct: s.medianReturnAfterPositivePct,
    wilsonLowPct: s.wilsonLowPct,
    wilsonHighPct: s.wilsonHighPct,
    baselineDominantAccuracyPct: s.baselineDominantAccuracyPct,
    baselineAlwaysUpAccuracyPct: s.baselineAlwaysUpAccuracyPct,
    baselineMomentumAccuracyPct: s.baselineMomentumAccuracyPct,
    edgeVsBestBaselinePp: s.edgeVsBestBaselinePp,
    meetsSampleGate,
    significance: null,
    verdict: null,
    verdictReason: null,
  };
  if (signals >= pe.DEFAULTS.MIN_SIGNAL_SAMPLE && s.correct != null) {
    const baselines = [s.baselineDominantAccuracyPct, s.baselineAlwaysUpAccuracyPct,
      s.baselineMomentumAccuracyPct].filter((v) => v != null);
    const best = baselines.length ? Math.max(...baselines) : null;
    if (best != null) {
      const t = zTestTwoProportions(s.correct, signals, Math.round((best / 100) * signals), signals);
      if (t) out.significance = { test: 'two-proportion-z', ...t, alpha: 0.05 };
    }
  }
  return out;
}

/**
 * Analyze ONE ticker's cached bars through the existing Phase 3 engine.
 * Pure given inputs (deterministic; clock injected via opts.generatedAt).
 */
export function analyzeBars({ bars, ticker, generatedAt = new Date().toISOString(), horizons = HORIZONS }) {
  const integrity = validateBarsDataset({ ticker, interval: '1d', bars });
  const search = walkForwardParameterSearch({ bars, horizons });
  if (!search.test || search.test.ok === false) {
    return {
      ticker,
      generatedAt,
      error: (search.test && search.test.message) || 'insufficient history for backtest',
      dataIntegrity: integrity,
      parameterSearch: { paramSearchSkipped: true, note: search.note ?? null, chosen: search.chosen ?? {}, validationScores: [] },
      scheme: { candleCount: bars.length },
      engineConfig: {}, horizons: {}, regimeSplit: null,
    };
  }
  const chosen = search.chosen || {};
  const runAll = search.test; // evaluated once on test rows by the search itself
  const runHighConf = walkForwardBacktest({ bars, horizons, ...chosen, requireEdge: true });
  const runForced = walkForwardBacktest({ bars, horizons, ...chosen, minSignalSample: 1 });

  const perHorizon = {};
  for (const h of horizons) {
    const all = runAll.horizons[h];
    const hc = runHighConf.horizons[h];
    const fc = runForced.horizons[h];
    const signals = (all.upSignals || 0) + (all.downSignals || 0);
    const meetsSampleGate = signals >= pe.DEFAULTS.MIN_SIGNAL_SAMPLE;
    const entry = {
      all: summarize(all, h, meetsSampleGate),
      highConfidence: summarize(hc, h, meetsSampleGate),
      forced: summarize(fc, h, false),
    };
    const v = verdictFor(all);
    entry.all.verdict = v.verdict;
    entry.all.verdictReason = v.reason;
    if (v.pValue != null && !entry.all.significance) {
      entry.all.significance = { test: 'two-proportion-z', pValue: v.pValue, alpha: 0.05 };
    }
    perHorizon[h] = entry;
  }

  // Regime-split DIAGNOSTIC (not part of the headline verdict): compare model
  // accuracy on the older vs newer half of the TEST window by truncating the
  // series at the median test-row timestamp with the SAME frozen config.
  let regimeSplit = null;
  try {
    const q = bars.length;
    const mid = runAll.splitIndex != null
      ? bars.findIndex((b) => b.t >= bars[runAll.splitIndex].t) : -1;
    if (mid > 80) {
      const cut = mid + Math.floor((q - mid) / 2);
      const older = walkForwardBacktest({ bars: bars.slice(0, cut), horizons: [horizons[0]], ...chosen });
      const newer = walkForwardBacktest({ bars, horizons: [horizons[0]], ...chosen });
      regimeSplit = {
        note: 'diagnostic only; truncation changes the database boundary',
        horizonDays: horizons[0],
        olderHalfAccuracyPct: older.ok ? older.horizons[horizons[0]].accuracyPct : null,
        newerHalfAccuracyPct: newer.ok ? newer.horizons[horizons[0]].accuracyPct : null,
        olderHalfSignals: older.ok
          ? (older.horizons[horizons[0]].upSignals + older.horizons[horizons[0]].downSignals) : 0,
        newerHalfSignals: newer.ok
          ? (newer.horizons[horizons[0]].upSignals + newer.horizons[horizons[0]].downSignals) : 0,
      };
    }
  } catch { regimeSplit = { note: 'regime split failed', olderHalfAccuracyPct: null }; }

  return {
    ticker,
    generatedAt,
    dataIntegrity: integrity,
    parameterSearch: {
      paramSearchSkipped: !!search.paramSearchSkipped,
      note: search.note ?? null,
      scheme: search.scheme ?? null,
      chosen,
      validationScores: search.validationScores ?? [],
    },
    scheme: {
      trainFrac: search.scheme?.trainFrac ?? 0.6,
      valFrac: search.scheme?.valFrac ?? 0.2,
      testFrac: search.scheme ? Number((1 - search.scheme.trainFrac - search.scheme.valFrac).toFixed(4)) : 0.2,
      splitIndexBar: runAll.splitIndex,
      splitDate: runAll.splitIndex != null && bars[runAll.splitIndex]
        ? new Date(bars[runAll.splitIndex].t).toISOString().slice(0, 10) : null,
      databaseRows: runAll.databaseRows,
      testRows: runAll.testRows,
      candleCount: bars.length,
      firstDate: new Date(bars[0].t).toISOString().slice(0, 10),
      lastDate: new Date(bars[bars.length - 1].t).toISOString().slice(0, 10),
    },
    engineConfig: runAll.config,
    horizons: perHorizon,
    regimeSplit,
  };
}

/** Validate the real-data results document schema. Returns {ok, errors}. */
export function validateResultsSchema(results) {
  const errors = [];
  const VERDICTS = ['EDGE', 'NO EDGE', 'INSUFFICIENT_SAMPLE'];
  const numOrNull = (v) => v === null || typeof v === 'number';
  if (!results || typeof results !== 'object') return { ok: false, errors: ['results is not an object'] };
  if (!Array.isArray(results.tickers)) errors.push('tickers must be an array');
  for (const t of results.tickers || []) {
    if (typeof t.ticker !== 'string') errors.push(`${t.ticker}: ticker string missing`);
    if (!t.dataIntegrity || typeof t.dataIntegrity.ok !== 'boolean') errors.push(`${t.ticker}: dataIntegrity.ok missing`);
    for (const [h, entry] of Object.entries(t.horizons || {})) {
      for (const sliceName of ['all', 'highConfidence', 'forced']) {
        const s = entry[sliceName];
        if (!s) { errors.push(`${t.ticker}/${h}/${sliceName}: missing`); continue; }
        for (const k of ['eligibleRows', 'predictions', 'noSignals', 'correct']) {
          if (!(Number.isInteger(s[k]) && s[k] >= 0)) errors.push(`${t.ticker}/${h}/${sliceName}.${k}: bad count`);
        }
        for (const k of ['coveragePct', 'accuracyPct', 'wilsonLowPct', 'wilsonHighPct',
          'baselineDominantAccuracyPct', 'baselineAlwaysUpAccuracyPct', 'baselineMomentumAccuracyPct',
          'winRatePct', 'avgReturnAfterPositivePct']) {
          if (!numOrNull(s[k])) errors.push(`${t.ticker}/${h}/${sliceName}.${k}: not number|null`);
          if (typeof s[k] === 'number' && (s[k] < -100 || s[k] > 100)) errors.push(`${t.ticker}/${h}/${sliceName}.${k}: out of range`);
        }
        if (s.wilsonLowPct != null && s.wilsonHighPct != null && s.wilsonLowPct > s.wilsonHighPct) {
          errors.push(`${t.ticker}/${h}/${sliceName}: wilsonLow > wilsonHigh`);
        }
      }
      if (!VERDICTS.includes(entry.all?.verdict)) errors.push(`${t.ticker}/${h}: bad verdict`);
    }
  }
  if (typeof results.crossTickerConsistency !== 'object') errors.push('crossTickerConsistency missing');
  if (!results.provenance || !Array.isArray(results.provenance.apiRequestsUsed)) errors.push('provenance incomplete');
  return { ok: errors.length === 0, errors };
}

// ---- consistency analysis ----
function buildConsistency(tickersResults) {
  const cells = [];
  for (const t of tickersResults) {
    for (const [h, entry] of Object.entries(t.horizons)) {
      cells.push({ ticker: t.ticker, horizon: Number(h), verdict: entry.all.verdict,
        signals: entry.all.upSignals + entry.all.downSignals,
        accuracyPct: entry.all.accuracyPct,
        edgeVsBestBaselinePp: entry.all.edgeVsBestBaselinePp });
    }
  }
  const byVerdict = {};
  for (const c of cells) byVerdict[c.verdict] = (byVerdict[c.verdict] || 0) + 1;
  const edgeTickers = [...new Set(cells.filter((c) => c.verdict === 'EDGE').map((c) => c.ticker))];
  const edgeHorizons = [...new Set(cells.filter((c) => c.verdict === 'EDGE').map((c) => String(c.horizon)))];
  return {
    totalCells: cells.length,
    verdictCounts: byVerdict,
    edgeCells: cells.filter((c) => c.verdict === 'EDGE'),
    isolatedToSingleTicker: edgeCells.length > 0 && edgeTickers.length === 1,
    isolatedToSingleHorizon: edgeCells.length > 0 && edgeHorizons.length === 1,
    edgeTickers,
    edgeHorizons,
    smallSampleCells: cells.filter((c) => c.verdict === 'INSUFFICIENT_SAMPLE'
      || (c.signals > 0 && c.signals < pe.DEFAULTS.MIN_SIGNAL_SAMPLE)).length,
    interpretation: null, // filled by the report generator based on counts
  };
}

function fmt(v, suffix = '') { return v == null ? '—' : `${v}${suffix}`; }

function buildReportMd(doc) {
  const L = [];
  L.push('# Phase 4 — Real Tickerbot Data Empirical Validation Report\n');
  L.push(`Generated: ${doc.provenance.generatedAt} · commit: ${doc.provenance.gitCommit}\n`);
  L.push('## Question\n');
  L.push('> Does our existing Phase 3 pattern engine actually identify historical market '
    + 'conditions that provide a statistically defensible improvement over simple baselines '
    + 'when tested on real Tickerbot historical data?\n');
  L.push('## Methodology\n');
  L.push('- REAL cached Tickerbot daily candles only (scripts/research/data/real/, fetched once '
    + 'via HistorySource.fetchRange; zero API calls on re-runs). No synthetic substitution.');
  L.push('- Existing Phase 3 engine UNCHANGED: walkForwardParameterSearch (train 60% → validation 20% → test 20%, '
    + 'parameters chosen on validation only, test evaluated once) then frozen-config evaluation.');
  L.push('- Point-in-time features, prior-only matching, adaptive top-K + percentile gate, '
    + 'NO-SIGNAL gate at MIN_SIGNAL_SAMPLE=' + pe.DEFAULTS.MIN_SIGNAL_SAMPLE + ', Wilson 95% CIs.');
  L.push('- Horizons: 1D/3D/5D/10D. Baselines: dominant-direction, always-up, trailing-5d momentum.');
  L.push('- Verdict rules: INSUFFICIENT_SAMPLE if signals < 30; EDGE only if accuracy > best baseline '
    + 'AND Wilson-95% lower bound > best baseline AND two-proportion z-test p < 0.05. Accuracy above '
    + '50% alone NEVER yields EDGE.\n');
  L.push('## Data Integrity\n');
  L.push('| Ticker | Candles | Range | Ordered | Invalid OHLC | Dups | Vol%>0 | OK |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const t of doc.tickers) {
    const r = t.dataIntegrity;
    L.push(`| ${r.ticker} | ${r.candleCount} | ${r.firstDate}..${r.lastDate} | ${r.orderedStrictly} | `
      + `${r.invalidOhlcRows} | ${r.duplicateTimestamps} | ${fmt(r.zeroOrNegativeVolumePct)} | ${r.ok} |`);
  }
  L.push('');
  for (const t of doc.tickers) {
    L.push(`\n## ${t.ticker}\n`);
    L.push(`Scheme: split bar index ${t.scheme.splitIndexBar} (${t.scheme.splitDate}), `
      + `DB rows ${t.scheme.databaseRows}, test rows ${t.scheme.testRows}; chosen config: `
      + `\`${JSON.stringify(t.parameterSearch.chosen)}\`\n`);
    L.push('| H | Slice | Pred | NoSig | Cov% | Acc% | +Acc% | −Acc% | AvgRet+ | MedRet+ | Wilson95 | Dom% | Up% | Mom% | Edge pp | Verdict |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [h, e] of Object.entries(t.horizons)) {
      for (const [name, s] of [['all', e.all], ['high-conf', e.highConfidence], ['forced', e.forced]]) {
        L.push(`| ${h}D | ${name} | ${s.predictions} | ${s.noSignals} | ${fmt(s.coveragePct)} | `
          + `${fmt(s.accuracyPct)} | ${fmt(s.positiveAccuracyPct)} | ${fmt(s.negativeAccuracyPct)} | `
          + `${fmt(s.avgReturnAfterPositivePct)} | ${fmt(s.medianReturnAfterPositivePct)} | `
          + `${s.wilsonLowPct == null ? '—' : `[${s.wilsonLowPct}, ${s.wilsonHighPct}]`} | `
          + `${fmt(s.baselineDominantAccuracyPct)} | ${fmt(s.baselineAlwaysUpAccuracyPct)} | `
          + `${fmt(s.baselineMomentumAccuracyPct)} | ${fmt(s.edgeVsBestBaselinePp)} | `
          + `${name === 'all' ? s.verdict : ''} |`);
      }
    }
  }
  const c = doc.crossTickerConsistency;
  L.push('\n## Cross-Ticker Consistency\n');
  L.push(`- Cells: ${c.totalCells}; verdict counts: ${JSON.stringify(c.verdictCounts)}`);
  L.push(`- EDGE cells concentrated in one ticker: ${c.isolatedToSingleTicker}; one horizon: ${c.isolatedToSingleHorizon}`);
  L.push(`- Small-sample cells: ${c.smallSampleCells}`);
  L.push(`- Interpretation: ${c.interpretation ?? '—'}\n`);
  L.push('## Final Answer\n');
  L.push(doc.finalAnswer);
  return L.join('\n');
}

async function main() {
  const { execSyncSafe } = { execSyncSafe: () => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } } };
  const gitCommit = execSyncSafe();
  const files = existsSync(CACHE_DIR)
    ? (await import('node:fs')).readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')) : [];
  const datasets = [];
  for (const f of files) {
    try { datasets.push(JSON.parse(readFileSync(path.join(CACHE_DIR, f), 'utf8'))); } catch { /* skip */ }
  }
  datasets.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

  mkdirSync(RESULTS_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  if (!datasets.length) {
    const blocked = {
      status: 'BLOCKED_NO_API_KEY',
      generatedAt,
      gitCommit,
      message: 'No cached real Tickerbot datasets found under scripts/research/data/real/. '
        + 'The dev environment has no Tickerbot API key (config.loadConfig never returns one; '
        + 'capture-aapl.mjs exits 2 for the same reason). NOTHING was fabricated: no synthetic data '
        + 'was substituted and no predictive claims are made. Once a key is provisioned, run:\n'
        + '  TICKERBOT_API_KEY=… node scripts/research/fetch-real-bars.mjs\n'
        + '  node scripts/research/run-real-validation.mjs',
      tickers: [],
    };
    writeFileSync(path.join(RESULTS_DIR, 'real-data-results.json'), JSON.stringify(blocked, null, 2));
    writeFileSync(path.join(RESULTS_DIR, 'RESULTS.md'), [
      '# Phase 4 — Real Tickerbot Data Empirical Validation Report\n',
      `Generated: ${generatedAt} · commit: ${gitCommit}`,
      '',
      '**STATUS: BLOCKED — NO REAL DATA COULD BE FETCHED.**',
      '',
      'The dev environment has **no Tickerbot API key** (the key lives only in the app\'s secure',
      'runtime store on the user device; `config.loadConfig()` never returns one here, and',
      '`scripts/capture-aapl.mjs` exits 2 for the same reason). Per the phase constraints:',
      '',
      '- No synthetic data was substituted.',
      '- No predictive ability is claimed or implied for real markets.',
      '- All harness code (fetcher, validator, runner, tests) IS shipped and tested;',
      '  synthetic Phase 3 results remain untouched under `scripts/research/results/`.',
      '',
      '## How to unblock (one command each)',
      '',
      '```bash',
      '# 1. One-time fetch (~6 API pages/ticker, cached forever after):',
      'TICKERBOT_API_KEY=<key> node scripts/research/fetch-real-bars.mjs',
      '# 2. Full real-data validation (reads cache only, zero API calls):',
      'node scripts/research/run-real-validation.mjs',
      '```',
      '',
      'This file and `real-data-results.json` will be overwritten with real, evidence-based',
      'numbers when those commands succeed.',
      '',
    ].join('\n'));
    console.log('[real-validation] BLOCKED: no cached real datasets (no API key in environment). '
      + 'Wrote blocked status to scripts/research/results/real-data/. Nothing fabricated.');
    process.exit(2);
  }

  // Integrity gate
  const integrity = [];
  const usable = [];
  for (const ds of datasets) {
    const rep = validateBarsDataset(ds);
    integrity.push(rep);
    if (rep.ok) usable.push(ds);
    else console.error(`[real-validation] ${ds.ticker}: HARD FAIL — ${rep.hardErrors.join('; ')}`);
  }

  const apiRequestsUsed = datasets.map((d) => ({
    ticker: d.ticker, apiRequestsUsed: d.apiRequestsUsed ?? null,
    pagesFetched: d.pagesFetched ?? null, fetchedAt: d.fetchedAt ?? null,
  }));

  const tickersResults = [];
  for (const ds of usable) {
    process.stdout.write(`[real-validation] analyzing ${ds.ticker} (${ds.bars.length} bars)…\n`);
    try {
      tickersResults.push(analyzeBars({ bars: ds.bars, ticker: ds.ticker, generatedAt }));
    } catch (err) {
      console.error(`[real-validation] ${ds.ticker}: analysis failed: ${err?.message}`);
      tickersResults.push({
        ticker: ds.ticker, generatedAt, error: String(err?.message || err),
        dataIntegrity: validateBarsDataset(ds),
        parameterSearch: {}, scheme: {}, engineConfig: {}, horizons: {},
      });
    }
  }

  const consistency = buildConsistency(tickersResults);
  const edgeCount = consistency.verdictCounts['EDGE'] || 0;
  consistency.interpretation = edgeCount === 0
    ? 'No ticker/horizon cell qualifies as EDGE under the pre-registered criteria; any apparent '
      + 'advantage is not statistically defensible against simple baselines.'
    : edgeCount === 1
      ? 'Exactly one cell qualifies as EDGE — consistent with an isolated effect (single ticker/horizon), '
        + 'which does not generalize without independent confirmation.'
      : `${edgeCount} cells qualify as EDGE; see per-cell details for breadth and sample sizes.`;

  const answerYes = edgeCount >= 3 && !consistency.isolatedToSingleTicker;
  const finalAnswer = edgeCount === 0
    ? '**NO.** On real Tickerbot historical data, the Phase 3 pattern engine does NOT provide a '
      + 'statistically defensible improvement over simple baselines in any tested ticker/horizon cell. '
      + 'This matches the synthetic Phase 3 finding and the app\'s conservative design (NO-SIGNAL gating): '
      + 'the engine is honest about uncertainty rather than predictive here. Do NOT change user-facing claims.'
    : answerYes
      ? '**PARTIALLY YES** — multiple broad cells qualify as EDGE under the pre-registered criteria; '
        + 'see tables for exact tickers/horizons, effect sizes and CIs before considering any claim change.'
      : '**NOT DEFENSIBLY.** Any qualifying cell(s) are isolated (single ticker or horizon) and do not '
        + 'establish a generalizable edge. Do NOT change user-facing claims.';

  const doc = {
    status: 'COMPLETE',
    title: 'Phase 4 — Real Tickerbot data empirical validation',
    generatedAt,
    gitCommit,
    finalAnswer,
    methodology: {
      source: 'tickerbot (cached via HistorySource.fetchRange over MarketAPI.fetchBarsPageRaw)',
      interval: '1d',
      engine: 'prediction-engine.walkForwardParameterSearch + walkForwardBacktest (unchanged Phase 3 logic)',
      horizons: HORIZONS,
      trainValidationTestFractions: { train: 0.6, validation: 0.2, test: 0.2 },
      verdictRules: [
        'INSUFFICIENT_SAMPLE if signals < DEFAULTS.MIN_SIGNAL_SAMPLE (30)',
        'EDGE iff accuracy > best baseline AND Wilson-95%-low > best baseline AND p < 0.05 (two-proportion z)',
        'otherwise NO EDGE; accuracy > 50% alone never yields EDGE',
      ],
    },
    dataIntegrity: integrity,
    tickers: tickersResults,
    crossTickerConsistency: consistency,
    provenance: {
      generatedAt,
      gitCommit,
      caches: datasets.map((d) => ({
        ticker: d.ticker, source: d.source, interval: d.interval,
        dateRange: [new Date(d.bars[0]?.t ?? 0).toISOString().slice(0, 10),
          new Date(d.bars[d.bars.length - 1]?.t ?? 0).toISOString().slice(0, 10)],
        candleCount: d.bars.length, fetchedAt: d.fetchedAt,
      })),
      apiRequestsUsed,
      totalApiRequests: apiRequestsUsed.reduce((a, r) => a + (r.apiRequestsUsed || 0), 0),
      syntheticResultsUntouched: 'scripts/research/results/ (Phase 3) left unmodified; real-data results isolated here',
    },
  };

  const schemaCheck = validateResultsSchema(doc);
  doc.schemaValid = schemaCheck.ok;
  if (!schemaCheck.ok) console.error('[real-validation] SCHEMA ERRORS:', schemaCheck.errors);

  writeFileSync(path.join(RESULTS_DIR, 'real-data-results.json'), JSON.stringify(doc, null, 2));
  writeFileSync(path.join(RESULTS_DIR, 'RESULTS.md'), buildReportMd(doc));
  console.log(`[real-validation] wrote ${RESULTS_DIR}/real-data-results.json and RESULTS.md `
    + `(schema valid: ${schemaCheck.ok}); verdicts: ${JSON.stringify(consistency.verdictCounts)}`);
  console.log(`[real-validation] FINAL ANSWER: ${finalAnswer.replace(/\*\*/g, '')}`);
}

// Run CLI unless imported (vitest imports the module for pure functions).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
