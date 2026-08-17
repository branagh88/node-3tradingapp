"""What an agent may CHANGE, enforced in code after the fact.

`tools:` is a capability list, not a sandbox, and two holes make it
unenforceable on its own:

  * `bash` runs anything. A builder handed bash to run a test suite can also
    run `git checkout adws/` — which is not hypothetical: one did, discarding
    uncommitted changes to the very quality check it was about to be judged by.
  * `write` reaches any path, not just the one report file an agent was given
    it for. A reviewer configured with "no edit, so it cannot quietly fix"
    could still rewrite the code it was reviewing.

So permission is verified the way every other claim in this system is —
after the fact, against the repo itself. `snapshot()` fingerprints the working
tree's change-set before an agent runs; `enforce()` compares it afterwards and
fails the phase if the agent touched anything outside its allowlist.

Comparing change-sets, rather than watching for writes, is what catches the
`git checkout` case: a path that was modified before the agent ran and is clean
afterwards has been reverted, and a reversion is a modification. Appearing,
disappearing, and changing all count.

A breach is NOT a gate violation. Gates are for work an agent can be asked to
redo; a breach cannot be corrected by re-prompting, because the write already
happened. It aborts the phase and names every offending path.

Two keys drive it, both in sssf.config.yaml:
    defaults.protected_files   paths no agent may touch unless it names them itself
    agents[].writes      None = unrestricted · [] = read-only · [...] = only these
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

from .data_types import AgentConfig, EventRecord, SSSFConfig


class PermissionBreach(RuntimeError):
    """An agent modified a path it was not permitted to modify."""


# ── machine-level guard: the repo tree is not the whole machine ─────────────
# Agents get bash, and bash reaches anywhere the operator's user can. The repo
# snapshot cannot see damage done outside the working tree (an agent once
# deleted a file from ~/.pi/agent/extensions/ — invisible to git entirely).
# As a second net behind the pi factory-guard extension, every phase boundary
# fingerprints a small set of critical system paths and the extensions dir,
# alerts on any change, and restores credential files from a run-local backup.
CRITICAL_FILES = ["auth.json", "auth.json.bak", "gcloud-adc-token.txt"]
BACKUP_DIR = Path.home() / ".pi" / "agent" / "studio" / "factory-guard-backups"
EXTENSIONS_DIR = Path.home() / ".pi" / "agent" / "extensions"


def _sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


def _system_fingerprint() -> dict[str, str]:
    """Critical credential files by content hash, extensions dir by listing."""
    fp: dict[str, str] = {}
    studio = Path.home() / ".pi" / "agent"
    for name in CRITICAL_FILES:
        p = studio / name
        if p.exists():
            fp[str(p)] = _sha256(p)
    if EXTENSIONS_DIR.is_dir():
        try:
            entries = sorted(
                f"{e.name}:{e.stat().st_size}" for e in EXTENSIONS_DIR.iterdir())
            fp["extensions-dir"] = "|".join(entries)
        except OSError:
            pass
    return fp


def _backup_criticals() -> None:
    """Run-local backup so a damaged credential file can be restored."""
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        studio = Path.home() / ".pi" / "agent"
        for name in CRITICAL_FILES:
            p = studio / name
            if p.exists():
                shutil.copy2(p, BACKUP_DIR / name)
    except OSError:
        pass


def _restore_criticals(changed: list[str]) -> list[str]:
    restored = []
    for name in CRITICAL_FILES:
        bak = BACKUP_DIR / name
        if not bak.exists():
            continue
        studio = Path.home() / ".pi" / "agent"
        target = studio / name
        if str(target) in changed or (target.exists() and _sha256(target) != _sha256(bak)):
            try:
                shutil.copy2(bak, target)
                restored.append(name)
            except OSError:
                pass
    return restored


def system_guard(run, phase) -> list[str]:
    """Second net behind the repo snapshot: detect + alert on damage to
    credentials or the extensions dir; restore credentials from backup.

    Returns human-readable notes for the console (empty when clean).
    """
    if not hasattr(run, "_sys_baseline"):
        _backup_criticals()
        run._sys_baseline = _system_fingerprint()
        return []
    baseline = run._sys_baseline
    now = _system_fingerprint()
    changed = [p for p in set(baseline) | set(now) if baseline.get(p) != now.get(p)]
    if not changed:
        return []
    restored = _restore_criticals(changed)
    notes = []
    for p in changed:
        label = "extensions dir" if p == "extensions-dir" else Path(p).name
        notes.append(f"{label} changed outside the repo" + (" (restored)" if label in restored else ""))
    try:
        run.tracer.event(EventRecord(
            adw_id=run.adw_id, phase_id=phase.phase_id,
            type="error", name="system_breach",
            payload={"agent": getattr(phase.params, "owner", ""),
                     "changed": changed,
                     "restored": restored,
                     "notes": notes}))
    except Exception:
        pass
    return notes


def _git(args: list[str], cwd) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def snapshot(run) -> dict[str, str] | None:
    """Content fingerprint of every repo file (tracked + untracked).

    Content-based, not git-diff-based: a commit mid-run — the run's own
    commit phases, or an operator committing while a run is live — moves HEAD
    but does not change file contents, so it cannot create false overstep
    reports. (The old `git diff HEAD` baseline reported any file committed
    during a phase as "vanished", and if it was protected machinery that was
    a FATAL false positive.)

    Best-effort by design: this is a permission CHECK, not the run's work. If
    the git subprocess itself fails (Windows CreateProcess can raise Errno 22
    when a builder drops a huge node_modules mid-phase, or when the pipe
    exceeds OS limits), degrade to None — the caller SKIPS enforcement for
    that boundary (never rolls back work it could not fingerprint) and logs
    the failure instead of killing the run. The factory must never die
    because its own tripwire hiccuped.
    """
    try:
        tracked = _git(["ls-files"], run.repo_root).splitlines()
        untracked = _git(["ls-files", "--others", "--exclude-standard"],
                         run.repo_root).splitlines()
        paths = [p.strip() for p in tracked + untracked if p.strip()]
        if not paths:
            return {}
        result = subprocess.run(
            ["git", "hash-object", "--stdin-paths"],
            cwd=run.repo_root, input="\n".join(paths),
            capture_output=True, text=True)
        hashes = result.stdout.splitlines()
        # `git hash-object` exits 128 (to stderr, no stdout line) on index
        # entries missing from the working tree — e.g. files deleted after a
        # commit. That would silently misalign the path/hash zip and create
        # false breaches. Hash only files that exist; mark the rest with a
        # sentinel so a deletion during a phase is still a visible change.
        import os as _os
        existing = [p for p in paths if _os.path.exists(_os.path.join(run.repo_root, p))]
        missing = [p for p in paths if not _os.path.exists(_os.path.join(run.repo_root, p))]
        fingerprints: dict[str, str] = {p: "missing" for p in missing}
        if existing:
            result = subprocess.run(
                ["git", "hash-object", "--stdin-paths"],
                cwd=run.repo_root, input="\n".join(existing),
                capture_output=True, text=True)
            hashes = result.stdout.splitlines()
            # Belt-and-suspenders: if alignment can't be trusted, fall back to
            # hashing each surviving file individually.
            if len(hashes) != len(existing):
                hashes = [_git(["hash-object", p], run.repo_root).strip()
                          for p in existing]
            fingerprints.update({p: h for p, h in zip(existing, hashes) if h})
        return fingerprints
    except OSError as e:
        # Errno 22 (Windows CreateProcess/pipe) and friends: never fatal.
        _snapshot_degraded(run, e)
        return None
    except Exception as e:
        _snapshot_degraded(run, e)
        return None


def _snapshot_degraded(run, e: Exception) -> None:
    """Log that the permission snapshot failed; enforcement is skipped."""
    try:
        run.tracer.event(EventRecord(
            adw_id=run.adw_id, phase_id="", type="log", name="permission_snapshot",
            payload={"warning": f"snapshot degraded ({type(e).__name__}: {e}); "
                                "permission enforcement skipped this phase"}))
    except Exception:
        pass


def changed_paths(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Every path whose state differs — appeared, vanished, or was rewritten."""
    return sorted({p for p in set(before) | set(after)
                   if before.get(p) != after.get(p)})


