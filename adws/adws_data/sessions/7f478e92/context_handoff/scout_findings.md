# Scout findings — Tickerbot zero historical data (root cause PROVEN)

## 1) API key search — NO key exists anywhere in this environment
Checked: project has no `.env` (only `.env.sample`, no Tickerbot entry);
`config.js:11` ships `apiKey: ''` and `loadConfig()` never returns a persisted key;
`secure-store.js:15` (`PREFS_KEY='tickerbot_api_key'`) / `storage.get('apikey')` —
runtime-only browser localStorage, not readable from CLI; `capacitor.config.json`
contains no key; `~/.pi/agent/studio/credentials/` contains only mesh-viewer secrets;
session logs scanned with redaction — no key strings. The key is user-entered via the
in-app Settings screen at runtime. Therefore all live calls below were made **keyless
via the documented anonymous sandbox route** `/v2/sandbox/...` (see docs note:
"Anonymously (the docs sandbox, no key) bars are scoped to the latest trading day").

## 2) Endpoint probes (keyless, sandbox)
- `GET /v2/sandbox/tickers/GME/bars/1d?limit=5` → **200**, envelope
  `{as_of, ticker, interval, count, coverage:'covered', next_cursor, bars:[{t,o,h,l,c,v}]}`.
  Sandbox caps to 1 bar (latest trading day); a real key lifts it to `limit`.
  AAPL control → 200 same shape. `5m` and `1h` intervals also 200 (GME covered).
- `GET /v2/sandbox/series?ticker=GME&range=1D&resolution=5m` → **200** but `range`
  and `resolution` are NOT recognized params — silently ignored. Defaults kick in:
  `interval=1d`, default columns `price/day_change_pct/relative_volume/market_cap`,
  50 rows returned in `series.GME` (rows like `{t:"2026-06-11", price:22.18,...}`).
- Direct `https://api.tickerbot.io/v2/*` without key → 401 `unauthenticated`
  (auth check precedes routing; can't distinguish 404 without a key).

## 3) THE MISMATCH (exact)
App call — `api.js:551-553` `getHistoricalData()`:
`GET /v2/series?ticker=GME&range=1D&resolution=5m`

Two independent defects:
a) **Wrong params**: `/v2/series` accepts `tickers|ticker`, `columns`, `interval`
   (`1m|1h|1d|1w|1q`), `from`, `to`, `asof`, `limit`, `cursor` (per
   https://tickerbot.io/docs/endpoints/series/get/). It has NO `range` or
   `resolution`; both are ignored → always full-history daily default grid,
   never intraday, never range-scoped.
b) **Wrong envelope for the parser**: series rows come back as an OBJECT keyed by
   ticker: `{..., series: { GME: [ {...} ] } }`. `api.js` getHistoricalData unwraps
   `data.data | data.candles | data.series` but requires `data.series` to be an
   ARRAY (`Array.isArray(data.series)`), so the object form yields `candles = []`
   → mapped `[]` → **zero historical data**. Even if it were an array, the row
   fields (`price`, `t` date-string) don't carry OHLCV, so charts would be flat.

**The correct chart endpoint is** `GET /v2/tickers/{ticker}/bars/{interval}`
(intervals `1s|1m|5m|15m|30m|1h|1d`, params `from`/`to`/`asof`/`before`/`limit`
max 1000/cursor). Returns compact OHLCV `bars:[{t(epoch-ms),o,h,l,c,v}]` — exactly
what getHistoricalData's mapper wants (`c.t/o/h/l/c/v`). Range mapping suggestion:
1D→bars/5m&from=today, 5D→bars/15m or 30m, 1M+→bars/1d&from=... .

## 4) Files of record
- `api.js:551-597` — getHistoricalData: wrong route + wrong params + array-only unwrap of `series`.
- `api.js:12` DEFAULT_BASE_URL `https://api.tickerbot.io`; web origin proxies via server.mjs `/v2/*`.
- `server.mjs` — reverse proxy preserving Bearer header (no key stored server-side).
- `secure-store.js:38-82` — key lives only in runtime storage (web localStorage / Capacitor prefs).

No files were modified.
