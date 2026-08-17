"""Validation gates: verify the envelope's CLAIMS, never guesses.

A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
Violations are derived from the failed checks and sent back to the SAME agent
session as a correction. Every check is recorded either way, so a green gate
says WHAT it verified instead of only that it passed.

Gates check what is mechanically checkable; plan quality is a reviewer's job.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .data_types import EnvelopeBase, GateReport

TAIL_CHARS = 1000        # command output kept as evidence on a failure


def _size(path: Path) -> str:
    n = path.stat().st_size
    return f"{n}B" if n < 1024 else f"{n / 1024:.1f}KB"


def artifacts_exist(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        report.check(a, p.exists(),
                     f"exists, {_size(p)}" if p.exists() else "declared artifact does not exist")
    return report


# Placeholder/marker files (git + Capacitor keep-this-dir markers, empty
# cordova shims) are legitimately empty — they're never a real deliverable,
# so the emptiness gate must not fail on them. The Android packaging step
# drops a handful: .gitkeep, .npmkeep, empty cordova.js / cordova_plugins.js.
_PLACEHOLDER_NAMES = ("cordova.js", "cordova_plugins.js")
_PLACEHOLDER_SUFFIXES = (".gitkeep", ".npmkeep", ".keep", ".DS_Store")


def _is_placeholder(path: Path) -> bool:
    n = path.name
    return n in _PLACEHOLDER_NAMES or any(n.endswith(s) for s in _PLACEHOLDER_SUFFIXES)


def files_non_empty(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if not (p.exists() and p.is_file()):
            continue                       # existence is artifacts_exist's job
        if _is_placeholder(p):
            continue                       # empty marker files are fine
        empty = p.stat().st_size == 0
        report.check(a, not empty, "declared artifact is empty" if empty else _size(p))
    return report


def json_parses(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if p.suffix != ".json" or not p.exists():
            continue
        try:
            parsed = json.loads(p.read_text())
            report.check(a, True, f"parses, {type(parsed).__name__}")
        except json.JSONDecodeError as e:
            report.check(a, False, f"declared JSON artifact does not parse: {e}")
    return report


def diff_matches_claims(envelope: EnvelopeBase, run) -> GateReport:
    """Every file claimed changed must exist on disk."""
    report = GateReport()
    for f in getattr(envelope, "changed_files", []):
        p = Path(f)
        report.check(f, p.exists(),
                     f"exists, {_size(p)}" if p.exists() else "claimed changed file does not exist")
    return report


def verdict_consistent(envelope: EnvelopeBase, run) -> GateReport:
    """A review's verdict must agree with the findings it just wrote down.

    Nothing here judges the code — that is the reviewer's job. This checks the
    envelope against itself: an approval that ships blocking items, or a
    rejection that names no problem, is a claim the harness can refute without
    reading a line of the diff.
    """
    report = GateReport()
    approved = bool(getattr(envelope, "approved", False))
    # Reviewer-style envelopes reject via `blocking`/`findings`; StackGuardOutput
    # rejects via `violations` (empty = approved). Read all three so a proper
    # rejection with items named is consistent either way.
    blocking = (list(getattr(envelope, "blocking", []))
                + list(getattr(envelope, "violations", [])))
    unmet = [f.requirement for f in getattr(envelope, "findings", []) if not f.met]

    report.check("approved vs blocking", not (approved and blocking),
                 "no blocking items" if not blocking
                 else f"{len(blocking)} blocking item(s) while approved=true"
                 if approved else f"{len(blocking)} blocking item(s), not approved")
    report.check("approved vs findings", not (approved and unmet),
                 "every requirement met" if not unmet
                 else f"{len(unmet)} unmet requirement(s) while approved=true"
                 if approved else f"{len(unmet)} unmet requirement(s), not approved")
    report.check("rejection names a problem", approved or bool(blocking or unmet),
                 "verdict is supported" if approved or blocking or unmet
                 else "approved=false but no blocking item or unmet requirement was given")
    return report


def tests_pass(command: str):
    """Gate factory: the given shell command must exit 0."""
    def gate(envelope: EnvelopeBase, run) -> GateReport:
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        ok = result.returncode == 0
        note = f"exit {result.returncode}"
        if not ok:
            note += "\n" + (result.stdout + result.stderr)[-TAIL_CHARS:]
        return GateReport().check(command, ok, note)
    gate.__name__ = f"tests_pass({command})"
    return gate


def decision_wellformed(envelope: EnvelopeBase, run) -> GateReport:
    """A ManagerDecision must name a real roster agent (or 'done'), with a task
    whenever it names an agent. Violations return to the manager as corrections,
    so a ghost agent name or a missing task is fixed in-session, not at runtime."""
    report = GateReport()
    next_phase = getattr(envelope, "next_phase", "") or ""
    task = getattr(envelope, "task", "") or ""
    names = [a.name for a in run.cfg.agents] + ["done"]
    report.check("next_phase named", bool(next_phase),
                 f"next_phase='{next_phase}'" if next_phase else "missing next_phase")
    report.check("next_phase in roster", next_phase in names,
                 f"'{next_phase}' is in the roster" if next_phase in names
                 else f"'{next_phase}' is not in the roster: {', '.join(names)}")
    if next_phase and next_phase != "done":
        report.check("task present", bool(task),
                     f"task: {task[:60]}" if task else "next_phase set but no task given")
    elif next_phase == "done":
        report.check("done has no task", not task,
                     "done" if not task else f"task set while next_phase='done': {task[:60]}")
    return report
