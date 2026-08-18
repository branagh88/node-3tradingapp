// tests/boot-harness.mjs — offline boot reproduction for the Android WebView
// "blank main + dead nav links" bug.
//
// Why this exists: every `.screen` in index.html starts `hidden`, style.css
// forces `[hidden]{display:none!important}`, and ONLY router() (called inside
// boot(), which is fired by DOMContentLoaded) reveals them. If boot() throws
// before router() runs — or never runs at all — the app boots to a blank main
// and the settings/watchlist links appear dead. That is the field symptom.
//
// How it works:
//   1. Serves www/ over real HTTP (NOT file:// — ES modules would not load
//      from file://) using python3 -m http.server.
//   2. Loads index.html in jsdom. jsdom cannot execute <script type="module">,
//      so we bootstrap the exact module graph from www/ via Node's dynamic
//      import after bridging jsdom's DOM/window/localStorage globals — the
//      same source files the WebView runs.
//   3. Fires DOMContentLoaded so app.js's boot() listener actually runs.
//   4. Captures the first uncaught exception + stack (what the WebView console
//      would show) and asserts which .screen (if any) ends up visible.
//   5. Verifies the router works: navigating to #/settings reveals the screen.
//   6. Fault-injection scenario: if router() throws mid-render the app must
//      STILL reveal at least one screen and surface an error banner (boot
//      hardening — a single failure can never blank the app).
//
// Run:  node tests/boot-harness.mjs        (or: npm run test:boot)

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';

const WWW = fileURLToPath(new URL('../www/', import.meta.url));

// ---------------------------------------------------------------------------
// HTTP server + helpers
// ---------------------------------------------------------------------------
// Pick a free port dynamically (stale servers may occupy fixed ports).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
const PORT = Number(process.env.BOOT_HARNESS_PORT) || (await getFreePort());
const BASE = `http://127.0.0.1:${PORT}`;

// Hard watchdog — never let the harness hang CI. NOTE: do NOT unref — a
// stuck await plus the live http.server child would otherwise hang forever.
let server = null;
const bailTimer = setTimeout(() => {
  console.error('[boot-harness] TIMEOUT — aborting');
  try { server?.kill('SIGTERM'); } catch { /* noop */ }
  process.exit(2);
}, 45000);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// Block the two CDN <head> scripts (hermetic/offline). The app never depends
// on them at boot; charts.js only touches window.LightweightCharts when an
// asset screen renders. This mirrors an offline WebView (which is exactly the
// environment where the blank-main bug was reported).
const cdnBlocker = requestInterceptor(async (request) => {
  const href = request.url;
  if (href.includes('cdn.jsdelivr.net') || href.includes('unpkg.com')) {
    return new Response('', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  }
  return undefined; // pass through to the real server
});

const virtualConsole = new VirtualConsole();
virtualConsole.forwardTo(console);

// Boot the real www/ module graph in a fresh jsdom window.
//  - beforeDispatch(dom): mutate the DOM/window right before boot() runs.
//  - label: used for the dynamic-import cache-buster so every scenario really
//    re-evaluates app.js (Node caches modules per URL).
async function bootScenario(label, { beforeDispatch } = {}) {
  const htmlRes = await fetch(`${BASE}/index.html`);
  const html = await htmlRes.text();

  const dom = new JSDOM(html, {
    url: `${BASE}/index.html`,
    resources: { interceptors: [cdnBlocker] },
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Event: window.Event,
  });

  let bootError = null;
  window.addEventListener('error', (e) => {
    if (!bootError) bootError = e.error || new Error(e.message || 'window error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (!bootError) bootError = e.reason instanceof Error ? e.reason : new Error(String(e.reason || 'unhandledrejection'));
  });

  let moduleEvalError = null;
  try {
    const appUrl = pathToFileURL(fileURLToPath(new URL('../www/app.js', import.meta.url))).href;
    // Cache-buster: each scenario must re-evaluate app.js against its own DOM.
    await import(`${appUrl}?scenario=${encodeURIComponent(label)}&t=${Date.now()}`);
  } catch (err) {
    moduleEvalError = err;
  }

  if (beforeDispatch) beforeDispatch(dom);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150)); // let boot() + async tasks settle

  return { dom, window, document: window.document, moduleEvalError, bootError };
}

// ---------------------------------------------------------------------------
// 1. HTTP server for www/
// ---------------------------------------------------------------------------
server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', WWW], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  const poll = async () => {
    try {
      const res = await fetch(`${BASE}/index.html`);
      if (res.ok) return resolve();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) return reject(new Error('http.server did not start in time'));
    setTimeout(poll, 200);
  };
  poll();
});

