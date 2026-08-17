#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Plan Art Build — full art-enabled chain: plan -> generate assets -> implement.

Usage:
    uv run adws/adw_plan_art_build.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> planner -> art-director -> builder -> git(commit)

The PRS art pipeline. For "make the game look good AND work":
1. planner: turns the request into an implementable plan — including WHAT art
   assets are needed, their style, and where they go.
2. art-director: generates the assets in one consistent style (imgen +
   BiRefNet), locked to a palette, using the plan's art spec.
3. builder: implements the plan, wiring the generated assets into the game.
4. git: commits it all.

The art-director receives the planner's envelope so it generates exactly the
assets the plan calls for; the builder receives the art-director's envelope so
it knows the asset paths to wire in.
"""

import argparse
import sys

from adw_modules import agents, gates, git_helper, session, utils
from adw_modules.data_types import (AgentCall, ArtDirectorOutput, BuildOutput,
                                    PhaseParams, PlanOutput)

REQUIRED_AGENTS = ["planner", "art-director", "builder"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    # ── 1. plan (implementation + art spec) ──
    with run.phase(PhaseParams(name="plan", kind="agent", owner="planner",
                               description="Turn the request into an implementable plan, "
                                           "including the art assets needed and their style")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    # ── 2. art-director: generate the assets the plan calls for ──
    with run.phase(PhaseParams(name="art", kind="agent", owner="art-director",
                               description="Generate the assets the plan specifies, in one "
                                           "consistent style, locked to a palette")) as ph:
        art = ph.call(AgentCall(output_type=ArtDirectorOutput, prompt=prompt, previous=plan,
                                gates=[gates.artifacts_exist, gates.files_non_empty]))

    # ── 3. builder: implement, wiring in the generated assets ──
    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                               description="Implement the plan, using the art-director's assets")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                  previous=art, gates=[gates.diff_matches_claims]))

    # ── 4. commit everything (plan spec + assets + implementation) ──
    with run.phase(PhaseParams(name="commit", kind="code", owner="git",
                               description="Land the implementation + assets")) as ph:
        message = build.commit_message or f"sssf({run.adw_id}): {build.summary}"
        ph.log(sha=git_helper.commit_all(message), message=message)

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
