# Plan: Diagnostic-Only Tickerbot Panel (Settings screen)

Repo: `node-3tradingapp` (market-intelligence-phase1) — vanilla ES modules,
**no bundler/Vite**; `www/` is Capacitor's webDir, refreshed by `npm run build`.

## 0. Ground truth you must know before coding

Most of this feature ALREADY EXISTS at HEAD (commits `128d5d1`, `b6c0643`).
Your job is to **close the small remaining gaps**, keep root files and `www/`
mirrors in sync, then run the full verification chain and rebuild + verify the
APK. Read these before editing:

- `app.js` lines ~233–430 — `fillSettingsForm()`, `testConnection()` incl. the
  existing TEMP-DIAGNOSTIC panel (`diagPanel`) and stage trace.
- `api.js` — `_doFetch()` (~line 189–376, `_diagCapture`/`_diagLast` raw-text
  capture, redacted logging), `getTickerQuoteDiagnostic()` (~line 422),
  `normalizeQuote()` (~line 565).
- `build-check.mjs` — the **build-id injection mechanism**: it runs
  `git rev-parse --short HEAD` and writes `build-info.js` (`BUILD_INFO =
  { commit, builtAt }`) into BOTH repo root and `www/`, then mirrors
  `app.js`, `index.html`, `style.css` + all modules into `www/`. There is no
  Vite; this generated-file mechanism IS how the build stamp is injected. Do
  not invent a second one.
- `index.html` ~line 160–172 — Settings actions block with the existing
  `testSymbol` input and `<p id="settings-build">`.
- `android/local.properties` — `sdk.dir=/opt/mesh-viewer-data/toolchains/android-sdk`;
  JDKs live at `/opt/mesh-viewer-data/toolchains/jdk-17.0.20+8` and
  `jdk-21.0.12+8` (export `JAVA_HOME` to one of them for gradle).

### Hard constraints (do NOT touch)
- `normalizeQuote()` in `api.js` — read-only.
- Endpoint resolution, auth headers, API-key storage (`secure-store.js`,
  `config.js` key paths), ticker search, artifact gates, everything under
  `adws/`.
- Never log or display: the API key, `Authorization` header, bearer token,
  cookies. Existing code already prints `'Bearer <redacted>'` — preserve that.

## 1. Changes

### 1.1 Settings build identifier — `app.js` (only file needed)
In `fillSettingsForm()` (~line 246) the element `#settings-build` is filled
with `` `Build: ${BUILD_INFO.commit} (${BUILD_INFO.builtAt})` ``.

Change the label to exactly:
```
Diagnostic Build: ${BUILD_INFO.commit}
```
(keep or drop the timestamp suffix — the required prefix is
`Diagnostic Build: <hash>`). The hash comes from the REAL git commit because
`build-check.mjs` regenerates `build-info.js` from `git rev-parse --short HEAD`
on every `npm run build`. No other file changes for requirement (1).

### 1.2 Diagnostic panel gap-fill — `app.js` `testConnection()`
The panel below the Test Connection result already renders: HTTP status,
requested symbol, returned symbol, response JS type, top-level keys,
price exists/typeof with value REDACTED, metrics probes, and the 6-stage trace
(RAW RESPONSE → PARSED JSON → NORMALIZE INPUT → NORMALIZED QUOTE → UI MODEL →
DISPLAYED). Two gaps vs. spec:

a. **API Key presence line** — the panel has no `API Key: CONFIGURED/MISSING`.
   Add it as the first line of `diagPanel`. `testConnection()` already holds
   `apiKey` (typed input or securely stored fallback); render ONLY presence:
   `API key: ${apiKey ? 'CONFIGURED' : 'MISSING'}` — never the value.

b. **Credential-free final URL guard** — `debug.url` (= `meta.url` =
   `safeUrl` = the full request URL) is rendered as "Endpoint:". The key
   travels only in the `Authorization` header so the URL is clean today, but
   add a cheap defense-in-depth helper in `app.js` (top-level util near
   `esc()`), e.g. `redactUrl(url)`: parse the URL and replace values of any
   query param named `api_key|apikey|key|token|access_token|password` with
   `REDACTED`. Use its output everywhere the panel renders an endpoint/URL.
   Do NOT modify `_doFetch` or `api.js`.

