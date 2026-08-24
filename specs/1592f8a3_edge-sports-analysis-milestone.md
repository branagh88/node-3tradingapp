# Plan — EDGE Sports-Analysis Milestone (node-3tradingapp)

Session: `1592f8a3` · Planner: ox-alpha · Read-only recon completed before writing this.

---

## 0. Reality check — READ THIS FIRST

The task prompt names entities that **do not exist in this repo under those names**.
Do not go hunting for them and do not invent git history. What actually exists
(verified by inspection):

| Prompt name | Actual repo counterpart | File |
|---|---|---|
| `ProviderCredentialService` / `SecureStorage` | Runtime-only credential facade: Capacitor Preferences on native, namespaced `storage.js` key on web; never logs the value | `secure-store.js` (117 lines) |
| `OddsApiProvider` | **Does not exist.** The only API client is `TickerbotAPI` (market data) | `api.js` (975 lines) |
| `SerpApiProvider` | **Does not exist.** No SerpAPI anywhere in the tree | — |
| "Home screen with raw 'Sport' text entry" | **Does not exist.** The app is a market-intelligence app: Watchlist / Search / Asset / Settings screens, hash router, dark mobile UI, bottom nav. There is zero sports content today | `index.html`, `app.js` |
| "live odds retrieval" | The live retrieval path is **Tickerbot** quotes/history (`api.js` → `_doFetch` → `Authorization: Bearer <key>` → `market-data.js` polling → charts/UI). Nothing sports-related exists to preserve except: don't touch any of it | `api.js`, `market-data.js`, `app.js` |

Also: the prompt says "~389 passing tests". Actual current state measured during
planning: **`npx vitest run` → 23 files, 214 tests, all passing** (~81s). Use 214
as the baseline number; the acceptance gate is "all previously-passing tests still
pass plus the new ones".

So this milestone **creates** the sports-analysis vertical inside the existing
vanilla-ES-module + Capacitor app, following the repo's established patterns,
and treats `secure-store.js`, `api.js` internals, Android config, and gates as
frozen (per constraints).

### Current data flow (what you must explain and not break)

1. User enters Base URL + API key once in **Settings** (`#screen-settings`
   form in `index.html`, wired by `wireSettings()` in `app.js`).
2. On submit, `app.js` first awaits `getApiKey()` from `secure-store.js`
   (Capacitor `@capacitor/preferences` key `tickerbot_api_key` on native;
   `storage.js` namespaced key `market-intelligence:apikey` on plain web),
   computes the effective key, then calls `api.setConfig(cfg)` **exactly once**
   (this ordering is guarded by `tests/api-key-persistence.spec.js` — preserve it).
3. `TickerbotAPI._doFetch()` (api.js ~line 230–340) attaches
   `Authorization: Bearer <key>`, dispatches through browser `fetch` or the
   native Capacitor HTTP plugin, normalizes errors (transport vs HTTP vs rate
   limit), and redacts the key from every log.
4. Controllers (`assets.js`/`app.js` via `market-data.js`) call
   `getQuote/searchTickers/fetchBarsPageRaw` and render into the active
   `.screen`; the hash router in `app.js` (`router()`, ~line 243) toggles
   screens and bottom-nav highlight.

The EDGE milestone adds a **parallel, independent** flow for two new services
(The Odds API, SerpAPI) with their own stored keys, their own thin provider
modules, and their own screen — sharing only the visual language, the router,
and the storage pattern. Nothing above changes behavior.

---

## 1. Goal (smallest safe path)

A new "EDGE" tab in the existing dark mobile UI where the user:

1. Picks a sport from a `<select>` populated live from The Odds API `/v4/sports`
   using the user's own stored Odds API key (no hardcoded teams, leagues, or
   sportsbooks anywhere).
2. Sees upcoming events for that sport (The Odds API `/v4/sports/{sport}/events`)
   and taps one to select it.
