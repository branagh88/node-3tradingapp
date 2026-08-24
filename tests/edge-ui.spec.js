// tests/edge-ui.spec.js — EDGE screen controller (jsdom, fully offline).
//
// vi.doMock patches the three service modules; the REAL initEdgeScreen from
// edge-ui.js drives a minimal DOM mirroring the #screen-edge markup.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ODDS_KEY = 'test-sentinel-key-abc123';

function mountEdgeDom() {
  document.body.innerHTML = `
    <div id="global-banner" hidden></div>
    <section id="screen-edge" class="screen" hidden>
      <div class="screen-head"><h1>EDGE Analysis</h1></div>
      <div id="edge-unconfigured" hidden>
        <button id="edge-unconfigured-settings-link" type="button">Open Settings</button>
      </div>
      <div id="edge-configured" hidden>
        <label id="edge-sport-field" class="field" hidden>
          <span>Sport</span>
          <select id="edge-sport-select"></select>
        </label>
        <div id="edge-sport-status" hidden></div>
        <div id="edge-events" class="result-list"></div>
        <div id="edge-events-status" hidden></div>
        <div class="edge-actions">
          <button id="edge-analyze" type="button" disabled>Analyze</button>
          <button id="edge-research" type="button" disabled>Research</button>
        </div>
        <div id="edge-analysis-panel" hidden></div>
        <div id="edge-research-panel" hidden></div>
      </div>
    </section>`;
}

const SPORTS = [
  { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: '', active: true, hasOutrights: false },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA', description: '', active: true, hasOutrights: false },
  { key: 'old_league', group: 'X', title: 'Inactive League', description: '', active: false, hasOutrights: false },
];
const EVENTS = [
  { id: 'e1', sportKey: 'soccer_epl', commenceTime: '2025-06-01T15:00:00Z', homeTeam: 'Arsenal', awayTeam: 'Chelsea' },
  { id: 'e2', sportKey: 'soccer_epl', commenceTime: '2025-06-02T15:00:00Z', homeTeam: 'Leeds', awayTeam: 'Fulham' },
];
const ODDS_PAYLOAD = {
  bookmakers: [
    { key: 'a', title: 'Book A', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }, { name: 'Chelsea', price: 3.5 }] }] },
    { key: 'b', title: 'Book B', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.2 }, { name: 'Chelsea', price: 3.4 }] }] },
  ],
};
const RESEARCH_RESULTS = Array.from({ length: 8 }, (_, i) => ({
  title: `Result ${i}`, link: `https://example.test/${i}`, snippet: `Snippet ${i}`,
}));

async function setup({
  oddsConfigured = true,
  serpConfigured = false,
  sportsImpl = () => Promise.resolve(SPORTS),
  eventsImpl = () => Promise.resolve(EVENTS),
  oddsImpl = () => Promise.resolve(ODDS_PAYLOAD),
  researchImpl = () => Promise.resolve(RESEARCH_RESULTS),
} = {}) {
  vi.resetModules();
  const calls = { fetchSports: 0, fetchUpcomingEvents: 0, fetchEventOdds: 0, fetchResearch: 0 };
  const storeMap = new Map();

  vi.doMock('../storage.js', () => ({
    storage: {
      get: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
      set: (k, v) => { storeMap.set(k, v); return true; },
      remove: (k) => storeMap.delete(k),
    },
  }));
  vi.doMock('../sports-credentials.js', () => ({
    getOddsApiKey: async () => (oddsConfigured ? ODDS_KEY : ''),
    setOddsApiKey: async () => true,
    clearOddsApiKey: async () => true,
    getSerpApiKey: async () => (serpConfigured ? ODDS_KEY : ''),
    setSerpApiKey: async () => true,
    clearSerpApiKey: async () => true,
    hasOddsCredential: async () => oddsConfigured,
    hasSerpCredential: async () => serpConfigured,
  }));
  vi.doMock('../odds-api.js', () => ({
    OddsApiProvider: function () {
      return {
        fetchSports: async (...a) => { calls.fetchSports++; return sportsImpl(...a); },
        fetchUpcomingEvents: async (...a) => { calls.fetchUpcomingEvents++; return eventsImpl(...a); },
        fetchEventOdds: async (...a) => { calls.fetchEventOdds++; return oddsImpl(...a); },
      };
    },
  }));
  vi.doMock('../serp-api.js', () => ({
    fetchResearch: async (...a) => { calls.fetchResearch++; return researchImpl(...a); },
  }));

  mountEdgeDom();
  const { initEdgeScreen } = await import('../edge-ui.js');
  const handle = initEdgeScreen();
  return { handle, controller: handle.controller, calls, storeMap };
}

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { vi.restoreAllMocks(); });