def _glob(pattern: str) -> re.Pattern:
    """Translate a pattern, with `*` stopping at a path separator.

    fnmatch would let `*` cross `/`, which quietly widens every pattern:
    `adws/adw_*.py` would match `adws/adw_data/sessions/x/y.py` as well as the
    ADW scripts it means. `**` is the way to say "cross directories".
    """
    out, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif char == "*":
            out.append("[^/]*")
            i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(char))
            i += 1
    return re.compile("".join(out))


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):                      # directory prefix
        return path.startswith(pattern)
    if "*" in pattern or "?" in pattern:
        return _glob(pattern).fullmatch(path) is not None
    return path == pattern


# ── Machinery: the code that GRADES the run. These are protected in CODE, not
# config — because the per-project config (adws/adw_sssf_config/) is now
# writable by agents (each project tunes its own settings), an agent must not
# be able to edit the config's protected_files to empty and then tamper with
# the grader. Hard-coding here makes the grader protection immutable.
MACHINERY_PATHS = [
    "adws/adw_modules/",
    "adws/adw_*.py",
]


def always_writable(cfg: SSSFConfig) -> list[str]:
    """The session runtime, which EVERY agent must be able to write.

    `context_handoff/` is the one place agents hand work to each other, and an
    agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
    Scout writes its findings there, the reviewer its review, the planner its
    plan — a read-only agent is read-only with respect to the REPO, never with
    respect to its own report.

    This is granted from `data_dir` rather than left to .gitignore. The runtime
    is normally ignored, so it never even appears in a snapshot — but an agent's
    ability to record its work must not hang on a gitignore entry that someone
    can delete or that a changed `data_dir` can outgrow.
    """
    return [cfg.defaults.data_dir.rstrip("/") + "/"]


