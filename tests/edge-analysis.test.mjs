// tests/edge-analysis.test.mjs — pure calculation layer (offline, no DOM).

import { describe, it, expect } from 'vitest';
import {
  impliedProbability,
  bestPricePerOutcome,
  priceSpreadPerOutcome,
  consensusImpliedProbability,
  analyzeEventOdds,
} from '../edge-analysis.js';

const BOOKS = [
  {
    key: 'a', title: 'Book A',
    markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 2.0 }, { name: 'Away', price: 3.5 }] }],
  },
  {
    key: 'b', title: 'Book B',
    markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 2.2 }, { name: 'Away', price: 3.4 }] }],
  },
];

describe('impliedProbability', () => {
  it('normal prices → 1/price clamped to (0,1]', () => {
    expect(impliedProbability(2)).toBe(0.5);
    expect(impliedProbability(1)).toBe(1);
    expect(impliedProbability(4)).toBeCloseTo(0.25);
  });
  it('zero, negative and non-finite → null', () => {
    expect(impliedProbability(0)).toBe(null);
    expect(impliedProbability(-2)).toBe(null);
    expect(impliedProbability(NaN)).toBe(null);
    expect(impliedProbability(Infinity)).toBe(null);
    expect(impliedProbability('nope')).toBe(null);
  });
});

describe('bestPricePerOutcome / priceSpreadPerOutcome', () => {
  it('picks best book per outcome with allPrices', () => {
    const best = bestPricePerOutcome(BOOKS);
    expect(best['Home'].bestPrice).toBe(2.2);
    expect(best['Home'].bestBook).toBe('Book B');
    expect(best['Home'].allPrices.length).toBe(2);
    expect(best['Away'].bestPrice).toBe(3.5);
    expect(best['Away'].bestBook).toBe('Book A');
  });
  it('spread is max − min per outcome', () => {
    const spread = priceSpreadPerOutcome(BOOKS);
    expect(spread['Home']).toBeCloseTo(0.2);
    expect(spread['Away']).toBeCloseTo(0.1);
  });
});

describe('consensusImpliedProbability', () => {
  it('averages implied probabilities across books', () => {
    const c = consensusImpliedProbability([{ book: 'A', price: 2.0 }, { book: 'B', price: 4.0 }]);
    expect(c).toBeCloseTo((0.5 + 0.25) / 2);
  });
  it('null when no valid prices', () => {
    expect(consensusImpliedProbability([])).toBe(null);
    expect(consensusImpliedProbability([{ book: 'A', price: -1 }])).toBe(null);
  });
});

describe('analyzeEventOdds', () => {
  it('builds the structured EdgeComputation with NOT_EVALUATED verdict always', () => {
    const comp = analyzeEventOdds({ bookmakers: BOOKS });
    expect(comp.verdict).toBe('NOT_EVALUATED');
    expect(comp.verdictReason).toMatch(/not implemented/i);
    expect(Array.isArray(comp.outcomes)).toBe(true);
    const home = comp.outcomes.find((o) => o.name === 'Home');
    expect(home.bestPrice).toBe(2.2);
    expect(home.spread).toBeCloseTo(0.2);
    expect(home.consensusImpliedProb).toBeCloseTo((0.5 + 1 / 2.2) / 2);
  });

  it('is deterministic — same input twice deep-equals output', () => {
    const a = analyzeEventOdds({ bookmakers: BOOKS });
    const b = analyzeEventOdds({ bookmakers: BOOKS });
    a.generatedAt = b.generatedAt; // timestamp is allowed to differ
    expect(a).toEqual(b);
  });

  it('handles empty/invalid payloads gracefully', () => {
    const empty = analyzeEventOdds(null);
    expect(empty.outcomes).toEqual([]);
    expect(empty.verdict).toBe('NOT_EVALUATED');
  });
});
