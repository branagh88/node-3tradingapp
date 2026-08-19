// patch-http-plugin-gradle.mjs — makes @capacitor-community/http@1.4.1
// compile under Capacitor 8's AGP (Android Gradle Plugin 8.x).
//
// Background: @capacitor-community/http is a Capacitor 3-era plugin. Its
// Android library module (android/build.gradle) predates the AGP 8 `namespace`
// requirement, so a fresh `npm install` leaves the plugin's build.gradle
// WITHOUT a namespace and the Gradle build fails with:
//
//   Could not create an instance of type LibraryVariantBuilderImpl.
//   > Namespace not specified. Specify a namespace in the module's build file:
//     node_modules/@capacitor-community/http/android/build.gradle
//
// This postinstall script idempotently patches the vendored copy in
// node_modules (which is wiped on every npm install, hence a script rather
// than a one-off edit) by inserting the namespace taken from the plugin's own
// AndroidManifest package attribute (com.getcapacitor.http.http).
//
// It is a no-op if the file is already patched or the package is absent, so
// it is safe to run on the web-only build path and on the studio machine.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILE = path.join(
  ROOT,
  'node_modules/@capacitor-community/http/android/build.gradle',
);
const MANIFEST = path.join(
  ROOT,
  'node_modules/@capacitor-community/http/android/src/main/AndroidManifest.xml',
);

const NAMESPACE = 'com.getcapacitor.http.http';

function run() {
  if (!existsSync(FILE)) {
    console.log('[patch-http-plugin-gradle] plugin not installed — nothing to patch');
    return;
  }
  let gradle = readFileSync(FILE, 'utf8');
  if (gradle.includes('namespace "com.getcapacitor.http.http"')) {
    console.log('[patch-http-plugin-gradle] already patched — no-op');
    return;
  }
  const marker = "apply plugin: 'com.android.library'\n\nandroid {\n";
  if (!gradle.includes(marker)) {
    console.warn(
      '[patch-http-plugin-gradle] WARN: could not locate android block marker — plugin may have changed; manual patch required',
    );
    return;
  }
  gradle = gradle.replace(
    marker,
    `${marker}    namespace "${NAMESPACE}"\n`,
  );
  writeFileSync(FILE, gradle);
  console.log(`[patch-http-plugin-gradle] patched namespace into ${FILE}`);
  if (existsSync(MANIFEST)) {
    const manifest = readFileSync(MANIFEST, 'utf8');
    const m = manifest.match(/package="([^"]+)"/);
    console.log(
      m && m[1] !== NAMESPACE
        ? `[patch-http-plugin-gradle] WARN: manifest package "${m[1]}" differs from namespace; verify the android plugin's package`
        : '[patch-http-plugin-gradle] manifest package matches namespace',
    );
  }
}

run();

// ---------------------------------------------------------------------------
// Null-Pointer guard for the native Http.request path (root cause of the
// reported Android NullPointerException).
//
// @capacitor-community/http@1.4.1 native handler (HttpRequestHandler.request /
// CapacitorHttpUrlConnection.setRequestHeaders) calls params.keys() and
// headers.keys() with NO null check. When a request option object omits
// "params" and/or "headers" (the app's Http.request() passes no "params", and
// "data: undefined" is dropped by JSON serialization), the native
// call.getObject(...) returns null and the handler throws
//   NullPointerException: Cannot invoke "...JSObject.keys()" because "<parameter1>" is null
// BEFORE any HTTP response is produced. This is the exact NPE the APK leaks on
// device. The fix null-guards the two dereferences (defense in depth; the
// JS wrapper in www/vendor also normalizes the request object). Applied to the
// vendored copy in node_modules so it ships in the compiled APK, and re-applied
// idempotently on every npm install (this file runs via package.json postinstall).
// ---------------------------------------------------------------------------
function patchJavaNullGuards() {
  const HANDLER = path.join(
    ROOT,
    'node_modules/@capacitor-community/http/android/src/main/java/com/getcapacitor/plugin/http/HttpRequestHandler.java',
  );
  const CONN = path.join(
    ROOT,
    'node_modules/@capacitor-community/http/android/src/main/java/com/getcapacitor/plugin/http/CapacitorHttpUrlConnection.java',
  );

  const MARK = '// [patch-http-plugin-gradle] null-guard';

  let h = readFileSync(HANDLER, 'utf8');
  if (!h.includes(MARK)) {
    // Prefix before the FIRST setUrlParams((JSObject) ... boolean) declared
    // in the code, so the fake/shim and any overload are covered.
    const anchor = 'public HttpURLConnectionBuilder setUrlParams(JSObject params, boolean shouldEncode)';
    const idx = h.indexOf(anchor);
    if (idx === -1) {
      console.warn('[patch-http-plugin-gradle] WARN: setUrlParams(JSObject,boolean) anchor not found; Java null-guard SKIPPED');
    } else {
      const insert =
        '\n' +
        '        // [patch-http-plugin-gradle] NPE fix: the JS wrapper may legally omit params (JSON ' +
        'undefined drops on the bridge), and call.getObject("params") returns null; dereferencing ' +
        'params.keys() throws NullPointerException before any HTTP I/O. Treat null as "no params".\n' +
        '        if (params == null) {\n' +
        '            return this;\n' +
        '        }\n';
      // Insert right before the body's first statement (`String initialQuery = ...`).
      const bodyIdx = h.indexOf('String initialQuery =', idx);
      if (bodyIdx === -1) {
        console.warn('[patch-http-plugin-gradle] WARN: setUrlParams body anchor not found; Java null-guard SKIPPED');
      } else {
        h = h.slice(0, bodyIdx) + MARK + insert + h.slice(bodyIdx);
        writeFileSync(HANDLER, h);
        console.log('[patch-http-plugin-gradle] patched HttpRequestHandler.setUrlParams null-guard');
      }
    }
  } else {
    console.log('[patch-http-plugin-gradle] HttpRequestHandler null-guard already present — no-op');
  }

  let c = readFileSync(CONN, 'utf8');
  const CONN_MARK = '// [patch-http-plugin-gradle] NPE fix: the JS wrapper may legally omit headers;';
  if (!c.includes(MARK) && !c.includes(CONN_MARK)) {
    const anchor = 'public void setRequestHeaders(JSObject headers) {';
    const idx = c.indexOf(anchor);
    if (idx === -1) {
      console.warn('[patch-http-plugin-gradle] WARN: setRequestHeaders(JSObject) anchor not found; Java null-guard SKIPPED');
    } else {
      const bodyIdx = c.indexOf('Iterator<String> keys = headers.keys();', idx);
      if (bodyIdx === -1) {
        console.warn('[patch-http-plugin-gradle] WARN: setRequestHeaders body anchor not found; Java null-guard SKIPPED');
      } else {
        const guard =
          '        // [patch-http-plugin-gradle] NPE fix: the JS wrapper may legally omit headers; ' +
          'call.getObject("headers") returns null and headers.keys() throws NullPointerException. ' +
          'Treat null as an empty header set.\n' +
          '        if (headers == null) {\n' +
          '            headers = new JSObject();\n' +
          '        }\n';
        c = c.slice(0, bodyIdx) + guard + c.slice(bodyIdx);
        writeFileSync(CONN, c);
        console.log('[patch-http-plugin-gradle] patched CapacitorHttpUrlConnection.setRequestHeaders null-guard');
      }
    }
  } else {
    console.log('[patch-http-plugin-gradle] CapacitorHttpUrlConnection null-guard already present — no-op');
  }
}

patchJavaNullGuards();
