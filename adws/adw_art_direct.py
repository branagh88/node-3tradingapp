#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Art-Direct — generate game assets with a consistent visual style.

Usage:
    uv run adws/adw_art_direct.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> art-director

The art-director is the factory's art agent: it decides ONE visual style
(optionally from a LoRA), generates the needed assets via the Krea2 image
pipeline (run_krea2.py), removes backgrounds on sprites where needed, and
reports palette + asset list + next polish steps. It writes assets/ only.

Use when a game needs art: "generate a hero sprite + coin + grass tiles in
pixel art", "make the UI feel warmer with pastel assets".
"""

import argparse
import sys

from adw_modules import agents, gates, session, utils
from adw_modules.data_types import AgentCall, ArtDirectorOutput, PhaseParams

REQUIRED_AGENTS = ["art-director"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the asset request")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="art_direct", kind="agent", owner="art-director",
                               description="Decide the style, generate the assets, write the art direction — "
                                           "assets only, never code")) as ph:
        ph.call(AgentCall(output_type=ArtDirectorOutput, prompt=prompt,
                          gates=[gates.artifacts_exist, gates.files_non_empty]))

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
