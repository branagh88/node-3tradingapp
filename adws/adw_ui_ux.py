#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW UI/UX — design the game's UI/UX: screens, flow, layout, UI assets.

Usage:
    uv run adws/adw_ui_ux.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> ui-ux-designer

The ui-ux-designer designs the interface: screens, flow between them, per-screen
layout, component list, style block — and generates the UI assets (panels,
buttons, slots, HUD bars, icons) via imgen in one consistent style.
"""

import argparse
import sys

from adw_modules import agents, gates, session, utils
from adw_modules.data_types import AgentCall, PhaseParams, UIDesignOutput

REQUIRED_AGENTS = ["ui-ux-designer"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the UI/UX request")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="ui_ux", kind="agent", owner="ui-ux-designer",
                               description="Design screens + flow + layout, generate UI assets — "
                                           "UI only, never game logic")) as ph:
        ph.call(AgentCall(output_type=UIDesignOutput, prompt=prompt,
                          gates=[gates.artifacts_exist, gates.files_non_empty]))

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