def _sandboxed() -> bool:
    """Sandbox mode (SSSF_SANDBOX=1, injected by the server for non-admin
    factory runs). Under sandbox, no agent is ever "unrestricted":
    writes: None is treated as read-only unless builders are allowed, and
    only the allowed roster (agents.py) may dispatch. Belt-and-braces behind
    the agents.py gate."""
    return os.environ.get("SSSF_SANDBOX") == "1"


def _sandbox_builders() -> bool:
    """Sandbox + build_code: the builder agents may write INSIDE the repo
    (their whole purpose), but the machinery + protected files stay immutable
    and the machine guard still blocks everything outside the project folder."""
    return os.environ.get("SSSF_SANDBOX") == "1" and os.environ.get("SSSF_ALLOW_BUILDERS") == "1"


def permitted(path: str, agent: AgentConfig, cfg: SSSFConfig) -> bool:
    """Session runtime first, then the agent's own list, then what is protected."""
    if any(_matches(path, p) for p in always_writable(cfg)):
        return True
    if any(_matches(path, p) for p in (agent.writes or [])):
        return True                      # naming a path is what unlocks a protected one
    # Immutable machinery — cannot be unlocked by any agent, ever.
    if any(_matches(path, p) for p in MACHINERY_PATHS):
        return False
    if any(_matches(path, p) for p in cfg.defaults.protected_files):
        return False
    # Sandbox: unrestricted agents become read-only — unless builders are
    # allowed (build_code), in which case they may write inside the repo; the
    # machinery/protected checks above still hold, and the machine guard
    # blocks outside-repo paths.
    if _sandboxed() and not _sandbox_builders():
        return False
    return agent.writes is None          # None = unrestricted, [] = no repo writes


