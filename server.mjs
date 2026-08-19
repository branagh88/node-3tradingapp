// server.mjs — Node-only dev server + Tickerbot API reverse proxy (zero deps).
//
// The app is vanilla ES modules with NO build step (no Vite), so this tiny
// Node server does two jobs:
//   1. Serves the static files from the repo root (index.html + ES modules).
//   2. Reverse-proxies every request whose path is exactly /v2 or starts with
//      /v2/ to https://api.tickerbot.io (same path + query, same method),
//      forwarding the caller's Authorization/Content-Type/Accept headers and
//      streaming the request body for POST. The browser's Host AND Origin are
//      intentionally dropped (see handleProxy) so upstream never sees our page
//      origin — api.tickerbot.io rejects unallowed origins with cors_origin_denied.
//
// Browser fetches therefore go to http://localhost:3000/... (same origin, no
// CORS) and server.mjs re-attaches the API key header upstream.
//
// Run:  node server.mjs            (or: npm run dev / npm run serve)
// Env:  PORT overrides the port (default 3000).
//
// Routes:
//   /v2, /v2/...   -> proxied to https://api.tickerbot.io with CORS headers
//   OPTIONS        -> 204 preflight with CORS headers
//   everything else -> static file (index.html fallback for the hash router)

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const PORT = Number(process.env.PORT) || 3000;
const API_TARGET = 'https://api.tickerbot.io';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Path segments that are NEVER served by the static file server (dot-led
// segments cover .git, .workbench, .env, etc.).
const BLOCKED_SEGMENTS = new Set(['node_modules', 'adws']);

function isBlockedPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  return segments.some((seg) => seg.startsWith('.') || BLOCKED_SEGMENTS.has(seg));
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

// ---------------------------------------------------------------------------
// Static file serving (with index.html fallback for the hash router)
// ---------------------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('Method Not Allowed');
  }
  if (isBlockedPath(pathname)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.resolve(ROOT, '.' + path.sep + rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT_PREFIX)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }

  try {
    const stat = await fs.stat(filePath);
    const target = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const body = await fs.readFile(target);
    res.writeHead(200, { 'content-type': contentType(target) });
    return res.end(body);
  } catch {
    // SPA fallback: unknown app paths serve index.html (hash routing). /v2/*
    // is handled by the proxy before this point, but a 404 from the proxy
    // must never be masked by the HTML fallback either.
    if (rel === '/v2' || rel.startsWith('/v2/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not Found');
    }
    try {
      const body = await fs.readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not Found');
    }
  }
}

// ---------------------------------------------------------------------------
// /v2 -> https://api.tickerbot.io reverse proxy
// ---------------------------------------------------------------------------
function handleProxy(req, res, pathname, search) {
  const targetUrl = `${API_TARGET}${pathname}${search}`;
  const headers = {};
  // Forward the caller's identity/body headers. Host is intentionally dropped
  // so the upstream request's Host is api.tickerbot.io, not localhost. The
  // browser's Origin header is ALSO intentionally NOT forwarded: api.tickerbot.io
  // rejects any origin not on its CORS allowlist with `cors_origin_denied`
  // (403), so leaking our page origin upstream would break the proxy. This is
  // a server-side reverse proxy — upstream must see no browser Origin. The
  // Authorization (Bearer key) IS forwarded so the API can authenticate.
  for (const name of ['authorization', 'content-type', 'accept']) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }

  const proxyReq = httpsRequest(targetUrl, { method: req.method, headers }, (proxyRes) => {
    // Keep upstream headers but let our CORS headers win.
    const resHeaders = { ...proxyRes.headers, ...corsHeaders() };
    res.writeHead(proxyRes.statusCode || 502, resHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: 'api_proxy_error', detail: err.message }));
    } else {
      res.end();
    }
  });

  // Stream the request body (POST) straight to the upstream host.
  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('Bad Request');
  }
  const pathname = parsed.pathname;
  const search = parsed.search; // '' or '?query'

  // CORS preflight (browser sends this before an Authorization-header fetch).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (pathname === '/v2' || pathname.startsWith('/v2/')) {
    return handleProxy(req, res, pathname, search);
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`node-3tradingapp dev server → http://localhost:${PORT}`);
  console.log(`/v2/* requests are reverse-proxied to ${API_TARGET}`);
  console.log('Press Ctrl+C to stop.');
});