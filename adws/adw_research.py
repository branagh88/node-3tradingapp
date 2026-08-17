#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Research — internet-enabled research on a hard topic, with a verdict.

Usage:
    uv run adws/adw_research.py "<topic or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> researcher

The researcher is the factory's internet agent: it searches the web via the
studio search CLI, reads real sources, and produces a feasibility note with a
verdict (adopt / prototype / watch / drop) for OUR stack. It changes nothing
in the repo except the note.

Use when a topic needs to be LEARNED, not found: "is WebGPU worth switching
to for our Three.js games", "how does the Tauri asset protocol scope work",
"what changed in Phaser 4's filter system".
"""

import argparse
import sys

from adw_modules import agents, gates, session, utils
from adw_modules.data_types import AgentCall, PhaseParams, ResearchOutput

REQUIRED_AGENTS = ["researcher"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the research topic")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="research", kind="agent", owner="researcher",
                               description="Search the web, read sources, write a feasibility note — "
                                           "change nothing else")) as ph:
        ph.call(AgentCall(output_type=ResearchOutput, prompt=prompt,
                          gates=[gates.artifacts_exist, gates.files_non_empty]))

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
