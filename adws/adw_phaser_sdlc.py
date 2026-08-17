#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Phaser SDLC — DEPRECATED alias. Use adw_sdlc.py (engine auto-detect) or `just sdlc`.

Kept so existing references (`just phaser`, docs, the mesh-viewer factory UI)
keep working. Forces engine=phaser and runs the shared pipeline.
"""

import argparse
import sys

from adw_modules import utils
from adw_sdlc import run_sdlc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    return run_sdlc(utils.resolve_prompt(args.prompt), args.config, args.adw_id, engine="phaser")


if __name__ == "__main__":
    sys.exit(main())
