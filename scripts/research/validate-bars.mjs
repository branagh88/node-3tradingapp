// validate-bars.mjs — Phase 4 real-data integrity validator.
//
// Pure, dependency-light checks over a cached dataset
// { ticker, source, interval, bars: [{t,o,h,l,c,v}] }:
//   ticker/interval/date range/candle count, strict chronological ordering,
//   OHLC validity (h ≥ max(o,c), l ≤ min(o,c), all finite > 0),
//   volume availability, duplicate timestamps, missing trading-day gaps,
//   suspicious zero-close rows.
//
// Hard failures (corrupt features): ordering violations or invalid OHLC rows.
// Warnings (tolerable): gaps, duplicates, sparse volume.
//
// CLI: node scripts/research/validate-bars.mjs [path/to/cache.json ...]

const DAY_MS = 24 * 3600 * 1000;

function isoDate(t) { return new Date(t).toISOString().slice(0, 10); }

/**
 * Validate one cached dataset. Pure — no I/O, deterministic.
 * @param {object} ds { ticker?, interval?, bars }
 * @returns {object} report with ok flag, hardErrors[], warnings[], metrics
 */
export function validateBarsDataset(ds) {
  const bars = Array.isArray(ds?.bars) ? ds.bars : [];
  const report = {
    ticker: ds?.ticker ?? null,
    interval: ds?.interval ?? null,
    candleCount: bars.length,
    firstDate: bars.length ? isoDate(bars[0].t) : null,
    lastDate: bars.length ? isoDate(bars[bars.length - 1].t) : null,
    orderedStrictly: true,
    outOfOrderCount: 0,
    invalidOhlcRows: 0,
    firstInvalidOhlcIndex: null,
    duplicateTimestamps: 0,
    zeroCloseRows: 0,
    zeroOrNegativeVolumePct: null,
    largeGaps: [],           // weekday gaps > 5 trading days
    hardErrors: [],
    warnings: [],
    ok: false,
  };
  if (!bars.length) {
    report.hardErrors.push('dataset has no bars');
    return report;
  }

  // Chronological ordering (strictly ascending t).
  let prevT = -Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (!(b.t > prevT)) {
      report.orderedStrictly = false;
      report.outOfOrderCount += 1;
      if (report.outOfOrderCount === 1) {
        report.warnings.push(`first out-of-order/duplicate timestamp at index ${i}`);
      }
    }
    prevT = Math.max(prevT, b.t);
  }

  // Duplicates by timestamp count.
  const seen = new Set();
  for (const b of bars) {
    if (seen.has(b.t)) report.duplicateTimestamps += 1;
    seen.add(b.t);
  }

  // OHLC validity + zero closes + volume availability.
  let badVolume = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const { o, h, l, c, v } = bars[i];
    const valid = [o, h, l, c].every((x) => Number.isFinite(x) && x > 0)
      && h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9 && h >= l - 1e-9;
    if (!valid) {
      report.invalidOhlcRows += 1;
      if (report.firstInvalidOhlcIndex == null) report.firstInvalidOhlcIndex = i;
    }
    if (!(c > 0)) report.zeroCloseRows += 1;
    if (!(Number.isFinite(v) && v > 0)) badVolume += 1;
  }
  report.zeroOrNegativeVolumePct = Number(((badVolume / bars.length) * 100).toFixed(2));

  // Missing-period detection: gaps spanning more than 5 potential trading days
  // (weekends alone are never flagged; a >7-calendar-day gap always contains
  // more than 5 weekdays and is listed).
  for (let i = 1; i < bars.length; i += 1) {
    const gapDays = Math.round((bars[i].t - bars[i - 1].t) / DAY_MS);
    if (gapDays > 7) {
      report.largeGaps.push({ after: isoDate(bars[i - 1].t), before: isoDate(bars[i].t), calendarDays: gapDays });
    }
  }

  if (!report.orderedStrictly) report.hardErrors.push('bars are not strictly chronologically ordered');
  if (report.invalidOhlcRows > 0) report.hardErrors.push(`${report.invalidOhlcRows} row(s) with invalid OHLC`);
  if (report.zeroCloseRows > 0) report.warnings.push(`${report.zeroCloseRows} zero-close row(s)`);
  if (report.duplicateTimestamps > 0) report.warnings.push(`${report.duplicateTimestamps} duplicate timestamp(s)`);
  if (report.zeroOrNegativeVolumePct > 5) report.warnings.push(`${report.zeroOrNegativeVolumePct}% of rows lack positive volume`);
  if (report.largeGaps.length) report.warnings.push(`${report.largeGaps} large gap(s)`);

  report.ok = report.hardErrors.length === 0;
  return report;
}

/** Validate a full set of cached datasets keyed by ticker. */
export function validateAll(datasetsByName) {
  const reports = {};
  let allOk = true;
  for (const [name, ds] of Object.entries(datasetsByName)) {
    const r = validateBarsDataset(ds);
    reports[name] = r;
    if (!r.ok) allOk = false;
  }
  return { allOk, reports };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/research/validate-bars.mjs <cache.json> [...]');
    process.exit(1);
  }
  let fail = false;
  for (const f of files) {
    const ds = JSON.parse(readFileSync(f, 'utf8'));
    const r = validateBarsDataset(ds);
    console.log(`\n${f} → ${r.ok ? 'OK' : 'HARD FAIL'} (${r.ticker} ${r.interval}, `
      + `${r.candleCount} candles ${r.firstDate}..${r.lastDate})`);
    for (const w of r.warnings) console.log(`  warn: ${w}`);
    for (const e of r.hardErrors) console.log(`  ERROR: ${e}`);
    if (!r.ok) fail = true;
  }
  process.exit(fail ? 1 : 0);
}
