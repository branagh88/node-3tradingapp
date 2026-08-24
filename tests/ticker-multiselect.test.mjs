// tests/ticker-multiselect.test.mjs — Phase 10 pure builders in
// ticker-multiselect.js: compact summary strings (byte-exact), trigger and
// popover markup, estimate-panel HTML. Zero DOM, zero network.

import { describe, it, expect } from 'vitest';
import {
  buildMultiSelectSummary,
  buildMultiSelectTriggerHtml,
  buildMultiSelectPopoverHtml,
  buildRvEstimatePanelHtml,
} from '../ticker-multiselect.js';

describe('buildMultiSelectSummary — exact strings', () => {
  it('0 selected → Select tickers…', () => {
    expect(buildMultiSelectSummary([], 5)).toBe('Select tickers…');
    expect(buildMultiSelectSummary(null, 0)).toBe('Select tickers…');
  });

  it('1 selected → bare symbol', () => {
    expect(buildMultiSelectSummary(['AAPL'], 5)).toBe('AAPL');
  });

  it('2 selected → comma-joined', () => {
    expect(buildMultiSelectSummary(['AAPL', 'MSFT'], 5)).toBe('AAPL, MSFT');
  });

  it('3 selected → comma-joined', () => {
    expect(buildMultiSelectSummary(['AAPL', 'MSFT', 'NVDA'], 5)).toBe('AAPL, MSFT, NVDA');
  });

  it('4 selected → first two + counter', () => {
    expect(buildMultiSelectSummary(['AAPL', 'MSFT', 'NVDA', 'TSLA'], 6)).toBe('AAPL, MSFT +2');
  });

  it('whole watchlist selected → N tickers selected', () => {
    expect(buildMultiSelectSummary(['A', 'B', 'C', 'D', 'E'], 5)).toBe('5 tickers selected');
    expect(buildMultiSelectSummary(['X'], 1)).toBe('1 tickers selected');
  });

  it('escapes/uppercases odd symbols safely', () => {
    const out = buildMultiSelectSummary(['<b>&</b>'], 3);
    expect(out).toBe('<B>&</B>');
    const trig = buildMultiSelectTriggerHtml('<script>x</script>');
    expect(trig).not.toContain('<script>');
    expect(trig).toContain('&lt;script&gt;');
  });
});

describe('popover / trigger markup builders', () => {
  it('trigger carries aria-expanded=false + aria-haspopup', () => {
    const html = buildMultiSelectTriggerHtml('Select tickers…');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="true"');
    expect(html).toContain('class="ms-trigger"');
    expect(html).toContain('ms-summary');
  });

  it('popover uses the id prefix for unique ids and wraps chips in role=group', () => {
    const html = buildMultiSelectPopoverHtml('<label>x</label>', { idPrefix: 'hd' });
    expect(html).toContain('id="hd-select-all"');
    expect(html).toContain('id="hd-clear-all"');
    expect(html).toContain('id="hd-tickers"');
    expect(html).toContain('role="group"');
    expect(html).toContain('chip-row');
    expect(html).toContain('Select all');
    expect(html).toContain('Clear all');

    const other = buildMultiSelectPopoverHtml('', { idPrefix: 'rv' });
    expect(other).toContain('id="rv-tickers"');
    expect(other).not.toContain('id="hd-');
  });
});

describe('buildRvEstimatePanelHtml', () => {
  it('renders cached vs fresh lines and the request total', () => {
    const html = buildRvEstimatePanelHtml(
      [{ ticker: 'AAPL', cached: true, valid: true }, { ticker: 'MSFT', cached: false, valid: false }],
      { pagesPerTicker: 8, totalEstimatedCalls: 8 },
    );
    expect(html).toContain('Per-ticker status:');
    expect(html).toContain('✓ AAPL — cached (COMPLETE, 0 requests needed)');
    expect(html).toContain('✗ MSFT — needs data (~8 requests)');
    expect(html).toContain('New API requests required: 8');
  });

  it('is safe against injection', () => {
    const html = buildRvEstimatePanelHtml([{ ticker: '<img onerror=x>', valid: false }], { pagesPerTicker: 1, totalEstimatedCalls: 1 });
    expect(html).not.toContain('<img ');
    expect(html.toLowerCase()).toContain('&lt;img');
  });
});
