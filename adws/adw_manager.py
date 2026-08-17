#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Manager - factory mode where a Manager Agent orchestrates the phases.

Usage:
    uv run adws/adw_manager.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> [manager decides -> chosen agent runs]... (bounded)
        -> git(commit) when the manager says done

There is no fixed phase chain. After every phase the Manager Agent reviews the
run's history (request, each envelope summary + artifacts + files touched) and
decides which configured agent runs next - or that the work is done. A failed
phase does not kill the run: the manager sees the failure and chooses the
repair, usually the same agent again with the error in its task.

The manager is read-only (`writes: []` in the config): it decides, it never
edits. Permissions are enforced on every phase either way.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from adw_modules import agents, gates, git_helper, permissions, session, utils
from adw_modules.data_types import (AgentCall, GenericOutput, ManagerDecision,
                                    PhaseParams)

REQUIRED_AGENTS = ["manager"]
MAX_PHASES = 12                   # hard cap on orchestrated agent phases

# Decide-phase guardrails (same as manager-lite; enforced in agent_pi.run via
# agents.execute): a manager that loops on identical tool calls or overruns
# its deadline is killed mid-turn, given ONE corrective retry, then the run
# fails. Tune via env.
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default

DECIDE_TIMEOUT_SEC = _int_env("SSSF_DECIDE_TIMEOUT_SEC", 900)
DECIDE_MAX_TOOL_CALLS = _int_env("SSSF_DECIDE_MAX_TOOL_CALLS", 60)
DECIDE_MAX_IDENTICAL = _int_env("SSSF_DECIDE_MAX_IDENTICAL_TOOL_CALLS", 6)

HISTORY_FILE = "run_history.json"


# -- run history (persisted for resume: a joined session picks up where the
#    trace left off instead of re-deciding from scratch) --------------------

def _load_history(run) -> list[dict]:
    f: Path = run.context_handoff_dir / HISTORY_FILE
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _save_history(run, history: list[dict]) -> None:
    (run.context_handoff_dir / HISTORY_FILE).write_text(
        json.dumps(history, indent=2), encoding="utf-8")