3. Runs "Analyze" on the selected event → fetches bookmaker odds for that event
   and displays **calculated differences** (best price per outcome, price spread
   between books, consensus implied probability) — never a raw JSON dump.
4. Optionally runs "Research" on the event → SerpAPI web search strictly via the
   user's stored personal SerpAPI key; when unset, shows a clear
   **"SerpAPI key required"** state linking to Settings.
5. All four data layers stay separated: raw market data / calculated differences /
   external research / EDGE conclusions. This milestone ships the conclusion
   layer as an explicit `NOT_EVALUATED` placeholder — no fabricated verdicts.

Non-goals (explicitly out of scope): changing Tickerbot behavior, touching
`secure-store.js` internals, Android/Capacitor build config, artifact gates,
any backend/server work, real EDGE-conclusion logic.

---

## 2. Files to CREATE

All root-level modules are mirrored into `www/` byte-for-byte (verified:
`diff -q app.js www/app.js` clean today; there is no sync script, so the
builder must copy manually and verify with `diff -q`). Create each new file at
repo root **and** copy to `www/`.

### 2.1 `sports-credentials.js` (new; sibling of secure-store.js — secure-store.js itself untouched)

Clone the structure/comments/style of `secure-store.js` (read it first). Two
independent runtime-only credentials:

- Preferences keys: `odds_api_key`, `serp_api_key` (Capacitor Preferences on
  native; `storage.js` namespaced fallback keys `market-intelligence:odds-api-key`
  and `market-intelligence:serp-api-key` on web).
- Exports: `getOddsApiKey()`, `setOddsApiKey(v)`, `clearOddsApiKey()`,
  `getSerpApiKey()`, `setSerpApiKey(v)`, `clearSerpApiKey()`,
  plus `hasOddsCredential()` / `hasSerpCredential()` returning booleans
  (resolve, never reject; log failures WITHOUT ever logging a key value —
  same discipline as secure-store.js).
- Do NOT import private internals of secure-store.js; duplicate its tiny
  `isNativeRuntime()`/`preferencesPlugin()` helpers locally exactly the way
  secure-store.js already duplicates them from api.js (established repo pattern).

### 2.2 `odds-api.js` (new — this IS the "OddsApiProvider")

Thin provider for The Odds API v4, styled after `api.js`'s transport discipline
but **standalone** (no import from api.js; TickerbotAPI stays frozen):

- Constructor takes `{ baseUrl = 'https://api.the-odds-api.com', transport = null }`;
  `transport` defaults to a local `_doFetch` that uses `globalThis.fetch` in
  browser/node. The Odds API authenticates via `apiKey` **query parameter** —
  therefore: every log line and every Error message produced here must be
  scrubbed of the key (strip/rebuild URLs before logging; reuse the redaction
  mindset from `api.js` `safeErrorInfo`).
- Methods (each returns normalized plain objects, never raw payloads):
  - `async fetchSports(apiKey)` → GET `/v4/sports/?apiKey=…` → array of
    `{ key, group, title, description, active, hasOutrights }` (map snake_case
    → camelCase). Filter nothing here — filtering is policy, done in the UI
    controller.
  - `async fetchUpcomingEvents(apiKey, sportKey, { dateFormat='iso' } = {})` →
    GET `/v4/sports/{sportKey}/events?apiKey=…&dateFormat=iso` → array of
    `{ id, sportKey, commenceTime, homeTeam, awayTeam }`.
  - `async fetchEventOdds(apiKey, sportKey, eventId, { regions='us', markets='h2h', oddsFormat='decimal' } = {})`
    → GET `/v4/sports/{sportKey}/events/{eventId}/odds?...` →
    `{ bookmakers: [{ key, title, lastUpdate, markets: [{ key, outcomes: [{ name, price }] }] }] }`
    passed through with light normalization only.
