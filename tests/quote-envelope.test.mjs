// tests/quote-envelope.test.mjs — regression tests for the Tickerbot quote
// pipeline envelope unwrap (GET /v2/tickers/{ticker} returns HTTP 200 with
// {"as_of":..., "ticker":"AAPL", "data":{"price":...}}).
//
// These tests use the EXACT observed live shapes and must FAIL before the
// adapter-level unwrap fix and PASS after it.
//
// Run: npx vitest run tests/quote-envelope.test.mjs

import { describe, it, expect } from 'vitest';
import { MarketAPI } from '../api.js';

function makeApi() {
  return new MarketAPI({
    apiKey: 'test-key',
    settings: { timeoutMs: 5000 },
  });
}

// Stub the transport so no network is touched: _doFetch returns the raw
// parsed payload exactly as the real endpoint would.
function stubFetch(api, payload) {
  api._doFetch = async () => ({
    data: JSON.parse(JSON.stringify(payload)),
    meta: { status: 200, url: '/v2/tickers/STUB', strategy: 'stub', strategyErrors: [], timestamp: Date.now() },
  });
}

describe('Tickerbot quote envelope unwrap', () => {
  it('AAPL: {"as_of","ticker","data":{price}} normalizes to ticker AAPL, numeric price 123.45', async () => {
    const api = makeApi();
    stubFetch(api, { as_of: '2024-06-03T15:00:00Z', ticker: 'AAPL', data: { price: 123.45 } });
    const quote = await api.getTickerQuote('AAPL');
    expect(quote.symbol).toBe('AAPL');
    expect(quote.price).toBe(123.45);
    expect(typeof quote.price).toBe('number');
    expect(quote._debug?.parsingError).toBeUndefined();
  });

  it('GME: {"as_of","ticker","data":{price}} normalizes to ticker GME, numeric price 24.6', async () => {
    const api = makeApi();
    stubFetch(api, { as_of: '2024-06-04T16:00:00Z', ticker: 'GME', data: { price: 24.6 } });
    const quote = await api.getTickerQuote('GME');
    expect(quote.symbol).toBe('GME');
    expect(quote.price).toBe(24.6);
    expect(typeof quote.price).toBe('number');
    expect(quote._debug?.parsingError).toBeUndefined();
  });

  it('preserves ALL fields from data without discarding any', async () => {
    const api = makeApi();
    stubFetch(api, {
      as_of: '2024-06-03T15:00:00Z',
      ticker: 'AAPL',
      data: {
        price: 123.45,
        previous_close: 120.0,
        day_change: 3.45,
        day_change_pct: 2.875,
        volume_today: 55_000_000,
        currency_name: 'usd',
        exchange: 'NASDAQ',
      },
    });
    const quote = await api.getTickerQuote('AAPL');
    expect(quote.symbol).toBe('AAPL');
    expect(quote.price).toBe(123.45);
    expect(quote.previousClose).toBe(120.0);
    expect(quote.change).toBe(3.45);
    expect(quote.changePercent).toBe(2.875);
    expect(quote.volume).toBe(55_000_000);
    expect(quote.currency).toBe('usd');
    expect(quote.exchange).toBe('NASDAQ');
  });

  it('diagnostic path also unwraps the envelope (price present in normalized quote)', async () => {
    const api = makeApi();
    stubFetch(api, { as_of: '2024-06-03T15:00:00Z', ticker: 'AAPL', data: { price: 123.45 } });
    // getTickerQuoteDiagnostic uses _diagCapture inside _doFetch; our stub
    // bypasses that, so exercise the same normalize call via the diagnostic
    // method's public surface.
    const diag = await api.getTickerQuoteDiagnostic('AAPL');
    expect(diag._debug.diag.normalizedQuote.price).toBe(123.45);
    expect(diag.price).toBe(123.45);
  });
});