Everything else in the panel already satisfies the spec — leave the stage
trace, REDACTED price handling, normalized-price line, and error/success
branches as they are.

### 1.3 Optional configurable test symbol — NO WORK
Already implemented: `index.html` has the `name="testSymbol"` input
(default AAPL, not persisted) and `testConnection()` reads it with AAPL
fallback. Skip unless trivially broken.

### 1.4 Keep `www/` in sync — automatic
Do not hand-edit `www/*`. `npm run build` regenerates `www/build-info.js` and
re-copies every web source. Just remember root `app.js`/`index.html` are the
sources of truth.

### 1.5 Optional (nice-to-have, skip if it drags)
Extend `tests/boot-harness.mjs` settings consumer to assert the string
`Diagnostic Build:` appears in `#settings-build` after boot, so the stamp can
never silently regress. Pure addition, no behavior risk.

## 2. Explicitly out of scope
No new API client (the diagnostic rides the EXISTING `TickerbotAPI` instance
created inside `testConnection()` via `getTickerQuoteDiagnostic()`), no
changes to `normalizeQuote()`, endpoints, auth, key storage, search, gates,
or `adws/`.

## 3. Verification chain (run in order, stop on first failure)

1. `npm run build` — syntax-validates all ES modules AND stamps
   `build-info.js` with the current short commit hash into `./` and `./www/`
   AND mirrors sources into `www/`. Confirm output line
   `build-info: commit <hash>` matches `git rev-parse --short HEAD`.
2. `npm run smoke` — offline fixture tests (indicators, normalization, config).
3. `npm run test:boot` — jsdom boot harness incl. router-to-settings,
   secure key save, and the testConnection price-render consumer.
4. Capacitor sync: `npx cap sync android` (copies fresh `www/` into
   `android/app/src/main/assets/public`).
5. APK build via the studio Capacitor/android-developer method:
   ```bash
   export JAVA_HOME=/opt/mesh-viewer-data/toolchains/jdk-21.0.12+8
   cd android && ./gradlew assembleDebug && cd ..
   ```
   SDK comes from `android/local.properties`
   (`/opt/mesh-viewer-data/toolchains/android-sdk`). Then refresh the
   deliverable copy: `cp android/app/build/outputs/apk/debug/app-debug.apk
   apk/market-intelligence-debug.apk` (existing convention).
6. APK artifact verification using the repaired gate system from commit
   `0e07724`: the envelope must declare `apk_built=true` plus the REAL
   `apk_path`, truthful `apk_size_bytes`, `apk_timestamp`, captured
   `gradle_output`, `embedded_build_hash`, `verification`, and `www_entry`;
   `gates.artifacts_exist` + `gates.android_verified` then bind those claims
   to actual files (non-empty APK, size agreement). Concretely verify the
   stamp inside the binary:
   ```bash
   unzip -p apk/market-intelligence-debug.apk assets/public/build-info.js
   ```
   must print the SAME commit hash as step 1. Also confirm
   `android/app/src/main/assets/public/app.js` contains both
   `Diagnostic Build:` and the `API key:` panel line before syncing.

## 4. Acceptance checklist
- [ ] Settings screen shows `Diagnostic Build: <short-hash>` matching HEAD.
- [ ] Test Connection result shows the diagnostic panel beneath the existing
      outcome (success OR price-unavailable branch) with: API Key
      CONFIGURED/MISSING, requested symbol, credential-free final URL, HTTP
      status, response received/type/top-level keys, returned symbol, price
      FOUND/NOT FOUND + typeof, price value REDACTED, normalized price.
- [ ] 6-stage price trace visible (raw HTTP → parsed JSON → normalizer input
      → normalizer output → app quote state → UI display).
- [ ] No key/token/cookie/Authorization value ever appears in DOM or logs
      (grep your diff for the redaction markers staying intact).
- [ ] `npm run build`, `npm run smoke`, `npm run test:boot` all green.
- [ ] Fresh APK built, copied to `apk/`, and passes the 0e07724-style
      artifact verification with matching embedded build hash.