- Error taxonomy mirroring api.js conventions: throw errors with `name` set to
  `'TransportError'` (network), `'ApiError'` (HTTP status attached), and mark
  401/403/422 distinctly so the UI can classify "unconfigured/bad key" vs
  "rate limited" vs "server". Include `statusCode` as a field, never embed the
  URL-with-key in message text.
- Zero hardcoded sports/books/teams. Zero bundled keys (matches FACTORY.md /
  apk leak-scan discipline: `tests/apk-leak-scan.test.mjs` must stay green).

### 2.3 `serp-api.js` (new — the "SerpApiProvider")

Same discipline for SerpAPI:

- `async fetchResearch(apiKey, query, { engine='google', num=5 } = {})` →
  GET `https://serpapi.com/search.json?engine=google&q=…&api_key=…` → returns
  normalized `[{ title, link, snippet }]` taken from `organic_results`
  (ignore everything else). Empty/absent organic_results → `[]`.
- Unconfigured key (empty string) → throw `err.name = 'NotConfiguredError'`
  **without issuing any network request**.
- Same key-redaction rules as 2.2 (`api_key` is a query param).

### 2.4 `edge-analysis.js` (new — pure calculation layer, node-safe)

Pure functions over the normalized odds payload; **no DOM, no network, no
imports** beyond possibly `utils.js` logger-free helpers (prefer none):

- `impliedProbability(decimalPrice)` → `1/price` clamped to (0,1]; `null` for
  non-finite/≤0 prices.
- `bestPricePerOutcome(bookmakers)` → `{ [outcomeName]: { bestPrice, bestBook, allPrices: [{book, price}] } }`.
- `priceSpreadPerOutcome(bookmakers)` → max−min price per outcome.
- `consensusImpliedProbability(outcomePrices)` → mean of implied probs across books.
- `analyzeEventOdds(normalizedOdds)` → orchestrates the three above and returns
  a structured `EdgeComputation`:
  `{ generatedAt, outcomes: [{ name, bestPrice, bestBook, spread, consensusImpliedProb }], verdict: 'NOT_EVALUATED', verdictReason: 'EDGE conclusions are not implemented in this milestone' }`.
  The verdict is a constant for now — the separation of layers is the point.
- Deterministic, fully unit-testable offline with inline fixtures.

### 2.5 `edge-ui.js` (new — screen controller)

Owns everything about `#screen-edge`, wired from `app.js` via one guarded call.
Pattern your lifecycle on how `app.js` guards sub-steps (`guardedWire`) and how
existing controllers render lists (`real-validation-ui.js` is the closest
existing example of a multi-state panel; `rv-ticker-selector.js` shows the
select-population pattern).

Exported API: `initEdgeScreen({ oddsApi, serpApi })` where the two providers
are injected (default: construct from 2.2/2.3) — this injection is what makes
the jsdom tests offline.

Internal state object keeps the four layers explicitly separated:
`{ sportsStatus, sports, selectedSportKey, eventsStatus, events, selectedEventId,
rawOdds, computation, researchStatus, research }`. Raw odds JSON is retained
only in memory for recalculation — **never rendered**.

Behaviors:

