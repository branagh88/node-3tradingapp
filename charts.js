// charts.js — ChartController (specs/phase1.md B2.8, B8).
// Lightweight Charts v4.2.3 (CDN, pinned): candlesticks + volume histogram +
// crosshair + tooltip, timeframe selection, SMA/EMA overlays and RSI subchart.
// Only renders candles fetched from the API (ma.candleCache, TTL 5 min) —
// empty history renders an UNAVAILABLE state, never synthetic data.

import { TIMEFRAMES, TIMEFRAME_DEFAULT } from './config.js';
import { INDICATORS, INDICATOR_META, DEFAULT_INDICATOR_TOGGLES } from './indicators.js';
import { storage } from './storage.js';
import { bus, logger, esc } from './utils.js';

const CANDLE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAIN_HEIGHT = 400;
const RSI_HEIGHT = 140;
const COLORS = {
  up: '#3aa876',
  down: '#d06161',
  text: '#8b93a7',
  border: 'rgba(148,163,184,0.2)',
  grid: 'rgba(148,163,184,0.08)',
};

function candleKey(symbol, tf) {
  return `${symbol}:${tf.range}:${tf.resolution}`;
}

export class ChartController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mainEl, opts.volumeEl (unused separately), opts.rsiEl, opts.wrapEl
   * @param {HTMLElement} opts.timeframeEl, opts.indicatorEl, opts.emptyEl, opts.tooltipEl, opts.statusEl
   * @param {import('./api.js').MarketAPI} opts.api
   * @param {() => object|null} opts.getAsset  returns watchlist entry for symbol
   */
  constructor({ mainEl, rsiEl, wrapEl, timeframeEl, indicatorEl, emptyEl, tooltipEl, statusEl, api, getAsset }) {
    this.mainEl = mainEl;
    this.rsiEl = rsiEl;
    this.wrapEl = wrapEl;
    this.timeframeEl = timeframeEl;
    this.indicatorEl = indicatorEl;
    this.emptyEl = emptyEl;
    this.tooltipEl = tooltipEl;
    this.statusEl = statusEl;
    this.api = api;
    this.getAsset = getAsset || (() => null);

    this.candleCache = storage.collection('candleCache');

    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.indSeries = {}; // key -> series
    this.rsiChart = null;
    this.rsiSeries = null;
    this.rsiLines = [];

    this.toggles = { ...DEFAULT_INDICATOR_TOGGLES };
    this.timeframes = TIMEFRAMES.stock;
    this.activeTf = TIMEFRAME_DEFAULT;
    this.symbol = null;
    this.assetType = 'stock';
    this.candles = [];
    this.resizeObserver = null;
    this.tooltipCleanup = null;
    this._destroyed = false;
  }

  // -------------------------------------------------------------------------
  // Rendering entry point
  // -------------------------------------------------------------------------
  async renderAsset(symbol) {
    this._destroyed = false;
    this.symbol = String(symbol).toUpperCase();
    const entry = this.getAsset(this.symbol);
    this.assetType = entry && entry.type === 'crypto' ? 'crypto' : 'stock';
    this.timeframes = TIMEFRAMES[this.assetType];

    this._renderTimeframeBar();
    this._renderIndicatorBar();
    this._clearStatus();

    // Default timeframe: 1D
    const defaultTf = this.timeframes.find((t) => t.id === '1D') || this.timeframes[0] || TIMEFRAME_DEFAULT;
    await this.setTimeframe(defaultTf, { renderCharts: true });
  }

  // -------------------------------------------------------------------------
  // Timeframe handling
  // -------------------------------------------------------------------------
  async setTimeframe(tf, { renderCharts = false } = {}) {
    if (!tf) return;
    this.activeTf = tf;
    this._markActiveTf();
    await this._loadCandles();
    this._renderCharts(); // recreate charts per spec (preserves indicator toggles)
    this._updateStatus();
  }

  async _loadCandles() {
    if (!this.symbol) return;
    const key = candleKey(this.symbol, this.activeTf);
    const cached = this.candleCache.get(key);
    if (cached && cached.candles && Date.now() - (cached.fetchedAt || 0) < CANDLE_CACHE_TTL_MS) {
      this.candles = cached.candles;
      logger.debug('charts: candles from cache', { key });
      return;
    }
    this._setStatus('Loading candles…', 'dim');
    try {
      const candles = await this.api.getHistoricalData(
        this.symbol,
        this.activeTf.range,
        this.activeTf.resolution,
      );
      // Ignore stale responses when the user already switched timeframe/asset.
      if (this._destroyed || !this.symbol || !this.activeTf || candleKey(this.symbol, this.activeTf) !== key) return;
      this.candles = Array.isArray(candles) ? candles : [];
      this.candleCache.put({ id: key, candles: this.candles, fetchedAt: Date.now() });
      console.log(`HISTORY UI UPDATE symbol=${this.symbol} key=${key} bars=${this.candles.length}`);
    } catch (err) {
      if (this._destroyed || candleKey(this.symbol, this.activeTf) !== key) return;
      console.error(`HISTORY REQUEST ERROR name=${err && err.name} message=${err && err.message} status=${(err && err.status) ?? 'N/A'}`);
      logger.warn('charts: candle fetch failed', { symbol: this.symbol, kind: err.kind });
      this.candles = [];
      bus.emit('api:error', { kind: err.kind, message: err.message, fatal: false });
      // Visible diagnostic error in the status bar — never a silent failure.
      this._setStatus(apiErrorMessage(err), 'error');
    } finally {
      // ALWAYS clear the 'Loading candles…' state, success or failure.
      if (!this._destroyed && this.activeTf && candleKey(this.symbol, this.activeTf) === key
          && this.statusEl && !this.statusEl.hidden && /Loading candles/.test(this.statusEl.textContent || '')) {
        this._clearStatus();
        console.log('HISTORY LOADING CLEARED');
      }
    }
  }

  _renderCharts() {
    if (this._destroyed) return;
    this.destroyCharts();
    if (!this.candles || this.candles.length === 0) {
      this._showEmptyState(true);
      return;
    }
    if (typeof window === 'undefined' || !window.LightweightCharts) {
      this._showEmptyState(true);
      this._setStatus('Chart library failed to load — check network access to the Lightweight Charts CDN', 'error');
      return;
    }
    this._showEmptyState(false);
    if (!this.wrapEl.offsetWidth || !this.wrapEl.offsetHeight) {
      // Screen hidden/zero-sized; retry on next visible pass (router re-renders).
      return;
    }
    this._createMainChart();

    for (const key of Object.keys(this.toggles)) {
      if (this.toggles[key] && key !== 'rsi') this._addOverlay(key);
    }
    if (this.toggles.rsi) this._createRsiChart();
    this._setupTooltip();
    this._setupResizeObserver();
  }

  _createMainChart() {
    const width = Math.max(this.wrapEl.clientWidth || this.wrapEl.offsetWidth, 320);
    this.chart = window.LightweightCharts.createChart(this.mainEl, {
      width,
      height: MAIN_HEIGHT,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(91,141,239,0.5)', labelBackgroundColor: '#2a3650' },
        horzLine: { color: 'rgba(91,141,239,0.5)', labelBackgroundColor: '#2a3650' },
      },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
      },
    });

    this.candleSeries = this.chart.addSeries(window.LightweightCharts.CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      priceLineVisible: false,
    });
    this.candleSeries.setData(this.candles);

    // Volume histogram in bottom 20% via overlay scale margins
    this.volumeSeries = this.chart.addSeries(window.LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const volData = this.candles.map((c) => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? 'rgba(58,168,118,0.35)' : 'rgba(208,97,97,0.35)',
    }));
    this.volumeSeries.setData(volData);
  }

  // Indicator overlay line on the main pane
  _addOverlay(key) {
    if (!this.chart) return;
    if (this.indSeries[key]) return;
    const meta = INDICATOR_META[key];
    const line = INDICATORS[key](this.candles);
    if (!line || line.length === 0) {
      // Insufficient history — surfaced as a tooltip on the chip + status line.
      this._markInsufficient(key);
      return;
    }
    const series = this.chart.addSeries(window.LightweightCharts.LineSeries, {
      color: meta ? meta.color : COLORS.text,
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: meta ? meta.label : key,
    });
    series.setData(line);
    this.indSeries[key] = series;
    this._clearInsufficient(key);
  }

  _removeOverlay(key) {
    if (this.indSeries[key]) {
      this.chart.removeSeries(this.indSeries[key]);
      delete this.indSeries[key];
    }
    this._clearInsufficient(key);
  }

  _createRsiChart() {
    if (!this.chart) return;
    const width = Math.max(this.wrapEl.clientWidth || this.wrapEl.offsetWidth, 320);
    this.rsiEl.hidden = false;
    this.rsiChart = window.LightweightCharts.createChart(this.rsiEl, {
      width,
      height: RSI_HEIGHT,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    this.rsiSeries = this.rsiChart.addSeries(window.LightweightCharts.LineSeries, {
      color: INDICATOR_META.rsi.color,
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: 'RSI 14',
    });

    const rsiLine = INDICATORS.rsi(this.candles);
    this.rsiHasData = Boolean(rsiLine && rsiLine.length);
    if (this.rsiHasData) {
      this.rsiSeries.setData(rsiLine);
      this._clearInsufficient('rsi');
    } else {
      this._markInsufficient('rsi');
    }

    // 30 / 70 guide lines (dashed)
    const addGuide = (price) => {
      const line = this.rsiSeries.createPriceLine({
        price,
        color: 'rgba(224,166,60,0.45)',
        lineWidth: 1,
        lineStyle: window.LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
        title: String(price),
      });
      this.rsiLines.push(line);
    };
    addGuide(70);
    addGuide(30);

    // Sync time scales both directions
    this._syncRsi = () => {
      const range = this.chart.timeScale().getVisibleLogicalRange();
      if (range && this.rsiChart) this.rsiChart.timeScale().setVisibleLogicalRange(range);
    };
    this._syncMain = () => {
      const range = this.rsiChart.timeScale().getVisibleLogicalRange();
      if (range && this.chart) this.chart.timeScale().setVisibleLogicalRange(range);
    };
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this._syncRsi);
    this.rsiChart.timeScale().subscribeVisibleLogicalRangeChange(this._syncMain);
  }

  // -------------------------------------------------------------------------
  // Tooltip (crosshair)
  // -------------------------------------------------------------------------
  _setupTooltip() {
    if (!this.chart) return;
    this.tooltipEl.hidden = false;
    this.tooltipCleanup = this.chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point) {
        if (this.tooltipEl) this.tooltipEl.hidden = true;
        return;
      }
      const data = param.seriesData && param.seriesData.get(this.candleSeries);
      if (!data || data.open == null) {
        if (this.tooltipEl) this.tooltipEl.hidden = true;
        return;
      }
      const prevClose = this._prevClose(data.time);
      const pct = prevClose && prevClose !== 0 && data.close != null ? ((data.close - prevClose) / prevClose) * 100 : null;
      const html =
        `<div class="tt-title">OHLCV</div>` +
        `<div class="tt-row"><span>O</span><b>${fmtNum(data.open)}</b><span>H</span><b>${fmtNum(data.high)}</b></div>` +
        `<div class="tt-row"><span>L</span><b>${fmtNum(data.low)}</b><span>C</span><b>${fmtNum(data.close)}</b></div>` +
        `<div class="tt-row"><span>Vol</span><b>${fmtVol(data.volume)}</b></div>` +
        (pct != null
          ? `<div class="tt-pct ${pct >= 0 ? 'pos' : 'neg'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}% vs prev close</div>`
          : '');
      this.tooltipEl.innerHTML = html;
      this.tooltipEl.hidden = false;
      const wrap = this.wrapEl.getBoundingClientRect();
      const x = param.point.x + 12;
      const y = param.point.y + 8;
      this.tooltipEl.style.left = `${Math.min(x, wrap.width - 160)}px`;
      this.tooltipEl.style.top = `${y}px`;
    });
  }

  _prevClose(time) {
    const idx = this.candles.findIndex((c) => c.time === time);
    if (idx <= 0) return null;
    return this.candles[idx - 1].close;
  }

  // -------------------------------------------------------------------------
  // Indicator toggles
  // -------------------------------------------------------------------------
  toggleIndicator(key, on) {
    if (!(key in this.toggles)) return;
    this.toggles[key] = Boolean(on);
    if (key === 'rsi') {
      if (on) this._createRsiChart();
      else this._destroyRsiChart();
      this._markActiveIndicators();
      return;
    }
    if (on) this._addOverlay(key);
    else this._removeOverlay(key);
    this._markActiveIndicators();
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------
  _setupResizeObserver() {
    this._teardownResizeObserver();
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this._destroyed || !this.chart) return;
      const width = Math.max(this.wrapEl.clientWidth || 320, 320);
      this.chart.applyOptions({ width });
      if (this.rsiChart) this.rsiChart.applyOptions({ width });
    });
    this.resizeObserver.observe(this.wrapEl);
  }

  _teardownResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  // -------------------------------------------------------------------------
  // Bars / toggles rendering
  // -------------------------------------------------------------------------
  _renderTimeframeBar() {
    if (!this.timeframeEl) return;
    this.timeframeEl.innerHTML = (this.timeframes || [])
      .map((tf) => `<button class="chip" data-tf="${esc(tf.id)}">${esc(tf.label)}</button>`)
      .join('');
    this.timeframeEl.querySelectorAll('button[data-tf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tf = this.timeframes.find((t) => t.id === btn.dataset.tf);
        if (tf) this.setTimeframe(tf);
      });
    });
    this._markActiveTf();
  }

  _markActiveTf() {
    if (!this.timeframeEl) return;
    this.timeframeEl.querySelectorAll('button[data-tf]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tf === (this.activeTf && this.activeTf.id));
    });
  }

  _renderIndicatorBar() {
    if (!this.indicatorEl) return;
    this.indicatorEl.innerHTML = Object.keys(INDICATOR_META)
      .map((key) => {
        const meta = INDICATOR_META[key];
        const checked = this.toggles[key] ? '☑' : '☐';
        return `<button class="chip chip--ind" data-ind="${esc(key)}" title="${esc(meta.label)}">${checked} ${esc(meta.label)}</button>`;
      })
      .join('');
    this.indicatorEl.querySelectorAll('button[data-ind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.ind;
        this.toggleIndicator(key, !this.toggles[key]);
      });
    });
    this._markActiveIndicators();
  }

  _markActiveIndicators() {
    if (!this.indicatorEl) return;
    this.indicatorEl.querySelectorAll('button[data-ind]').forEach((btn) => {
      btn.classList.toggle('active', Boolean(this.toggles[btn.dataset.ind]));
    });
  }

  _markInsufficient(key) {
    const btn = this.indicatorEl && this.indicatorEl.querySelector(`button[data-ind="${key}"]`);
    if (btn) {
      btn.classList.add('insufficient');
      btn.title = `Insufficient history for ${INDICATOR_META[key].label}`;
    }
  }

  _clearInsufficient(key) {
    const btn = this.indicatorEl && this.indicatorEl.querySelector(`button[data-ind="${key}"]`);
    if (btn) {
      btn.classList.remove('insufficient');
      btn.title = INDICATOR_META[key].label;
    }
  }

  // -------------------------------------------------------------------------
  // Status / empty states
  // -------------------------------------------------------------------------
  _setStatus(message, kind = 'dim') {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `chart-status chart-status--${kind}`;
    this.statusEl.hidden = false;
  }

  _clearStatus() {
    if (this.statusEl) this.statusEl.hidden = true;
  }

  _updateStatus() {
    if (this._destroyed) return;
    if (!this.candles || this.candles.length === 0) {
      this._setStatus('UNAVAILABLE — no historical data for this asset/timeframe', 'error');
      return;
    }
    const insuff = Object.keys(this.toggles).filter((k) => this.toggles[k] && this._overlayEmpty(k));
    if (insuff.length) {
      const labels = insuff.map((k) => INDICATOR_META[k].label).join(', ');
      this._setStatus(`Insufficient history for ${labels}`, 'warn');
    } else {
      this._clearStatus();
    }
  }

  _overlayEmpty(key) {
    if (key === 'rsi') return !this.rsiHasData;
    return !this.indSeries[key];
  }

  _showEmptyState(show) {
    if (!this.emptyEl) return;
    this.emptyEl.hidden = !show;
    if (this.mainEl) this.mainEl.hidden = show;
    if (this.rsiEl) this.rsiEl.hidden = show;
    this.tooltipEl.hidden = show;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------
  destroyCharts() {
    this._teardownResizeObserver();
    if (this._syncRsi && this.chart) {
      try {
        this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._syncRsi);
      } catch {
        /* noop */
      }
    }
    if (this._syncMain && this.rsiChart) {
      try {
        this.rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(this._syncMain);
      } catch {
        /* noop */
      }
    }
    if (this.chart) {
      try {
        this.chart.remove();
      } catch {
        /* noop */
      }
    }
    if (this.rsiChart) {
      try {
        this.rsiChart.remove();
      } catch {
        /* noop */
      }
    }
    this.chart = null;
    this.rsiChart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.rsiSeries = null;
    this.rsiHasData = false;
    this.indSeries = {};
    this.rsiLines = [];
    this._syncRsi = null;
    this._syncMain = null;
    this.tooltipCleanup = null;
    if (this.mainEl) this.mainEl.innerHTML = '';
    if (this.rsiEl) {
      this.rsiEl.hidden = true;
      this.rsiEl.innerHTML = '';
    }
    this.tooltipEl.hidden = true;
  }

  _destroyRsiChart() {
    if (this.rsiChart) {
      try {
        this.rsiChart.remove();
      } catch {
        /* noop */
      }
    }
    this.rsiChart = null;
    this.rsiSeries = null;
    if (this.rsiEl) {
      this.rsiEl.hidden = true;
      this.rsiEl.innerHTML = '';
    }
  }

  destroy() {
    this._destroyed = true;
    this.destroyCharts();
  }
}

function fmtNum(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fmtVol(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function apiErrorMessage(err) {
  if (!err) return 'UNAVAILABLE — no historical data (request failed)';
  if (err.kind === 'network') return 'UNAVAILABLE — network error (CORS or offline; see README for a dev proxy)';
  if (err.kind === 'timeout') return 'UNAVAILABLE — request timed out';
  if (err.kind === 'auth') return 'UNAVAILABLE — invalid API key';
  if (err.kind === 'rate_limit') return 'UNAVAILABLE — rate limited';
  if (err.kind === 'not_found') return 'UNAVAILABLE — candles endpoint not found (check Settings)';
  return 'UNAVAILABLE — no historical data';
}