// ---------------------------------------------------------------------------
// Scenario A — normal boot (the bug's reproduction + the fix's verification)
// ---------------------------------------------------------------------------
console.log('\nboot harness [normal boot]:');
const A = await bootScenario('normal');

check('app.js module evaluated without error', !A.moduleEvalError, A.moduleEvalError ? `-> ${A.moduleEvalError.stack || A.moduleEvalError}` : '');
check('boot() completed without an uncaught exception', !A.bootError, A.bootError ? `-> ${A.bootError.stack || A.bootError}` : '');

const screensA = [...A.document.querySelectorAll('.screen')];
const visibleA = screensA.filter((s) => !s.hidden);
console.log(`  (${screensA.length} .screen elements; visible: [${visibleA.map((s) => s.id).join(', ') || 'NONE'}])`);
check('at least one .screen is visible after boot', visibleA.length >= 1, '-> ALL screens still hidden: blank-main bug reproduced');

A.window.location.hash = '#/settings';
await new Promise((r) => setTimeout(r, 100));
check('router reveals #screen-settings on #/settings', !A.document.querySelector('#screen-settings').hidden);

A.window.location.hash = '#/watchlist';
await new Promise((r) => setTimeout(r, 100));
check('router reveals #screen-watchlist on #/watchlist', !A.document.querySelector('#screen-watchlist').hidden);

// ---------------------------------------------------------------------------
// Scenario B — fault injection: router() throws mid-render. The hardening must
// still reveal at least one .screen and surface the error banner (never blank).
// ---------------------------------------------------------------------------
console.log('\nboot harness [fault: router throws]:');
const B = await bootScenario('router-throws', {
  beforeDispatch(dom) {
    // Break the watchlist route so router() throws on `null.hidden` while
    // trying to reveal #screen-watchlist, and force that route to be active.
    dom.window.document.querySelector('#screen-watchlist')?.remove();
    dom.window.location.hash = '#/watchlist';
  },
});

check('boot() survives the router throw (no uncaught exception)', !B.bootError, B.bootError ? `-> ${B.bootError.stack || B.bootError}` : '');

const screensB = [...B.document.querySelectorAll('.screen')];
const visibleB = screensB.filter((s) => !s.hidden);
console.log(`  (${screensB.length} .screen elements; visible: [${visibleB.map((s) => s.id).join(', ') || 'NONE'}])`);
check('at least one .screen is STILL visible after a router throw', visibleB.length >= 1, '-> blanked: hardening failed');
const bannerB = B.document.querySelector('#global-banner');
check('global error banner surfaced the failure', bannerB && !bannerB.hidden, '-> error was swallowed silently');

// ---------------------------------------------------------------------------
// Scenario C — boot with a previously saved watchlist (realistic device state):
// router() renders cards through AssetsController.renderWatchlist() and the
// screens must still come up.
// ---------------------------------------------------------------------------
console.log('\nboot harness [saved watchlist]:');
const C = await bootScenario('saved-watchlist', {
  beforeDispatch(dom) {
    const wl = [
      { id: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.', type: 'stock', exchange: 'NASDAQ', currency: 'USD', quote: { price: 190.21, changePercent: 1.12, volume: 51200000 }, updatedAt: Date.now() },
      { id: 'BTC/USD', symbol: 'BTC/USD', name: 'Bitcoin', type: 'crypto', exchange: 'Coinbase', currency: 'USD', quote: { price: 61234.5, changePercent: -0.4, volume: 12345 }, updatedAt: Date.now() },
    ];
    dom.window.localStorage.setItem('market-intelligence:watchlist', JSON.stringify(wl));
    dom.window.location.hash = '#/watchlist';
  },
});

check('app.js module evaluated without error', !C.moduleEvalError, C.moduleEvalError ? `-> ${C.moduleEvalError.stack || C.moduleEvalError}` : '');
check('boot() completed without an uncaught exception (saved watchlist)', !C.bootError, C.bootError ? `-> ${C.bootError.stack || C.bootError}` : '');
check('watchlist screen rendered from saved data', !C.document.querySelector('#screen-watchlist').hidden && C.document.querySelectorAll('#watchlist-grid .asset-card').length === 2,
  `-> cards=${C.document.querySelectorAll('#watchlist-grid .asset-card').length}`);
check('watchlist still navigable to settings', (() => {
  C.window.location.hash = '#/settings';
  return true;
})(), '');
await new Promise((r) => setTimeout(r, 100));
check('router reveals #screen-settings after saved-watchlist boot', !C.document.querySelector('#screen-settings').hidden);

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nBOOT HARNESS PASS' : `\nBOOT HARNESS FAIL (${failures} failure(s))`);
clearTimeout(bailTimer);
try { server.kill('SIGTERM'); } catch { /* noop */ }
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 50);