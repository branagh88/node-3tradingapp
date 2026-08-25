# Phase B Verification + Repository Integrity Plan (session ff6a2670)

## Role

You are the VERIFICATION builder. This is **verification only** — no features,
no refactors, no Phase C. Target state: `FILES CHANGED = NONE`.

## Critical context from planning recon (already confirmed — do not redo blindly)

1. **`f8b6f46d` DOES NOT EXIST in this repository.** `git cat-file -t f8b6f46d`
   → `fatal: Not a valid object name`. The Phase B implementation was landed in
   commit **`778eb67`** ("Verify Phase B: land prediction persistence, wire
   real quality gates, add e2e lifecycle check"). Treat every instruction in
   the task prompt that references `f8b6f46d` as referring to `778eb67`, and
   call out this hash discrepancy explicitly in your final report.
2. **The protected-machinery finding is real and already committed.** Commit
   `778eb67` modified `adws/adw_modules/quality.py` relative to the factory
   baseline `c50a97c` ("PRS Factory: install factory machinery"). The diff:
   - `test()` argv changed from `_placeholder("test")` → `["npx", "vitest", "run"]`
   - `lint()` and `typecheck()` blocks **removed**
   - new `smoke()` block → `["npm", "run", "smoke"]`
   - `build()` argv → `["bash", "-c", "npm run build && node build-check.mjs"]`
   - `run_quality()` blocks list updated accordingly.
   The SAME commit also touched other `adws/` files (`adw_android.py`,
   `data_types.py`, `gateways/gates.py`, `git_helper.py`) plus added
   `adws/tests/test_android_gates.py` and session context files.
3. **Working tree is otherwise clean** w.r.t. `adws/` (`git status` shows only
   a dirty `node_modules/.vite/vitest/...results.json`). Current branch:
   `factory/ff6a2670`. HEAD = `32621e4` ("factory 32d2bdf5: merge run branch").
4. The change to `quality.py` is precisely the "replace placeholder quality
   gate with real commands" wiring the task prompt itself demands ("the
   previous run's placeholder quality gate must NOT be treated as evidence of
   passing tests"). It is a **prior, committed** change — do NOT revert it,
   rewrite history, or edit anything under `adws/adw_modules/`. Report it.

## Absolute prohibitions (repeat)

- Do NOT edit `adws/adw_modules/quality.py` or ANY file under `adws/adw_modules/`.
- Do NOT edit any factory/orchestration machinery.
- Do NOT redesign Phase B, start Phase C, add calibration / dashboards /
  LLM features / automated trading.
- Do NOT modify live Phase A prediction behavior or Android dropdown code.
- If you find an application defect: STOP and report it; make no fix unless
  the defect blocks a mandated check and the minimal fix is unambiguous.

---

## STEP 1 — Repository integrity

Run and record output:

```
git status
git log --oneline -10
git rev-parse HEAD
git diff 778eb67^..HEAD -- adws/adw_modules/quality.py
git show HEAD:adws/adw_modules/quality.py | head -80
git diff --stat c50a97c..HEAD -- adws/
git status --short adws/
```

Determine and report:

- PROTECTED FACTORY STATUS: whether `adws/adw_modules/quality.py` at HEAD
  differs from factory baseline `c50a97c`, and the exact responsible commit
  (`778eb67`) and hunk summary (see recon item 2 — confirm it matches).
- Confirm NO *uncommitted* working-tree changes exist under `adws/`.
- Confirm nothing else under `adws/adw_modules/` changed beyond what
  `git log --oneline --all -- adws/adw_modules/` attributes to commits
  `c50a97c` (factory install) and `778eb67` (gate wiring).
- Explicitly flag the `f8b6f46d` vs `778eb67` hash mismatch.

Do NOT revert, restore, or rewrite anything. If the delta is exactly the
documented placeholder→real-command wiring above, classify it as
"intentional gate wiring, committed in 778eb67"; anything beyond that
classification is a red flag to escalate.

## STEP 2 — Verify Phase B files exist

```
ls prediction-record.js prediction-repository.js tests/prediction-repository.test.mjs scripts/verify/e2e-phase-b.mjs
grep -n "api/predictions" server.mjs        # endpoints at lines ~69–155
grep -n "wirePredictionRecords\|PredictionRepository" app.js
grep -n -i "prediction records" index.html  # panel ~line 295
```

All were confirmed present at planning time; re-confirm and note sizes.

## STEP 3 — Full real test suite

`package.json` confirms `"test": "vitest run"`. Run:

```
npx vitest run
```

Record: number of test files, tests, passed, failed, skipped (use the vitest
summary line). Never substitute echo placeholders.

## STEP 4 — Phase B tests

```
npx vitest run tests/prediction-repository.test.mjs
```

Report exact file/test/pass counts.

## STEP 5 — Build

```
npm run build          # runs node build-check.mjs (per package.json)
node build-check.mjs   # run standalone too, record exit code
```

## STEP 6 — Smoke

```
npm run smoke          # runs node tests/smoke.mjs
```

Record pass/fail + exit code.

## STEP 7 — Phase B end-to-end lifecycle (actually execute)

A deterministic E2E driver exists: `scripts/verify/e2e-phase-b.mjs`
(builds a fixed contract for ticker `vrfy` at a fixed conditionTime, POSTs
create, POSTs duplicate, POSTs outcome bars, asserts resolved/correct and
noop-immutability on re-post).

Run it against a live server:

```
node server.mjs &            # PORT=3999 default of the script
sleep 2
node scripts/verify/e2e-phase-b.mjs; echo "exit=$?"
```

The existing script covers: PREDICT(contract)→PERSIST→RETRIEVE→snapshot
verify→COMPLETE HORIZON(outcome)→retrieve actual→return/direction/compare
(asserted inside repo+server)→PERSIST OUTCOME→duplicate noop. It does **not**
cover RELOAD-after-restart. Add the missing leg WITHOUT committing files —
do it live:

```
kill %1                       # stop server
node server.mjs &
sleep 2
curl -s http://localhost:3999/api/predictions/VRFY%7C2026-01-15%7Cv1 > /tmp/reloaded.json
```

Then compare `/tmp/reloaded.json`'s `.prediction` subtree byte-for-byte with
the original snapshot captured before restart (save the create response to
/tmp first). All prediction fields must be identical post-reload.

## STEP 8 — Immutability

From the artifacts captured in STEP 7 (original create response vs post-
outcome response vs post-reload response), assert these did NOT change:
prediction price (entryClose), probabilityPct, direction, confidence,
feature snapshot (condition/analysis/dataset), analog statistics,
methodology/matchMode, engine version, generatedAt/conditionTime timestamps.
Only `outcomes.*`, `lifecycleStatus`, and outcome-side fields may differ.
You may additionally rely on vitest tests 9, 14, 17 in
`tests/prediction-repository.test.mjs` as corroborating evidence, but the
live E2E comparison is primary.

## STEP 9 — Leakage

Run the dedicated regression:

```
npx vitest run tests/prediction-repository.test.mjs -t "17"
# (test name: 'leakage regression: post-condition data can never alter stored prediction fields')
```

Also read `tests/prediction-repository.test.mjs` test 17 briefly and confirm
it mutates future bars after snapshot and asserts stored prediction fields
are untouched. Confirm the server outcome endpoint never writes back into
`record.prediction` (read `server.mjs` lines ~155–200).

## STEP 10 — Duplicate protection

Covered by E2E step (second POST → `200 {duplicate:true}`) and vitest
test 7 ("same identity returns existing record unchanged, count stays 1"):

```
npx vitest run tests/prediction-repository.test.mjs -t "7"
```

Additionally verify separation: POST two contracts differing in ticker (or
conditionTime) → two distinct ids, list shows both. Use curl against the
running server; no committed code changes.

## STEP 11 — Horizon semantics

Vitest tests 15 and 16 assert parity with `computeMatchedForwardOutcomes`
and candle-offset (not calendar-day) semantics:

```
nvitest() { npx vitest run tests/prediction-repository.test.mjs -t "$1"; }
nvitest "15"; nvitest "16"
```

Confirm `prediction-record.js`/`prediction-repository.js` horizon math calls
or mirrors the same entry/target-close logic used by the Phase A engine in
`prediction-engine.js` (`computeMatchedForwardOutcomes`). No calendar-day
logic introduced — grep for `86400000 *` misuse / date arithmetic in the
outcome path if in doubt.

## STEP 12 — API surface

Against the running server from STEP 7, exercise with curl:

- `POST /api/predictions` (create → 201)
- duplicate POST (→ 200 duplicate)
- `GET /api/predictions/:id` (retrieve)
- `GET /api/predictions` (list/filter — try `?ticker=` and status filters;
  read `server.mjs` ~line 110 for actual query params)
- pending filter / `lifecycleStatus=pending` visibility
- `POST /api/predictions/:id/outcome` (resolution → resolved)

Record status codes for each.

## STEP 13 — UI

Static inspection + served-page check:

- `index.html` contains "Prediction Records" panel with
  `pred-records-btn` (SAVE / REFRESH PREDICTION RECORD).
- `app.js` `wirePredictionRecords()` renders via
  `renderPredictionRecordsHtml`; confirm it distinguishes prediction vs
  outcome fields, shows pending/resolved lifecycle state, and takes its
  ticker/data from the record (grep for hardcoded tickers like `TSLA`/`NVDA`
  in `app.js` prediction-records section — there must be none).
- Optionally load `http://localhost:3999/` and confirm the page serves
  without JS errors via `node tests/boot-harness.mjs` (`npm run test:boot`)
  if it boots headlessly.

## STEP 14 — Phase A regression

- `git show --stat 297c4e9` — confirm Phase A commit intact and reachable
  from HEAD (`git merge-base --is-ancestor 297c4e9 HEAD`).
- `npx vitest run tests/live-prediction.test.mjs tests/prediction-engine.test.mjs`
  must pass with zero modifications to those files
  (`git diff 297c4e9..HEAD --stat -- live-prediction.js prediction-engine.js pattern-engine.js`
  should show no unexpected behavioral edits; note whatever it shows).

## STEP 15 — Android regression

- `git show ec6fc0a` — identify the mobile multiselect dropdown files
  (`ticker-multiselect.js`, `style.css`).
- `git diff ec6fc0a..HEAD --stat -- ticker-multiselect.js style.css` and
  confirm the popover positioning fix is not reverted.
- `npx vitest run tests/multiselect-mobile.test.mjs tests/ticker-multiselect.test.mjs`
  must pass.
- Physical Android device testing is almost certainly unavailable in this
  environment — say so explicitly in the report rather than claiming it.

---

## Verdict rules

Return exactly one:

- **PHASE B VERIFIED COMPLETE** — only if ALL of: factory machinery clean
  relative to its *post-wiring* accepted state (no NEW deltas beyond
  `c50a97c→778eb67` gate wiring, nothing uncommitted), full suite green,
  Phase B suite green, build green, build-check green, smoke green, E2E incl.
  reload leg green, immutability/leakage/duplicate/horizon/API/UI/Phase-A
  checks all green.
- **PHASE B IMPLEMENTED — VERIFICATION FAILED** — any application-level check
  fails while machinery integrity holds.
- **PHASE B VERIFICATION BLOCKED** — protected-machinery state cannot be
  certified clean (unexpected/unexplained deltas beyond the documented
  `778eb67` wiring), or environment prevents running real checks.

Given planning recon, the most likely outcome is: all app checks pass, and
PROTECTED FACTORY STATUS = "modified by prior commit 778eb67 (real-command
gate wiring); no uncommitted changes; f8b6f46d does not exist". Whether that
counts as "clean" is the operator's call — if you judge strictly by the
prompt's rule ("machinery is clean"), report **PHASE B VERIFICATION BLOCKED**
with the full explanation and let the operator ratify the `778eb67` wiring;
do NOT silently treat the wiring commit as pre-approved.

## Final report format

Emit exactly these fields:

CURRENT COMMIT / PROTECTED FACTORY STATUS / FULL TEST SUITE (files, tests,
passed/failed/skipped) / PHASE B TESTS / BUILD / BUILD CHECK / SMOKE /
END-TO-END / IMMUTABILITY / LEAKAGE / DUPLICATE PROTECTION / HORIZON / API /
UI / PHASE A REGRESSION / ANDROID REGRESSION / FILES CHANGED (target: NONE) /
FINAL VERDICT / RECOMMENDED NEXT PHASE (Phase C only if verdict is
VERIFIED COMPLETE; otherwise "none — resolve blockers first").

Include the `f8b6f46d`→`778eb67` hash correction prominently.
