// tests/watchlist-selector-sync.test.mjs — regression test for the Watchlist →
// RUN REAL VALIDATION selector sync bug (scout findings a479f4ea).
//
// Root cause: app.js subscribed to 'watchlist:changed' via the DOM helper
// on(target, event, handler) with only two args, so NOTHING registered and
// the validation ticker selector only re-rendered at boot / panel open.
// After adding a ticker on the Watchlist screen, navigating to Charts did
// NOT show it in the selector until the panel was re-opened.
//
// Fix under test: app.js subscribes through the real event bus
// (bus.on('watchlist:changed', ...) from utils.js) during wireRealValidation(),
// so renderRvTickerOptions() re-runs whenever the watchlist changes.
//
// These tests drive the REAL module graph (app.js boots against jsdom) and
// the REAL AssetsController.addAsset/removeAsset path — no hardcoded ticker
// list beyond fixtures, no network (fetch is stubbed), no history fetch.
//
// Run: npx vitest run tests/watchlist-selector-sync.test.mjs

// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { bus } from '../utils.js';

let assetsInstance = null;
let addAssetOriginal = null;

async function bootApp(seedWatchlist) {
  // Stub every network touch so boot is fully offline/hermetic.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline test'));
  try {
    localStorage.setItem('market-intelligence:watchlist', JSON.stringify(seedWatchlist));
    // Capture the app's internal AssetsController instance by wrapping
    // addAsset BEFORE app.js boots (module import side effect).
    const { AssetsController } = await import('../assets.js');
    if (!addAssetOriginal) {
      addAssetOriginal = AssetsController.prototype.addAsset;
      // Capture the app's internal AssetsController instance at construction.
      const origBind = AssetsController.prototype._bindMarketData;
      AssetsController.prototype._bindMarketData = function () {
        assetsInstance = this;
        return origBind.call(this);
      };
    }
    await import('../app.js');
    // boot() is async; wait until wireRealValidation has rendered the initial
    // chips from the seeded watchlist.
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

function chips() {
  return [...document.querySelectorAll('#rv-tickers .rv-ticker')].map((b) => b.value);
}

function fixture(symbol) {
  return { id: symbol, symbol, name: symbol + ' Inc.', type: 'stock', exchange: 'X', currency: 'USD', quote: null, updatedAt: null };
}

beforeEach(() => {
  // Boot happens once in beforeAll with a seeded watchlist; tests below must
  // not wipe its storage state.
});

let booted = false;

describe('Watchlist → RUN REAL VALIDATION selector sync (bus wiring regression)', () => {
  beforeAll(async () => {
    document.body.innerHTML = `
      <main>
        <section id="screen-search" class="screen" hidden></section>
        <section id="screen-asset" class="screen" hidden>
          <button id="hist-analysis-btn"></button>
          <div id="hist-panel" hidden>
            <div id="rv-tickers" class="chip-row"></div>
            <div id="rv-results"></div>
            <div id="rv-error" hidden></div>
          </div>
        </section>
        <section id="screen-watchlist" class="screen" hidden>
          <div id="watchlist-grid"></div>
        </section>
        <section id="screen-settings" class="screen" hidden></section>
      </main>`;
    await bootApp([fixture('AAPL')]);
    booted = true;
  });

  it('boots and renders the selector from the live watchlist', () => {
    expect(booted).toBe(true);
    expect(chips()).toEqual(['AAPL']);
  });

  it('a ticker added on the watchlist appears in the selector IMMEDIATELY (no panel reopen, no navigation)', async () => {
    expect(assetsInstance).not.toBeNull();
    const ok = await assetsInstance.addAsset(fixture('PLTR'));
    expect(ok).toBe(true);
    // The bus subscription must have re-rendered synchronously on emit.
    expect(chips()).toContain('PLTR');
    expect(chips()).toEqual(['AAPL', 'PLTR']);
  });

  it('registers exactly ONE bus listener (no duplicate handlers → no duplicate chips)', async () => {
    const listeners = bus._listeners.get('watchlist:changed');
    expect(listeners).toBeDefined();
    expect(listeners.size).toBe(1); // only the app's renderRvTickerOptions handler
    // Repeated emits (e.g. several adds) must never duplicate chips.
    bus.emit('watchlist:changed', assetsInstance.getWatchlist());
    bus.emit('watchlist:changed', assetsInstance.getWatchlist());
    expect(chips()).toEqual(['AAPL', 'PLTR']);
  });

  it('removing a ticker is reflected in the selector immediately', async () => {
    const ok = assetsInstance.removeAsset('PLTR');
    expect(ok).toBe(true);
    expect(chips()).toEqual(['AAPL']);
    expect(chips()).not.toContain('PLTR');
  });
});
