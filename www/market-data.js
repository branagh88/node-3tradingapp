// market-data.js
// Polling controller for live watchlist quotes.

import { DEFAULTS } from './config.js';
import { bus, logger } from './utils.js';

export class MarketData {
  constructor({ api, getAssets }) {
    this.api = api;
    this.getAssets = getAssets || (() => []);
    this.timer = null;
    this.running = false;
    this.refreshing = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();

    const interval =
      Number(this.api?.config?.settings?.pollInterval) ||
      DEFAULTS.settings.pollInterval || 30;

    this.timer = setInterval(
      () => this.refresh(),
      Math.max(interval, 5) * 1000
    );

    logger.info('Market data polling started');
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Market data polling stopped');
  }

  async refresh() {
    if (!this.running || this.refreshing) return [];
    this.refreshing = true;

    try {
      const assets = this.getAssets() || [];
      if (!assets.length) {
        bus.emit('market-data:updated', []);
        return [];
      }

      const symbolsMap = {};
      for (const asset of assets) {
        if (!asset?.symbol) continue;
        symbolsMap[String(asset.symbol).toUpperCase()] = asset.type || 'stock';
      }

      const results = await this.getQuotes(symbolsMap);
      bus.emit('market-data:updated', results);
      return results;
    } catch (err) {
      logger.error('Market data refresh failed:', err);
      bus.emit('api:error', {
        kind: err.kind || 'network',
        message: err.message || 'Market data refresh failed',
        fatal: false,
      });
      return [];
    } finally {
      this.refreshing = false;
    }
  }

  async getQuotes(symbolsMap) {
    const results = [];
    await Promise.all(
      Object.entries(symbolsMap).map(async ([symbol, type]) => {
        try {
          const quote = await this.api.getQuote(symbol, { type });
          results.push({ symbol, quote, error: null });
        } catch (err) {
          results.push({ symbol, quote: null, error: err });
        }
      })
    );
    return results;
  }
}

export default MarketData;
