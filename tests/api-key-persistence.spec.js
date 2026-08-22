// tests/api-key-persistence.spec.js — regression tests for the Settings-save
// API-key lifecycle bug.
//
// BUG (scout findings f8af86ec): wireSettings()'s submit handler used to call
// api.setConfig(newCfg) with apiKey:'' BEFORE awaiting getApiKey(). If that
// read failed or returned '', the live TickerbotAPI singleton stayed keyless
// and every Watchlist/Search request went out unauthenticated — even though
// the persisted secure store was intact.
//
// These tests drive the REAL app.js boot + settings form inside jsdom and
// must FAIL against the old call order and PASS after the
// "compute effectiveKey first, setConfig exactly once" fix.
//
// TEST SENTINELS only — never a real key.
//
// Run: npx vitest run tests/api-key-persistence.spec.js

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SENTINEL = 'test-sentinel-key-abc123';
const BASE = 'https://tickerbot.example.test';

let setConfigCalls;
let liveApi;

function spyTickerbotAPI() {
  return import('../api.js').then(({ TickerbotAPI }) => {
    const realSetConfig = TickerbotAPI.prototype.setConfig;
    setConfigCalls = [];
    liveApi = null;
    TickerbotAPI.prototype.setConfig = function (cfg) {
      setConfigCalls.push(cfg);
      liveApi = this;
      return realSetConfig.call(this, cfg);
    };
  });
}

async function importSecureStoreWithFlakyReads(flakyControl) {
  const actual = await import('../secure-store.js');
  // vi.doMock applies to subsequent dynamic imports of app.js.
  await Promise.resolve();
  const { vi } = await import('vitest');
  vi.doMock('../secure-store.js', () => ({
    ...actual,
    getApiKey: async (...args) => {
      if (flakyControl && flakyControl.armed) {
        flakyControl.armed = false; // fail exactly one read, then succeed
        return ''; // transient read failure — resolves '' like the real one
      }
      return actual.getApiKey(...args);
    },
    migrateLegacyApiKey: actual.migrateLegacyApiKey,
    setApiKey: actual.setApiKey,
    clearApiKey: actual.clearApiKey,
  }));
}

async function bootApp({ flakyControl = null } = {}) {
  await spyTickerbotAPI();
  if (flakyControl) await importSecureStoreWithFlakyReads(flakyControl);
  await import('../app.js'); // boots immediately (document.readyState != 'loading')
  // Wait for boot() phase-2 to construct the singleton.
  for (let i = 0; i < 100 && !liveApi; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(liveApi).toBeTruthy();
}

function mountSettingsDom() {
  document.body.innerHTML = `
    <div id="global-status"></div>
    <div id="global-banner"></div>
    <section id="screen-settings" class="screen">
      <form id="settings-form" novalidate>
        <input name="baseURL" type="url" value="${BASE}" />
        <input name="apiKey" type="password" value="" />
        <input name="apiVersion" type="text" value="" />
        <input name="stockEndpoint" type="text" value="" />
        <input name="cryptoEndpoint" type="text" value="" />
        <input name="wsEndpoint" type="text" value="" />
        <select name="pollInterval"><option value="30" selected>30</option></select>
        <input type="checkbox" name="capabilitiesSearch" checked />
        <button type="submit">Save</button>
      </form>
      <div id="settings-status-banner" hidden></div>
      <div id="api-key-saved" hidden></div>
      <div id="settings-onboarding"></div>
    </section>
    <section id="screen-watchlist" class="screen" hidden></section>
    <section id="screen-search" class="screen" hidden></section>
    <nav>
      <a class="nav-item" href="#/watchlist">Watchlist</a>
      <a class="nav-item" href="#/search">Search</a>
      <a class="nav-item" href="#/settings">Settings</a>
    </nav>`;
}

async function submitSettingsForm() {
  const form = document.getElementById('settings-form');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  // Handler is async; yield long enough for setApiKey/getApiKey to settle.
  await new Promise((r) => setTimeout(r, 50));
}

async function navigate(hash) {
  window.location.hash = hash;
  await new Promise((r) => setTimeout(r, 20));
}

describe('Settings save must never leave the live TickerbotAPI keyless', () => {
  beforeEach(() => {
    localStorage.clear();
    mountSettingsDom();
  });

  afterEach(async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doUnmock('../secure-store.js');
    localStorage.clear();
  });

  it('saving a fresh key: runtime client gets the sentinel exactly once, persisted store intact, navigation does not lose it', async () => {
    await bootApp();
    setConfigCalls.length = 0;

    // User types the sentinel key into Settings and saves.
    document.querySelector('[name="apiKey"]').value = SENTINEL;
    await submitSettingsForm();

    // No setConfig call may ever carry an empty key (old code pushed a
    // keyless newCfg FIRST — that is the regression this guards).
    expect(setConfigCalls.filter((c) => !c.apiKey)).toEqual([]);

    // Exactly ONE setConfig carries the sentinel (merged config pushed once).
    expect(setConfigCalls.filter((c) => c.apiKey === SENTINEL).length).toBe(1);

    // Simulate navigation: Watchlist mounts, Search mounts, back to Settings.
    await navigate('#/watchlist');
    await navigate('#/search');
    await navigate('#/settings');

    // Runtime client still holds the sentinel after navigation.
    expect(liveApi.getConfig().apiKey).toBe(SENTINEL);

    // Persisted secure store intact (web fallback namespaced key)…
    const { storage } = await import('../storage.js');
    expect(storage.get('apikey')).toBe(SENTINEL);
    // …and the key NEVER leaked into the localStorage config blob.
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().apiKey).toBe('');
  });

  it('re-saving settings WITHOUT retyping the key preserves it even when getApiKey transiently fails once then succeeds', async () => {
    // Arm the flaky-read mock up-front; it stays inert until we trip it below.
    const flaky = { armed: false };
    await bootApp({ flakyControl: flaky });
    setConfigCalls.length = 0;

    // First save: user types the sentinel.
    document.querySelector('[name="apiKey"]').value = SENTINEL;
    await submitSettingsForm();
    expect(liveApi.getConfig().apiKey).toBe(SENTINEL);

    // Second save: field left BLANK (user did NOT retype), and getApiKey
    // transiently fails once (returns '') before succeeding.
    document.querySelector('[name="apiKey"]').value = '';
    flaky.armed = true;
    setConfigCalls.length = 0;

    await submitSettingsForm();

    expect(setConfigCalls.filter((c) => !c.apiKey)).toEqual([]);
    expect(liveApi.getConfig().apiKey).toBe(SENTINEL);

    // Persisted store untouched throughout.
    const { storage } = await import('../storage.js');
    expect(storage.get('apikey')).toBe(SENTINEL);
  });
});
