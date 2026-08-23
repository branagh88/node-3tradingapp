// fetch-real-bars.mjs — Phase 4 ONE-SHOT real Tickerbot history fetcher + cache.
//
// Fetches daily bars for liquid tickers through the app's OWN integration
// (MarketAPI.fetchBarsPageRaw via HistorySource.fetchRange) and caches them
// locally ONCE under scripts/research/data/real/<TICKER>.json.
//
// API-budget discipline (free plan has a monthly cap):
//   - if the cache file exists, the ticker is SKIPPED (zero API calls)
//     unless --force is passed;
//   - 1000 bars/page → ≤ ~6 pages per ticker for 15 years of dailies;
//   - HistorySource's built-in rate limiter keeps us ≤55 req/min.
//
// Run:   node scripts/research/fetch-real-bars.mjs [--force] [TICKER...]
// Exits: 0 all requested tickers cached/fetched OK
//        2 no API key available anywhere (nothing was fetched, nothing fabricated)
//        1 some or all tickers failed (details in summary; cache holds successes)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'data', 'real');

// ---- localStorage shim (Node has none) — mirrors scripts/capture-aapl.mjs ----
if (typeof localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'GME'];
const INTERVAL = '1d';
const FROM_MS = Date.now() - 15 * 365.25 * 24 * 3600 * 1000; // ~15 years back
const TO_MS = Date.now();
const MAX_PAGES = 200; // hard cap; at 1000/page only ~6 pages are needed

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const tickers = argv.filter((a) => !a.startsWith('--'))
    .map((a) => a.toUpperCase());
  const list = tickers.length ? tickers : DEFAULT_TICKERS;

  // Resolve credentials: stored app config first, then env override. Never printed.
  const { loadConfig } = await import('../../config.js');
  const { storage } = await import('../../storage.js');
  storage.migrate();
  const cfg = loadConfig();
  const apiKey = (process.env.TICKERBOT_API_KEY || process.env.TICKERBOT_API_TOKEN || '').trim()
    || (cfg.apiKey && String(cfg.apiKey).trim()) || '';

  if (!apiKey) {
    console.error('[fetch-real] STOP: no Tickerbot API key found '
      + '(env TICKERBOT_API_KEY / TICKERBOT_API_TOKEN, or stored app config). '
      + 'Nothing was fetched and nothing was fabricated. '
      + 'Re-run with a key provisioned: TICKERBOT_API_KEY=… node scripts/research/fetch-real-bars.mjs');
    process.exit(2);
  }

  const { MarketAPI } = await import('../../api.js');
  const { HistorySource } = await import('../../history-source.js');
  const api = new MarketAPI({
    baseURL: cfg.baseURL,
    apiKey,
    apiVersion: cfg.apiVersion,
    stockEndpoint: cfg.stockEndpoint,
    settings: cfg.settings,
  });
  const source = new HistorySource({ fetchPage: api.fetchBarsPageRaw.bind(api) });

  mkdirSync(CACHE_DIR, { recursive: true });
  let okCount = 0;
  let totalRequests = 0;
  const failures = [];

  for (const ticker of list) {
    const cachePath = path.join(CACHE_DIR, `${ticker}.json`);
    if (!force && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log(`[fetch-real] ${ticker}: cache hit (${cached.bars?.length ?? 0} bars, `
          + `fetchedAt=${cached.fetchedAt}) — 0 API calls used.`);
        okCount += 1;
        continue;
      } catch {
        console.log(`[fetch-real] ${ticker}: cache unreadable, refetching.`);
      }
    }
    process.stdout.write(`[fetch-real] ${ticker}: fetching ${INTERVAL} bars …`);
    let requestsBefore = null;
    try {
      const res = await source.fetchRange({
        ticker, interval: INTERVAL, from: FROM_MS, to: TO_MS, maxPages: MAX_PAGES,
      });
      requestsBefore = res.pagesFetched;
      totalRequests += res.pagesFetched;
      const bars = res.bars || [];
      if (!bars.length) {
        failures.push({ ticker, reason: `no bars returned (stoppedReason=${res.stoppedReason})` });
        console.log(` FAILED: no bars (${res.stoppedReason}${res.error ? `: ${res.error.message}` : ''})`);
        continue;
      }
      if (res.stoppedReason && res.stoppedReason !== 'server_exhausted') {
        failures.push({ ticker, reason: `partial fetch stopped early: ${res.stoppedReason}` });
      }
      const payload = {
        ticker,
        source: 'tickerbot',
        interval: INTERVAL,
        fetchedAt: new Date().toISOString(),
        fromMs: FROM_MS,
        toMs: TO_MS,
        pagesFetched: res.pagesFetched,
        apiRequestsUsed: res.pagesFetched,
        stoppedReason: res.stoppedReason,
        bars,
      };
      writeFileSync(cachePath, JSON.stringify(payload));
      const first = new Date(bars[0].t).toISOString().slice(0, 10);
      const last = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
      console.log(` OK: ${bars.length} candles ${first}..${last} (${res.pagesFetched} requests)`);
      okCount += 1;
    } catch (err) {
      failures.push({ ticker, reason: err?.message || String(err) });
      console.log(` FAILED: ${err?.message || err}`);
    }
  }

  console.log(`\n[fetch-real] done: ${okCount}/${list.length} tickers cached, `
    + `${totalRequests} API requests used this run.`);
  if (failures.length) {
    for (const f of failures) console.error(`[fetch-real] failure: ${f.ticker}: ${f.reason}`);
  }
  if (okCount === 0) process.exit(1);
}

main();
