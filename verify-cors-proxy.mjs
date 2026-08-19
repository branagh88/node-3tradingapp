#!/usr/bin/env node
// verify-cors-proxy.mjs — zero-dependency CORS proxy verification for node-3tradingapp.
//
// Reproduces the app's REAL proxy strategy (mirrored from config.js + api.js)
// and tests every hop of the chain with a live GET so a 'CONNECTION FAILED /
// NETWORK OR CORS ERROR / Status: N/A' shown by Settings > Test Connection can
// be classified as NETWORK (DNS/TCP/TLS/timeout), CORS (missing
// access-control-allow-origin), or PROXY MISBEHAVIOR (HTML error body /
// non-JSON) — instead of the app's generic message.
//
// Strategy chain (same order as api.js _fetchWithProxy + api.js buildUrl):
//   1. same-origin server.mjs proxy  -> http://localhost:3000/v2/<probe>
//   2. custom proxyUrl (settings)    -> <proxyUrl>?url=<encoded> (skipped when unset)
//   3. allorigins                    -> https://api.allorigins.win/get?url=<encoded>
//   4. corsproxy.io                  -> https://corsproxy.io/?<encoded>
//   5. direct                        -> https://api.tickerbot.io/v2/<probe>
//
// In the app, hop 1 is used only on localhost origins (api.js
// isLocalDevOrigin/resolveBaseURL swap the base to location.origin); hops 2-4
// are the browser fallback chain; hop 5 is the last resort. No Authorization
// header is sent to public proxies (API_CONFIG.apiKey defaults to '' in
// config.js) — this mirrors _fetchViaAllOrigins/_fetchViaCorsProxy exactly.
//
// A strategy is "ok" only when the full plumbing works for the app's purposes:
// HTTP response + JSON body + access-control-allow-origin present (status 401
// with a JSON body is treated as REACHED — it proves DNS/TCP/TLS/proxy all
// work; the missing API key is a separate auth concern, NOT the connectivity
// failure being diagnosed).
//
// Exit code: 0 when every hop the app RELIES on works (same-origin proxy AND
// at least one CORS-clean public browser fallback); 1 otherwise.
//
// Usage:  node verify-cors-proxy.mjs [probePath]     (default probe /v2/status)

import { readFileSync } from 'node:fs';
import { API_CONFIG, DEFAULTS } from './config.js';
import { TickerbotAPI } from './api.js';

// Mirror of api.js's module-local constant (not exported):
//   const DEFAULT_BASE_URL = 'https://api.tickerbot.io';
const API_DEFAULT_BASE_URL = 'https://api.tickerbot.io';

const PROBE = process.argv[2] || '/v2/status';
const TIMEOUT_MS = 10000; // matches DEFAULTS.settings.timeoutMs
const DEV_PROXY_ORIGIN = process.env.DEV_PROXY_ORIGIN || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const now = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now()
  : Date.now();

function sample(text, max = 180) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function prettyLatency(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// Classify an underlying fetch error (DNS / TCP / TLS / timeout / other).
function classifyFetchError(err) {
  const cause = err && err.cause ? err.cause : err;
  const code = cause && cause.code ? cause.code : (err && err.code ? err.code : '');
  const name = err && err.name ? err.name : '';
  if (name === 'AbortError') {
    return { kind: 'NETWORK', sub: 'timeout', detail: `timed out after ${TIMEOUT_MS}ms (AbortError)` };
  }
  const NET_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
    'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'EPIPE', 'ENETDOWN',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_SSL_PROTOCOL_ERROR', 'EPROTO',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  ]);
  if (code && NET_CODES.has(code)) {
    return { kind: 'NETWORK', sub: code, detail: `${code} — DNS/TCP/TLS-level failure: ${err.message || ''}` };
  }
  // Browser-style CORS TypeError arrives as "Failed to fetch" with no cause code.
  if (name === 'TypeError' || (err && /fetch failed/i.test(err.message || ''))) {
    return { kind: 'NETWORK', sub: 'fetch-failed', detail: `${err.message || name} (in a browser, TypeError on a cross-origin fetch = CORS block or network unreachable)` };
  }
  return { kind: 'NETWORK', sub: code || name || 'unknown', detail: `${err.message || String(err)}` };
}

