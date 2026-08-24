// edge-analysis.js — Pure calculation layer for the EDGE screen.
//
// No DOM, no network, no imports. Deterministic and fully unit-testable
// offline. Input is the normalized odds payload from odds-api.js:
//   { bookmakers: [{ key, title, markets: [{ key, outcomes: [{ name, price }] }] }] }
//
// The verdict layer ships as an explicit NOT_EVALUATED placeholder — this
// milestone separates the layers; it does not fabricate conclusions.

// impliedProbability(decimalPrice) → 1/price clamped to (0,1]; null for
// non-finite or ≤ 0 prices.
export function impliedProbability(decimalPrice) {
  const p = Number(decimalPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.min(1 / p, 1);
}

// Collect h2h outcome prices across all bookmakers.
function collectOutcomePrices(bookmakers) {
  const byOutcome = new Map(); // name → [{ book, price }]
  for (const book of Array.isArray(bookmakers) ? bookmakers : []) {
    if (!book || !Array.isArray(book.markets)) continue;
    const bookLabel = book.title || book.key || 'unknown';
    for (const market of book.markets) {
      if (market.key && market.key !== 'h2h') continue;
      for (const outcome of Array.isArray(market.outcomes) ? market.outcomes : []) {
        if (!outcome || typeof outcome.name !== 'string') continue;
        const price = Number(outcome.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (!byOutcome.has(outcome.name)) byOutcome.set(outcome.name, []);
        byOutcome.get(outcome.name).push({ book: bookLabel, price });
      }
    }
  }
  return byOutcome;
}

// bestPricePerOutcome → { [outcomeName]: { bestPrice, bestBook, allPrices } }
export function bestPricePerOutcome(bookmakers) {
  const byOutcome = collectOutcomePrices(bookmakers);
  const result = {};
  for (const [name, prices] of byOutcome) {
    let best = prices[0];
    for (const entry of prices) {
      if (entry.price > best.price) best = entry;
      else if (entry.price === best.price && entry.book < best.book) best = entry; // deterministic tie-break
    }
    result[name] = {
      bestPrice: best.price,
      bestBook: best.book,
      allPrices: prices.slice().sort((a, b) => a.book < b.book ? -1 : a.book > b.book ? 1 : 0),
    };
  }
  return result;
}

// priceSpreadPerOutcome → { [outcomeName]: max − min price }
export function priceSpreadPerOutcome(bookmakers) {
  const best = bestPricePerOutcome(bookmakers);
  const spread = {};
  for (const [name, info] of Object.entries(best)) {
    if (!info.allPrices.length) continue;
    const min = Math.min(...info.allPrices.map((p) => p.price));
    spread[name] = info.bestPrice - min;
  }
  return spread;
}

// consensusImpliedProbability(outcomePrices: [{book, price}]) → mean of
// implied probabilities across books; null when no valid prices.
export function consensusImpliedProbability(outcomePrices) {
  const probs = (Array.isArray(outcomePrices) ? outcomePrices : [])
    .map((e) => impliedProbability(e && e.price))
    .filter((v) => v !== null);
  if (!probs.length) return null;
  return probs.reduce((a, b) => a + b, 0) / probs.length;
}

// analyzeEventOdds(normalizedOdds) → EdgeComputation
export function analyzeEventOdds(normalizedOdds) {
  const bookmakers = normalizedOdds && Array.isArray(normalizedOdds.bookmakers)
    ? normalizedOdds.bookmakers : [];
  const best = bestPricePerOutcome(bookmakers);
  const spreads = priceSpreadPerOutcome(bookmakers);
  const outcomes = Object.keys(best)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      bestPrice: best[name].bestPrice,
      bestBook: best[name].bestBook,
      spread: typeof spreads[name] === 'number' ? spreads[name] : null,
      consensusImpliedProb: consensusImpliedProbability(best[name].allPrices),
    }));
  return {
    generatedAt: new Date().toISOString(),
    outcomes,
    verdict: 'NOT_EVALUATED',
    verdictReason: 'EDGE conclusions are not implemented in this milestone',
  };
}
