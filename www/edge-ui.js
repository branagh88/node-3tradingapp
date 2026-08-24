// edge-ui.js — Controller for the #/edge screen (EDGE sports analysis).
//
// Owns #screen-edge; wired from app.js via initEdgeScreen(). Providers are
// injected ({ oddsApi, serpApi }) so jsdom tests run fully offline.
//
// The four data layers stay explicitly separated in state and in the DOM:
//   1. raw market data  (rawOdds — kept ONLY in memory, never rendered)
//   2. calculated differences (computation → edge-analysis card)
//   3. external SerpAPI research (research → its own panel subtree)
//   4. EDGE conclusions (verdict line, NOT_EVALUATED placeholder this milestone)
import { logger, esc } from './utils.js';
import { storage } from './storage.js';
import {
  getOddsApiKey, hasOddsCredential,
  getSerpApiKey, hasSerpCredential,
} from './sports-credentials.js';
import { OddsApiProvider } from './odds-api.js';
import { fetchResearch } from './serp-api.js';
import { analyzeEventOdds } from './edge-analysis.js';

const SPORT_STORAGE_KEY = 'edge-sport';

function el(id) { return document.getElementById(id); }

class EdgeScreenController {
  constructor({ oddsApi = null, serpApi = null } = {}) {
    this.oddsApi = oddsApi || new OddsApiProvider();
    this.serpApi = serpApi || { fetchResearch };
    // Layer-separated state:
    this.sportsStatus = 'idle';   // idle | loading | ready | error | unconfigured
    this.sports = [];
    this.selectedSportKey = '';
    this.eventsStatus = 'idle';   // idle | loading | ready | empty | error
    this.events = [];
    this.selectedEventId = '';
    this.rawOdds = null;          // raw market data — never rendered to DOM
    this.computation = null;
    this.researchStatus = 'idle'; // idle | loading | ready | empty | error | unconfigured
    this.research = [];
    this.wired = false;
    this._enteredOnce = false;
  }

  wire() {
    if (this.wired) return;
    const select = el('edge-sport-select');
    if (!select) return;
    select.addEventListener('change', () => {
      const keyVal = select.value || '';
      if (keyVal === this.selectedSportKey) return;
      this.selectedSportKey = keyVal;
      try { storage.set(SPORT_STORAGE_KEY, keyVal); } catch { /* best-effort */ }
      this.resetEventLayers();
      this.loadEvents();
    });
    const retrySports = el('edge-sport-retry');
    if (retrySports) retrySports.addEventListener('click', () => this.onRouteEnter({ force: true }));
    const retryEvents = el('edge-events-retry');
    if (retryEvents) retryEvents.addEventListener('click', () => this.loadEvents());
    const analyzeBtn = el('edge-analyze');
    if (analyzeBtn) analyzeBtn.addEventListener('click', () => this.runAnalysis());
    const researchBtn = el('edge-research');
    if (researchBtn) researchBtn.addEventListener('click', () => this.runResearch());
    const settingsLink = el('edge-unconfigured-settings-link');
    if (settingsLink) settingsLink.addEventListener('click', () => { window.location.hash = '#/settings'; });
    this.wired = true;
  }

  // Called by app.js router when #/edge becomes visible.
  onRouteEnter({ force = false } = {}) {
    this.wire();
    if (this._enteredOnce && !force) return; // cached after first load
    this._enteredOnce = true;
    this.bootstrap();
  }

  async bootstrap() {
    let hasKey = false;
    try { hasKey = await hasOddsCredential(); } catch { hasKey = false; }
    if (!hasKey) {
      this.sportsStatus = 'unconfigured';
      this.renderUnconfigured();
      return;
    }
    this.renderConfiguredShell();
    await this.loadSports();
  }

  async loadSports() {
    this.sportsStatus = 'loading';
    this.renderSportStatus();
    try {
      const key = await getOddsApiKey();
      this.sports = await this.oddsApi.fetchSports(key);
      this.sportsStatus = 'ready';
      this.renderSportSelect();
      // Restore previously chosen sport (persisted via storage.js).
      const saved = storage.get(SPORT_STORAGE_KEY);
      const restored = typeof saved === 'string' ? saved : '';
      const select = el('edge-sport-select');
      if (restored && select) {
        select.value = restored;
        this.selectedSportKey = select.value || '';
      }
      if (this.selectedSportKey) {
        this.resetEventLayers();
        await this.loadEvents();
      } else {
        this.eventsStatus = 'idle';
        this.renderEventsPanel();
      }
    } catch (err) {
      logger.warn('[EdgeUi] fetchSports failed:', err && err.message);
      this.sportsStatus = 'error';
      this.renderSportStatus(err);
    }
  }