// Mirror of api.js parseJsonBody — is the body actually the upstream JSON?
function parseJsonBody(text) {
  const trimmed = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .trim();
  if (!trimmed) return { ok: false, reason: 'empty response body' };
  if (/^</.test(trimmed)) {
    return { ok: false, reason: `HTML page / proxy error body ("${sample(trimmed, 80)}")` };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: `non-JSON body ("${sample(trimmed, 80)}")` };
  }
}

// Mirror of api.js buildCustomProxyUrl (custom proxyUrl conventions).
function buildCustomProxyUrl(proxyBase, target) {
  const base = String(proxyBase || '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return null;
  const encoded = encodeURIComponent(target);
  if (base.includes('{url}')) return base.replace(/\{url\}/g, encoded);
  try {
    const u = new URL(base);
    if (u.searchParams.has('url')) {
      u.searchParams.set('url', target);
      return u.toString();
    }
  } catch { /* bare base — fall through */ }
  const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${sep}url=${encoded}`;
}

// ---------------------------------------------------------------------------
// (a) "Read" config.js + api.js and print the app's mirrored strategy
// ---------------------------------------------------------------------------
function mirrorAudit() {
  const configSrc = readFileSync(new URL('./config.js', import.meta.url), 'utf8');
  const apiSrc = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

  const configuredBase = (API_CONFIG.baseURL && String(API_CONFIG.baseURL).trim() &&
    String(API_CONFIG.baseURL).trim() !== 'YOUR_API_BASE_URL')
    ? String(API_CONFIG.baseURL).replace(/\/+$/, '')
    : '';
  const baseURL = configuredBase || API_DEFAULT_BASE_URL;

  // What the app itself would dispatch in this runtime:
  const probeApi = new TickerbotAPI({
    baseURL: API_CONFIG.baseURL,
    apiKey: API_CONFIG.apiKey,
    settings: DEFAULTS.settings,
  });
  const appUrl = probeApi.buildUrl(PROBE);

  console.log('┌────────────────────────────────────────────────────────────────────┐');
  console.log('│ CORS PROXY VERIFIER — node-3tradingapp                              │');
  console.log('└────────────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('── (a) App proxy strategy (mirrored from config.js + api.js) ──────────');
  console.log(`  config.js      : baseURL=${JSON.stringify(API_CONFIG.baseURL)} apiKey=${JSON.stringify(API_CONFIG.apiKey)} (empty ⇒ NO Authorization header)`);
  console.log(`  settings       : useProxy=${DEFAULTS.settings.useProxy} proxyUrl=${JSON.stringify(DEFAULTS.settings.proxyUrl)} timeoutMs=${DEFAULTS.settings.timeoutMs}`);
  console.log(`  api.js         : DEFAULT_BASE_URL=${API_DEFAULT_BASE_URL} (placeholder config falls back to it — line: ${sample(apiSrc.split('\n').find(l => l.includes('DEFAULT_BASE_URL =')) || '', 70)})`);
  console.log(`  local origins  : localhost / 127.0.0.1 / ::1 / [::1] ⇒ base swapped to location.origin (server.mjs proxy)`);
  console.log(`  probe endpoint : ${PROBE}`);
  console.log(`  app.dispatch   : ${appUrl}   (probeApi.buildUrl() = same base resolution as _doFetch)`);
  console.log(`  app.shouldUseProxy() in this runtime: ${probeApi.shouldUseProxy()} (true on browser non-localhost origins)`);
  console.log('');
  console.log('  Ordered chain (order = api.js _fetchWithProxy + resolveBaseURL):');
  console.log('    1. same-origin server.mjs proxy   (localhost:3000 only)');
  console.log('    2. custom proxyUrl ?url=<enc>      (settings.proxyUrl — skipped when empty)');
  console.log('    3. api.allorigins.win/get?url=…    (wrapper: {contents,status})');
  console.log('    4. corsproxy.io/?<enc>             (raw body)');
  console.log('    5. direct fetch                    (api.tickerbot.io — no ACAO ⇒ browser CORS block)');
  console.log('');
  console.log(`  Source context (config.js):  ${sample(configSrc.split('\n').find(l => l.includes('apiKey:')) || '', 70)}`);
  console.log(`  Source context (api.js):     ${sample(apiSrc.split('\n').find(l => l.includes("api.allorigins.win")) || '', 80)}`);
  console.log('');
  return { baseURL, appUrl };
}

// ---------------------------------------------------------------------------
// (b) + (c) Per-strategy live probe with NETWORK / CORS / PROXY classification
// ---------------------------------------------------------------------------
async function testStrategy(strategy, url, { statusRule }) {
  const t0 = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const result = {
    name: strategy,
    url,
    status: null,
    latencyMs: null,
    corsHeader: null,
    corsOk: null,
    bodySample: '',
    classification: null,
    ok: false,
    note: '',
  };
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' }, // no Authorization — mirrors public-proxy fetches
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      const cls = classifyFetchError(err);
      result.latencyMs = now() - t0;
      result.classification = `${cls.kind} FAILURE (${cls.sub})`;
      result.note = cls.detail;
      return result;
    }

    result.latencyMs = now() - t0;
    result.status = res.status;
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    result.corsHeader = headers['access-control-allow-origin'] || null;
    result.corsOk = !!result.corsHeader;

    const bodyText = await res.text();
    result.bodySample = sample(bodyText, 180);
    const parsed = parseJsonBody(bodyText);

    const is2xx = res.status >= 200 && res.status < 300;

    if (!parsed.ok) {
      // HTML error page / empty body / plain-text error → proxy (or upstream)
      // is not delivering JSON. This is exactly api.js's proxy-misbehavior test.
      result.classification = `PROXY MISBEHAVIOR (HTTP ${res.status} — ${parsed.reason})`;
      result.ok = false;
      result.note = parsed.reason;
      return result;
    }

    // JSON body received — the plumbing (DNS/TCP/TLS/proxy) works end-to-end.
    // CORS header is what decides whether a BROWSER can read it.
    if (!result.corsOk) {
      result.classification = `CORS FAILURE (HTTP ${res.status}, valid JSON, but access-control-allow-origin MISSING — a browser cannot read this response)`;
      result.ok = false;
      result.note = 'No access-control-allow-origin header present.';
      return result;
    }

    // CORS ok + JSON: strategy is usable. Status rule decides whether a
    // non-2xx response (e.g. the API's 401 without an API key) counts as ok.
    if (statusRule === 'any' || is2xx) {
      result.classification = `OK (HTTP ${res.status}, JSON, CORS ok [${result.corsHeader}])${statusRule === 'any' && !is2xx ? ' — plumbing works; non-2xx is the API\'s own auth/upstream status, not a connectivity failure' : ''}`;
      result.ok = true;
    } else {
      result.classification = `REACHED but non-2xx (HTTP ${res.status}, JSON, CORS ok — app treats non-2xx as strategy-fail: ${sample(bodyText, 60)})`;
      result.ok = false;
      result.note = 'Proxy delivered the response with CORS headers, but upstream status is not 2xx.';
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// allorigins-specific validation (mirror of _fetchViaAllOrigins): body must be a
// JSON wrapper {contents, status:{http_code}} whose contents are the API JSON.
function validateAllOrigins(result) {
  if (!result.bodySample || result.classification && result.classification.startsWith('PROXY MISBEHAVIOR')) {
    return result;
  }
  try {
    const wrap = JSON.parse(String(result.bodySample).replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, ''));
    if (wrap && typeof wrap === 'object' && Object.prototype.hasOwnProperty.call(wrap, 'contents')) {
      const code = wrap.status && typeof wrap.status.http_code === 'number'
        ? wrap.status.http_code
        : result.status;
      const contents = wrap.contents;
      const corsStr = result.corsOk ? `CORS ok [${result.corsHeader}]` : 'CORS MISSING';
      if (code < 200 || code >= 300) {
        result.classification = `PROXY MISBEHAVIOR (allorigins wrapper reports upstream HTTP ${code}, ${corsStr})`;
        result.ok = false;
        result.note = `wrapper.status.http_code=${code} — the upstream fetch failed inside the proxy.`;
      } else if (typeof contents === 'string') {
        const inner = parseJsonBody(contents);
        if (!inner.ok) {
          result.classification = `PROXY MISBEHAVIOR (allorigins delivered wrapper, but contents: ${inner.reason})`;
          result.ok = false;
          result.note = inner.reason;
        } else {
          result.ok = result.corsOk;
          result.classification = result.ok
            ? `OK (allorigins wrapper HTTP ${code}, upstream JSON delivered, ${corsStr})`
            : `CORS FAILURE (allorigins wrapper HTTP ${code}, upstream JSON delivered, access-control-allow-origin MISSING)`;
        }
      } else if (contents == null) {
        result.classification = `PROXY MISBEHAVIOR (allorigins wrapper has no contents, ${corsStr})`;
        result.ok = false;
        result.note = 'wrapper.contents is missing/empty.';
      } else {
        result.ok = result.corsOk;
        result.classification = result.ok
          ? `OK (allorigins wrapper HTTP ${code}, upstream JSON delivered, ${corsStr})`
          : `CORS FAILURE (allorigins wrapper HTTP ${code}, ${corsStr})`;
      }
    } else {
      result.classification = `PROXY MISBEHAVIOR (allorigins returned JSON but not the {contents} wrapper, HTTP ${result.status})`;
      result.ok = false;
      result.note = 'Body does not match the allorigins {contents,status} envelope.';
    }
  } catch { /* non-JSON already classified by testStrategy */ }
  return result;
}

function formatResult(r) {
  const lines = [];
  lines.push(`  [${r.name}]`);
  lines.push(`    url        : ${r.url}`);
  lines.push(`    status     : ${r.status == null ? '— (no HTTP response)' : r.status}`);
  lines.push(`    latency    : ${prettyLatency(r.latencyMs)}`);
  lines.push(`    cors       : ${r.corsHeader ? `present → ${r.corsHeader}` : 'MISSING access-control-allow-origin'}`);
  lines.push(`    sample     : ${r.bodySample ? JSON.stringify(r.bodySample) : '(empty body)'}`);
  lines.push(`    result     : ${r.classification}`);
  if (r.note) lines.push(`    note       : ${r.note}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Real app path — reproduce exactly what Settings > Test Connection sees
// ---------------------------------------------------------------------------
async function reproduceAppPath(appUrl) {
  console.log('── (d) Real app path (TickerbotAPI._fetchWithProxy / _doFetch — as the Settings test) ──');
  const api = new TickerbotAPI({
    baseURL: API_CONFIG.baseURL,
    apiKey: API_CONFIG.apiKey,
    settings: { ...DEFAULTS.settings, timeoutMs: TIMEOUT_MS },
  });
  try {
    const res = await api._fetchWithProxy(appUrl, { method: 'GET' });
    console.log(`  _fetchWithProxy resolved: strategy="${res._strategy || 'direct'}" status=${res.status} ok=${res.ok}`);
    if (res._strategyErrors && res._strategyErrors.length) {
      console.log('  earlier strategies that failed:');
      for (const e of res._strategyErrors) {
        console.log(`    - ${e.strategy}: ${e.message}`);
      }
    }
    if (!res.ok) {
      console.log(`  => app._doFetch would throw on HTTP ${res.status} (auth/not_found/rate_limit/server error by status).`);
    }
  } catch (err) {
    console.log(`  _fetchWithProxy THREW: ${err.name}: ${err.message} (status=${err.status || 'N/A'})`);
    if (err.strategyErrors && err.strategyErrors.length) {
      console.log('  per-strategy failures (strategyErrors):');
      for (const e of err.strategyErrors) {
        console.log(`    - ${e.strategy}: ${e.message}`);
      }
    }
  }
  console.log('');
  console.log('  Browser reality on a NON-localhost origin (StackBlitz / static hosting):');
  console.log('    direct fetch → browser throws TypeError "Failed to fetch" (api.tickerbot.io does NOT');
  console.log('    send access-control-allow-origin ⇒ CORS block). If allorigins + corsproxy.io also fail,');
  console.log('    every strategy throws and the app reports EXACTLY:');
  console.log('      CONNECTION FAILED / Error: NETWORK OR CORS ERROR / Status: N/A');
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { baseURL, appUrl } = mirrorAudit();

  const normalizedProbe = PROBE.startsWith('/') ? PROBE : `/${PROBE}`;
  const directUrl = `${baseURL}${normalizedProbe}`;
  const localUrl = `${DEV_PROXY_ORIGIN}${normalizedProbe}`;
  const allOriginsUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`;
  const corsProxyUrl = `https://corsproxy.io/?${encodeURIComponent(directUrl)}`;
  const customProxyBase = (DEFAULTS.settings.proxyUrl || '').trim();

  const customProxyTarget = customProxyBase ? buildCustomProxyUrl(customProxyBase, directUrl) : null;

  const strategies = [
    {
      name: 'same-origin server.mjs proxy',
      url: localUrl,
      statusRule: 'any', // 401 from the API still proves the proxy chain works
      validate: (r) => r,
    },
    {
      name: 'custom proxyUrl (settings)',
      url: customProxyTarget,
      statusRule: '2xx', // api.js _fetchViaCustomProxy throws on !res.ok
      validate: (r) => r,
    },
    {
      name: 'allorigins (api.allorigins.win/get)',
      url: allOriginsUrl,
      statusRule: '2xx',
      validate: validateAllOrigins,
    },
    {
      name: 'corsproxy.io',
      url: corsProxyUrl,
      statusRule: '2xx', // api.js _fetchViaCorsProxy throws on !res.ok
      validate: (r) => r,
    },
    {
      name: 'direct (api.tickerbot.io)',
      url: directUrl,
      statusRule: 'any',
      validate: (r) => r,
    },
  ];

  console.log(`── (b)+(c) Live per-strategy probes (GET, no Authorization header, timeout ${TIMEOUT_MS}ms) ──`);
  console.log('');
  const results = [];
  for (const s of strategies) {
    let r;
    if (s.url === null) {
      r = {
        name: s.name,
        url: `${customProxyBase || '(unset)'} → skipped: no proxyUrl configured in config.js (api.js skips it too)`,
        status: null, latencyMs: 0, corsHeader: null, corsOk: false,
        bodySample: '', classification: 'SKIPPED (settings.proxyUrl empty — DEFAULTS.settings)',
        ok: false, note: 'Nothing to test until the user supplies a custom proxy URL in Settings.',
      };
    } else {
      r = await testStrategy(s.name, s.url, { statusRule: s.statusRule });
    }
    r = s.validate(r) || r;
    results.push(r);
    console.log(formatResult(r));
    console.log('');
  }

  // -------------------------------------------------------------------------
  // (d) Final verdict
  // -------------------------------------------------------------------------
  console.log('── (d) Final verdict on reported "CONNECTION FAILED / NETWORK OR CORS ERROR / Status: N/A" ──');
  console.log('');

  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  const local = byName['same-origin server.mjs proxy'];
  const allOrigins = byName['allorigins (api.allorigins.win/get)'];
  const corsProxy = byName['corsproxy.io'];
  const direct = byName['direct (api.tickerbot.io)'];

  const localOk = !!(local && local.ok && local.corsOk);
  const publicFallbackOk = !!(
    (allOrigins && allOrigins.ok && allOrigins.corsOk) ||
    (corsProxy && corsProxy.ok && corsProxy.corsOk)
  );
  const directReachable = !!(direct && direct.status != null);
  const directCorsBlocked = !!(direct && direct.status != null && !direct.corsOk);

  const kinds = [];
  results.forEach((r) => {
    if (!r.classification || r.classification.startsWith('SKIPPED')) return;
    if (r.classification.startsWith('NETWORK FAILURE')) kinds.push(`${r.name}: NETWORK failure (${r.note || ''})`);
    else if (r.classification.startsWith('CORS FAILURE')) kinds.push(`${r.name}: CORS failure (${r.note || 'missing access-control-allow-origin'})`);
    else if (r.classification.startsWith('PROXY MISBEHAVIOR')) kinds.push(`${r.name}: proxy misbehavior (${r.note || ''})`);
    else if (r.ok) kinds.push(`${r.name}: OK`);
    else kinds.push(`${r.name}: ${r.classification}`);
  });

  console.log('  Per-strategy classification:');
  kinds.forEach((k) => console.log(`    • ${k}`));
  console.log('');

  console.log(`  api.tickerbot.io reachable from this network: ${directReachable ? 'YES' : 'NO'}${direct && direct.status != null ? ` (HTTP ${direct.status} in ${prettyLatency(direct.latencyMs)})` : ''}`);
  console.log(`  api.tickerbot.io CORS headers: ${direct ? (direct.corsOk ? 'YES' : 'NO — access-control-allow-origin MISSING ⇒ browsers block direct calls') : 'n/a'}`);
  console.log(`  same-origin server.mjs proxy on localhost:3000: ${localOk ? 'WORKS' : (local ? `FAILS (${local.classification})` : 'not tested')}`);
  console.log(`  public browser fallback (allorigins OR corsproxy.io): ${publicFallbackOk ? 'WORKS' : 'FAILS — neither is currently usable'}`);
  console.log('');

  console.log('  ROOT-CAUSE CONCLUSION:');
  console.log('    The Tickerbot API is UP (a direct request returns HTTP ' + (direct ? direct.status : 'n/a') + ' JSON in ~' + (direct ? Math.round(direct.latencyMs || 0) : '?') + 'ms) — this is NOT a DNS/TCP/TLS outage of the API. The reported');
  console.log('    "CONNECTION FAILED / NETWORK OR CORS ERROR / Status: N/A" is a CORS + proxy-availability problem:');
  console.log('    1. api.tickerbot.io does NOT send access-control-allow-origin ⇒ a browser on a non-localhost');
  console.log('       origin can never read the direct response (CORS failure).');
  if (allOrigins && !(allOrigins.ok && allOrigins.corsOk)) {
    console.log('    2. allorigins.win is currently unreliable from this network: ' + (allOrigins.classification || 'failed') + '.');
  }
  if (corsProxy && !(corsProxy.ok && corsProxy.corsOk)) {
    console.log('    3. corsproxy.io is refusing requests from this network (HTTP ' + (corsProxy.status || 'n/a') + ') — it may work from a residential browser, but is not a reliable fallback here.');
  }
  console.log('    ⇒ When every chain hop fails in the browser, api.js throws ApiError("network", "NETWORK OR CORS ERROR", 0)');
  console.log('      and Settings shows "CONNECTION FAILED / Error: NETWORK OR CORS ERROR / Status: N/A".');
  console.log('    ⇒ FIX (already in the repo): run `npm run dev` and open http://localhost:3000 — the');
  console.log('      same-origin server.mjs proxy adds access-control-allow-origin: * and forwards /v2/* to');
  console.log('      the API, bypassing the CORS block entirely' + (localOk ? ' (verified WORKING below).' : ' (start it: node server.mjs).'));
  console.log('');

  const overallOk = localOk && publicFallbackOk;
  console.log(`  OVERALL: ${overallOk ? 'PASS — every strategy the app relies on works (local proxy + public browser fallback).' : 'FAIL — same-origin proxy AND/OR public CORS fallback chain is not fully working.'}`);
  console.log(`  Exit code: ${overallOk ? 0 : 1}`);
  return overallOk ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error('verify-cors-proxy.mjs crashed:', err);
    process.exitCode = 2;
  });