describe('EDGE screen', () => {
  it('shows UNCONFIGURED card when no odds credential and issues zero fetches', async () => {
    const { handle, calls } = await setup({ oddsConfigured: false });
    handle.onRouteEnter();
    await new Promise((r) => setTimeout(r));
    expect(document.getElementById('edge-unconfigured').hidden).toBe(false);
    expect(calls.fetchSports).toBe(0);
  });

  it('loads and populates the sport select from stubbed sports (active only)', async () => {
    const { handle } = await setup();
    handle.onRouteEnter();
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    const select = document.getElementById('edge-sport-select');
    const opts = [...select.options].filter((o) => o.value);
    expect(opts.length).toBe(2); // inactive league filtered
    expect(opts[0].textContent).toContain('EPL');
    expect(opts[0].textContent).toContain('Soccer');
  });

  it('sports fetch failure → ERROR state with Retry, screen stays visible', async () => {
    const { handle } = await setup({ sportsImpl: () => Promise.reject(Object.assign(new Error('boom'), { name: 'TransportError' })) });
    document.getElementById('screen-edge').hidden = false; // router reveals the screen
    handle.onRouteEnter();
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    const statusEl = document.getElementById('edge-sport-status');
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.textContent).toMatch(/Network error/i);
    expect(document.getElementById('edge-sport-retry')).toBeTruthy();
    expect(document.getElementById('screen-edge').hidden).toBe(false);
  });

  it('choosing a sport loads events; empty result shows EMPTY state', async () => {
    const empty = await setup({ eventsImpl: () => Promise.resolve([]) });
    empty.handle.onRouteEnter();
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    const select = document.getElementById('edge-sport-select');
    select.value = 'soccer_epl';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    expect(empty.calls.fetchUpcomingEvents).toBe(1);
    expect(document.getElementById('edge-events-status').textContent).toMatch(/No upcoming events/i);

    const withEvents = await setup();
    withEvents.handle.onRouteEnter();
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    const sel2 = document.getElementById('edge-sport-select');
    sel2.value = 'soccer_epl';
    sel2.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    const rows = document.querySelectorAll('.event-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Arsenal vs Chelsea');
  });

  it('event selection highlights the row and enables Analyze/Research', async () => {
    const { handle } = await setup();
    handle.onRouteEnter();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-sport-select').value = 'soccer_epl';
    document.getElementById('edge-sport-select').dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    expect(document.getElementById('edge-analyze').disabled).toBe(true);
    const row = document.querySelector('.event-row');
    row.click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    expect(document.querySelector('.event-row.is-selected')).toBeTruthy();
    expect(document.getElementById('edge-analyze').disabled).toBe(false);
    expect(document.getElementById('edge-research').disabled).toBe(false);
  });

  it('Analyze renders computed fields + pending verdict, never raw JSON', async () => {
    const { handle } = await setup();
    handle.onRouteEnter();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-sport-select').value = 'soccer_epl';
    document.getElementById('edge-sport-select').dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.querySelector('.event-row').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-analyze').click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));

    const panel = document.getElementById('edge-analysis-panel');
    const text = panel.textContent;
    expect(text).toContain('Calculated differences');
    expect(text).toContain('Book B'); // best book for Arsenal at 2.2
    expect(text).toMatch(/pending|not evaluated/i);
    // No raw payload dump anywhere in the body:
    expect(document.body.textContent.includes(JSON.stringify(ODDS_PAYLOAD))).toBe(false);
    expect(document.body.textContent.includes('"bookmakers"')).toBe(false);
  });

  it('Research without SerpAPI key → "SerpAPI key required", zero fetches', async () => {
    const { handle, calls } = await setup({ serpConfigured: false });
    handle.onRouteEnter();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-sport-select').value = 'soccer_epl';
    document.getElementById('edge-sport-select').dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.querySelector('.event-row').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-research').click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
    expect(document.getElementById('edge-research-panel').textContent).toContain('SerpAPI key required');
    expect(calls.fetchResearch).toBe(0);
  });

  it('Research with key renders ≤5 sanitized results under the external-research heading', async () => {
    const { handle } = await setup({ serpConfigured: true });
    handle.onRouteEnter();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-sport-select').value = 'soccer_epl';
    document.getElementById('edge-sport-select').dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.querySelector('.event-row').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-research').click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
    const panel = document.getElementById('edge-research-panel');
    expect(panel.textContent).toContain('External research (SerpAPI)');
    const items = panel.querySelectorAll('.edge-research-item');
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items.length).toBeGreaterThan(0);
    // Sanitization: injected markup must not survive esc().
    const hostile = await setup({ serpConfigured: true, researchImpl: () => Promise.resolve([{ title: '<img src=x onerror=alert(1)>', link: 'https://example.test/', snippet: '<script>x</script>' }]) });
    hostile.handle.onRouteEnter();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
    hostile.document = document;
    document.getElementById('edge-sport-select').value = 'soccer_epl';
    document.getElementById('edge-sport-select').dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.querySelector('.event-row').click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    document.getElementById('edge-research').click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
    expect(document.querySelector('#edge-research-panel img')).toBe(null);
    expect(document.querySelector('#edge-research-panel script')).toBe(null);
  });

  it('sport choice persists via storage and is restored on re-init', async () => {
    const first = await setup();
    first.handle.onRouteEnter();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    const sel = document.getElementById('edge-sport-select');
    sel.value = 'soccer_epl';
    sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r));
    expect(first.storeMap.get('edge-sport')).toBe('soccer_epl');

    const second = await setup();
    // Same underlying store map is not shared across setups; pre-seed instead.
    second.storeMap.set('edge-sport', 'soccer_epl');
    second.handle.onRouteEnter();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
    expect(document.getElementById('edge-sport-select').value).toBe('soccer_epl');
    expect(second.calls.fetchUpcomingEvents).toBeGreaterThanOrEqual(1);
  });
});
