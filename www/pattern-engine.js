// pattern-engine.js — Phase 3 interface stub (specs/phase1.md B2.10, B13).
// DO NOT implement pattern matching in Phase 1. Signatures only.

export const patternEngine = {
  // buildProfile(symbol) → Promise<{symbol, windows: []}>
  async buildProfile(_symbol) {
    // TODO Phase 3: asset behavioral fingerprint from real historical candles
    throw new Error('patternEngine.buildProfile is not implemented in Phase 1 (Phase 3)');
  },
  // matchPattern(symbol, profile) → Promise<{similarity, confidence, direction}>
  async matchPattern(_symbol, _profile) {
    // TODO Phase 3
    throw new Error('patternEngine.matchPattern is not implemented in Phase 1 (Phase 3)');
  },
};

export default patternEngine;