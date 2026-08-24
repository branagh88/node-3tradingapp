// sports-credentials.js — Runtime-only storage facade for the two EDGE
// sports-analysis credentials (The Odds API key + SerpAPI key).
//
// HARD CONSTRAINT (same as secure-store.js): keys are never hardcoded, faked,
// or bundled. The user enters them once in Settings; they live only on their
// device:
//   - Capacitor native shell → @capacitor/preferences (on-device secure store)
//   - plain web (dev / no native bridge) → dedicated namespaced keys in the
//     existing storage.js wrapper (`market-intelligence:odds-api-key` and
//     `market-intelligence:serp-api-key`). Convenience fallback ONLY.
//
// Every method resolves (never rejects) past its caller, logs failures via
// logger WITHOUT ever logging a key value, and returns '' / false on error.
// secure-store.js itself is untouched — its tiny helpers are duplicated here
// locally, exactly the way secure-store.js duplicates them from api.js.
import { storage } from './storage.js';
import { logger } from './utils.js';

const ODDS_PREFS_KEY = 'odds_api_key';
const SERP_PREFS_KEY = 'serp_api_key';
const ODDS_STORAGE_KEY = 'odds-api-key'; // → market-intelligence:odds-api-key
const SERP_STORAGE_KEY = 'serp-api-key'; // → market-intelligence:serp-api-key

// Same native-runtime detection as secure-store.js / api.js (kept local to
// avoid new coupling; each copy is trivially small).
function isNativeRuntime() {
  return !!(
    globalThis.Capacitor &&
    typeof globalThis.Capacitor.isNativePlatform === 'function' &&
    globalThis.Capacitor.isNativePlatform()
  );
}

async function preferencesPlugin() {
  try {
    const mod = await import('@capacitor/preferences');
    return mod.Preferences || null;
  } catch {
    return null; // plugin unavailable — non-native or not installed
  }
}

async function getKey(prefsKey, storageKey, label) {
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) {
        const { value } = await Preferences.get({ key: prefsKey });
        if (typeof value === 'string' && value) return value;
      }
    } catch (err) {
      logger.warn(`[SportsCredentials] ${label} Preferences.get failed:`, err && err.message);
      // fall through to web fallback rather than throwing
    }
  }
  const v = storage.get(storageKey);
  return typeof v === 'string' ? v : '';
}

async function setKey(prefsKey, storageKey, value, label) {
  const v = typeof value === 'string' ? value.trim() : '';
  // Overwrite guard: an empty value must NEVER delete a stored key. Use the
  // explicit clear* function (Settings remove buttons) for that.
  if (!v) {
    logger.warn(`[SportsCredentials] ${label} set ignored: empty value (no overwrite; use the clear function to remove)`);
    return false;
  }
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) {
        await Preferences.set({ key: prefsKey, value: v });
        try { storage.set(storageKey, v); } catch { /* best-effort mirror */ }
        return true;
      }
    } catch (err) {
      logger.warn(`[SportsCredentials] ${label} Preferences.set failed:`, err && err.message);
    }
  }
  return storage.set(storageKey, v);
}

async function clearKey(prefsKey, storageKey, label) {
  let okNative = true;
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) await Preferences.remove({ key: prefsKey });
    } catch (err) {
      logger.warn(`[SportsCredentials] ${label} Preferences.remove failed:`, err && err.message);
      okNative = false;
    }
  }
  const okWeb = storage.remove(storageKey);
  return okNative && okWeb !== false;
}

// ── The Odds API ──
export async function getOddsApiKey() {
  return getKey(ODDS_PREFS_KEY, ODDS_STORAGE_KEY, 'OddsApiKey');
}
export async function setOddsApiKey(keyValue) {
  return setKey(ODDS_PREFS_KEY, ODDS_STORAGE_KEY, keyValue, 'OddsApiKey');
}
export async function clearOddsApiKey() {
  return clearKey(ODDS_PREFS_KEY, ODDS_STORAGE_KEY, 'OddsApiKey');
}

// ── SerpAPI ──
export async function getSerpApiKey() {
  return getKey(SERP_PREFS_KEY, SERP_STORAGE_KEY, 'SerpApiKey');
}
export async function setSerpApiKey(keyValue) {
  return setKey(SERP_PREFS_KEY, SERP_STORAGE_KEY, keyValue, 'SerpApiKey');
}
export async function clearSerpApiKey() {
  return clearKey(SERP_PREFS_KEY, SERP_STORAGE_KEY, 'SerpApiKey');
}

// Presence checks — resolve true/false, never reject.
export async function hasOddsCredential() {
  try { return !!(await getOddsApiKey()); } catch { return false; }
}
export async function hasSerpCredential() {
  try { return !!(await getSerpApiKey()); } catch { return false; }
}
