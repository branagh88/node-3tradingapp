"""Config loading/validation and agent execution.

Every ADW validates its agents before running (fail fast, nothing spawns
against a half-valid config). Every agent call parses against a concrete
output type; parse failures and gate violations re-prompt the SAME session
with a correction — context intact, bounded retries. Agent proposes, code
disposes.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import yaml

from . import agent_pi, permissions, prompts
from .data_types import (AgentCall, AgentConfig, EnvelopeBase, EventRecord,
                         GateCheck, GateReport, Phase, PiRequest, SSSFConfig,
                         UsageBreakdown)
from .utils import new_id

JSON_FIX_ATTEMPTS = 2      # continue-with-correction attempts for malformed JSON


def disabled_agents() -> set[str]:
    """Agents the operator turned off (PRS Factory Run The Factory checkboxes).
    The server injects SSSF_DISABLED_AGENTS into every ADW spawn; both
    resolve() and the manager roster read it so a disabled agent is never
    dispatched (and never silently run)."""
    return {a.strip() for a in os.environ.get("SSSF_DISABLED_AGENTS", "").split(",") if a.strip()}


def sandbox_allowed() -> set[str] | None:
    """Sandbox mode: the server injects SSSF_SANDBOX=1 + SSSF_ALLOWED_AGENTS
    for runs launched by a non-admin (or on a sandbox-flagged project). Under
    sandbox, only the allowed roster may dispatch — builder/manager/art-director
    and friends are refused outright unless explicitly granted (build_code adds
    the phaser/threejs/web builders via SSSF_ALLOWED_AGENTS). Returns None when
    not sandboxed (all agents OK)."""
    if os.environ.get("SSSF_SANDBOX") != "1":
        return None
    allowed = {a.strip() for a in os.environ.get("SSSF_ALLOWED_AGENTS", "").split(",") if a.strip()}
    return allowed or {"scout", "planner", "documenter", "reviewer", "researcher", "quality"}


def sandbox_builders_allowed() -> bool:
    """True when the sandboxed run may use the builder agents (the server sets
    SSSF_ALLOW_BUILDERS=1 when the session has build_code). Builders write
    inside the repo — permissions.py uses this to relax the no-writes floor."""
    return os.environ.get("SSSF_ALLOW_BUILDERS") == "1"


def enabled_agents(cfg: SSSFConfig) -> list[AgentConfig]:
    """Configured agents minus the disabled set — the roster the manager may
    dispatch. (resolve() still refuses a disabled name; this just stops the
    manager from ever picking one.) Under sandbox, further narrowed to the
    allowed roster."""
    off = disabled_agents()
    allowed = sandbox_allowed()
    return [a for a in cfg.agents
            if a.name not in off and (allowed is None or a.name in allowed)]


class GateFailure(RuntimeError):
    pass


# ── config ───────────────────────────────────────────────────────────────────

def load_config(path: str = "adws/adw_sssf_config/sssf.config.yaml") -> SSSFConfig:
    raw = yaml.safe_load(Path(path).read_text()) or {}
    defaults = raw.get("defaults", {}) or {}
    for agent in raw.get("agents", []) or []:
        for key in ("coding_agent", "model", "thinking", "color", "tools", "writes"):
            if key in defaults:
                agent.setdefault(key, defaults[key])
        agent.setdefault("harness_engineering", defaults.get("harness_engineering", []))
    return SSSFConfig(**raw)


def resolve(cfg: SSSFConfig, name: str) -> AgentConfig:
    for agent in cfg.agents:
        if agent.name == name:
            # Disabled by the operator (PRS Factory Run The Factory checkboxes).
            if name in disabled_agents():
                raise SystemExit(
                    f"agent {name!r} is DISABLED in the factory (unchecked in "
                    f"PRS Factory → Run The Factory). Re-enable it in the UI or "
                    f"unset SSSF_DISABLED_AGENTS to run it.")
            # Sandbox: only the allowed roster may run. This is the hard stop —
            # a non-admin factory run can never dispatch a system-touching agent.
            allowed = sandbox_allowed()
            if allowed is not None and name not in allowed:
                raise SystemExit(
                    f"agent {name!r} is NOT ALLOWED in sandboxed factory runs "
                    f"(allowed: {', '.join(sorted(allowed))}). Admin can run any agent.")
            return agent
    raise SystemExit(f"agent {name!r} is not defined in the config — "
                     f"available: {[a.name for a in cfg.agents]}")


def validate(cfg: SSSFConfig, required: list[str]) -> None:
    """Fail fast: every required name must resolve to a usable agent."""
    problems = []
    for name in required:
        try:
            agent = resolve(cfg, name)
        except SystemExit as e:
            problems.append(str(e))
            continue
        if agent.coding_agent != "pi":
            problems.append(f"agent {name!r}: coding_agent {agent.coding_agent!r} "
                            f"is not implemented in v1 (pi only)")
        for label, ref in (("system", agent.prompt_engineering.system),
                           ("user", agent.prompt_engineering.user)):
            if not Path(ref).is_file():
                problems.append(f"agent {name!r}: {label} prompt not found: {ref}")
        try:
            agent_pi.resolve_model(agent.model)
        except ValueError as e:
            problems.append(f"agent {name!r}: {e}")
    if problems:
        raise SystemExit("config validation failed:\n- " + "\n- ".join(problems))


# ── execution ────────────────────────────────────────────────────────────────

def execute(run, phase: Phase, call: AgentCall) -> EnvelopeBase:
    """One agent call: render prompts -> pi run -> typed parse -> gates -> envelope."""
    agent = resolve(run.cfg, phase.params.owner)
    agent_dir = run.session_dir / agent.name
    agent_dir.mkdir(parents=True, exist_ok=True)

    variables = {
        "prompt": call.prompt,
        "previous_envelope": call.previous.model_dump_json(indent=2) if call.previous else "(none)",
        "context_handoff_dir": str(run.context_handoff_dir),
    }
    system_text = prompts.render(agent.prompt_engineering.system, variables)
    user_text = prompts.render(agent.prompt_engineering.user, variables)
    # The final-message contract, stated on EVERY call. A coding agent's
    # natural exit is a prose summary ("done, tests pass"), and a prose exit
    # cannot be parsed into an envelope. Making the contract explicit per call
    # keeps the ask and the parse from drifting — this is the main fix for
    # flash models that finish a long tool-using phase with no JSON at all.
    user_text += (
        "\n\n## Final message contract\n"
        "When your work is done, your ENTIRE final message must be exactly one "
        "valid JSON object and nothing else: no markdown fences, no prose before "
        "or after it, no 'here is the JSON:' prefix. Do not call any more tools "
        "to produce it. Required fields: "
        + ", ".join(call.output_type.model_fields.keys()) + "."
        + " The 'status' field MUST be exactly \"success\" or \"fail\": "
        "'success' means the goal was achieved (note any partial/skipped sub-steps "
        "in the other fields, e.g. a conversion done but an APK not built); "
        "'fail' means you could not complete the goal, and summary must say why. "
        "Never use any other status value ('not_started', 'skipped', 'partial', "
        "'done', etc.) — those will fail validation."
    )
    # Make the agent deadline-aware when the operator/user set a run timeout
    # (SSSF_RUN_TIMEOUT minutes). The process is SIGTERM'd at the limit, so a
    # heads-up with the REMAINING time lets the agent scope its work and
    # finish before the cut.
    timeout_min = getattr(run, "timeout_min", 0) or 0
    deadline_at = getattr(run, "deadline_at", None)
    if timeout_min > 0:
        remaining_min = max(0, int((deadline_at - time.time()) / 60)) if deadline_at else timeout_min
        user_text += (
            f"\n\n## Time limit\n"
            f"This run has a hard time limit of {timeout_min} minutes; roughly "
            f"{remaining_min} minute(s) remain. The process is terminated "
            f"automatically when the time is up — scope the remaining work to fit, "
            f"prioritize the core goal over polish, and emit your JSON before the limit."
        )
    prompts.save(agent_dir / "prompts", "system.md", system_text)
    prompts.save(agent_dir / "prompts", "user.md", user_text)

    session_id = _agent_session_id(run, agent)
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_start", name=agent.name,
                                 payload={"model": agent.model, "thinking": agent.thinking,
                                          "color": agent.color,
                                          "session_id": session_id,
                                          "coding_agent": agent.coding_agent,
                                          "purpose": agent.purpose,
                                          "tools": agent.tools,  # None = all tools
                                          "harness_engineering": agent.harness_engineering}))
    run.console.agent_started(agent.name, agent.model, session_id)

    # Parse retries and gate corrections re-enter the SAME pi session, so the
    # last send is the one whose context occupancy is current — while spend is
    # the opposite: every send costs, so usage accumulates across all of them.
    latest: agent_pi.PiResult | None = None
    spent = UsageBreakdown()

    def send(prompt_text: str,
             max_tool_calls: int | None = None,
             max_identical: int | None = None) -> agent_pi.PiResult:
        nonlocal latest
        request = PiRequest(
            prompt=prompt_text,
            system_prompt=system_text,
            model=agent.model,
            thinking=agent.thinking,
            session_id=session_id,
            # absolute: these are read by the pi subprocess, which runs in repo_root
            session_dir=str((agent_dir / "pi_sessions").resolve()),
            raw_output_path=str((agent_dir / "raw_output.jsonl").resolve()),
            tools=_agent_tools(agent),
            extensions=agent.harness_engineering,
            cwd=str(run.repo_root),
            # Phase guardrails: identical-call loop guard, tool budget, and
            # the phase deadline all live in agent_pi.run (it owns the child
            # process). Defaults come from the phase; a corrective retry can
            # tighten them (see the abort path below).
            max_tool_calls=(max_tool_calls if max_tool_calls is not None
                            else phase.params.max_tool_calls),
            max_identical_tool_calls=(max_identical if max_identical is not None
                                      else phase.params.max_identical_tool_calls),
            deadline_at=(time.time() + phase.params.timeout_sec)
            if phase.params.timeout_sec > 0 else None,
        )
        result = agent_pi.run(
            request,
            on_event=_event_forwarder(run, phase, agent.name),
            on_spawn=lambda pid: run.tracer.process_start(
                run.adw_id, "agent", agent.name, pid,
                f"{agent.coding_agent} {agent.name} {agent.model}"),
            on_exit=lambda pid: run.tracer.process_end(run.adw_id, pid))
        run.add_usage(result.tokens, result.cost)
        spent.merge(result.usage)
        latest = result
        return result

    # What the tree looked like before this agent got its hands on it. Every
    # send in this phase — first prompt, JSON retries, gate corrections — is
    # measured against this one baseline.
    tree_before = permissions.snapshot(run)

    result = send(user_text)
    if result.aborted_reason:
        # A guardrail fired before the agent produced a final message: it
        # looped on identical tool calls, blew its tool budget, or ran past
        # the phase deadline. One corrective retry in the SAME session with a
        # hard "stop using tools" instruction and a tight budget; a second
        # abort fails the phase instead of looping again.
        run.tracer.event(EventRecord(
            adw_id=run.adw_id, phase_id=phase.phase_id, type="log",
            name="guardrail", payload={"agent": agent.name,
                                       "reason": result.aborted_reason,
                                       "detail": result.aborted_detail}))
        run.console.note(f"{agent.name}: {result.aborted_reason} "
                         f"({result.aborted_detail}) — corrective retry")
        correction = (
            f"You were stopped during your previous attempt: "
            f"{result.aborted_detail} (reason: {result.aborted_reason}). "
            f"You must NOT call any tools and must NOT write any files. "
            f"Based on the run history and your original instructions, "
            f"produce your final output NOW as exactly one JSON object."
        )
        result = send(correction, max_tool_calls=12, max_identical=3)
        if result.aborted_reason:
            raise RuntimeError(
                f"{agent.name} aborted twice ({result.aborted_reason}: "
                f"{result.aborted_detail}) — refusing to loop again")
    envelope, attempt = _parse_with_retries(run, phase, call, result, send)

    # claim gates — violations flow back into the SAME session as corrections
    for gate_attempt in range(1, max(1, phase.params.retries + 1) + 1):
        violations = []
        for gate in call.gates:
            report = _as_report(gate(envelope, run))
            found = report.violations
            run.tracer.gate_row(phase, gate.__name__, report, gate_attempt)
            run.tracer.event(EventRecord(
                adw_id=run.adw_id, phase_id=phase.phase_id,
                type="gate_fail" if found else "gate_pass", name=gate.__name__,
                payload={"attempt": gate_attempt, "violations": found,
                         "checks": [c.model_dump() for c in report.checks]}))
            run.console.gate_result(gate.__name__, report)
            violations.extend(found)
        if not violations:
            break
        if gate_attempt > phase.params.retries:
            raise GateFailure(f"{agent.name} failed gates after {gate_attempt} attempt(s):\n- "
                              + "\n- ".join(violations))
        phase.attempt = gate_attempt
        run.console.retry(agent.name, gate_attempt, phase.params.retries,
                          f"{len(violations)} gate violation(s)")
        correction = ("Your previous response failed validation:\n- "
                      + "\n- ".join(violations)
                      + "\n\nFix these problems, then re-emit ONLY your Report JSON.")
        result = send(correction)
        envelope, attempt = _parse_with_retries(run, phase, call, result, send)

    # Permission is checked after every send is done, and before the envelope is
    # accepted: an agent does not get to report success on a phase in which it
    # wrote somewhere it was not allowed to.
    try:
        touched = permissions.enforce(run, phase, agent, tree_before)
    except permissions.PermissionBreach as breach:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="error", name="permission_breach",
                                     payload={"agent": agent.name, "error": str(breach),
                                              "writes": agent.writes,
                                              "protected_files": run.cfg.defaults.protected_files}))
        # A permission breach fails THIS PHASE, not the whole run. The failed
        # envelope is returned (not raised), so the phase records a clean
        # failure and the run's own logic decides: the manager (in a
        # manager-driven run) sees the failure and dispatches a repair (e.g.
        # factory-dev for machinery edits); a fixed-chain run's acceptance
        # check sees the failed phase and fails the run — but with a full
        # trace and no hung process.
        fail_env = call.output_type(status="fail",
                                    summary=f"{agent.name} overstepped permissions: {str(breach)[:300]}")
        _persist_envelope(run, phase, agent.name, call, fail_env, 0, valid=False)
        run.console.envelope_summary(fail_env)
        return fail_env
    if touched:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="log", name="paths_touched",
                                     payload={"agent": agent.name, "paths": touched}))

    _persist_envelope(run, phase, agent.name, call, envelope, attempt, valid=True)
    run.console.envelope_summary(envelope)
    context = latest or result
    run.tracer.agent_session_row(run.adw_id, agent, session_id,
                                 context_tokens=context.context_tokens,
                                 context_window=context.context_window)
    run.save_agent_map(agent.name, {"session_id": session_id, "model": agent.model,
                                    "coding_agent": agent.coding_agent})
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="handoff", name=agent.name,
                                 payload={"artifacts": envelope.artifacts,
                                          "summary": envelope.summary}))
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_end", name=agent.name,
                                 # Phase totals, not the last send's: a retried
                                 # phase paid for every attempt.
                                 tokens=spent.total_tokens,
                                 payload={"cost": spent.total_cost,
                                          "usage": spent.model_dump(),
                                          "context_tokens": context.context_tokens,
                                          "context_window": context.context_window}))
    run.console.agent_finished(agent.name, spent.total_tokens, spent.total_cost)
    if envelope.status != "success":
        raise RuntimeError(f"{agent.name} reported status={envelope.status!r}: {envelope.summary}")
    return envelope


# ── internals ────────────────────────────────────────────────────────────────

def _as_report(result) -> GateReport:
    """Accept a GateReport, or a legacy gate that returned a violations list."""
    if isinstance(result, GateReport):
        return result
    return GateReport(checks=[GateCheck(item=str(v), ok=False) for v in (result or [])])


def _agent_tools(agent: AgentConfig):
    """Every agent can summon the Factory Manager (manager_help tool) — except
    the manager itself, which must never summon itself.

    The manager-help pi extension auto-loads globally, but an agent whose
    config names an explicit `tools` allowlist only sees tools on that list,
    so the allowlisted tool is injected here rather than in every config.
    """
    if agent.tools is None:
        return None                    # full toolset — manager_help is already available
    tools = list(agent.tools)
    if agent.name != "manager" and "manager_help" not in tools:
        tools.append("manager_help")
    return tools


def _agent_session_id(run, agent: AgentConfig) -> str:
    entry = run.agent_map.get(agent.name)
    if entry and entry.get("model") == agent.model:
        return entry["session_id"]           # rejoin the existing context window
    return f"sssf-{run.adw_id}-{agent.name}-{new_id(4)}"


def _event_forwarder(run, phase: Phase, agent_name: str):
    """One tool_call event per real tool call, with its exact args and result."""
    tracker = agent_pi.ToolCallTracker()

    def forward(event: dict) -> None:
        record = tracker.observe(event)
        if record is None:
            return
        # The call's span rides the columns; duration_ms stays in the payload as
        # pi's own authoritative number.
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="tool_call", name=record.pop("label"),
                                     started_at=record.pop("started_at", None),
                                     ended_at=record.pop("ended_at", None),
                                     payload={**record, "agent": agent_name}))
    return forward


def _extract_json(text: str) -> dict:
    """Pull the first complete JSON object out of an agent's final message.

    Tries, in order: every ```json fence block, then the raw text. For each
    candidate it slides a raw_decode across every '{', so prose before, after,
    or between JSON values never drags junk into the parse. A flash model that
    ends a long tool-using session with \"here's what I did: {...} and then...\"
    is recovered instead of rejected; only a response with NO JSON at all raises.
    """
    if not text or not text.strip():
        raise ValueError("empty response — no JSON object found")
    decoder = json.JSONDecoder()
    candidates = [text]
    if "```" in text:
        fences = [b.removeprefix("json").strip()
                  for b in text.split("```")[1::2] if b.strip()]
        candidates = fences + candidates
    for candidate in candidates:
        idx = candidate.find("{")
        while idx != -1:
            try:
                obj, _ = decoder.raw_decode(candidate[idx:])
            except json.JSONDecodeError:
                idx = candidate.find("{", idx + 1)
                continue
            if isinstance(obj, dict):
                return obj
            idx = candidate.find("{", idx + 1)
    raise ValueError("no JSON object found in the response")
    return json.loads(candidate[start:end + 1])


