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
import { Http } from '@capacitor-community/http';
export { Http };
