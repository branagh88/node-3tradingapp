# Plan — Runtime-Only Tickerbot API Key (Settings entry, secure on-device storage, graceful degradation)

Session: `3c97b56d`
Repo: `/opt/mesh-viewer-data/branagh88/projects/node-3tradingapp`

## Hard constraint (from operator)

The Tickerbot API key is **NOT available at development time**. It must never be
hardcoded, faked, committed, or requested from any agent/user during dev. The
app must:

1. Provide a Settings UI where the user enters their own Tickerbot API key after install.
2. Store it securely on-device (Capacitor Preferences / secure storage), not plaintext in the WebView's localStorage.
3. Attach it only to runtime requests made from the installed app.
4. Degrade gracefully when no key is set — a clear "API key not configured" state, never fabricated data, never a crash.

## Current state (grounded in the repo)

Already correct — do not regress these:

- `config.js` — `API_CONFIG.apiKey` ships as `''`, `baseURL` ships as the
  placeholder `'YOUR_API_BASE_URL'`. No key in source. `loadConfig()` merges
  saved config over defaults; `saveConfig()` persists via `storage.js`.
- `api.js` — `TickerbotAPI._doFetch()` adds `Authorization: Bearer <key>` at
  request time from `this.config.apiKey`; header value is redacted in all
  logging (`Bearer <redacted>`). Native shell routes through the Capacitor
  native HTTP plugin; browser origins through the same-origin proxy in
  `server.mjs`.
- `index.html` — Settings screen (`#settings-form`) already has an
  `apiKey` password input plus Test connection / Save buttons.
- `app.js` — `wireSettings()` saves the form; `fillSettingsForm()` populates
  it; Phase 4 of `boot()` shows `#settings-onboarding` and redirects to
  `#/settings` when `!isConfigured(config)`.

Gaps to close:

1. **Storage is plaintext localStorage.** `storage.js` keeps everything,
   including `config.apiKey`, under `market-intelligence:config` in
   localStorage — readable by anything in the WebView and not "secure
   on-device storage". No `@capacitor/preferences` (or similar) is installed
   (`package.json` deps: only `@capacitor-community/http`,
   `@capacitor/android`, `@capacitor/cli`, `@capacitor/core`).
2. **`isConfigured()` ignores the API key.** It only validates `baseURL`
   (`config.js`). An install with a base URL but no key counts as
   "configured": onboarding never shows, polling starts, and every request
   goes out unauthenticated → confusing 401s instead of a clear
   "API key not configured" state.
3. **Boot is synchronous.** `boot()` calls `loadConfig()` synchronously
   (Phase 1) before constructing `TickerbotAPI`. Moving the key to an async
   plugin store requires an awaited config-load step.
4. **No way to remove a key.** Settings can overwrite but not clear the key.

## Implementation tasks

### Task 1 — Secure key store module (`secure-store.js`, new file)

Create `secure-store.js` exporting an async key-value facade used ONLY for
the API key:

- `getApiKey(): Promise<string>` — empty string when unset.
- `setApiKey(key: string): Promise<boolean>`
- `clearApiKey(): Promise<boolean>`

Behavior:

- On the Capacitor native runtime (reuse the `isNativeRuntime()` pattern from
  `api.js` or move it to `utils.js` and import from both): use
  `@capacitor/preferences` (`Preferences.set/get/remove({ key:
  'tickerbot_api_key' })`). Add `@capacitor/preferences@^8` to
  `package.json` dependencies and run `npx cap sync android` so the plugin is
  registered (it should then appear alongside the HTTP plugin in
  `android/capacitor.plugins.json` after sync/build).
- On plain web (no native bridge): fall back to the existing `storage.js`
  wrapper under a dedicated namespaced key (e.g. `storage.get/set('apikey')`),
  clearly commented as the non-native fallback. Do NOT invent a fake
  encryption layer — the constraint is "not hardcoded, entered post-install";
  Preferences on native is the secure path, localStorage fallback keeps web
  dev working.
- All methods must catch plugin errors and resolve (never throw past the
  caller); log failures via `logger` without ever logging the key value.

### Task 2 — Migrate the key out of localStorage config

In `secure-store.js` (or a small helper called once during boot):

- One-time migration: if the legacy `storage.get('config').apiKey` is
  non-empty, write it to the secure store, then rewrite the stored config
  object with `apiKey: ''` so the plaintext copy is gone.
- `loadConfig()` in `config.js` stops returning a persisted `apiKey`
  entirely (always `''` from defaults); the runtime key comes only from
  `secure-store.getApiKey()`.

### Task 3 — Async boot config load (`app.js`)

- Convert `boot()` to `async function boot()` (its caller already just
  invokes it; verify the invocation site and keep error reporting behavior).
- Phase 1 becomes: `storage.migrate()` → `const config = loadConfig()` →
  `config.apiKey = await secureStore.getApiKey()` (each still individually
  guarded; on failure default to `''` and report via `reportBootError`).
- `TickerbotAPI` construction (Phase 2) happens after the key is merged, so
  `this.config.apiKey` remains the single runtime source the fetch path
  already reads. No changes needed inside `api.js`'s `_doFetch`.

### Task 4 — Key-aware configuration status (`config.js`)

- Add `hasApiKey(cfg)` (non-empty trimmed string).
- Introduce a three-state helper, e.g. `configStatus(cfg)` returning
  `'unconfigured'` (placeholder/no base URL), `'missing-key'` (valid base
  URL, no key), or `'ready'`.
