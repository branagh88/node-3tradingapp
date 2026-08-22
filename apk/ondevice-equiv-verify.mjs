// ondevice-equiv-verify.mjs — off-device equivalent of the requested ON-DEVICE
// Tickerbot verification, driving the app's REAL shipped code (www/api.js —
// byte-identical to android/app/src/main/assets/public/api.js inside the APK)
// against the LIVE api.tickerbot.io server.
//
// Why this exists: this factory box has NO adb device, NO emulator, NO system
// images and NO /dev/kvm (adb devices -> empty), so the APK cannot be executed
// here. This harness runs the exact same JS pipeline Test Connection runs in
// the WebView (_doFetch -> unwrapQuoteEnvelope -> normalizeQuote ->
// getTickerQuoteDiagnostic probes), with globalThis.Capacitor shimmed to the
// NATIVE runtime shape so resolveBaseURL keeps the absolute
// https://api.tickerbot.io base exactly as it does on device.
//
// Keyless live transport: no tb_test_*/tb_live_* key exists in this
// environment (checked env/.env/tests/adws handoffs). The authenticated
// /v2/tickers/{sym} endpoint therefore answers 401 "Malformed API key"
// (expected, proven in apk/DIAGNOSTIC_REPORT.md). To still exercise a REAL
// HTTP 200 + real envelope through the app's own pipeline, we use the
// legitimate Settings > Stock Endpoint override ({ticker} placeholder is an
// existing api.js feature) pointed at the KEYLESS SANDBOX single-row endpoint
// /v2/sandbox/tickers/{ticker}, which returns the SAME
// {as_of, ticker, data:{...price...}} envelope shape as production.
//
// No repo source files are modified by this harness.

const ROOT = new URL('..', import.meta.url).pathname;

// ---- Runtime shape: NO globalThis.Capacitor and NO globalThis.location ----
// The bundled http-plugin.js cannot run on plain Node (it needs the real
// Capacitor bridge's nativeCallback), and defining globalThis.Capacitor makes
// the bundle REPLACE it mid-run anyway. Instead we reproduce the property the
// app actually needs from the native runtime: resolveBaseURL must keep the
// ABSOLUTE https://api.tickerbot.io base. isLocalDevOrigin() returns false when
// globalThis.location is undefined, so with no Capacitor AND no location the
// app keeps the absolute base and dispatches through plain fetch() — the same
// URL, headers, envelope unwrap and normalization the WebView uses. The native
// Java transport itself was already proven separately by the desktop JVM
// harness driving the REAL CapacitorHttpUrlConnection/HttpRequestHandler
// classes (apk/native-harness/, apk/native-probe-output.txt).
delete globalThis.Capacitor;
delete globalThis.location;

const { TickerbotAPI } = await import(new URL('../www/api.js', import.meta.url).href);

const out = { test_connection: {}, search_url_preservation: {} };
let failures = 0;

