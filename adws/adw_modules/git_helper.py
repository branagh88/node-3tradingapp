"""Low-level git operations for code phases. All low-level logic lives in adw_modules."""

from __future__ import annotations

import subprocess
from pathlib import Path


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def current_branch() -> str:
    return _git("rev-parse", "--abbrev-ref", "HEAD")


def create_branch(name: str) -> str:
    _git("checkout", "-b", name)
    return name


def is_repo() -> bool:
    result = subprocess.run(["git", "rev-parse", "--git-dir"],
                            capture_output=True, text=True)
    return result.returncode == 0


def repo_root() -> Path:
    """Absolute root of the codebase — where agents are spawned to work.

    The git toplevel when there is one, else the process cwd (ADWs run fine in a
    non-git dir; only a commit phase requires a repo). Always absolute, so it is
    safe to hand to a subprocess regardless of where the ADW was launched from.
    """
    if is_repo():
        return Path(_git("rev-parse", "--show-toplevel")).resolve()
    return Path.cwd().resolve()


def _ensure_user_config() -> None:
    """git refuses to commit without user.name/email, and GDD-tab-created
    projects have neither (their scaffold only runs `git init`). Set per-repo
    fallbacks so the commit phase cannot die on the very first commit."""
    for key, fallback in (("user.name", "PRS Factory"),
                          ("user.email", "factory@mesh-viewer.local")):
        who = subprocess.run(["git", "config", "--local", key],
                             capture_output=True, text=True)
        if not who.stdout.strip():
            _git("config", "--local", key, fallback)


def commit_all(message: str) -> str:
    """Stage the working tree and commit it. Returns the new short sha."""
    if not is_repo():
        raise RuntimeError(
            "not a git repository — a commit phase needs one. Run `git init` in the "
            "repo root (and make a first commit) before running an ADW that commits.")
    _ensure_user_config()
    _git("add", "-A")
    if not _git("status", "--porcelain"):
        raise RuntimeError("nothing to commit — the preceding phases changed no files")
    _git("commit", "-m", message)
    return _git("rev-parse", "--short", "HEAD")


def push_all() -> str:
    """Push the current branch to origin (best-effort).

    Every successful run pushes its code back to the user's private GitHub
    repo, so the code lives on GitHub (and the desktop backup pulls it down).
    The remote was set with an embedded token at project-creation time and
    stripped after; for pushes we rely on the container's git credential
    helper / stored token. Never fails the run on a push error — the local
    commit is the source of truth and the backup pull still captures it.
    """
    try:
        _git("push", "-u", "origin", "HEAD")
        return ""
    except Exception as e:
        return str(e)[:300]


def changed_files() -> list[str]:
    out = _git("status", "--porcelain")
    return [line[3:] for line in out.splitlines() if line]


# ── diff plumbing (composed into a ChangeSet by documentation.py) ────────────

def ref_exists(ref: str) -> bool:
    """True when `ref` resolves to a commit. Never raises — this is a question."""
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                            capture_output=True, text=True)
    return result.returncode == 0


def rev(ref: str = "HEAD") -> str:
    result = subprocess.run(["git", "rev-parse", ref], capture_output=True, text=True)
    if result.returncode != 0:
        # A fresh repo with no commits has an UNBORN HEAD (seen: GDD-tab
        # projects — `git init` but no initial commit). Callers treat "" as
        # "no baseline yet" instead of the run crashing on rev-parse.
        if "unknown revision" in result.stderr:
            return ""
        raise RuntimeError(f"git rev-parse {ref} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def short_sha(ref: str = "HEAD") -> str:
    result = subprocess.run(["git", "rev-parse", "--short", ref or "HEAD"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        if "unknown revision" in result.stderr:
            return ""     # unborn HEAD or unresolvable ref — no sha yet
        raise RuntimeError(f"git rev-parse --short {ref} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def merge_base(ref: str, other: str = "HEAD") -> str:
    """The commit where `ref` and `other` diverged — the honest base of a branch.

    On the base branch itself this returns HEAD, which makes the diff exactly
    "what is not committed yet". Off it, the diff is the whole branch plus the
    working tree. One command covers both cases, so no ADW has to branch on it.
    Returns "" when either side is an unborn HEAD (nothing to merge against).
    """
    result = subprocess.run(["git", "merge-base", ref, other],
                            capture_output=True, text=True)
    if result.returncode != 0:
        if "unknown revision" in result.stderr or "not a valid" in result.stderr:
            return ""
        raise RuntimeError(f"git merge-base {ref} {other} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def is_dirty() -> bool:
    return bool(_git("status", "--porcelain"))


def untracked_files() -> list[str]:
    out = _git("ls-files", "--others", "--exclude-standard")
    return [line for line in out.splitlines() if line]


def diff_files(base: str) -> list[str]:
    """Tracked files that differ between `base` and the working tree."""
    out = _git("diff", "--name-only", base)
    return [line for line in out.splitlines() if line]


def diff_stat(base: str) -> str:
    return _git("diff", "--stat", base)


def diff_counts(base: str) -> tuple[int, int]:
    """(insertions, deletions) across the diff. Binary files count as neither."""
    insertions = deletions = 0
    for line in _git("diff", "--numstat", base).splitlines():
        added, removed, *_ = line.split("\t")
        if added.isdigit():
            insertions += int(added)
        if removed.isdigit():
            deletions += int(removed)
    return insertions, deletions


def diff_text(base: str) -> str:
    return _git("diff", base)


# ── branch-isolated runs: each factory run works on its OWN branch, so
# concurrent runs on one repo never share a dirty working tree. ───────────────

def start_run_branch(adw_id: str) -> str:
    """Create (or rejoin) this run's isolated branch from the current HEAD.

    Branch name: ``factory/<adw_id>``. Idempotent: a resumed run rejoins its
    existing branch instead of forking a second one. Returns the branch name.
    """
    branch = f"factory/{adw_id}"
    if ref_exists(branch):
        _git("checkout", branch)   # resume: back onto the run's own branch
        return branch
    _git("checkout", "-b", branch)
    return branch


def base_branch_of() -> str:
    """The branch the factory works off of: 'dev' if it exists, else main/master."""
    for candidate in ("dev", "development", "main", "master"):
        if ref_exists(candidate):
            return candidate
    return current_branch()


def finish_run_branch(adw_id: str, ok: bool) -> str:
    """Finish a branch-isolated run: merge it back to the base branch.

    On success (ok=True): merge ``factory/<adw_id>`` into the base branch
    (fast-forward if possible, else no-ff) and delete the run branch. The
    working tree ends on the base branch with the merged result.

    On failure (ok=False): leave the run branch in place (the work is not
    lost — an engineer can inspect or fix it) and return to the base branch
    with a clean tree. Returns a status line for the trace.
    """
    branch = f"factory/{adw_id}"
    if not ref_exists(branch):
        return "no run branch to merge"
    base = base_branch_of()
    _git("checkout", base)
    if not ok:
        return f"left branch {branch} (run failed — work preserved for inspection)"
    try:
        # merge the run's commits into base; ff when clean, else a merge commit
        _git("merge", "--no-ff", branch, "-m", f"factory {adw_id}: merge run branch")
        _git("branch", "-d", branch)
        return f"merged {branch} -> {base}"
    except RuntimeError as e:
        # merge conflict — keep the branch, report clearly
        return (f"MERGE CONFLICT merging {branch} into {base} — branch kept. "
                f"Resolve manually then delete it. ({str(e)[:120]})")


def on_run_branch(adw_id: str) -> bool:
    """True if the current branch is this run's factory branch."""
    return current_branch() == f"factory/{adw_id}"
