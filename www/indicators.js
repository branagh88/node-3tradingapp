// indicators.js — pure indicator math (specs/phase1.md B9).
// All functions operate on close arrays from REAL normalized candles and return
// arrays the same length as the input, with `null` during warm-up, so charts can
// skip nulls. Nothing here ever fabricates data.

// SMA(n): mean of last n closes; null while i < n-1
export function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0) return out;
  for (let i = period - 1; i < closes.length; i += 1) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const v = closes[j];
      if (v == null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

// EMA(n): seed = SMA(first n); k = 2/(n+1); output starts at index n-1
export function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;
  const seedArr = sma(closes, period);
  const seed = seedArr[period - 1];
  if (seed == null) return out;
  const k = 2 / (period + 1);
  let prev = seed;
  out[period - 1] = seed;
  for (let i = period; i < closes.length; i += 1) {
    const v = closes[i];
    if (v == null || !Number.isFinite(v)) continue;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI(n): Wilder smoothing; output starts at index n (B9); avgLoss==0 -> 100
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (Number.isFinite(diff) && diff >= 0) gainSum += diff;
    else if (Number.isFinite(diff)) lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const rsiAt = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));

  out[period] = rsiAt(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (!Number.isFinite(diff)) continue;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiAt(avgGain, avgLoss);
  }
  return out;
}

function closesOf(candles) {
  return (candles || []).map((c) => (c && c.close != null ? Number(c.close) : null));
}

// Build a [{time, value}] line from aligned indicator output; nulls skipped.
function toLine(candles, values) {
  const line = [];
  for (let i = 0; i < candles.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    const t = candles[i] && candles[i].time;
    if (t == null) continue;
    line.push({ time: t, value: v });
  }
  return line;
}

// Named indicator builders used by charts.js (B2.9). Each takes normalized
// candles (ascending time) and returns a [{time, value}] line (or [] when short).
export const INDICATORS = {
  sma5: (candles) => toLine(candles, sma(closesOf(candles), 5)),
  sma10: (candles) => toLine(candles, sma(closesOf(candles), 10)),
  sma20: (candles) => toLine(candles, sma(closesOf(candles), 20)),
  sma50: (candles) => toLine(candles, sma(closesOf(candles), 50)),
  ema9: (candles) => toLine(candles, ema(closesOf(candles), 9)),
  ema21: (candles) => toLine(candles, ema(closesOf(candles), 21)),
  rsi: (candles) => toLine(candles, rsi(closesOf(candles), 14)),
};

export const INDICATOR_META = {
  sma5: { label: 'SMA 5', color: '#5b8def' },
  sma10: { label: 'SMA 10', color: '#7aa2f7' },
  sma20: { label: 'SMA 20', color: '#f0a35e' },
  sma50: { label: 'SMA 50', color: '#c078dd' },
  ema9: { label: 'EMA 9', color: '#3ddad7' },
  ema21: { label: 'EMA 21', color: '#e5c07b' },
  rsi: { label: 'RSI 14', color: '#8be0a3' },
};

export const DEFAULT_INDICATOR_TOGGLES = {
  sma5: false,
  sma10: false,
  sma20: true,
  sma50: false,
  ema9: false,
  ema21: false,
  rsi: false,
};