def _parse_with_retries(run, phase: Phase, call: AgentCall, result, send):
    """Parse the final response against the declared output type; on failure,
    continue the SAME session with a correction (bounded)."""
    for attempt in range(1, JSON_FIX_ATTEMPTS + 2):
        try:
            payload = _extract_json(result.text)
            return call.output_type.model_validate(payload), attempt
        except Exception as error:
            _persist_envelope(run, phase, phase.params.owner, call, None, attempt,
                              valid=False, raw=result.text)
            if attempt > JSON_FIX_ATTEMPTS:
                raise RuntimeError(
                    f"{phase.params.owner} never produced valid "
                    f"{call.output_type.__name__} JSON: {error}") from error
            run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS,
                              f"invalid {call.output_type.__name__} JSON: {error}")
            fields = ", ".join(call.output_type.model_fields.keys())
            result = send(
                f"Your response was not valid JSON for the required structure "
                f"({error}). Do NOT call any tools and do NOT write any files. "
                f"Your entire reply must be exactly one JSON object with these "
                f"fields: {fields}. No prose, no markdown, no code fences.")


def _persist_envelope(run, phase: Phase, agent_name: str, call: AgentCall,
                      envelope: Optional[EnvelopeBase], attempt: int,
                      valid: bool, raw: str = "") -> None:
    payload_json = envelope.model_dump_json(indent=2) if envelope else json.dumps({"raw": raw[-2000:]})
    run.tracer.envelope_row(phase, agent_name, call.output_type.__name__,
                            payload_json, valid, attempt)
    if envelope:
        record = {"agent_name": agent_name, "purpose": resolve(run.cfg, agent_name).purpose,
                  "output_type": call.output_type.__name__, "attempt": attempt,
                  **envelope.model_dump()}
        (run.session_dir / agent_name / "envelope.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
