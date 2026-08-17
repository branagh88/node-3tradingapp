#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Simple SDLC Stack — the full PRS chain with our custom agents.

Usage:
    uv run adws/adw_simple_sdlc_stack.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> planner -> git(commit_plan)
        -> ui-ux-designer -> art-director
        -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
        -> stack-guard [-> builder(fix_stack) -> stack-guard ... bounded]
        -> test-writer -> code(retest) -> git(commit_build)
        -> release-manager

The PRS flagship ADW. Everything the stock simple_sdlc does, plus our custom
agents in the places they earn their keep:
- ui-ux-designer: designs screens, flow, layout + generates UI assets
- art-director: generates world/character assets in one consistent style
- stack-guard: audits the change against our Phaser 4 / Three.js / Tauri /
  web-perf rules (a second review, for OUR stack)
- test-writer: writes Vitest/Playwright tests for the change as a separate
  pass, so the builder stays focused on implementation
- release-manager: stages the version bump + changelog + release notes
  (it never commits — the engineer's go is the only path to a commit)

Testing stays CODE (`quality.run_tests`), not an agent. Stack-guard runs
after the suite is green; test-writer runs after stack-guard approves, and the
tree is re-tested before the code commit so what lands is green AND audited.
The builder receives the ui-ux + art envelopes so it wires in the designed UI
and generated assets.
"""

import argparse
import sys

from adw_modules import agents, changes, gates, git_helper, quality, session, utils
from adw_modules.data_types import (AgentCall, ArtDirectorOutput, BuildOutput,
                                    ChangeCapture, PhaseParams, PlanOutput,
                                    ReleaseOutput, StackGuardOutput,
                                    TestWriterOutput, UIDesignOutput)

REQUIRED_AGENTS = ["planner", "ui-ux-designer", "art-director", "builder",
                   "stack-guard", "test-writer", "release-manager"]
MAX_FIX_LOOPS = 3
MAX_STACK_FIX_LOOPS = 2

DOCUMENT_NOTES = ("Read diff_path in full before writing. Document only what the "
                  "diff shows, then copy the write-up into app_docs/ as your task "
                  "describes.")


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
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
        ph.log(input=prompt, baseline=git_helper.short_sha(baseline))

    # ── plan ──
    with run.phase(PhaseParams(name="plan", kind="agent", owner="planner",
                               description="Turn the request into an implementable plan")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    with run.phase(PhaseParams(name="commit_plan", kind="code", owner="git",
                               description="Put the spec on record before any code exists to blur it")) as ph:
        commit(ph, plan)

    # ── ui-ux: design the interface (screens, flow, layout, UI assets) ──
    with run.phase(PhaseParams(name="ui_ux", kind="agent", owner="ui-ux-designer",
                               description="Design screens, flow, and layout; generate UI assets in one style")) as ph:
        uiux = ph.call(AgentCall(output_type=UIDesignOutput, prompt=prompt, previous=plan,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    # ── art: generate the world/character assets in the plan's style ──
    with run.phase(PhaseParams(name="art", kind="agent", owner="art-director",
                               description="Generate the game assets in one consistent style, locked to a palette")) as ph:
        art = ph.call(AgentCall(output_type=ArtDirectorOutput, prompt=prompt, previous=uiux,
                                gates=[gates.artifacts_exist, gates.files_non_empty]))

    # ── build with deterministic test loop ──
    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                               description="Implement the plan, wiring in the designed UI and generated assets")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=art,
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

        with run.phase(PhaseParams(name=f"fix_{i}", kind="agent", owner="builder", retries=1,
                                   description="Repair what the suite reported, from its "
                                               "verbatim output")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                      previous=quality.as_envelope(test, "tests"),
                                      gates=[gates.diff_matches_claims]))

    # ── stack-guard audit with fix loop ──
    guard = None
    for i in range(1, MAX_STACK_FIX_LOOPS + 1):
        with run.phase(PhaseParams(name=f"stack_guard_{i}", kind="agent", owner="stack-guard",
                                   description="Audit the change against PRS stack rules — "
                                               "Phaser 4, Three.js, Tauri, web perf")) as ph:
            guard = ph.call(AgentCall(output_type=StackGuardOutput, prompt=prompt, previous=build,
                                      gates=[gates.artifacts_exist, gates.verdict_consistent]))

        if guard.approved or i == MAX_STACK_FIX_LOOPS:
            break

        with run.phase(PhaseParams(name=f"fix_stack_{i}", kind="agent", owner="builder", retries=1,
                                   description="Close the stack-guard's blocking violations")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=guard,
                                      gates=[gates.diff_matches_claims]))

    # ── test-writer: separate pass so tests get real attention ──
    tests = None
    with run.phase(PhaseParams(name="write_tests", kind="agent", owner="test-writer",
                               description="Write Vitest/Playwright tests for the change")) as ph:
        tests = ph.call(AgentCall(output_type=TestWriterOutput, prompt=prompt, previous=build,
                                  gates=[gates.artifacts_exist]))

    # The test-writer added tests after the last green suite run — re-run so
    # the tree that gets committed is the tree that was verified.
    if tests is not None and tests.tests_written:
        with run.phase(PhaseParams(name="retest", kind="code", owner="quality",
                                   description="Re-run the suite — the test-writer added tests "
                                               "after the last green result")) as ph:
            test = quality.run_tests(run)
            record(ph, test)

    # ── verified gate: green suite + approved stack audit + passing new tests ──
    verified = (test is not None and test.passed
                and guard is not None and guard.approved
                and tests is not None and tests.tests_pass)
    if verified:
        with run.phase(PhaseParams(name="commit_build", kind="code", owner="git",
                                   description="Land the code + tests: green suite, audited, "
                                               "stack-approved")) as ph:
            commit(ph, build)

        # ── release-manager: stage version bump + changelog + notes (never commits) ──
        with run.phase(PhaseParams(name="release", kind="agent", owner="release-manager",
                                   description="Bump version, append changelog, draft release "
                                               "notes — staging only, no commit")) as ph:
            release = ph.call(AgentCall(output_type=ReleaseOutput, prompt=prompt,
                                        previous=tests,
                                        gates=[gates.artifacts_exist, gates.files_non_empty]))

        # Release-manager edits are not committed by the agent; leave them in
        # the working tree for the engineer's review (the run itself commits
        # only what the git phases staged above).

    return run.finish(accepted=verified,
                      reason="the suite, stack-guard, or test-writer never came back clean")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
