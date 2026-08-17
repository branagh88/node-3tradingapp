#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW SDLC — one engine-aware specialist pipeline for every project type.

Usage:
    uv run adws/adw_sdlc.py "<prompt or path/to/prompt.md>" [--config ...] [--adw-id ...] [--engine phaser|threejs|web|generic]

Phases: engineer(request) -> <architect> -> git(commit_plan)
        -> <builder> -> code(test) [-> <builder>(fix) -> code(test) ... bounded]
        -> stack-guard [-> <builder>(fix_stack) -> stack-guard ... bounded]
        -> git(commit_build)

The engine is auto-detected from package.json dependencies, or forced with
--engine. Each engine gets its specialist architect + builder pair:

    phaser   → phaser-architect / phaser-builder  (Phaser 4, v4-exact APIs)
    threejs  → threejs-architect / threejs-builder (r150+, disposal discipline)
    web      → planner / web-builder              (React/Vite/TS sites)
    generic  → planner / builder                  (any other repo)

stack-guard audits every engine against the PRS stack rules (Phaser 4,
Three.js, Tauri, web perf). Testing stays CODE (`quality.run_tests`).
This replaces the old engine-specific adw_phaser_sdlc.py / adw_threejs_sdlc.py —
they are now thin aliases that force an engine.
"""

import argparse
import json
import sys
from pathlib import Path

from adw_modules import agents, gates, git_helper, quality, session, utils
from adw_modules.data_types import (AgentCall, BuildOutput, PhaseParams,
                                    PlanOutput, StackGuardOutput)

REQUIRED_AGENTS = ["phaser-architect", "phaser-builder",
                   "threejs-architect", "threejs-builder",
                   "planner", "builder", "web-builder", "stack-guard"]
MAX_FIX_LOOPS = 3
MAX_STACK_FIX_LOOPS = 2

# engine -> (architect, builder). Detection order matters: a Phaser project
# may ship three/react deps; games declare their engine first.
AGENT_PAIRS = {
    "phaser": ("phaser-architect", "phaser-builder"),
    "threejs": ("threejs-architect", "threejs-builder"),
    "web": ("planner", "web-builder"),
    "generic": ("planner", "builder"),
}


def detect_engine(cwd: str = ".") -> str:
    """Map the repo to a specialist pair via package.json dependencies."""
    try:
        pkg = json.loads((Path(cwd) / "package.json").read_text(encoding="utf-8"))
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        if "phaser" in deps:
            return "phaser"
        if "three" in deps:
            return "threejs"
        if "react" in deps:
            return "web"
    except Exception:
        pass
    return "generic"


def run_sdlc(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
             adw_id: str | None = None, engine: str | None = None) -> int:
    engine = engine or detect_engine()
    if engine not in AGENT_PAIRS:
        raise SystemExit(f"unknown engine '{engine}' — use one of {sorted(AGENT_PAIRS)}")
    architect, builder = AGENT_PAIRS[engine]

    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)
    baseline = git_helper.rev("HEAD")     # pinned before this run commits anything

    def commit(ph, envelope) -> None:
        """Commit what the preceding phase produced, in that agent's own words."""
        message = envelope.commit_message or f"sssf({run.adw_id}): {envelope.summary}"
        ph.log(sha=git_helper.commit_all(message), message=message)

    def record(ph, result) -> None:
        """Log a deterministic block's verdict — the same shape every ADW uses."""
        passed = sum(1 for check in result.checks if check.passed)
        ph.log(passed=result.passed, checks=f"{passed}/{len(result.checks)}",
               artifacts=", ".join(result.artifacts))

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt, baseline=git_helper.short_sha(baseline), engine=engine)

    # ── architect: design for the detected engine ──
    with run.phase(PhaseParams(name="design", kind="agent", owner=architect,
                               description=f"Design the {engine} architecture — into a spec the "
                                           f"builder implements without questions")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    with run.phase(PhaseParams(name="commit_plan", kind="code", owner="git",
                               description="Put the spec on record before any code exists to blur it")) as ph:
        commit(ph, plan)

    # ── builder: implement with engine-exact patterns ──
    with run.phase(PhaseParams(name="build", kind="agent", owner=builder,
                               description=f"Implement the spec with {engine}-exact APIs")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=plan,
                                  gates=[gates.diff_matches_claims]))

    test = None
    for i in range(1, MAX_FIX_LOOPS + 1):
        with run.phase(PhaseParams(name=f"test_{i}", kind="code", owner="quality",
                                   description="Run the suite — a known command, so code runs "
                                               "it and no agent has to rediscover it")) as ph:
            test = quality.run_tests(run)
            record(ph, test)

        if test.passed:
            break

        with run.phase(PhaseParams(name=f"fix_{i}", kind="agent", owner=builder, retries=1,
                                   description="Repair what the suite reported, from its "
                                               "verbatim output")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                      previous=quality.as_envelope(test, "tests"),
                                      gates=[gates.diff_matches_claims]))

    # ── stack-guard audit with fix loop ──
    guard = None
    for i in range(1, MAX_STACK_FIX_LOOPS + 1):
        with run.phase(PhaseParams(name=f"stack_guard_{i}", kind="agent", owner="stack-guard", retries=1,
                                   description="Audit the change against PRS stack rules — "
                                               "Phaser 4, Three.js, Tauri, web perf")) as ph:
            guard = ph.call(AgentCall(output_type=StackGuardOutput, prompt=prompt, previous=build,
                                      gates=[gates.artifacts_exist, gates.verdict_consistent]))

        if guard.approved or i == MAX_STACK_FIX_LOOPS:
            break

        with run.phase(PhaseParams(name=f"fix_stack_{i}", kind="agent", owner=builder, retries=1,
                                   description="Close the stack-guard's blocking violations")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=guard,
                                      gates=[gates.diff_matches_claims]))

    verified = (test is not None and test.passed
                and guard is not None and guard.approved)
    if verified:
        with run.phase(PhaseParams(name="commit_build", kind="code", owner="git",
                                   description="Land the code: green suite + stack-approved "
                                               "implementation")) as ph:
            commit(ph, build)

    return run.finish(accepted=verified,
                      reason="the suite or stack-guard never came back clean")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    parser.add_argument("--engine", default=None, choices=sorted(AGENT_PAIRS),
                        help="override engine detection (phaser|threejs|web|generic)")
    args = parser.parse_args()
    return run_sdlc(utils.resolve_prompt(args.prompt), args.config, args.adw_id, args.engine)


if __name__ == "__main__":
    sys.exit(main())
