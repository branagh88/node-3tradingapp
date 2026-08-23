// gen-bars.mjs — deterministic synthetic daily bars per ticker profile.
//
// The dev environment has NO Tickerbot API key (the key lives only in the
// app's secure store on the user's device), so the Phase 3 empirical
// comparison loop runs on SEEDED SYNTHETIC FIXTURES that mimic different
// market characters. This is a documented limitation: numbers produced here
// validate methodology behavior (selectivity, gating, leakage-safety,
// determinism), NOT live-market edge. If live access becomes available, the
// same compare.mjs can consume cached real bars from data/<TICKER>.json.

const DAY = 24 * 3600 * 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  // Irwin–Hall approx of N(0,1)
  return (rand() + rand() + rand() + rand() + rand() + rand() - 3) * Math.sqrt(2);
}

/**
 * Generate n weekday bars with regime-switching drift/vol.
 * @param {object} p {seed, startClose, dailyVol, drift, regimes}
 */
export function genBars(n, {
  seed = 1, startClose = 100, dailyVol = 0.015, drift = 0.0002, regimeProb = 0.01,
} = {}) {
  const rand = rng(seed);
  const bars = [];
  let t = Date.UTC(2019, 0, 2);
  let close = startClose;
  let vol = dailyVol;
  let mu = drift;
  while (bars.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      if (rand() < regimeProb) { vol = dailyVol * (0.5 + rand() * 2); mu = drift * (rand() * 4 - 1.5); }
      const open = close;
      close = open * Math.exp(mu + vol * gauss(rand));
      const h = Math.max(open, close) * (1 + Math.abs(gauss(rand)) * vol * 0.4);
      const l = Math.min(open, close) * (1 - Math.abs(gauss(rand)) * vol * 0.4);
      const v = 1_000_000 * Math.exp(0.3 * gauss(rand)) * (1 + 8 * Math.abs(close / open - 1));
      bars.push({ t, o: open, h, l, c: close, v });
    }
    t += DAY;
  }
  return bars;
}

export const TICKER_PROFILES = {
  AAPL: { seed: 101, startClose: 150, dailyVol: 0.014, drift: 0.0006 },
  GME: { seed: 202, startClose: 25, dailyVol: 0.05, drift: 0.0001, regimeProb: 0.03 },
  MSFT: { seed: 303, startClose: 250, dailyVol: 0.013, drift: 0.0005 },
  NVDA: { seed: 404, startClose: 200, dailyVol: 0.024, drift: 0.0012 },
  AMZN: { seed: 505, startClose: 170, dailyVol: 0.017, drift: 0.0004 },
};

export function fixtureFor(ticker, n = 1254) {
  return genBars(n, TICKER_PROFILES[ticker] || { seed: 999 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [tk, p] of Object.entries(TICKER_PROFILES)) {
    console.log(tk, genBars(10, p).length, 'bars ok');
  }
}