  resetEventLayers() {
    this.eventsStatus = 'idle';
    this.events = [];
    this.selectedEventId = '';
    this.rawOdds = null;
    this.computation = null;
    this.researchStatus = 'idle';
    this.research = [];
    this.renderEventsPanel();
    this.renderAnalysisPanel();
    this.renderResearchPanel();
  }

  async loadEvents() {
    if (!this.selectedSportKey) return;
    const statusEl = el('edge-events-status');
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Loading upcoming events…'; }
    const list = el('edge-events');
    if (list) list.textContent = '';
    this.eventsStatus = 'loading';
    this.renderAnalysisPanel();
    this.renderResearchPanel();
    try {
      const key = await getOddsApiKey();
      this.events = await this.oddsApi.fetchUpcomingEvents(key, this.selectedSportKey);
      this.eventsStatus = this.events.length ? 'ready' : 'empty';
    } catch (err) {
      logger.warn('[EdgeUi] fetchUpcomingEvents failed:', err && err.message);
      this.eventsStatus = 'error';
      this._eventsError = err;
    }
    this.renderEventsPanel();
  }

  selectEvent(eventId) {
    this.selectedEventId = eventId;
    this.rawOdds = null;
    this.computation = null;
    this.researchStatus = 'idle';
    this.research = [];
    this.renderEventsPanel();
    this.renderAnalysisPanel();
    this.renderResearchPanel();
  }

  selectedEvent() {
    return this.events.find((e) => e.id === this.selectedEventId) || null;
  }

  classifyError(err) {
    if (!err) return 'Network error.';
    if (err.name === 'NotConfiguredError') return 'SerpAPI key required.';
    if (err.kind === 'rate-limited' || err.statusCode === 429) return 'Rate limited — try again later.';
    if (err.kind === 'unconfigured-or-invalid-key' || err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 422) {
      return 'API key missing or invalid — check Settings.';
    }
    if (err.name === 'TransportError') return 'Network error — could not reach the service.';
    return 'Request failed — please retry.';
  }

  async runAnalysis() {
    const event = this.selectedEvent();
    if (!event) return;
    const panel = el('edge-analysis-panel');
    if (panel) { panel.hidden = false; panel.innerHTML = `<div class="edge-status-banner edge-status-banner--loading">Analyzing ${esc(event.homeTeam)} vs ${esc(event.awayTeam)}…</div>`; }
    try {
      const key = await getOddsApiKey();
      this.rawOdds = await this.oddsApi.fetchEventOdds(key, this.selectedSportKey, event.id);
      // Calculated layer — computed over rawOdds; only THIS object is rendered.
      this.computation = analyzeEventOdds(this.rawOdds);
      if (!this.computation.outcomes.length) {
        if (panel) {
          panel.innerHTML = '<div class="edge-status-banner edge-status-banner--empty">No bookmaker odds available for this event.</div>';
        }
        return;
      }
    } catch (err) {
      logger.warn('[EdgeUi] fetchEventOdds failed:', err && err.message);
      this.rawOdds = null;
      this.computation = null;
      if (panel) {
        panel.innerHTML = `<div class="edge-status-banner edge-status-banner--error">${esc(this.classifyError(err))}</div>`;
      }
      return;
    }
    this.renderAnalysisPanel();
  }

