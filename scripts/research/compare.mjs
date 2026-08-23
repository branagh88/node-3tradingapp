// compare.mjs — Phase 3 EMPIRICAL comparison loop (W2/W3/W7).
//
// Runs, per ticker fixture: the Phase 2 baseline config, tightened threshold,
// top-K variants, composite mode, and feature-group ablations through the
// walk-forward backtest. Also runs walkForwardParameterSearch. Emits a JSON
// + Markdown results table under results/.
//
// Usage: node scripts/research/compare.mjs [--bars-file path.json] [TICKER...]
// If --bars-file is given it is used for every requested ticker slot (used to
// plug in real cached bars later); otherwise seeded synthetic fixtures.

import { mkdirSync, writeFileSync } from 'node:fs';
import { walkForwardBacktest, walkForwardParameterSearch } from '../../prediction-engine.js';
import { FEATURE_NAMES } from '../../pattern-engine.js';
import { fixtureFor } from './gen-bars.mjs';

const HORIZONS = [1, 3, 5, 10];
const N = Number(process.env.BARS_N || 1254);

const FEATURE_GROUPS = {
  momentumReturns: ['return1d', 'return3d', 'return5d', 'return10d'],
  candleAnatomy: ['bodyPct', 'upperWickPct', 'lowerWickPct', 'highLowRangePct'],
  volume: ['volume', 'volumeVsAvg20'],
  maDistances: ['distFromSma5', 'distFromSma10', 'distFromSma20', 'distFromSma50', 'distFromEma9', 'distFromEma21'],
  streak: ['consecutiveUpDown'],
  volatility: ['volatility5d', 'volatility10d'],
  rsi: ['rsi14'],
};

function summarize(label, bt) {
  const h = {};
  for (const d of HORIZONS) {
    const s = bt.horizons[d] || {};
    h[`${d}D`] = {
      acc: s.accuracyPct, upSig: s.upSignals || s.positiveSignals || 0,
      downSig: s.downSignals || s.negativeSignals || 0,
      none: s.noSignals ?? null, coverage: s.coveragePct,
      baseDominant: s.baselineDominantAccuracyPct, baseUp: s.baselineAlwaysUpAccuracyPct,
      baseMomentum: s.baselineMomentumAccuracyPct,
      edge: s.edgeVsBestBaselinePp, beats: s.beatsBaselines,
      wilson: s.wilsonLowPct != null ? `${s.wilsonLowPct}–${s.wilsonHighPct}` : null,
      avgRetPos: s.avgReturnAfterPositivePct, avgMatch: s.avgMatchCount == null ? null : Number(s.avgMatchCount?.toFixed?.(1) ?? s.avgMatchCount),
    };
  }
  return {
    label,
    ok: bt.ok,
    overallAcc: bt.accuracyPct,
    predictions: bt.predictionsCount,
    medianMatchCount: bt.medianMatchCount,
    horizons: h,
  };
}

function runVariant(bars, cfg, label) {
  const bt = walkForwardBacktest({ bars, horizons: HORIZONS, ...cfg });
  return summarize(label, bt);
}

function ablations(bars, baseCfg) {
  const out = [];
  out.push(runVariant(bars, baseCfg, 'baseline(all features)'));
  for (const [group, feats] of Object.entries(FEATURE_GROUPS)) {
    const active = FEATURE_NAMES.filter((f) => !feats.includes(f));
    out.push(runVariant(bars, { ...baseCfg, activeFeatures: active }, `ablate(-${group})`));
  }
  return out;
}

function mdTable(rows) {
  const cols = ['variant', '1D acc', '1D edge', '1D cov%', 'sig u/d/n', 'medianMatches', '10D acc', '10D edge'];
  const line = (cells) => `| ${cells.join(' | ')} |`;
  let out = line(cols) + '\n|' + cols.map(() => '---').join('|') + '|\n';
  for (const r of rows) {
    const h1 = r.horizons['1D']; const h10 = r.horizons['10D'];
    out += line([
      r.label,
      h1.acc ?? '—', h1.edge ?? '—', h1.coverage ?? '—',
      `${h1.upSig ?? '—'}/${h1.downSig ?? '—'}/${h1.none ?? '—'}`,
      r.medianMatchCount ?? '—',
      h10.acc ?? '—', h10.edge ?? '—',
    ]) + '\n';
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let barsFile = null;
  const tickers = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bars-file') { barsFile = args[++i]; continue; }
    tickers.push(args[i]);
  }
  const list = tickers.length ? tickers : Object.keys((await import('./gen-bars.mjs')).TICKER_PROFILES);
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });

  const report = {};
  for (const ticker of list) {
    let bars;
    if (barsFile) {
      bars = JSON.parse((await import('node:fs')).readFileSync(barsFile, 'utf8'));
    } else {
      bars = fixtureFor(ticker, N);
    }
    console.log(`\n=== ${ticker} (${bars.length} bars${barsFile ? ', from file' : ', synthetic fixture'}) ===`);

    const variants = [];
    // Phase 2 legacy config.
    variants.push(runVariant(bars, { matchMode: 'threshold', maxDistance: 1.5, minSignalSample: 0 }, 'phase2-threshold-1.5'));
    // Tightened threshold.
    variants.push(runVariant(bars, { matchMode: 'threshold', maxDistance: 0.6, minSignalSample: 0 }, 'threshold-0.6'));
    // Top-K defaults.
    variants.push(runVariant(bars, { matchMode: 'topk' }, 'topk-kFrac0.05'));
    variants.push(runVariant(bars, { matchMode: 'topk', kFraction: 0.02 }, 'topk-kFrac0.02'));
    variants.push(runVariant(bars, { matchMode: 'topk', kFraction: 0.02, requireEdge: true }, 'topk-kFrac0.02+edgeGate'));
    // Composite.
    variants.push(runVariant(bars, { matchMode: 'composite' }, 'composite'));
    variants.push(runVariant(bars, { matchMode: 'composite', requireEdge: true }, 'composite+edgeGate'));

    // Ablations on top-K default config.
    const abl = ablations(bars, { matchMode: 'topk' });

    // Walk-forward parameter selection.
    const pws = walkForwardParameterSearch({ bars, horizons: [1] });

    report[ticker] = { bars: bars.length, synthetic: !barsFile, variants, ablations: abl, paramSearch: { chosen: pws.chosen, skipped: pws.paramSearchSkipped, note: pws.note, validationScores: pws.validationScores, testSummary: summarize('paramsearch-test', pws.test) } };

    console.log(mdTable(variants));
    console.log('-- ablations --');
    console.log(mdTable(abl));
    console.log(`-- param search chosen: ${JSON.stringify(pws.chosen)} skipped=${pws.paramSearchSkipped}`);
    const t1 = pws.test.horizons[1] || {};
    console.log(`   test 1D acc=${t1.accuracyPct} edge=${t1.edgeVsBestBaselinePp} cov=${t1.coveragePct} sig u/d/n=${t1.upSignals}/${t1.downSignals}/${t1.noSignals}`);
  }

  const outFile = new URL('./results/compare-results.json', import.meta.url);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outFile.pathname}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
