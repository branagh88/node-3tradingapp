// tests/watchlist-sync-regression.test.mjs — Phase 10 regression lock for the
// event-driven Watchlist → selector sync (commit 48fa639) with BOTH compact
// multi-select instances present (validation + historical-data retrieval).
// Drives the REAL module graph (app.js boots against jsdom), real bus, real
// AssetsController. No network.

// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { bus } from '../utils.js';

let assetsInstance = null;
let addAssetOriginal = null;

async function bootApp(seedWatchlist) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline test'));
  try {
    localStorage.setItem('market-intelligence:watchlist', JSON.stringify(seedWatchlist));
    const { AssetsController } = await import('../assets.js');
    if (!addAssetOriginal) {
      addAssetOriginal = AssetsController.prototype.addAsset;
      const origBind = AssetsController.prototype._bindMarketData;
      AssetsController.prototype._bindMarketData = function () {
        assetsInstance = this;
        return origBind.call(this);
      };
    }
    await import('../app.js');
    await waitFor(() => document.querySelectorAll('#rv-tickers .rv-ticker').length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function waitFor(cond, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      let ok = false;
      try { ok = cond(); } catch { /* retry */ }
      if (ok) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 25);
    })();
  });
}

function chips(sel) {
  return [...document.querySelectorAll(`${sel || '#rv-tickers'} .rv-ticker`)].map((b) => b.value);
}

function fixture(symbol) {
  return { id: symbol, symbol, name: symbol + ' Inc.', type: 'stock', exchange: 'X', currency: 'USD', quote: null, updatedAt: null };
}

describe('Watchlist sync with both multi-select instances (Phase 10)', () => {
  beforeAll(async () => {
    document.body.innerHTML = `
      <main>
        <section id="screen-search" class="screen" hidden></section>
        <section id="screen-asset" class="screen" hidden>
          <button id="hist-analysis-btn"></button>
          <div id="hist-panel" hidden>
            <div class="ms-wrap">
              <button id="hd-ms-trigger" type="button" aria-expanded="false"><span class="ms-summary">Select tickers…</span></button>
              <div id="hd-ms-popover" class="ms-popover ms-box-sizing" hidden></div>
            </div>
            <div class="ms-wrap">
              <button id="rv-ms-trigger" type="button" aria-expanded="false"><span class="ms-summary">Select tickers…</span></button>
              <div id="rv-ms-popover" class="ms-popover ms-box-sizing" hidden></div>
            </div>
            <select id="rv-depth"><option value="1y" selected>1y</option></select>
            <input type="checkbox" id="rv-use-cache" checked>
            <button id="rv-run"></button>
            <div id="rv-estimate" hidden></div>
            <div id="hd-estimate" hidden></div>
            <button id="hd-fetch"></button>
            <div id="hd-progress" hidden></div>
            <div id="hd-status" class="rv-status" hidden></div>
            <div id="hd-error" hidden></div>
            <div id="rv-call-warning" hidden></div>
            <div id="rv-progress" hidden></div>
            <div id="rv-status" hidden></div>
            <div id="rv-error" hidden></div>
            <div id="rv-results"></div>
          </div>
        </section>
        <section id="screen-watchlist" class="screen" hidden><div id="watchlist-grid"></div></section>
        <section id="screen-settings" class="screen" hidden></section>
      </main>`;
    // Seed out of alphabetical order to assert sorting.
    await bootApp([fixture('MSFT'), fixture('AAPL')]);
  });

  it('boots and renders sorted chips in BOTH instances from the live watchlist', () => {
    expect(chips('#rv-tickers')).toEqual(['AAPL', 'MSFT']);
    expect(chips('#hd-tickers')).toEqual(['AAPL', 'MSFT']);
  });

  it('added ticker appears immediately in both lists, unchecked; checked state preserved across re-render', async () => {
    document.querySelector('#rv-tickers .rv-ticker[value="AAPL"]').checked = true;
    document.querySelector('#hd-tickers .rv-ticker[value="MSFT"]').checked = true;
    const ok = await assetsInstance.addAsset(fixture('PLTR'));
    expect(ok).toBe(true);
    expect(chips('#rv-tickers')).toEqual(['AAPL', 'MSFT', 'PLTR']);
    expect(chips('#hd-tickers')).toEqual(['AAPL', 'MSFT', 'PLTR']);
    // Prior selections survived the re-render.
    expect(document.querySelector('#rv-tickers .rv-ticker[value="AAPL"]').checked).toBe(true);
    expect(document.querySelector('#rv-tickers .rv-ticker[value="MSFT"]').checked).toBe(false);
    expect(document.querySelector('#hd-tickers .rv-ticker[value="MSFT"]').checked).toBe(true);
    expect(document.querySelector('#hd-tickers .rv-ticker[value="PLTR"]').checked).toBe(false);
  });

  it('registers exactly ONE watchlist:changed bus listener (no duplicate handlers)', () => {
    const listeners = bus._listeners.get('watchlist:changed');
    expect(listeners).toBeDefined();
    expect(listeners.size).toBe(1);
  });

  it('removing a ticker is reflected in both lists immediately', () => {
    const ok = assetsInstance.removeAsset('PLTR');
    expect(ok).toBe(true);
    expect(chips('#rv-tickers')).toEqual(['AAPL', 'MSFT']);
    expect(chips('#hd-tickers')).toEqual(['AAPL', 'MSFT']);
  });

  it('empty watchlist renders the hint, not chips', () => {
    for (const s of ['AAPL', 'MSFT']) assetsInstance.removeAsset(s);
    expect(chips('#rv-tickers')).toEqual([]);
    expect(document.getElementById('rv-tickers').innerHTML).toContain('watchlist is empty');
    // Restore for any later assertions.
    assetsInstance.addAsset(fixture('AAPL'));
  });
});