- **Sport selector**: on first activation (route `#/edge` entered), if
  `hasOddsCredential()` false → render UNCONFIGURED card ("Odds API key
  required — add it in Settings", button deep-links `#/settings`). Else show
  loading skeleton in the select area, call `fetchSports`, populate
  `<select id="edge-sport-select">` with `active === true` options labeled
  `"${title} (${group})"` sorted by title. Persist chosen sport key in
  `storage.js` under `market-intelligence:edge-sport` so revisit restores it.
- **Events list**: on sport change → loading state → `fetchUpcomingEvents` →
  render tappable rows (`<button class="event-row">`: `homeTeam vs awayTeam` +
  localized commence time). Loading / EMPTY ("No upcoming events") / ERROR
  (retry button) / UNCONFIGURED states all handled.
- **Event selection**: tapping a row sets `selectedEventId`, applies an
  `is-selected` class (reuse existing selected-row CSS idioms), enables the
  Analyze button.
- **Analyze**: per-event action → loading spinner on the row's result panel →
  `fetchEventOdds` → store `rawOdds`, compute via `analyzeEventOdds`, render a
  formatted card per outcome (name, best price + book, spread, consensus implied
  probability as %) plus the verdict line rendered verbatim from the
  computation (`NOT_EVALUATED` → "EDGE conclusion: pending — not evaluated in
  this version"). Errors map to friendly banners (bad key / rate limit /
  network), never stack traces, never raw JSON (`JSON.stringify` of payloads
  must not appear in any DOM write — tests will assert this).
- **Research**: second per-event action → `hasSerpCredential()` false →
  render the dedicated **"SerpAPI key required"** state (distinct card, CTA →
  `#/settings`). Else loading → `fetchResearch(`${homeTeam} vs ${awayTeam} preview odds`)`
  → render up to 5 results as title/link/snippet list explicitly headed
  "External research (SerpAPI)" with an attribution/disclaimer line. Research
  results replace only the research panel; they never mix into the computation
  card DOM subtree.

### 2.6 Tests (Vitest, matching existing patterns exactly)

Existing conventions to follow: node-environment tests use plain
`describe/it/expect` with injected stub transports (`tests/rv-status.test.mjs`,
`tests/history-pagination.test.mjs`); UI tests use
`// @vitest-environment jsdom` + `vi.doMock` module patching + boot-the-real-code
(`tests/api-key-persistence.spec.js`, `tests/watchlist-add-flow.spec.js`);
offline-only, sentinel keys like `test-sentinel-key-abc123`, zero network.

| New file | Env | Covers |
|---|---|---|
| `tests/sports-credentials.test.mjs` | node (stub `storage.js` via vi.doMock; fake `globalThis.Capacitor`) | get/set/clear for both keys; native branch reads Preferences; web fallback namespacing; failures resolve `''`/`false` and log WITHOUT the key value (assert logged strings don't contain the sentinel); no cross-talk between odds & serp keys |
| `tests/odds-api.test.mjs` | node (stub `globalThis.fetch` recording requests, like `scripts/verify-v2-offline.mjs` does) | request shape for all three endpoints (paths, apiKey param present when provided); camelCase normalization of a `/v4/sports` fixture; events + odds normalization fixtures; 401→unconfigured-classifiable ApiError, 429→rate-limit, fetch rejection→TransportError; **no error message/log contains the sentinel key**; no hardcoded sport/book keys anywhere in module source |
| `tests/serp-api.test.mjs` | node (same stubbed fetch) | empty key → NotConfiguredError AND fetch never called; normalization to `{title,link,snippet}` from an `organic_results` fixture; missing organic_results → `[]`; key redaction in logs/errors |
| `tests/edge-analysis.test.mjs` | node | impliedProbability (normal, zero, negative, NaN → null); bestPrice/spread across multi-book fixture; consensus averaging; `verdict === 'NOT_EVALUATED'` always; determinism (same input twice → deep-equal output) |
| `tests/edge-ui.spec.js` | jsdom (`vi.doMock` the three service modules; drive real `initEdgeScreen`) | (1) no odds credential → UNCONFIGURED card shown, zero fetches; (2) loading→populated select from stubbed sports; (3) sports fetch rejects → ERROR state with retry, app doesn't blank (screen still visible); (4) sport change loads events; empty events → EMPTY state; (5) event selection highlights row + enables Analyze; (6) Analyze renders computed card fields and **does not contain `JSON.stringify` of raw payload** in `document.body.textContent`; verdict line shows pending text; (7) Research without serp key → exact "SerpAPI key required" state, no fetch; (8) Research with key → ≤5 sanitized links rendered under external-research heading; (9) sport choice persists via storage mock and is restored on re-init |

Also **modify** (see §3): `build-check.mjs` gains the five new modules in its
explicit `MODULES` list; `index.html` gains the new screen/nav markup;
`app.js` gains the route branch + one `guardedWire(initEdgeScreen…)` step +
Settings wiring for the two new keys; `style.css` gains the edge styles.

---

## 3. Files to CHANGE (minimal diffs)

### 3.1 `index.html` (root, then mirror to `www/index.html`)

- Add nav item `<a class="nav-item" href="#/edge" data-nav="edge">` in BOTH nav
  bars (top ~line 32–41 block and bottom ~line 290–299 block), with a simple
  inline-SVG icon consistent with siblings; label "EDGE".
- Add `<section id="screen-edge" class="screen" hidden>` between Search and
  Settings sections containing:
  - `.screen-head` with `<h1>EDGE Analysis</h1>`
  - `<div id="edge-unconfigured">` (hidden; Odds-key-required card)
  - `<label class="field"><span>Sport</span><select id="edge-sport-select" class="select"></select></label>`
    plus `<div id="edge-sport-status">` for loading/error/empty messages
  - `<div id="edge-events" class="result-list">` (event rows)
  - `<div id="edge-analysis-panel">` (computed-differences card target)
  - `<div id="edge-research-panel">` (external-research card target)
- In `#screen-settings` form, add one new `.card` titled "Sports data keys"
  with two password inputs: `name="oddsApiKey"` (hint: "The Odds API —
  the-odds-api.com personal key") and `name="serpApiKey"`
  (hint: "SerpAPI — serpapi.com personal key"), each with saved-indicator
  smalls (`id="odds-key-saved"`, `id="serp-key-saved"`), plus two ghost buttons
  `id="settings-remove-odds-key"`, `id="settings-remove-serp-key"`.
  Copy the existing API-key hint wording about device-secure storage.

### 3.2 `app.js`

- Router (~line 243 `router()`): add branch
  `else if (baseRoute === 'edge') { $('#screen-edge').hidden = false; if (edgeUi) edgeUi.onRouteEnter(); }`
  (export/return a tiny handle from `initEdgeScreen`, or expose
  `onRouteEnter` via the returned object — pick whichever keeps the diff
  smallest; lazy-fetch on first enter, cached afterwards).
- Boot sequence: after existing guarded steps, add
  `guardedWire(() => { edgeUiHandle = initEdgeScreen(); }, '[boot] edge screen init');`
  with `let edgeUiHandle = null;` declared beside the other controller lets.
- `wireSettings()`: extend the existing load/save/remove flow for the two new
  fields following the EXACT proven order that `tests/api-key-persistence.spec.js`
  enforces for the main key: read stored value first, update UI, and on save
  persist via `setOddsApiKey/setSerpApiKey` BEFORE any consumer refresh; never
  pass empty-string keys around as if they were configured. Keep the existing
  tickerbot logic byte-identical.

### 3.3 `style.css`

Add a compact `/* ── EDGE screen ── */` section: reuse existing tokens/classes
(`.card`, `.btn`, `.field`, `.result-list`, `.hint`) as much as possible; new
classes limited to `.event-row`, `.event-row.is-selected`,
`.edge-status-banner` (+ modifier classes for loading/error/unconfigured),
`.edge-computation-card`, `.edge-research-card`. Dark-theme variables already
in `:root` — do not introduce new colors.

### 3.4 `build-check.mjs`

Append the five new filenames to the explicit `MODULES` array so
`npm run build` syntax-checks them (this file is not constraint-protected;
the change is additive and required for the gate to cover new code).

### 3.5 Mirror everything to `www/`

Copy each created/modified root file to `www/` (there is no automated sync).
Verify: `for f in <changed files>; do diff -q "$f" "www/$f"; done` prints
nothing.

---

## 4. Frozen files (constraints — do NOT touch)

- `secure-store.js` (the SecureStorage/ProviderCredentialService architecture)
- Anything inside `api.js` / `TickerbotAPI` (live retrieval path) and
  `market-data.js`, `history-source.js`, `charts.js`, `indicators.js`, etc.
- `android/` directory, `capacitor.config.json`, `scripts/patch-http-plugin-gradle.mjs`
- Artifact/gate scripts beyond the additive `build-check.mjs` list entry
  (`tests/apk-leak-scan.test.mjs`, `tests/smoke.mjs`, CI configs)
- Existing specs under `specs/` (records)

If you find yourself editing any of these, stop — the design above is
specifically shaped so you don't need to.

---

## 5. Implementation order (builder checklist)

1. Read `secure-store.js`, `api.js` (_doFetch + safeErrorInfo region),
   `app.js` (boot/router/wireSettings), `index.html`, one node-env test and
   one jsdom test end-to-end.
2. `sports-credentials.js` + `tests/sports-credentials.test.mjs` → green.
3. `odds-api.js` + `tests/odds-api.test.mjs` → green.
4. `serp-api.js` + `tests/serp-api.test.mjs` → green.
5. `edge-analysis.js` + `tests/edge-analysis.test.mjs` → green.
6. `index.html` + `style.css` + `edge-ui.js` + `app.js` wiring +
   `tests/edge-ui.spec.js` → green.
7. `build-check.mjs` MODULES += new files.
8. Mirror all changed/new root files into `www/`; `diff -q` each pair.
9. Full verification (§6). Commit.

Each step leaves the tree green; if a later step stalls, earlier steps are
still shippable.

---

## 6. Verification / acceptance criteria

Run from repo root; ALL must pass:

1. `npm run build` — parses all top-level modules including the five new ones.
2. `npx vitest run` — **all previous 214 tests still pass** plus the new files
   (~35–45 new assertions expected). Zero skipped, zero network.
3. `grep -riE "odds[_-]?api(_|\.)?com|serpapi" --include="*.js" --include="*.html" . | grep -v node_modules | grep -v tests/` —
   endpoint hostnames may appear ONLY in the two provider modules (and their
   tests); confirm no key material anywhere: `git grep -iE "sk-|api_key\s*=\s*['\"][A-Za-z0-9]"`
   returns nothing outside placeholders.
4. Manual smoke via `npm run serve` (optional but recommended):
   - Without keys: EDGE tab shows "Odds API key required"; Settings accepts and
     removes both new keys; existing Watchlist/Search flows unchanged.
   - With a real Odds API key: selector populates from live `/v4/sports`;
     choosing a sport lists events; Analyze renders the computed card (never
     raw JSON); Research shows "SerpAPI key required" until a SerpAPI key is
     saved, then renders titled/snippet results.
5. `apk-leak-scan` test remains green (no new secrets in shipped assets).

Definition of done: all of the above true; no file from §4 modified
(`git diff --name-only` checked against §4 list); both `specs/` record and
this handoff unchanged.

---

## 7. Known risks / notes

- **The Odds API auth is a query-param key**, unlike Tickerbot's header. Every
  log/Error path in the new providers must rebuild URLs without the param
  before logging. Tests assert this with a sentinel.
- **Rate limits**: The Odds API plans are quota-limited per month. The UI must
  cache the sports list in-memory per session (refetch only on manual retry)
  and not auto-poll events — one fetch per user action, matching the repo's
  "no surprise calls" ethos (`tests/api-efficiency-zero-calls.test.mjs` culture).
- **No bundler**: everything is plain ES modules loaded from `index.html`; do
  not add imports that only work under Node (except in `edge-analysis.js`,
  which should have none anyway).
- **www/ drift** is the likeliest silent failure — the final `diff -q` loop in
  §3.5 is mandatory.
- If The Odds API response shape evolves (v4 field renames), normalization is
  isolated in `odds-api.js`; fix there, not in UI/tests.
