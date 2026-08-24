// tests/sports-credentials.test.mjs — sports-credentials.js facade.
//
// OFFLINE: storage.js is stubbed via vi.doMock; a fake globalThis.Capacitor
// exercises the native branch with an in-memory Preferences stub.
// Sentinel keys only — never a real credential.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ODDS_SENTINEL = 'test-sentinel-key-abc123';
const SERP_SENTINEL = 'test-sentinel-serp-xyz789';

function makePrefsBackend() {
  const mem = new Map();
  return {
    backend: mem,
    Preferences: {
      get: async ({ key }) => ({ value: mem.has(key) ? mem.get(key) : null }),
      set: async ({ key, value }) => { mem.set(key, value); },
      remove: async ({ key }) => { mem.delete(key); },
    },
  };
}

async function importModule({ native = false } = {}) {
  const prefs = makePrefsBackend();
  if (native) {
    globalThis.Capacitor = { isNativePlatform: () => true };
    vi.doMock('@capacitor/preferences', () => ({ Preferences: prefs.Preferences }));
  }
  const store = new Map();
  vi.doMock('../storage.js', () => ({
    storage: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => { store.set(k, v); return true; },
      remove: (k) => store.delete(k),
    },
  }));
  const mod = await import('../sports-credentials.js');
  return { mod, prefs, store };
}

let logCalls;
beforeEach(() => {
  delete globalThis.Capacitor;
  vi.resetModules();
  logCalls = [];
  const spy = (...args) => logCalls.push(args.map(String).join(' '));
  vi.spyOn(console, 'warn').mockImplementation(spy);
  vi.spyOn(console, 'error').mockImplementation(spy);
  vi.spyOn(console, 'info').mockImplementation(spy);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.Capacitor;
});

describe('sports-credentials — web fallback branch', () => {
  it('get/set/clear odds key via namespaced storage', async () => {
    const { mod, store } = await importModule();
    expect(await mod.getOddsApiKey()).toBe('');
    expect(await mod.setOddsApiKey(ODDS_SENTINEL)).toBe(true);
    expect(store.get('odds-api-key')).toBe(ODDS_SENTINEL);
    expect(await mod.getOddsApiKey()).toBe(ODDS_SENTINEL);
    expect(await mod.hasOddsCredential()).toBe(true);
    await mod.clearOddsApiKey();
    expect(await mod.getOddsApiKey()).toBe('');
    expect(await mod.hasOddsCredential()).toBe(false);
  });

  it('serp key is independent of the odds key (no cross-talk)', async () => {
    const { mod } = await importModule();
    await mod.setSerpApiKey(SERP_SENTINEL);
    expect(await mod.getSerpApiKey()).toBe(SERP_SENTINEL);
    expect(await mod.getOddsApiKey()).toBe('');
    await mod.setOddsApiKey(ODDS_SENTINEL);
    expect(await mod.getSerpApiKey()).toBe(SERP_SENTINEL);
    await mod.clearSerpApiKey();
    expect(await mod.getOddsApiKey()).toBe(ODDS_SENTINEL);
  });

  it('empty set is a no-op and never deletes a stored key', async () => {
    const { mod } = await importModule();
    await mod.setOddsApiKey(ODDS_SENTINEL);
    expect(await mod.setOddsApiKey('')).toBe(false);
    expect(await mod.getOddsApiKey()).toBe(ODDS_SENTINEL);
  });
});

describe('sports-credentials — native branch', () => {
  it('reads/writes Capacitor Preferences and mirrors to web fallback', async () => {
    const { mod, prefs, store } = await importModule({ native: true });
    await mod.setSerpApiKey(SERP_SENTINEL);
    expect(prefs.backend.get('serp_api_key')).toBe(SERP_SENTINEL);
    expect(store.get('serp-api-key')).toBe(SERP_SENTINEL);
    expect(await mod.getSerpApiKey()).toBe(SERP_SENTINEL);
    await mod.clearOddsApiKey();
    await mod.clearSerpApiKey();
    expect(prefs.backend.size).toBe(0);
  });

  it('Preferences failure resolves empty/false without rejecting or leaking keys', async () => {
    globalThis.Capacitor = { isNativePlatform: () => true };
    vi.doMock('@capacitor/preferences', () => ({
      Preferences: {
        get: async () => { throw new Error('prefs boom'); },
        set: async () => { throw new Error('prefs boom'); },
      },
    }));
    const store = new Map();
    vi.doMock('../storage.js', () => ({
      storage: { get: () => null, set: () => true, remove: () => true },
    }));
    const mod = await import('../sports-credentials.js');
    // Preferences failure degrades to the web-fallback write (never rejects).
    await expect(mod.setOddsApiKey(ODDS_SENTINEL)).resolves.not.toThrow();
    await expect(mod.hasOddsCredential()).resolves.toBeTypeOf('boolean');
    // No logged string may contain the sentinel value.
    const allLogs = logCalls.join('\n');
    expect(allLogs.includes(ODDS_SENTINEL)).toBe(false);
  });
});
