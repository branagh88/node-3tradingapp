// tests/real-validation-ui-render.test.mjs — offline render tests for the
// RUN REAL VALIDATION results UI (real-validation-ui.js). Verifies the
// responsive presentation contract: desktop table + narrow-screen stacked
// horizon cards, distinct verdict badges, edge-pp color coding, and that
// every pooled-table field is preserved in the card representation.

import { describe, it, expect } from 'vitest';
import {
  renderRealValidationResults,
  rvHorizonCard,
  rvVerdictBadge,
  rvEdgeCell,
} from '../real-validation-ui.js';

function pooledCell(overrides = {}) {
  return {
    predictions: 120,
    accuracyPct: 56.7,
    wilsonLowPct: 47.5,
    wilsonHighPct: 65.4,
    bestBaselinePct: 52.1,
    edgeVsBestBaselinePp: 4.6,
    significance: { pValue: 0.031 },
    verdict: 'EDGE',
    overlapAwareEdge: true,
    bootstrapCI: { lowPct: 48.2, highPct: 64.9 },
    ...overrides,
  };
}

function sampleReport() {
  return {
    requested: ['AAPL'],
    depth: '1y',
    included: ['AAPL'],
    skipped: [{ ticker: 'XYZ', reason: 'insufficient history: 10 candles (<200)' }],
    perTicker: {
      AAPL: {
        status: 'COMPLETE', candles: 252, dateRange: '2025-01-01..2026-01-01',
        apiRequests: 1, fromCache: false,
      },
    },
    pooled: {
      1: pooledCell(),
      3: pooledCell({ verdict: 'NO EDGE', edgeVsBestBaselinePp: -2.3, overlapAwareEdge: false }),
      5: pooledCell({ verdict: 'INSUFFICIENT EVIDENCE', edgeVsBestBaselinePp: 0 }),
      10: pooledCell({ verdict: 'EDGE', bootstrapCI: null }),
    },
    totals: { apiCallsSpent: 3, cachedDatasets: 0, freshDatasets: 1 },
    disclaimer: 'Descriptive historical evaluation — NOT a forecast.',
  };
}

describe('rvVerdictBadge', () => {
  it('uses a visually distinct class per verdict', () => {
    expect(rvVerdictBadge('EDGE')).toContain('badge--edge');
    expect(rvVerdictBadge('NO EDGE')).toContain('badge--no-edge');
    expect(rvVerdictBadge('INSUFFICIENT EVIDENCE')).toContain('badge--insufficient');
    expect(rvVerdictBadge('EDGE')).not.toBe(rvVerdictBadge('NO EDGE'));
  });

  it('escapes the verdict text', () => {
    expect(rvVerdictBadge('<b>x</b>')).toContain('&lt;b&gt;');
  });
});

describe('rvEdgeCell color coding', () => {
  it('marks positive edge green and negative red', () => {
    expect(rvEdgeCell(4.6)).toContain('rv-edge--pos');
    expect(rvEdgeCell(-2.3)).toContain('rv-edge--neg');
    expect(rvEdgeCell(0)).toContain('rv-edge--zero');
    expect(rvEdgeCell(null)).toBe('\u2014');
  });
});

describe('renderRealValidationResults', () => {
  const html = renderRealValidationResults(sampleReport());

  it('renders the desktop pooled table with all columns', () => {
    expect(html).toContain('rv-pooled-table');
    for (const col of ['H', 'Signals', 'Accuracy', 'Wilson 95% CI', 'Bootstrap CI',
      'Best baseline', 'Edge pp', 'p-value', 'Verdict']) {
      expect(html).toContain(col);
    }
    // One row per horizon (1D/3D/5D/10D).
    for (const h of ['1D', '3D', '5D', '10D']) expect(html).toContain(`>${h}<`);
  });

  it('renders a stacked card per horizon carrying every field', () => {
    const cards = html.match(/class="rv-card"/g) || [];
    expect(cards.length).toBe(4);
    for (const label of ['Signals', 'Accuracy', 'Best baseline', 'Edge pp',
      'Wilson 95% CI', 'Bootstrap CI', 'p-value']) {
      expect(html).toContain(label);
    }
    const card1 = rvHorizonCard(1, sampleReport().pooled[1]);
    expect(card1).toContain('data-rv-horizon="1"');
    expect(card1).toContain('badge--edge');
    expect(card1).toContain('rv-edge--pos');
    expect(card1).toContain('(overlap-aware)');
  });

  it('renders datasets and skipped tables inside scroll-safe wrappers', () => {
    expect((html.match(/rv-table-wrap/g) || []).length >= 3).toBe(true);
    expect(html).toContain('data-rv-retry="XYZ"');
  });

  it('keeps the disclaimer and API totals', () => {
    expect(html).toContain('NOT a forecast');
    expect(html).toContain('Total API requests spent');
  });

  it('returns empty string for null report', () => {
    expect(renderRealValidationResults(null)).toBe('');
  });

  it('never emits fixed pixel widths that force phone-portrait overflow', () => {
    expect(html).not.toMatch(/width\s*:\s*\d+px/i);
    expect(html).not.toMatch(/min-width\s*:\s*\d{3,}px/i);
  });

  it('card handles missing bootstrap CI without crashing', () => {
    const c = rvHorizonCard(10, pooledCell({ bootstrapCI: null }));
    expect(c).toContain('Bootstrap CI');
    expect(c).toContain('—');
  });
});
