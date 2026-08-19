// http-plugin.src.mjs — SOURCE entry for the Capacitor HTTP plugin bundle.
//
// This is NOT part of the app's runtime module graph. It exists only as the
// esbuild entry that produces `./http-plugin.js` (the self-contained bundle
// the Capacitor www build actually imports). It re-exports the Http plugin so
// www/api.js can `import('./vendor/http-plugin.js')` and reach the native
// @capacitor-community/http implementation.
//
// Web build caveat: `@capacitor-community/http`'s own index.js dynamically
// imports its `./web` implementation (HTTPS implementation for browsers) and
// pulls in `@capacitor/core`. esbuild resolves those bare specifiers from
// node_modules and inlines everything into the single output file, so the
// resulting bundle has NO bare import specifiers and resolves cleanly inside
// the Capacitor WebView (which has no node_modules / no bare-specifier
// resolution).
//
// Regenerate with:
//   npx esbuild www/vendor/http-plugin.src.mjs --bundle --format=esm \
//     --platform=browser --target=es2020 --minify \
//     --outfile=www/vendor/http-plugin.js --sourcemap
import { Http as NativeHttp } from '@capacitor-community/http';

// ---- NPE fix (root cause of the Android "Http.request() NullPointerException") ----
// @capacitor-community/http@1.4.1 native handler (HttpRequestHandler.request /
// CapacitorHttpUrlConnection.setRequestHeaders) dereferences
//   call.getObject("params").keys()  and  call.getObject("headers").keys()
// with NO null check. When the request options object omits "params" (the app
// never passes one) and/or "headers", JSON serialization over the native
// bridge drops the absent/undefined keys, so the native PluginCall has no such
// key, call.getObject(...) returns null, and the handler throws
//   NullPointerException: Cannot invoke "...JSObject.keys()" because "<parameter1>" is null
// BEFORE any HTTP response is produced — exactly the reported Android bug.
//
// Fix (two layers, applied without touching the Base URL / server.mjs / proxy):
//   1. HERE (JS): sanitize the request object — ALWAYS supply real non-null
//      `headers: {}` and `params: {}`, and DROP any undefined/null property
//      (data: undefined, etc.) instead of passing it to the plugin. This keeps
//      every option object the app sends safe for the native handler.
//   2. Native (node_modules @capacitor-community/http Java, patched idempotently
//      by scripts/patch-http-plugin-gradle.mjs): null-guard params.keys() /
//      headers.keys() so the handler never NPEs even if a caller bypasses layer 1.
// The Java-only guard alone fixes the bug; the JS normalization additionally
// guarantees the object shape is exactly what the native code expects.
function sanitizeRequestOptions(options) {
  if (!options || typeof options !== 'object') options = {};
  const clean = {};
  for (const key of Object.keys(options)) {
    const value = options[key];
    // Never pass undefined/null down to the native plugin (JSON serialization
    // would drop undefined anyway, but explicit undefined/null must not cause
    // missing/empty natively-tracked options either).
    if (value === undefined || value === null) continue;
    clean[key] = value;
  }
  // The native @capacitor-community/http handler iterates headers/params
  // without a null check — always hand it real objects.
  if (clean.headers === undefined || clean.headers === null || typeof clean.headers !== 'object') {
    clean.headers = {};
  }
  if (clean.params === undefined || clean.params === null || typeof clean.params !== 'object') {
    clean.params = {};
  }
  return clean;
}

// Wrap every verb so no caller path can reach the native handler with a
// null headers/params or stray undefined property.
export const Http = {
  request: (options) => NativeHttp.request(sanitizeRequestOptions(options)),
  get: (options) => NativeHttp.get(sanitizeRequestOptions(options)),
  post: (options) => NativeHttp.post(sanitizeRequestOptions(options)),
  put: (options) => NativeHttp.put(sanitizeRequestOptions(options)),
  patch: (options) => NativeHttp.patch(sanitizeRequestOptions(options)),
  del: (options) => NativeHttp.del(sanitizeRequestOptions(options)),
  uploadFile: (options) => NativeHttp.uploadFile(sanitizeRequestOptions(options)),
  downloadFile: (options) => NativeHttp.downloadFile(sanitizeRequestOptions(options)),
};
export default Http;
