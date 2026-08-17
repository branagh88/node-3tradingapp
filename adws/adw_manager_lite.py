#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Manager-Lite - the LIGHT version of the Factory Manager.

Usage:
    uv run adws/adw_manager_lite.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Same orchestration loop as adw_manager.py but trimmed for cheap, quick runs:

- MAX_PHASES 10 (was 5) — bounded, fast, low token burn  -> bounded, fast, low token burn
- No manager-help extension folding (lighter history)
- Shorter decision prompt (no disabled-agent note, minimal context)
- Cheaper default thinking (config: manager-lite sets thinking: minimal)
- Decide guardrails: 15-min deadline, 60 tool calls, 6 identical-call streak

Suitable for small tasks ("add a /health endpoint", "fix the button"),
demo runs, and cost-conscious users. For big multi-agent builds use the
full manager (adw_manager.py).

The manager-lite is read-only (`writes: []`): it decides, it never edits.
Permissions are enforced on every phase either way.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from adw_modules import agents, gates, git_helper, permissions, session, utils
from adw_modules.data_types import (AgentCall, GenericOutput, ManagerDecision,
                                    PhaseParams)

REQUIRED_AGENTS = ["manager-lite"]
MAX_PHASES = 10                     # hard cap — lite stays bounded and cheap

# Decide-phase guardrails (enforced in agent_pi.run via agents.execute): a
# manager that loops on identical tool calls or overruns its deadline is
# killed mid-turn, given ONE corrective retry, then the run fails. Observed:
# a decide_1 phase stuck 40 min on 242x the same grep. Tune via env.
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default

DECIDE_TIMEOUT_SEC = _int_env("SSSF_DECIDE_TIMEOUT_SEC", 900)          # 15 min
DECIDE_MAX_TOOL_CALLS = _int_env("SSSF_DECIDE_MAX_TOOL_CALLS", 60)     # per decide
DECIDE_MAX_IDENTICAL = _int_env("SSSF_DECIDE_MAX_IDENTICAL_TOOL_CALLS", 6)

HISTORY_FILE = "run_history.json"


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


def _history_text(history: list[dict]) -> str:
    lines = []
    for i, h in enumerate(history, 1):
        status = h.get("status", "?")
        mark = "+" if status == "success" else ("!" if status == "fail" else ".")
        owner = h.get("owner", "")
        text = (h.get("summary") or h.get("error") or "").strip()[:220]
        lines.append(f"{i}. [{mark}] [{owner}] {text}")
    return "\n".join(lines) or "(no phases yet)"


def _manager_prompt(run, prompt: str, history: list[dict]) -> str:
    roster = "\n".join(f"- {a.name}: {a.purpose or '(no purpose)'}"
                       for a in agents.enabled_agents(run.cfg))
    return (
        f"Original request: {prompt}\n\n"
        f"ROSTER (agents you may dispatch — ONLY from this list):\n{roster}\n\n"
        f"RUN HISTORY:\n{_history_text(history)}"
    )


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
         adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)
    history = _load_history(run)
    manager_name = agents.resolve(cfg, "manager-lite").name

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

    for i in range(1, MAX_PHASES + 1):
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
                                  reason=f"manager-lite decide failed: {str(error)[:200]}",
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
        before = permissions.snapshot(run)
        try:
            with run.phase(PhaseParams(name=f"run_{i}_{target}", kind="agent",
                                       owner=target, description=description)) as ph:
                agents.resolve(cfg, target)
                try:
                    envelope = ph.call(AgentCall(
                        output_type=GenericOutput, prompt=decision.task,
                        previous=last_envelope,
                        gates=[gates.artifacts_exist, gates.files_non_empty]))
                except BaseException as first_error:
                    # A malformed envelope / parse failure is recoverable: the
                    # agent gets ONE retry with the error appended to its task
                    # (flash models occasionally exit with prose instead of the
                    # required JSON — the retry with the exact error fixes it).
                    retry_task = decision.task + "\n\n[RETRY — previous attempt FAILED]\n" \
                        + f"{type(first_error).__name__}: {str(first_error)[:600]}\n" \
                        + "Re-do the work, then emit the required JSON envelope exactly. " \
                        + "Your ENTIRE final message must be the JSON object — no prose, no fences."
                    envelope = ph.call(AgentCall(
                        output_type=GenericOutput, prompt=retry_task,
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
            touched = permissions.changed_paths(before or {}, permissions.snapshot(run) or {})
            history.append({"kind": "agent", "owner": target, "status": "fail",
                            "error": str(error)[:300], "touched": touched})
            last_run_ok = False
        _save_history(run, history)

    if final is None:
        return run.finish(accepted=False,
                          reason=f"manager-lite did not conclude within {MAX_PHASES} phases",
                          require_all_phases=False)

    if commit_requested:
        with run.phase(PhaseParams(name="commit", kind="code", owner="git",
                                   description="Land the accumulated work")) as ph:
            message = final.commit_message or f"sssf({run.adw_id}): {final.summary}"
            ph.log(sha=git_helper.commit_all(message), message=message)

    accepted = last_run_ok is not False
    reason = "" if accepted else "manager-lite said done while the last phase failed"
    return run.finish(accepted=accepted, reason=reason, require_all_phases=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
