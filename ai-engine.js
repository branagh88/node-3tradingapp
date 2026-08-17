// ai-engine.js — Phase 4+ interface stub (specs/phase1.md B2.10, B13).
// DO NOT implement generative AI in Phase 1. Signatures only.

export const aiEngine = {
  // explain(prediction) → Promise<string>  — natural-language explanation of
  // structured model output (never supplies market facts itself)
  async explain(_prediction) {
    // TODO Phase 4+: natural-language explanation of model output
    throw new Error('aiEngine.explain is not implemented in Phase 1 (Phase 4+)');
  },
  // assistantQuery(userMessage) → Promise<string>
  async assistantQuery(_userMessage) {
    // TODO Phase 7: rule-based + optional keyed LLM assistant
    throw new Error('aiEngine.assistantQuery is not implemented in Phase 1 (Phase 7)');
  },
};

export default aiEngine;