  async runResearch() {
    const event = this.selectedEvent();
    if (!event) return;
    let hasKey = false;
    try { hasKey = await hasSerpCredential(); } catch { hasKey = false; }
    if (!hasKey) {
      this.researchStatus = 'unconfigured';
      this.research = [];
      this.renderResearchPanel();
      return;
    }
    const panel = el('edge-research-panel');
    if (panel) { panel.hidden = false; panel.innerHTML = '<div class="edge-status-banner edge-status-banner--loading">Searching external sources…</div>'; }
    try {
      const key = await getSerpApiKey();
      const query = `${event.homeTeam} vs ${event.awayTeam} preview odds`;
      this.research = await this.serpApi.fetchResearch(key, query).then((r) => r.slice(0, 5));
      this.researchStatus = this.research.length ? 'ready' : 'empty';
    } catch (err) {
      logger.warn('[EdgeUi] research failed:', err && err.message);
      if (err && err.name === 'NotConfiguredError') this.researchStatus = 'unconfigured';
      else this.researchStatus = 'error';
      this._researchError = err;
    }
    this.renderResearchPanel();
  }

  // ── Renderers ──

  renderUnconfigured() {
    const box = el('edge-unconfigured');
    const configuredWrap = el('edge-configured');
    if (box) box.hidden = false;
    if (configuredWrap) configuredWrap.hidden = true;
    this.renderEventsPanel();
    this.renderAnalysisPanel();
    this.renderResearchPanel();
  }

  renderConfiguredShell() {
    const box = el('edge-unconfigured');
    const configuredWrap = el('edge-configured');
    if (box) box.hidden = true;
    if (configuredWrap) configuredWrap.hidden = false;
  }

