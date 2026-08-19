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
