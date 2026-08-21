// build-check.mjs — offline build validation for Market Intelligence (Phase 1).
//
// The app is vanilla ES modules with no bundler by design (see README.md), so
// there is nothing to compile. "npm run build" therefore validates that every
// top-level .js module parses as a valid ES module, so a broken file (syntax
// error, stray brace, corrupted edit) fails the build instead of only breaking
// at runtime in the browser.
//
// Approach: spawn `node --check` per module. This is syntax-only and never
// executes the module, so browser-only globals (document, window,
// localStorage) and CDN-loading code in the UI modules cannot false-fail the
// check, and the app's behavior is untouched.
//
// Run:  node build-check.mjs   (or: npm run build)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Every top-level .js module the app ships. Explicit list keeps the check
// deterministic and independent of unrelated stray files in the repo.
const MODULES = [
  'app.js',
  'api.js',
  'ai-engine.js',
  'assets.js',
  'alerts.js',
  'charts.js',
  'config.js',
  'indicators.js',
  'market-data.js',
  'secure-store.js',
  'Marketanalysis.js',
  'notifications.js',
  'pattern-engine.js',
  'prediction-engine.js',
  'storage.js',
  'utils.js',
];

let failures = 0;

console.log('build-check: validating top-level ES modules with `node --check`');

for (const mod of MODULES) {
  const file = path.join(ROOT, mod);
  if (!existsSync(file)) {
    console.error(`  ✗ ${mod} — MISSING (expected at ${file})`);
    failures += 1;
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', file], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    console.log(`  ✓ ${mod} — syntax OK`);
  } catch (err) {
    console.error(`  ✗ ${mod} — syntax error`);
    console.error(String(err.stderr || err.message).trim());
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\nBUILD FAILED — ${failures} module(s) failed to parse`);
  process.exit(1);
}

console.log(`\nBUILD PASS — all ${MODULES.length} modules parse as valid ES modules`);
process.exit(0);