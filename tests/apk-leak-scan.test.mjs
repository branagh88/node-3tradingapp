// tests/apk-leak-scan.test.mjs — credential-leak scan for web sources, the
// Capacitor www/ build output, and (when present) the debug APK's assets.
//
// Security rule enforced: the Tickerbot API key must NEVER appear in any
// shipped artifact. It lives only in secure-store (Capacitor Preferences /
// storage.js namespaced key) and flows solely into TickerbotAPI._doFetch.
//
// Deterministic and offline. APK scanning is skipped (not failed) when the
// APK or an unzip binary is absent — e.g. CI without the Android SDK.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'www');
const APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

// Credential-shaped literal detectors. Deliberately conservative to avoid
// false positives on legitimate vendor code:
const PATTERNS = [
  { name: 'sk-style secret key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: 'Bearer token literal', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'api key assignment', re: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

// Long hex strings can be vendor hashes — allowlisted known-safe literals.
const LONG_HEX_RE = /[a-f0-9]{32,}/gi;
const HEX_WHITELIST = new Set([
  // Known vendored hashes (none currently) — add exact matches here if a
  // legitimate 32+-hex constant ever ships in www/ or the new modules.
]);

/** Scan one file's text; returns list of finding strings (empty = clean). */
export function scanText(text) {
  const findings = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) findings.push(name);
  }
  const hexes = text.match(LONG_HEX_RE) || [];
  for (const h of hexes) {
    if (!HEX_WHITELIST.has(h)) findings.push(`long-hex-literal (${h.slice(0, 12)}…)`);
  }
  return findings;
}

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, out);
    else out.push(p);
  }
  return out;
}

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.txt', '.xml', '.map']);
function isTextFile(p) {
  return TEXT_EXT.has(path.extname(p).toLowerCase());
}

describe('credential leak scan', () => {
  it('new modules (real-validation.js / pooled-stats.js) contain no credential-shaped literals', () => {
    for (const mod of ['real-validation.js', 'pooled-stats.js']) {
      const src = fs.readFileSync(path.join(ROOT, mod), 'utf8');
      expect(scanText(src), `${mod} leaked`).toEqual([]);
      // Structural hygiene: these modules never touch secure-store or raw keys.
      expect(src).not.toMatch(/secure-store/i);
      expect(src).not.toMatch(/Authorization|apiKey|getApiKey/);
    }
  });

  it('www/ build output is free of credential-shaped literals', () => {
    expect(fs.existsSync(WWW), 'www/ exists').toBe(true);
    const files = collectFiles(WWW).filter(isTextFile);
    expect(files.length).toBeGreaterThan(10);
    const leaks = [];
    for (const f of files) {
      const found = scanText(fs.readFileSync(f, 'utf8'));
      if (found.length) leaks.push(`${path.relative(ROOT, f)}: ${found.join(', ')}`);
    }
    expect(leaks).toEqual([]);
  });

  it('debug APK assets (when built) mirror the clean www/ scan', () => {
    if (!fs.existsSync(APK)) {
      console.warn(`apk-leak-scan: ${path.relative(ROOT, APK)} not found — skipping APK scan (run ./gradlew assembleDebug)`);
      return;
    }
    let unzip;
    try {
      unzip = execFileSync('which', ['unzip'], { encoding: 'utf8' }).trim();
    } catch {
      console.warn('apk-leak-scan: unzip binary unavailable — skipping APK scan');
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-scan-'));
    try {
      execFileSync(unzip, ['-q', '-o', APK, 'assets/*'], { cwd: tmp, stdio: 'pipe' });
      const assetsDir = path.join(tmp, 'assets');
      const files = collectFiles(assetsDir).filter(isTextFile);
      const leaks = [];
      for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; } // skip binary
        const found = scanText(text);
        if (found.length) leaks.push(`${path.relative(tmp, f)}: ${found.join(', ')}`);
      }
      expect(leaks).toEqual([]);
      // The bundled web app must actually be present under assets/public/.
      expect(fs.existsSync(path.join(assetsDir, 'public', 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(assetsDir, 'public', 'real-validation.js'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
