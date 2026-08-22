// secure-store.js — Runtime-only storage facade for the Tickerbot API key.
//
// HARD CONSTRAINT: the API key is never hardcoded, faked, or bundled. The user
// enters it once in Settings after install; it lives only on their device:
//   - Capacitor native shell → @capacitor/preferences (on-device secure store)
//   - plain web (dev / no native bridge) → dedicated namespaced key in the
//     existing storage.js wrapper (`market-intelligence:apikey`). This is a
//     convenience fallback ONLY — no fake encryption layer is invented here.
//
// Every method resolves (never rejects) past its caller, logs failures via
// logger WITHOUT ever logging the key value, and returns '' / false on error.
import { storage } from './storage.js';
import { logger } from './utils.js';

const PREFS_KEY = 'tickerbot_api_key';

// Same native-runtime detection as api.js (kept local to avoid a new coupling;
// api.js's copy is not exported and both are trivially small).
function isNativeRuntime() {
  return !!(
    globalThis.Capacitor &&
    typeof globalThis.Capacitor.isNativePlatform === 'function' &&
    globalThis.Capacitor.isNativePlatform()
  );
}

// Lazily load @capacitor/preferences. Returns null when the plugin is not
// installed/reachable (plain web dev) so callers fall back to storage.js.
async function preferencesPlugin() {
  try {
    const mod = await import('@capacitor/preferences');
    return mod.Preferences || null;
  } catch {
    return null; // plugin unavailable — non-native or not installed
  }
}

export async function getApiKey() {
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) {
        const { value } = await Preferences.get({ key: PREFS_KEY });
        if (typeof value === 'string' && value) return value;
      }
    } catch (err) {
      logger.warn('[SecureStore] Preferences.get failed:', err && err.message);
      // fall through to web fallback rather than throwing
    }
  }
  // Web fallback: dedicated namespaced key, separate from the config blob.
  const v = storage.get('apikey');
  return typeof v === 'string' ? v : '';
}

export async function setApiKey(keyValue) {
  const value = typeof keyValue === 'string' ? keyValue.trim() : '';
  // Overwrite guard: an empty/undefined value must NEVER delete the stored
  // key (the destructive path is the explicit clearApiKey(), called only by
  // the Settings remove-key button). Callers that pass '' (e.g. a blank form
  // field or a boot-time default) are no-ops so a transient empty write can
  // never wipe a persisted key. Logs presence only, never the value.
  if (!value) {
    logger.warn('[SecureStore] setApiKey ignored: empty value (no overwrite; use clearApiKey to remove)');
    return false;
  }
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) {
        await Preferences.set({ key: PREFS_KEY, value });
        // Mirror into the web fallback too so a later transient Preferences
        // failure cannot make a persisted key invisible (store mismatch).
        try { storage.set('apikey', value); } catch { /* best-effort mirror */ }
        return true;
      }
    } catch (err) {
      logger.warn('[SecureStore] Preferences.set failed:', err && err.message);
    }
  }
  // Web fallback.
  return storage.set('apikey', value);
}

export async function clearApiKey() {
  let okNative = true;
  if (isNativeRuntime()) {
    try {
      const Preferences = await preferencesPlugin();
      if (Preferences) await Preferences.remove({ key: PREFS_KEY });
    } catch (err) {
      logger.warn('[SecureStore] Preferences.remove failed:', err && err.message);
      okNative = false;
    }
  }
  const okWeb = storage.remove('apikey');
  return okNative && okWeb !== false;
}

// One-time migration: older builds persisted `config.apiKey` inside the
// plaintext localStorage blob (`market-intelligence:config`). Move any legacy
// key into the secure store and rewrite the stored config with apiKey: ''
// so no readable copy remains. Resolves true when a migration happened.
export async function migrateLegacyApiKey() {
  try {
    const stored = storage.get('config');
    const legacyKey = stored && typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
    if (!legacyKey) return false;
    await setApiKey(legacyKey);
    storage.set('config', { ...stored, apiKey: '' }); // strip plaintext copy
    logger.info('[SecureStore] migrated legacy API key out of plaintext config');
    return true;
  } catch (err) {
    logger.warn('[SecureStore] legacy migration failed:', err && err.message);
    return false;
  }
}