  renderSportStatus(err) {
    const statusEl = el('edge-sport-status');
    const select = el('edge-sport-select');
    if (!statusEl) return;
    if (this.sportsStatus === 'loading') {
      statusEl.hidden = false;
      statusEl.className = 'edge-status-banner edge-status-banner--loading';
      statusEl.textContent = 'Loading sports…';
      if (select) select.disabled = true;
    } else if (this.sportsStatus === 'error') {
      statusEl.hidden = false;
      statusEl.className = 'edge-status-banner edge-status-banner--error';
      statusEl.textContent = `${this.classifyError(err)} `;
      const btn = document.createElement('button');
      btn.id = 'edge-sport-retry';
      btn.type = 'button';
      btn.className = 'btn btn--ghost';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => this.onRouteEnter({ force: true }));
      statusEl.appendChild(btn);
      if (select) select.disabled = true;
    } else {
      statusEl.hidden = true;
      statusEl.textContent = '';
      if (select) select.disabled = false;
    }
  }

  renderSportSelect() {
    const fieldLabel = el('edge-sport-field');
    const select = el('edge-sport-select');
    if (!select) return;
    const active = this.sports.filter((s) => s.active === true);
    active.sort((a, b) => a.title.localeCompare(b.title));
    select.innerHTML = '<option value="">— Choose a sport —</option>'
      + active.map((s) => `<option value="${esc(s.key)}">${esc(s.title)} (${esc(s.group)})</option>`).join('');
    if (fieldLabel) fieldLabel.hidden = false;
    this.renderSportStatus();
  }

  renderEventsPanel() {
    const list = el('edge-events');
    const statusEl = el('edge-events-status');
    const analyzeBtn = el('edge-analyze');
    const researchBtn = el('edge-research');
    if (!list) return;

    if (analyzeBtn) analyzeBtn.disabled = !this.selectedEventId;
    if (researchBtn) researchBtn.disabled = !this.selectedEventId;

    if (this.eventsStatus === 'idle') {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.className = 'hint';
        statusEl.textContent = this.selectedSportKey ? '' : 'Choose a sport to see upcoming events.';
      }
      list.textContent = '';
      return;
    }
    if (this.eventsStatus === 'loading') {
      if (statusEl) { statusEl.hidden = false; statusEl.className = 'edge-status-banner edge-status-banner--loading'; statusEl.textContent = 'Loading upcoming events…'; }
      list.textContent = '';
      return;
    }
    if (this.eventsStatus === 'empty') {
      if (statusEl) { statusEl.hidden = false; statusEl.className = 'edge-status-banner edge-status-banner--empty'; statusEl.textContent = 'No upcoming events.'; }
      list.textContent = '';
      return;
    }
    if (this.eventsStatus === 'error') {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.className = 'edge-status-banner edge-status-banner--error';
        statusEl.textContent = `${this.classifyError(this._eventsError)} `;
        const btn = document.createElement('button');
        btn.id = 'edge-events-retry';
        btn.type = 'button';
        btn.className = 'btn btn--ghost';
        btn.textContent = 'Retry';
        btn.addEventListener('click', () => this.loadEvents());
        statusEl.appendChild(btn);
      }
      list.textContent = '';
      return;
    }
    if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
    list.classList.add('result-list');
    list.innerHTML = this.events.map((e) => {
      const when = e.commenceTime ? new Date(e.commenceTime).toLocaleString() : '';
      const selCls = e.id === this.selectedEventId ? ' is-selected' : '';
      return `<button type="button" class="event-row${selCls}" data-event-id="${esc(e.id)}">`
        + `<span class="event-row__title">${esc(e.homeTeam)} vs ${esc(e.awayTeam)}</span>`
        + (when ? `<span class="event-row__time">${esc(when)}</span>` : '')
        + '</button>';
    }).join('');
    list.querySelectorAll('.event-row').forEach((row) => {
      row.addEventListener('click', () => this.selectEvent(row.dataset.eventId));
    });
  }

  renderAnalysisPanel() {
    const panel = el('edge-analysis-panel');
    if (!panel) return;
    if (!this.selectedEventId || !this.computation) {
      panel.hidden = !this.selectedEventId;
      if (this.selectedEventId && !this.computation) panel.innerHTML = '';
      else if (!this.selectedEventId) panel.textContent = '';
      return;
    }
    const c = this.computation;
    const rows = c.outcomes.map((o) => `
      <div class="edge-outcome">
        <div class="edge-outcome__name">${esc(o.name)}</div>
        <dl>
          <dt>Best price</dt><dd>${esc(String(o.bestPrice))} <span class="hint">(${esc(o.bestBook)})</span></dd>
          <dt>Spread across books</dt><dd>${o.spread === null ? '—' : esc(o.spread.toFixed(3))}</dd>
          <dt>Consensus implied probability</dt><dd>${o.consensusImpliedProb === null ? '—' : esc((o.consensusImpliedProb * 100).toFixed(2)) + '%'}</dd>
        </dl>
      </div>`).join('');
    const verdictText = c.verdict === 'NOT_EVALUATED'
      ? 'EDGE conclusion: pending — not evaluated in this version'
      : esc(c.verdict);
    panel.innerHTML = `
      <div class="card edge-computation-card">
        <h2>Calculated differences</h2>
        ${rows}
        <p class="edge-verdict hint">${verdictText}</p>
      </div>`;
    panel.hidden = false;
  }

  renderResearchPanel() {
    const panel = el('edge-research-panel');
    if (!panel) return;
    if (!this.selectedEventId) { panel.hidden = true; panel.textContent = ''; return; }
    if (this.researchStatus === 'unconfigured') {
      panel.hidden = false;
      panel.innerHTML = `
        <div class="card edge-research-card">
          <h2>SerpAPI key required</h2>
          <p class="hint">External research needs your personal SerpAPI key.</p>
          <a class="btn btn--ghost" href="#/settings">Open Settings</a>
        </div>`;
      return;
    }
    if (this.researchStatus === 'error') {
      panel.hidden = false;
      panel.innerHTML = `<div class="edge-status-banner edge-status-banner--error">${esc(this.classifyError(this._researchError))}</div>`;
      return;
    }
    if (this.researchStatus !== 'ready') {
      if (this.researchStatus === 'idle') { panel.hidden = true; panel.textContent = ''; }
      return;
    }
    panel.hidden = false;
    const items = this.research.map((r) => `
      <li class="edge-research-item">
        <a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.link)}</a>
        ${r.snippet ? `<p class="hint">${esc(r.snippet)}</p>` : ''}
      </li>`).join('');
    panel.innerHTML = `
      <div class="card edge-research-card">
        <h2>External research (SerpAPI)</h2>
        ${items ? `<ul class="edge-research-list">${items}</ul>` : '<p class="hint">No results found.</p>'}
        <p class="hint">Results come from third-party web search via your personal SerpAPI account. Not investment or betting advice.</p>
      </div>`;
  }
}

let _controller = null;

// Entry point used by app.js. Returns a tiny handle with onRouteEnter().
export function initEdgeScreen(deps = {}) {
  if (!_controller) _controller = new EdgeScreenController(deps);
  return { onRouteEnter: (opts) => _controller.onRouteEnter(opts), controller: _controller };
}

export default initEdgeScreen;
