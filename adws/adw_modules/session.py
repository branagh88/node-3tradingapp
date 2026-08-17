"""Session lifecycle: pin-or-create an adw_id, build the Run object.

`ensure(cfg, adw_id)` joins the session if it exists or creates it under
exactly that id (pinned ids for repeatable runs); omitted, a fresh id is
minted and printed so the next ADW can pick it up.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

from .data_types import SSSFConfig
from .git_helper import is_repo, start_run_branch
from .runner import Run
from .tracer import Tracer
from .utils import engineer_name, new_id


def _finalize_when_killed(run: Run) -> None:
    """A killed run still closes its own trace.

    Python's default SIGTERM handling exits without unwinding, so `just kill`
    (or any `kill <pid>`) would leave the session reading `running` forever and
    its process rows open — the trace would claim work is in flight that is
    already dead. Turning the signal into SystemExit both finalizes here and
    lets the phase context manager record the phase as failed on the way out.
    """
    def handler(signum, _frame):
        run.tracer.session_finish(run.adw_id, ok=False)   # also closes process rows
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, handler)


def ensure(cfg: SSSFConfig, adw_id: str | None = None) -> Run:
    adw_id = adw_id or new_id(8)
    # ── concurrency guard: refuse to start if ANOTHER run is already active
    # on this project. Two builders on one repo = git conflicts + permission
    # snapshot chaos (seen: a second run's edits read as the first run's
    # "breaches", deadlocking both). Resuming the SAME run (--adw-id) is the
    # one allowed overlap — it continues that session, not a competing one.
    import sqlite3 as _sqlite3
    try:
        _conn = _sqlite3.connect(cfg.observability.db, timeout=3)
        _active = _conn.execute(
            "SELECT adw_id FROM sessions WHERE status='running' AND adw_id != ?",
            (adw_id,)).fetchall()
        # SAME-id double-run guard: a resume must never stack on a LIVE
        # process already driving this adw_id (seen: an auto-resume + a manual
        # resume racing, two managers on one repo). Probe each open process
        # row; a live pid means another driver is already here — refuse.
        _procs = _conn.execute(
            "SELECT pid FROM processes WHERE adw_id=? AND ended_at IS NULL AND pid > 0",
            (adw_id,)).fetchall()
        _conn.close()
        if _active:
            other = ", ".join(r[0] for r in _active[:3])
            raise RuntimeError(
                f"ANOTHER FACTORY RUN IS ACTIVE on this project ({other}). "
                f"Concurrent runs on one repo corrupt the working tree and "
                f"deadlock each other. Wait for it to finish, or stop it first.")
        for (pid,) in _procs:
            try:
                os.kill(int(pid), 0)          # signal 0 probes existence
            except (OSError, ValueError):
                continue                      # dead/zombie — no longer driving
            raise RuntimeError(
                f"run {adw_id} is ALREADY LIVE (pid {pid}). A second process "
                f"driving the same session would double-run the repo. Stop it "
                f"first (Factory tab → stop, or kill {pid}) and retry.")
    except _sqlite3.Error:
        pass   # db busy/new — proceed; the race window is tiny and harmless
    # ── branch isolation: this run works on its OWN branch (factory/<adw_id>),
    # so concurrent runs on one repo never share a dirty working tree. Resuming
    # rejoins the same branch. Non-git repos skip this (single-run, fine).
    if is_repo():
        start_run_branch(adw_id)
    tracer = Tracer(cfg.observability.db,
                    f"{cfg.defaults.data_dir}/sessions/{adw_id}/events.jsonl")
    run = Run(cfg=cfg, adw_id=adw_id, tracer=tracer, engineer=engineer_name())
    tracer.session_start(adw_id, run.engineer, adw_name=Path(sys.argv[0]).stem)
    # This process is the run. Record it before any phase opens, so a run that
    # hangs in its first agent call is still killable by adw_id.
    tracer.process_start(adw_id, "adw", "", os.getpid(),
                         " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]))
    _finalize_when_killed(run)
    # Optional user/operator-set run timeout (SSSF_RUN_TIMEOUT minutes). 0 =
    # no cap (default — real factories legitimately run long). A non-zero cap
    # SIGTERMs this process after N minutes; _finalize_when_killed closes the
    # trace cleanly so the run reads "fail" instead of hanging "running".
    try:
        timeout_min = int(os.environ.get("SSSF_RUN_TIMEOUT", "0") or "0")
    except ValueError:
        timeout_min = 0
    # Expose the deadline on the run so agents can see how much time is LEFT
    # (not just the total) and scope their remaining work accordingly.
    run.timeout_min = timeout_min
    run.deadline_at = (time.time() + timeout_min * 60) if timeout_min > 0 else None
    if timeout_min > 0:
        import threading

        def _kill_after():
            time.sleep(timeout_min * 60)
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            except Exception:
                pass

        threading.Thread(target=_kill_after, daemon=True).start()
    run.console.session_started(adw_id, run.engineer)
    return run
