// assets.js
// Watchlist and asset management controller.

import { storage } from './storage.js';
import {
  bus, esc, fmtPrice, fmtPct, fmtVolume, fmtTime, logger,
} from './utils.js';
import { toast } from './notifications.js';

const WATCHLIST_KEY = 'watchlist';

export class AssetsController {
  constructor(api) {
    this.api = api;
    this.sortBy = 'name';
    this.watchlist = this._loadWatchlist();
    this._bindMarketData();
  }

  _loadWatchlist() {
    const stored = storage.get(WATCHLIST_KEY, []);
    return Array.isArray(stored) ? stored : [];
  }

  _saveWatchlist() { storage.set(WATCHLIST_KEY, this.watchlist); }

  _bindMarketData() {
    bus.on('market-data:updated', results => {
      if (!Array.isArray(results)) return;

      for (const result of results) {
        const asset = this.getAsset(result.symbol);
        if (!asset) continue;

        if (result.quote) {
          asset.quote = result.quote;
          asset.updatedAt = Date.now();
        }

        asset.error = result.error || null;
      }

      this._saveWatchlist();
      this.renderWatchlist();
    });
  }

  getWatchlist() { return [...this.watchlist]; }

  getAsset(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.watchlist.find(
      asset => String(asset.symbol).toUpperCase() === normalized
    ) || null;
  }

  setSort(sort) {
    this.sortBy = sort || 'name';
    this.renderWatchlist();
  }

  async promptAdd(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) return;

