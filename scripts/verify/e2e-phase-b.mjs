// Phase B verification: full deterministic lifecycle against a live server.
const PORT = process.env.PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const conditionTime = Date.UTC(2026, 0, 15, 14, 30);
const contract = {
  schemaVersion: 1,
  status: 'OK',
  ticker: 'vrfy',
  generatedAt: conditionTime,
  conditionTime,
  dataset: { status: 'ok', candles: 1000, coverageYears: 4, dateRange: { start: '2022-01-01', end: '2026-01-15' }, stoppedReason: null, depth: 'daily' },
  condition: { rsi14: 55 },
  analysis: { matchMode: 'composite', kUsed: 12, percentileCutoff: 80, maxMatchDistance: 1.5, compositeSignature: 'sig-vrfy' },
  horizons: {
    1: { direction: 'up', probabilityPct: 61 },
    3: { direction: 'down', probabilityPct: 57 },
    5: { direction: 'up', probabilityPct: 55 },
    10: { direction: null, probabilityPct: null },
  },
  disclaimer: 'test',
};
const entryClose = 101.25;
const bars = Array.from({ length: 16 }, (_, i) => ({
  t: conditionTime + i * 86400000,
  c: +(entryClose * (1 + i * 0.01)).toFixed(4),
}));

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
function assert(cond, msg) { if (!cond) { console.error('E2E FAIL: ' + msg); process.exit(1); } }

let r = await j('POST', '/api/predictions', { contract, entryClose });
assert(r.status === 201 && r.json.record.id === 'VRFY|2026-01-15|v1', 'create -> 201 with deterministic id');
const original = r.json.record;

r = await j('POST', '/api/predictions', { contract, entryClose });
assert(r.status === 200 && r.json.duplicate === true, 'duplicate create -> 200 duplicate:true');

r = await j('POST', `/api/predictions/${encodeURIComponent(original.id)}/outcome`, { bars });
assert(r.status === 200 && r.json.record.lifecycleStatus === 'resolved', 'outcome -> resolved');
assert(r.json.record.outcomes['1'].status === 'resolved' && r.json.record.outcomes['1'].correct === true, 'h1 resolved correct');

const resolvedSnapshot = JSON.stringify(r.json.record);
r = await j('POST', `/api/predictions/${encodeURIComponent(original.id)}/outcome`, { bars });
assert(r.status === 200 && r.json.noop === true && JSON.stringify(r.json.record) === resolvedSnapshot, 're-post outcome on terminal record is noop/immutable');

console.log('E2E PHASE B PASS (pre-restart)');
console.log(JSON.stringify({ ok: true, id: original.id }));
