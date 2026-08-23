# Scout findings — AAPL/5D/15m: 256 normalized candles but blank chart + 'UNAVAILABLE'

## Root cause (one line)
`charts.js` uses the **Lightweight Charts v5** series API (`chart.addSeries(CandlestickSeries)`), but
`index.html:10` pins **lightweight-charts@4.2.3**, where `LightweightCharts.CandlestickSeries` is
`undefined` and `chart.addSeries` does not exist. `_createMainChart()` therefore throws
(TypeError: addSeries is not a function / undefined definition) AFTER `destroyCharts()` has already
wiped the old chart and AFTER the 256 candles were successfully fetched and stored — so the chart is
blank and the stale UNAVAILABLE status from a previous failed load is never cleared.

## Stage trace (file:line evidence)

1. **getHistoricalData return** — `api.js:582-683`. Fetches
   `/v2/tickers/{sym}/bars/{interval}` (5D→15m per RANGE_MAP `api.js:588`), unwraps `bars|data|candles`
   or bare array (`api.js:630-650`), maps to `{time,open,high,low,close,volume}` (`api.js:652-660`),
   sets `histDiag.counts.normalized = mapped.length` (`api.js:671`) → device diagnostic NORMALIZED CANDLES=256,
   returns `mapped` (`api.js:676`). Caller awaiting it: `charts.js:110-113` inside `_loadCandles()`.
2. **Receiver** — `this.candles` on ChartController (`charts.js:117`: `this.candles = Array.isArray(candles) ? candles : []`),
   also cached in `this.candleCache` under key `${symbol}:${range}:${resolution}` (`charts.js:118`, key fn `charts.js:23`).
   Success guard at `charts.js:116` passes (no symbol/tf switch) → assignment DOES happen.
3. **UNAVAILABLE condition** — `ChartController._updateStatus()` `charts.js:479-482`:
   `if (!this.candles || this.candles.length === 0) this._setStatus('UNAVAILABLE — no historical data for this asset/timeframe','error')`.
   It checks `this.candles`, which holds **256** — BUT `_updateStatus()` is never reached in this run (see stage 6).
   The visible message is the STALE one left by an earlier failed/empty load (same setter, `charts.js:481`,
   or the catch path `charts.js:126-128`). Status is only cleared via `_clearStatus()` (`charts.js:491`)
   called from `_updateStatus` success branch or a fresh `renderAsset`.
4. **Renderer input** — `candleSeries.setData(this.candles)` at `charts.js:198`; volume at `charts.js:216`.
   These lines are NEVER EXECUTED: `this.candleSeries = this.chart.addSeries(...)` at `charts.js:195`
   throws first because `window.LightweightCharts.CandlestickSeries` is undefined under v4.2.3
   (v4 uses `chart.addCandlestickSeries()`; `addSeries(defs)` is the v5 API). So rendered candles = 0.
5. **Lifecycle** — init once at boot (`app.js:90-99`); `renderAsset(symbol)` (`app.js:243` → `charts.js:70-85`)
   resets `_destroyed=false`, renders bars, calls `setTimeframe(defaultTf 1D)`; timeframe clicks call
   `setTimeframe(tf)` (`charts.js:408-411`) which does `await _loadCandles(); _renderCharts(); _updateStatus();`
   (`charts.js:73-78`). `_renderCharts()` (`charts.js:139-166`) FIRST calls `destroyCharts()`
   (`charts.js:145`, impl `charts.js:520-566` — clears DOM, nulls series) THEN checks candles/library.
   Stale-response guards exist (`charts.js:116,121`), finally-block only clears 'Loading…' text
   (`charts.js:129-136`); no listener overwrites populated state; quote polling (`market-data.js:25`)
   does not touch the chart. The killer: no try/catch around `_renderCharts()`/`_createMainChart()`,
   so the throw escapes `setTimeframe` → unhandled promise rejection from `renderAsset`.
6. **FIRST disconnect after NORMALIZED=256** — candles are intact in `this.candles` (charts.js:117);
   the data→renderer link breaks at `charts.js:195` when `addSeries` throws under the v4 library.
   Because the throw happens between `destroyCharts()` and `_updateStatus()`, the empty chart container
   is left wiped and the status bar keeps showing the older UNAVAILABLE text indefinitely
   (`_clearStatus`/success branch never runs). On first-ever open the sequence is identical except the
   initial UNAVAILABLE comes from the same throw path leaving whatever status preceded it.

## Report JSON summary fields
- getHistoricalData: 256 ✓ | caller variable: `candles` → `this.candles` (charts.js:110-118)
- chart state: `this.candles`=256, `candleCache` populated, but `this.candleSeries=null` (throw)
- availability variable: `this.candles.length` in `_updateStatus` (charts.js:480) — TRUE-empty display is stale text
- renderer input: `candleSeries.setData(this.candles)` (charts.js:198) never reached
- rendered candles: 0 | UI unavailable condition: VISIBLE (stale), though `this.candles` is non-empty

## MINIMAL fix (do NOT implement here)
One-line change in `index.html:10` (and `www/index.html:10`): pin the v5 build the code was written for,
e.g. `https://cdn.jsdelivr.net/npm/lightweight-charts@5.0.7/dist/lightweight-charts.standalone.production.js`
— OR equivalently revert charts.js:195/207/234/272 to the v4 API (`addCandlestickSeries()`,
`addHistogramSeries()`, `addLineSeries()`). The CDN pin swap is the single smallest edit.
(Secondary hardening, optional: wrap `this._renderCharts()` in setTimeframe in try/catch so a renderer
throw can't leave a stale status bar.)

No files were modified.