    try {
      let asset = this.getAsset(normalized);
      if (!asset) asset = await this._resolveAsset(normalized);

      if (!asset) {
        toast(`Unable to find ${normalized}`, 'error');
        return;
      }

      this._populateConfirmModal(asset);

      const modal = document.querySelector('#confirm-modal');
      if (modal && typeof modal.showModal === 'function') modal.showModal();
    } catch (err) {
      logger.error('Unable to prepare asset:', err);
      toast(err.message || 'Unable to load asset', 'error');
    }
  }

  async _resolveAsset(symbol) {
    try {
      const quote = await this.api.getQuote(symbol);
      return {
        id: symbol,
        symbol,
        name: quote?.name || symbol,
        type: quote?.type || 'stock',
        exchange: quote?.exchange || '—',
        currency: quote?.currency || 'USD',
        quote,
        updatedAt: Date.now(),
      };
    } catch (err) {
      logger.warn('Quote lookup failed:', err);
      return {
        id: symbol, symbol, name: symbol, type: 'stock',
        exchange: '—', currency: 'USD', quote: null,
        error: err, updatedAt: null,
      };
    }
  }

  _populateConfirmModal(asset) {
    const set = (id, value) => {
      const el = document.querySelector(`#${id}`);
      if (el) el.textContent = value == null || value === '' ? '—' : String(value);
    };

    set('confirm-name', asset.name);
    set('confirm-symbol', asset.symbol);
    set('confirm-type', asset.type);
    set('confirm-exchange', asset.exchange);
    set('confirm-currency', asset.currency);

    const price = asset.quote?.price ?? asset.quote?.last ?? asset.quote?.close;
    set(
      'confirm-price',
      price != null ? fmtPrice(price, asset.currency || 'USD') : 'UNAVAILABLE'
    );

    this._pendingAsset = asset;
  }

  async addAsset(asset) {
    if (!asset?.symbol) return false;
    const symbol = String(asset.symbol).toUpperCase();

    if (this.getAsset(symbol)) {
      toast(`${symbol} is already in your watchlist`, 'info');
      return false;
    }

    const normalized = {
      ...asset,
      id: asset.id || symbol,
      symbol,
      name: asset.name || symbol,
      type: asset.type || 'stock',
      exchange: asset.exchange || '—',
      currency: asset.currency || 'USD',
      quote: asset.quote || null,
      updatedAt: asset.updatedAt || null,
    };

    this.watchlist.push(normalized);
    this._saveWatchlist();
    this.renderWatchlist();
    toast(`${symbol} added to watchlist`, 'success');
    bus.emit('watchlist:changed', this.getWatchlist());
    return true;
  }

  removeAsset(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    const before = this.watchlist.length;

    this.watchlist = this.watchlist.filter(
      asset => String(asset.symbol).toUpperCase() !== normalized
    );

    if (this.watchlist.length !== before) {
      this._saveWatchlist();
      this.renderWatchlist();
      bus.emit('watchlist:changed', this.getWatchlist());
      return true;
    }
    return false;
  }

  renderWatchlist() {
    const grid = document.querySelector('#watchlist-grid');
    const empty = document.querySelector('#watchlist-empty');
    const error = document.querySelector('#watchlist-error');
    if (!grid) return;

    if (error) error.hidden = true;

    const assets = [...this.watchlist].sort((a, b) => this._compare(a, b));

    if (!assets.length) {
      grid.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }

    if (empty) empty.hidden = true;
    grid.innerHTML = assets.map(asset => this._renderCard(asset)).join('');

    grid.querySelectorAll('[data-remove-symbol]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const symbol = btn.dataset.removeSymbol;
        if (confirm(`Remove ${symbol} from your watchlist?`)) this.removeAsset(symbol);
      });
    });

    grid.querySelectorAll('[data-open-symbol]').forEach(card => {
      card.addEventListener('click', () => {
        window.location.hash = `#/asset/${encodeURIComponent(card.dataset.openSymbol)}`;
      });
    });
  }

  _compare(a, b) {
    if (this.sortBy === 'ticker')
      return String(a.symbol).localeCompare(String(b.symbol));

    if (this.sortBy === 'price')
      return this._number(b.quote?.price) - this._number(a.quote?.price);

    if (this.sortBy === 'changePercent')
      return this._number(b.quote?.changePercent) - this._number(a.quote?.changePercent);

    if (this.sortBy === 'volume')
      return this._number(b.quote?.volume) - this._number(a.quote?.volume);

    return String(a.name || a.symbol).localeCompare(String(b.name || b.symbol));
  }

  _number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  _renderCard(asset) {
    const quote = asset.quote || {};
    const price = quote.price ?? quote.last ?? quote.close;
    const change = quote.changePercent ?? quote.percentChange ?? quote.changePct;
    const volume = quote.volume;

    const hasPrice = Number.isFinite(Number(price));
    const hasChange = Number.isFinite(Number(change));

    const changeClass =
      hasChange && Number(change) > 0 ? 'pos' :
      hasChange && Number(change) < 0 ? 'neg' : '';

    return `
      <article class="asset-card" data-open-symbol="${esc(asset.symbol)}" tabindex="0">
        <div class="asset-card__top">
          <div>
            <div class="asset-card__symbol">${esc(asset.symbol)}</div>
            <div class="asset-card__name">${esc(asset.name || '—')}</div>
          </div>
          <button type="button" class="icon-btn"
            data-remove-symbol="${esc(asset.symbol)}"
            title="Remove ${esc(asset.symbol)}"
            aria-label="Remove ${esc(asset.symbol)}">×</button>
        </div>
        <div class="asset-card__price">
          ${hasPrice ? esc(fmtPrice(price, asset.currency || 'USD')) : 'UNAVAILABLE'}
        </div>
        <div class="asset-card__meta">
          <span class="${changeClass}">${hasChange ? esc(fmtPct(change)) : '—'}</span>
          <span>Vol: ${volume != null ? esc(fmtVolume(volume)) : '—'}</span>
        </div>
        <div class="asset-card__footer">
          <span>${esc(asset.exchange || '—')}</span>
          <span>${asset.updatedAt ? esc(fmtTime(asset.updatedAt)) : '—'}</span>
        </div>
      </article>
    `;
  }
}

export default AssetsController;
