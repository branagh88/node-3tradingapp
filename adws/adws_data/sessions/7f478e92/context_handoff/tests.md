# Test pass notes — getHistoricalData regression tests

## What was added
`tests/historical-data.test.mjs` — 11 Vitest tests covering `getHistoricalData` in `api.js`.
Transport (`_doFetch`) is stubbed per the existing repo pattern (`tests/quote-envelope.test.mjs`);
the stub records every requested path so request-shape is asserted without network.

## Coverage
- Request shape: `GET /v2/tickers/{ticker}/bars/{interval}` for GME/AAPL;
  interval mapping 1D→5m, 5D→15m, 1M/3M/1Y→1d; from/to epoch-ms integers
  anchored around now with the exact window span; `limit=1000`; ticker uppercased.
- Parsing: documented `{as_of,ticker,interval,count,next_cursor,bars:[{t,o,h,l,c,v}]}` envelope
  (epoch-ms `t`) → multiple chronologically ordered candles with numeric o/h/l/c/v,
  first/last timestamps preserved (converted to epoch seconds), values untouched.
- Bare-array variant parses identically.
- Failing-if-empty guard: `expect(candles.length).toBeGreaterThan(0)` on valid payloads,
  so a silent empty series regresses.
- Edge: unknown range falls back to 1D mapping; empty `bars:[]` → `[]`.
- Failure: `_doFetch` throwing ApiError(500) degrades to `[]`, never throws.

## Result
`npm test` (vitest run): **4 files / 20 tests passed** (11 new).

## Notes for next agent
- `getHistoricalData` does NOT sort server output — ordering tests feed ascending bars and
  assert order is preserved. If chronological sorting becomes required regardless of server
  order, that's an implementation change (out of scope here).
- Live verification against api.tickerbot.io still needs a real API key (none in this env);
  keyless sandbox check noted in previous envelope remains a manual step.
