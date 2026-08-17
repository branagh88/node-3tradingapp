#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Android-Dev — package a web game into an Android APK via Capacitor.

Usage:
    uv run adws/adw_android.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> android-developer

The android-developer agent turns the project's web game into an Android
app using the studio's Capacitor method: npm setup, capacitor.config.json,
copy the web build to www/, cap add/sync android, and (when the Android SDK
is reachable via ANDROID_HOME / G:/android-sdk) a debug APK build.

Use when a game needs to run on a phone: "build an APK", "make an Android
version", "package this for my phone".
"""

import argparse
import sys

from adw_modules import agents, gates, session, utils
from adw_modules.data_types import AndroidDeveloperOutput, PhaseParams

REQUIRED_AGENTS = ["android-developer"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the Android packaging request")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="android_package", kind="agent", owner="android-developer",
                               description="Set up Capacitor, package the web build, sync Android, "
                                           "build a debug APK when the SDK is available")) as ph:
        call = ph.agent(agent="android-developer", envelope=AndroidDeveloperOutput)
        call.request(prompt)
        reply = call.run()

        env = gates.validate_and_apply(ph, call, reply, AndroidDeveloperOutput)
        if env:
            # Surface the key outcome on the run line so it's visible without
            # opening the envelope: APK path or the conversion status.
            ph.log(input=f"appId={env.app_id or '?'} converted={env.converted} apk_built={env.apk_built} "
                         f"apk={env.apk_path or '(none)'}")

    run.finish_ok()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Android-Dev ADW")
    parser.add_argument("prompt")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None)
    args = parser.parse_args()
    sys.exit(main(args.prompt, args.config, args.adw_id))
