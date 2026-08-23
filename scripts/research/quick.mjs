import { walkForwardBacktest, walkForwardParameterSearch } from '../../prediction-engine.js';
import { fixtureFor } from './gen-bars.mjs';

const bars = fixtureFor('AAPL', 1254);
for (const cfg of [
  { matchMode: 'threshold', maxDistance: 1.5, minSignalSample: 0 },
  { matchMode: 'topk' },
  { matchMode: 'topk', requireEdge: true },
  { matchMode: 'composite' },
]) {
  const t0 = Date.now();
  const bt = walkForwardBacktest({ bars, horizons: [1, 3, 5, 10], ...cfg });
  const h1 = bt.horizons[1];
  console.log(JSON.stringify(cfg), `${Date.now() - t0}ms`, 'acc', bt.accuracyPct,
    'edge', h1.edgeVsBestBaselinePp, 'cov', h1.coveragePct,
    'u/d/n', `${h1.upSignals}/${h1.downSignals}/${h1.noSignals}`,
    'medMatch', bt.medianMatchCount);
}
const t0 = Date.now();
const pws = walkForwardParameterSearch({ bars });
console.log('paramsearch', `${Date.now() - t0}ms`, 'chosen', JSON.stringify(pws.chosen),
  'testAcc', pws.test.accuracyPct, 'edge', pws.test.edgeVsBestBaselinePp,
  'u/d/n', (() => { const h = pws.test.horizons[1]; return `${h.upSignals}/${h.downSignals}/${h.noSignals}`; })());