def _roll_back(run, path: str, before: dict[str, str], after: dict[str, str]) -> str:
    """Undo one unauthorized change. Returns a word describing what happened.

    Only changes the agent INTRODUCED are undone. A path that was already dirty
    when the agent started is left exactly as it is: the operator had
    uncommitted work there, and discarding it to tidy up would be the same harm
    this module exists to prevent, committed by the cleanup instead of the agent.
    """
    if path in before:
        # Already dirty beforehand. If it is gone from the diff now, the agent
        # reverted an engineer's uncommitted work and the content is not ours
        # to reconstruct — say so loudly rather than pretend it was handled.
        return "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)" \
            if path not in after else "left as-is (was already modified)"
    if after.get(path) == "untracked":
        try:
            (Path(run.repo_root) / path).unlink()
            return "deleted"
        except OSError as error:
            return f"could not delete ({error})"
    result = subprocess.run(["git", "checkout", "--", path],
                            cwd=run.repo_root, capture_output=True, text=True)
    return "rolled back" if result.returncode == 0 else "could not roll back"


def enforce(run, phase, agent: AgentConfig, before: dict[str, str]) -> list[str]:
    """Compare the tree against `before`; undo oversteps, continue the run.

    Returns the paths the agent legitimately changed, so the trace records
    what it actually touched rather than only what it claimed in its envelope.

    Two classes of overstep, two responses:
    - Allowlist breaches (agent wrote outside its `writes:` but not into
      protected territory): ROLL BACK + WARN + CONTINUE. The run must not die
      because a read-only agent touched one file — the note tells it to stop.
      This is the gap that was killing whole runs.
    - Protected-file breaches (factory machinery: adws/, config — the grader):
      FATAL. An agent editing the machinery that decides its own pass is
      sabotage; the run stops and the engineer sees it.

    On top of the repo-tree check, `system_guard` fingerprints the machine
    (credentials + extensions dir) and alerts/restores — see system_guard.
    """
    sys_notes = system_guard(run, phase)
    if sys_notes:
        run.console.note("system guard: " + "; ".join(sys_notes))

    after = snapshot(run)
    # Snapshot degraded (Errno 22 / subprocess failure — see snapshot()): skip
    # enforcement this phase. Rolling back against a broken baseline would
    # treat every legit file as "vanished" and destroy the agent's work; a
    # skipped check is the safe side of the same fence.
    if after is None:
        run.console.note("permission snapshot unavailable — enforcement skipped this phase")
        return []
    touched = changed_paths(before, after)
    breaches = [p for p in touched if not permitted(p, agent, run.cfg)]
    if not breaches:
        return touched

    outcomes = {p: _roll_back(run, p, before, after) for p in breaches}
    scope = ("read-only" if agent.writes == []
             else f"limited to {agent.writes}" if agent.writes
             else f"barred from {run.cfg.defaults.protected_files}")
    detail = "\n".join(f"  - {p} — {outcome}" for p, outcome in outcomes.items())

    # Separate protected (fatal) from allowlist (recoverable) breaches.
    # Separate protected (fatal) from allowlist (recoverable) breaches.
    # Machinery breaches are immutable-fatal (code-defined). Config-file
    # touches (adws/adw_sssf_config/) are now per-project settings — rolled
    # back + warned, but NOT run-killing.
    protected = [p for p in breaches
                 if any(_matches(p, pp) for pp in MACHINERY_PATHS)]
    if protected:
        raise PermissionBreach(
            f"{agent.name} touched PROTECTED factory machinery "
            f"({len(protected)} path(s)) — run stopped:\n"
            + "\n".join(f"  - {p}" for p in protected))

    # Allowlist overstep: rolled back, noted, run continues.
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="error", name="permission_warning",
                                 payload={"agent": agent.name,
                                          "warning": f"{agent.name} is {scope} but modified "
                                                     f"{len(breaches)} path(s) — rolled back:\n{detail}",
                                          "writes": agent.writes,
                                          "protected_files": run.cfg.defaults.protected_files}))
    return [p for p in touched if p not in breaches]