// ================= 1) Test Connection equivalent: AAPL + GME =================
for (const sym of ['AAPL', 'GME']) {
  const api = new TickerbotAPI({
    baseURL: 'https://api.tickerbot.io',
    apiKey: '', // no key exists in this environment; sandbox is keyless
    stockEndpoint: '/v2/sandbox/tickers/{ticker}',
    settings: { timeoutMs: 20000 },
  });
  const rec = { symbol: sym };
  try {
    const q = await api.getTickerQuoteDiagnostic(sym);
    const d = q._debug.diag;
    rec.httpStatus = d.httpStatus;
    rec.requestedSymbol = d.requestedSymbol;
    rec.returnedSymbol = d.returnedSymbol;
    rec.urlPath = d.urlPath;
    rec.parsedJson_priceExists = d.parsedJson.priceExists;
    rec.parsedJson_priceType = d.parsedJson.priceType;
    rec.normalizeInput_priceExists = d.normalizeInput.priceExists;
    rec.normalizeInput_priceType = d.normalizeInput.priceType;
    rec.normalizedQuote_price = d.normalizedQuote.price;
    rec.normalizedQuote_priceType = d.normalizedQuote.priceType;
    rec.uiModel_price = q.price;
    rec.uiModel_priceType = typeof q.price;
    rec.displayed = Number.isFinite(Number(q.price)) ? String(Number(q.price)) : 'UNAVAILABLE';
    rec.parsingError = d.parsingError ? d.parsingError.message : null;
    checks(rec, [
      ['httpStatus == 200', rec.httpStatus === 200],
      ['parsedJson price exists == YES', rec.parsedJson_priceExists === 'YES'],
      ['normalizeInput price exists == YES', rec.normalizeInput_priceExists === 'YES'],
      ['normalizedQuote price numeric', rec.normalizedQuote_priceType === 'number' && Number.isFinite(rec.normalizedQuote_price)],
      ['UI model price numeric', rec.uiModel_priceType === 'number' && Number.isFinite(rec.uiModel_price)],
      ['displayed numeric', rec.displayed !== 'UNAVAILABLE'],
    ]);
  } catch (err) {
    rec.error = `${err.name}: ${err.message} (status ${err.status ?? 'n/a'})`;
    failures++;
  }
  out.test_connection[sym] = rec;
}

function checks(rec, list) {
  rec.assertions = {};
  for (const [name, ok] of list) {
    rec.assertions[name] = ok ? 'PASS' : 'FAIL';
    if (!ok) failures++;
  }
}

// ================= 2) Search URL preservation: AAPL GME MSFT NVDA ============
{
  // Capture the EXACT final URL _doFetch would request (buildUrl of the path
  // searchTickers assembled), answering with a synthetic envelope so no
  // authenticated call is attempted.
  const api = new TickerbotAPI({ baseURL: 'https://api.tickerbot.io', apiKey: '' });
  const captured = [];
  api._doFetch = async function (path) {
    const finalUrl = this.buildUrl(path);
    captured.push(finalUrl);
    return {
      data: { as_of: 'harness', count: 1, next_cursor: null, results: [{ ticker: 'X', name: 'X', asset_class: 'stocks' }] },
      meta: { status: 200, url: finalUrl, strategy: 'url-capture-harness', timestamp: Date.now() },
    };
  };
  for (const sym of ['AAPL', 'GME', 'MSFT', 'NVDA']) {
    await api.searchTickers(sym);
    const finalUrl = captured[captured.length - 1];
    const expected = `https://api.tickerbot.io/v2/tickers?search=${sym}`;
    const ok = finalUrl === expected && finalUrl.includes(`search=${sym}`);
    if (!ok) failures++;
    out.search_url_preservation[sym] = {
      requested: sym,
      finalTickerbotUrl: finalUrl,
      symbolPreservedInUrl: ok ? 'YES' : 'NO',
      assertion: ok ? 'PASS' : 'FAIL',
    };
  }

  // Live cross-check (keyless): the sandbox bulk lookup echoes each requested
  // symbol back, proving end-to-end symbol round-trip against the live server.
  const syms = ['AAPL', 'GME', 'MSFT', 'NVDA'];
  const res = await fetch(`https://api.tickerbot.io/v2/sandbox/tickers?tickers=${syms.join(',')}`);
  let bulk = null;
  try { bulk = await res.json(); } catch {}
  const echoed = Array.isArray(bulk?.results) ? bulk.results.map(r => r.ticker) : [];
  const allEchoed = syms.every(s => echoed.includes(s));
  if (!allEchoed) failures++;
  out.search_url_preservation._live_bulk_crosscheck = {
    requestUrl: `https://api.tickerbot.io/v2/sandbox/tickers?tickers=${syms.join(',')}`,
    httpStatus: res.status,
    symbolsReturned: echoed,
    allRequestedSymbolsReturned: allEchoed ? 'YES' : 'NO',
    assertion: allEchoed ? 'PASS' : 'FAIL',
  };
}

out.failures = failures;
console.log(JSON.stringify(out, null, 2));
process.exit(failures === 0 ? 0 : 1);
