// tests/watchlist-add-flow.spec.js — regression test for the Add to Watchlist
// flow after the wireConfirmModal/_pendingAsset fix.
//
// Drives the REAL controller code path: a search query resolves candidates
// via api.searchTickers(), "selecting" one calls AssetsController.promptAdd()
// (exactly what app.js's .select-asset-btn handler does), which stores the
// chosen asset on `assets._pendingAsset` for the confirm modal, and confirming
// calls assets.addAsset(assets._pendingAsset) — the same call the modal
// handler makes.
//
// api/search are mocked; Tickerbot auth, key storage, normalizeQuote() and
// quote parsing are NOT exercised here.
//
// Run: npx vitest run tests/watchlist-add-flow.spec.js

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

const QUOTES = {
  AAPL: { symbol: 'AAPL', name: 'Apple Inc.', price: 227.5, currency: 'USD', exchange: 'NASDAQ', type: 'stock' },
  GME: { symbol: 'GME', name: 'GameStop Corp.', price: 21.1, currency: 'USD', exchange: 'NYSE', type: 'stock' },
};

function mockApi() {
  return {
    async searchTickers(query) {
      const q = String(query || '').toUpperCase();
      return Object.keys(QUOTES)
        .filter(sym => sym.includes(q))
        .map(sym => ({ symbol: sym, name: QUOTES[sym].name }));
    },
    async getQuote(symbol) {
      const quote = QUOTES[String(symbol || '').toUpperCase()];
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return { ...quote };
    },
  };
}

async function makeAssets() {
  const { AssetsController } = await import('../assets.js');
  return new AssetsController(mockApi());
}

// Mirrors app.js wireConfirmModal's confirm handler: reads the pending asset
// off the controller and hands it to addAsset().
async function confirmAdd(assets) {
  const asset = assets._pendingAsset;
  if (!asset) return false;
  const ok = await assets.addAsset(asset);
  if (assets._pendingAsset === asset) assets._pendingAsset = null;
  return ok;
}

// Search → select (promptAdd sets _pendingAsset) → confirm (addAsset).
async function searchSelectAdd(assets, query) {
  const results = await assets.api.searchTickers(query);
  expect(results.length).toBeGreaterThan(0);
  const selected = results[0]; // user picks the first result row
  await assets.promptAdd(selected.symbol);
  expect(assets._pendingAsset).toBeTruthy();
  return confirmAdd(assets);
}

const symbols = wl => wl.map(a => a.symbol);

describe('Add to Watchlist flow (_pendingAsset wiring)', () => {
  let assets;

  beforeEach(async () => {
    localStorage.clear();
    // Fresh module instance per test so watchlist state never leaks.
    const mod = await import('../assets.js');
    assets = new mod.AssetsController(mockApi());
  });

  it('adds AAPL once: exactly one AAPL entry in the watchlist', async () => {
    const ok = await searchSelectAdd(assets, 'AAPL');
    expect(ok).toBe(true);
    expect(assets._pendingAsset).toBeNull();

    const wl = assets.getWatchlist();
    expect(wl.length).toBe(1);
    expect(symbols(wl).filter(s => s === 'AAPL').length).toBe(1);
    expect(assets.getAsset('aapl')).toBeTruthy(); // case-insensitive lookup
  });

  it('repeat-add of AAPL does not create a duplicate', async () => {
    await searchSelectAdd(assets, 'AAPL');
    // Second full flow for the same symbol must be rejected by addAsset.
    const okAgain = await searchSelectAdd(assets, 'AAPL');
    expect(okAgain).toBe(false);

    const wl = assets.getWatchlist();
    expect(wl.length).toBe(1);
    expect(symbols(wl).filter(s => s === 'AAPL').length).toBe(1);
  });

  it('adding GME yields a watchlist containing both AAPL and GME', async () => {
    await searchSelectAdd(assets, 'AAPL');
    const okGme = await searchSelectAdd(assets, 'GME');
    expect(okGme).toBe(true);

    const wl = assets.getWatchlist();
    expect(wl.length).toBe(2);
    expect(symbols(wl)).toEqual(expect.arrayContaining(['AAPL', 'GME']));
    // And persisted through the real storage layer.
    const stored = JSON.parse(
      localStorage.getItem('market-intelligence:watchlist') || '[]'
    );
    expect(symbols(stored)).toEqual(expect.arrayContaining(['AAPL', 'GME']));
  });
});