- Keep `isConfigured()` semantics backward-compatible for the existing smoke
  contract OR update `tests/smoke.mjs` deliberately (see Task 7). Recommended:
  keep `isConfigured()` as-is (URL check) and let the UI/polling gate on
  `configStatus() === 'ready'`, so the offline smoke assertions about the
  placeholder defaults stay true.

### Task 5 — Settings UI updates (`index.html`, `app.js`, `style.css`)

- In `fillSettingsForm()`: populate the key input from the secure store
  (masked; show only presence, e.g. placeholder `•••• saved on this device`
  when set — never render the raw key back into the DOM unless the user is
  actively re-entering it; simplest compliant behavior: leave the field empty
  and show a "key saved" indicator line).
- Add a "Remove API key" ghost button next to Save that calls
  `clearApiKey()`, blanks the field, flips status to missing-key, and
  re-shows onboarding.
- Status banner on the Settings screen driven by `configStatus()`:
  - `unconfigured` → "No API base URL configured".
  - `missing-key` → prominent **"API key not configured — enter your
    Tickerbot API key to enable live data."**
  - `ready` → "Connected — key stored on this device."
- Update the hint under the API Key input: key is stored in device secure
  storage (native) / local app storage (web), never logged, never bundled.
- On save (`wireSettings`): call `setApiKey(elKey.value.trim())` when
  non-empty; persist the rest of the config via `saveConfig()` with
  `apiKey: ''` (key never enters the localStorage config blob again).
- Boot onboarding gate (Phase 4) switches from `!isConfigured(config)` to
  `configStatus(config) !== 'ready'` so a URL-without-key install also lands
  on Settings with the missing-key message.

### Task 6 — Graceful degradation at runtime

- `market-data.js` / charts / assets already render `UNAVAILABLE` /
  `NOT CONFIGURED` states and never fabricate prices — preserve that.
- Gate live polling: in `MarketData.start()` (or its caller in `app.js`
  Phase 6), skip auto-start when `configStatus() !== 'ready'`; emit a bus
  event or log explaining why (no key). When the user saves a valid key in
  Settings, start polling immediately (existing save flow already restarts
  behavior — verify and wire if needed).
- `api.js` request path: when `config.apiKey` is empty, requests may still be
  attempted by explicit user actions (e.g. Test connection) — that's fine;
  ensure the resulting `auth`-kind error surfaces the friendly
  "API key not configured / invalid" copy that `charts.js` already maps.
- Re-verify redaction: grep that no new log statement prints the key; keep
  all diagnostics printing `Bearer <redacted>`.

### Task 7 — Tests & verification

- `tests/smoke.mjs`: keep passing. If you change `isConfigured()` semantics,
  update its assertions explicitly; otherwise add assertions for
  `hasApiKey`/`configStatus` (placeholder → `unconfigured`; real URL + no key
  → `missing-key`; both → `ready`).
- `tests/boot-harness.mjs`: adapt to async boot (await boot completion or
  expose a ready promise) and assert the app boots with no key into the
  missing-key state without throwing.
- New guard test (can live in `tests/smoke.mjs` or `build-check.mjs`):
  scan shipped sources (`*.js`, `www/**` excluding vendored libs) for any
  string matching a plausible assigned key pattern — assert none exist, i.e.
  the build contains only the `''` default and placeholders.
- Commands: `npm run smoke`, `npm run test:boot`, `npm run build`, and
  `npm run dev` + manual browser pass:
  1. Fresh profile → onboarding redirect, "API key not configured" visible.
  2. Enter base URL only → still missing-key state, no polling started.
  3. Enter key → status ready, quotes flow, key absent from
     `localStorage['market-intelligence:config']`.
  4. Reload → key still effective (loaded from store).
  5. Remove key → back to missing-key, polling stops/unavailable states show.
- Android (if toolchain available): `npx cap sync android`, rebuild the APK
  per existing `justfile`/`scripts/patch-http-plugin-gradle.mjs` flow,
  confirm `@capacitor/preferences` appears in the plugins manifest and the
  on-device flow works (install → enter key → data flows; uninstall/reinstall
  clears it with Preferences default behavior).

## Out of scope / notes for the builder

- Do NOT introduce any `.env`-based or build-time key injection; `.env.sample`
  must stay free of real values. The key exists only on the user's device.
- Do NOT touch `server.mjs` proxying or the native HTTP plugin wiring beyond
  what's listed — they are orthogonal and currently working.
- SECURITY (flagged to operator, not part of this task's acceptance):
  `package.json` contains what looks like a live GitHub token embedded in
  `repository.url` (`gho_…`). This plan does not authorize editing it here,
  but the operator should rotate that credential and scrub it from history
  (see the studio `security-hygiene` skill).
- README/changelog updates documenting the new key flow are the builder's to
  include if the project conventions require them (planner may not edit those
  files).

## Acceptance criteria

1. Repo and built bundles contain no API key material (only `''`/placeholders).
2. Fresh install boots to a clear "API key not configured" state; no
  unauthenticated polling spam.
3. User-entered key persists across reloads via Capacitor Preferences on
  native (localStorage fallback on web) and is stripped from the legacy
  localStorage config blob.
4. Key is attached only at request time as a Bearer header and never logged.
5. Removing the key returns the app to the degraded state cleanly.
6. `npm run smoke`, `npm run test:boot`, `npm run build` all pass.