def _help_entries(run, agent, seen: int) -> tuple[list[dict], int]:
    """New manager-help exchanges (agent -> manager) since the last check.

    The manager_help extension appends one JSON line per request and per reply
    to <session_dir>/<agent>/manager_help.jsonl. We fold them into the run
    history so the orchestrator manager sees that help was asked and what was
    advised.
    """
    f: Path = run.session_dir / agent / "manager_help.jsonl"
    if not f.exists():
        return [], seen
    lines = [l for l in f.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
    if len(lines) <= seen:
        return [], len(lines)
    entries = []
    for line in lines[seen:]:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if "situation" in e:
            entries.append({"kind": "help", "owner": agent, "status": "asked",
                            "summary": f"asked the manager: {str(e['situation'])[:180]}"})
        elif "reply" in e:
            entries.append({"kind": "help", "owner": agent, "status": "advised",
                            "summary": f"manager advised: {str(e['reply'])[:180]}"})
    return entries, len(lines)


def _history_text(history: list[dict]) -> str:
    lines = []
    for i, h in enumerate(history, 1):
        status = h.get("status", "?")
        mark = "+" if status == "success" else ("!" if status == "fail" else ".")
        owner = h.get("owner", "")
        text = (h.get("summary") or h.get("error") or "").strip()[:220]
        parts = [f"{i}. [{mark}] [{owner}] {text}"]
        touched = h.get("touched") or []
        if touched:
            parts.append(f"   files: {', '.join(str(t) for t in touched[:12])}")
        lines.append("".join(parts))
    return "\n".join(lines) or "(no phases yet)"


# -- the manager's decision prompt: request + roster + run history -----------

def _manager_prompt(run, prompt: str, history: list[dict]) -> str:
    # The manager may ONLY dispatch enabled agents. The disabled set comes from
    # SSSF_DISABLED_AGENTS (injected by the server from the Run The Factory
    # checkboxes); resolve() would refuse a disabled pick anyway, so listing
    # only the enabled roster keeps the manager from wasting a phase on one.
    roster = "\n".join(f"- {a.name}: {a.purpose or '(no purpose)'}"
                       for a in agents.enabled_agents(run.cfg))
    off = agents.disabled_agents()
    disabled_note = (f"\nDISABLED AGENTS (do NOT dispatch these): {', '.join(sorted(off))}"
                     if off else "")
    return (
        f"Original request: {prompt}\n\n"
        f"ROSTER (agents you may dispatch — ONLY from this list):\n{roster}"
        f"{disabled_note}\n\n"
        f"RUN HISTORY:\n{_history_text(history)}"
    )


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
         adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)
    history = _load_history(run)
    manager_name = agents.resolve(cfg, "manager").name

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt, baseline=git_helper.short_sha(git_helper.rev("HEAD")))
        history.append({"kind": "engineer", "owner": run.engineer,
                        "status": "success", "summary": prompt[:220]})
        _save_history(run, history)

    last_envelope = None
    final = None
    commit_requested = False
    last_run_ok: bool | None = None   # None = no dispatched phase yet
    help_seen: dict[str, int] = {}    # agent -> manager_help.jsonl lines consumed

    for i in range(1, MAX_PHASES + 1):
        # -- the manager steps in: review + decide the next phase --
        with run.phase(PhaseParams(
                name=f"decide_{i}", kind="agent", owner=manager_name,
                description="Review the run so far and pick the next phase",
                retries=1,
                timeout_sec=DECIDE_TIMEOUT_SEC,
                max_tool_calls=DECIDE_MAX_TOOL_CALLS,
                max_identical_tool_calls=DECIDE_MAX_IDENTICAL)) as ph:
            try:
                decision = ph.call(AgentCall(
                    output_type=ManagerDecision,
                    prompt=_manager_prompt(run, prompt, history),
                    previous=last_envelope,
                    gates=[gates.decision_wellformed]))
            except BaseException as error:
                # A decide that can't conclude (e.g. guardrail abort twice) must
                # close the run cleanly — never leave it stuck 'running'.
                history.append({"kind": "manager", "owner": manager_name,
                                "status": "fail", "error": str(error)[:300]})
                _save_history(run, history)
                return run.finish(accepted=False,
                                  reason=f"manager decide failed: {str(error)[:200]}",
                                  require_all_phases=False)
        history.append({"kind": "manager", "owner": manager_name, "status": "success",
                        "summary": f"decided -> {decision.next_phase}: "
                                   f"{(decision.reason or decision.task)[:200]}"})
        _save_history(run, history)

        if decision.next_phase == "done":
            final = decision
            commit_requested = bool(decision.commit)
            break

        target = decision.next_phase
        description = decision.reason or f"Execute the manager's directive: {decision.task[:80]}"
        before = permissions.snapshot(run)      # for the files-it-touched record
        try:
            with run.phase(PhaseParams(name=f"run_{i}_{target}", kind="agent",
                                       owner=target, description=description)) as ph:
                # resolve inside the phase so a bad name fails this phase (and
                # the run) cleanly instead of leaving the session dangling
                agents.resolve(cfg, target)
                envelope = ph.call(AgentCall(
                    output_type=GenericOutput, prompt=decision.task,
                    previous=last_envelope,
                    gates=[gates.artifacts_exist, gates.files_non_empty]))
            touched = permissions.changed_paths(
                before or {}, permissions.snapshot(run) or {})
            history.append({"kind": "agent", "owner": target, "status": "success",
                            "summary": envelope.summary[:220],
                            "artifacts": [str(a) for a in envelope.artifacts[:12]],
                            "touched": touched})
            last_envelope = envelope
            last_run_ok = True
        except BaseException as error:
            # a failed phase is a decision for the manager, not a dead run
            touched = permissions.changed_paths(before or {}, permissions.snapshot(run) or {})
            history.append({"kind": "agent", "owner": target, "status": "fail",
                            "error": str(error)[:300], "touched": touched})
            last_run_ok = False
        # fold any manager-help exchanges the agent had into the history
        help_entries, help_seen[target] = _help_entries(run, target, help_seen.get(target, 0))
        history.extend(help_entries)
        _save_history(run, history)

    if final is None:
        return run.finish(accepted=False,
                          reason=f"manager did not conclude within {MAX_PHASES} phases",
                          require_all_phases=False)

    if commit_requested:
        with run.phase(PhaseParams(name="commit", kind="code", owner="git",
                                   description="Land the accumulated work")) as ph:
            message = final.commit_message or f"sssf({run.adw_id}): {final.summary}"
            ph.log(sha=git_helper.commit_all(message), message=message)

    # Manager-mode verdict: the manager concluded AND the last dispatched phase
    # succeeded (a repair chain is fine; finishing on a failed phase is not).
    accepted = last_run_ok is not False
    reason = "" if accepted else "manager said done while the last phase failed"
    return run.finish(accepted=accepted, reason=reason, require_all_phases=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
