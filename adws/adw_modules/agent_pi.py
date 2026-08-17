"""Pi coding agent interface — v1's only coding agent.

Runs `pi -p --mode json` and tails its JSONL stdout line by line, forwarding
each event to a callback WHILE the agent works (the streaming crack, solved
by construction). `--session-id` creates-or-continues, so running and
continuing an agent are the same call: same session id = same context window.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional

from .data_types import PiRequest, PiResult
from .utils import now_iso, operator_env

PI_PATH = os.environ.get("PI_PATH", "pi")
MODELS_JSON = os.environ.get("PI_MODELS_PATH",
                             str(Path.home() / ".pi" / "agent" / "models.json"))

RESULT_SNIPPET_CHARS = 20_000   # tool output rides along whole; clip only guards pathological cases
ARG_VALUE_CHARS = 20_000        # args too — the UI scrolls, it must not be handed cut-off data
LABEL_CHARS = 80                # "bash: <command>" shown as the event name

# The arg that identifies a call at a glance, in the order tools tend to use.
PRIMARY_ARGS = ("command", "path", "file_path", "pattern", "query", "url")


def _count(value: str) -> int:
    """Parse pi's compact model-list counts (`272K`, `1.0M`)."""
    suffixes = {"K": 1_000, "M": 1_000_000}
    suffix = value[-1:].upper()
    if suffix in suffixes:
        return int(float(value[:-1]) * suffixes[suffix])
    return int(value)


@lru_cache(maxsize=1)
def _pi_catalog() -> list[tuple[str, str, int]]:
    """Read pi's merged catalog, including built-in providers and custom models."""
    try:
        result = subprocess.run(
            [PI_PATH, "--list-models"], capture_output=True, text=True,
            timeout=30, env=operator_env(), check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    rows = []
    for line in result.stdout.splitlines()[1:]:
        columns = line.split()
        if len(columns) < 3:
            continue
        try:
            rows.append((columns[0], columns[1], _count(columns[2])))
        except ValueError:
            continue
    return rows


def resolve_model(pattern: str) -> tuple[str, str]:
    """Resolve a model pattern to an explicit ``(provider, model_id)`` pair.

    Pi's catalog merges built-in models with ``~/.pi/agent/models.json``. Using
    that same merged view lets SSSF target direct providers such as
    ``openai/gpt-5.6-terra`` without re-registering built-in models locally.
    """
    catalog = [(provider, model_id) for provider, model_id, _ in _pi_catalog()]
    if "/" in pattern:
        provider, model_id = pattern.split("/", 1)
        if (provider, model_id) in catalog:
            return provider, model_id
    matches = [(provider, model_id) for provider, model_id in catalog
               if pattern == model_id or pattern in model_id]
    exact = [match for match in matches
             if match[1] == pattern or match[1].endswith("/" + pattern)]
    if len(exact) == 1:
        return exact[0]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ValueError(f"model pattern {pattern!r} not found in pi --list-models — "
                         "authenticate/register it or fix the config")
    raise ValueError(f"model pattern {pattern!r} is ambiguous: {matches}")


def _context_tokens(usage: dict) -> int:
    """Tokens occupying the window after a turn.

    Mirrors pi's own `calculateContextTokens` (coding-agent
    `core/compaction/compaction.ts`), which is what pi compacts against and
    shows in its footer: prefer the provider's `totalTokens`, else sum the
    parts. Cache reads count — cached prompt is still prompt.
    """
    total = usage.get("totalTokens") or 0
    if total:
        return int(total)
    return int(sum(usage.get(part) or 0
                   for part in ("input", "output", "cacheRead", "cacheWrite")))


def context_window(provider: str, model_id: str) -> int:
    """The model's context ceiling from pi's merged model catalog."""
    registry = json.loads(Path(MODELS_JSON).read_text())
    for model in registry.get("providers", {}).get(provider, {}).get("models", []):
        if model.get("id") == model_id:
            return int(model.get("contextWindow") or 0)
    for listed_provider, listed_model, window in _pi_catalog():
        if listed_provider == provider and listed_model == model_id:
            return window
    return 0


def _text_of(container: dict) -> str:
    """Join the text blocks of anything pi shapes as {content: [...]} — a
    message or a tool result."""
    return "".join(part.get("text", "") for part in container.get("content", []) or []
                   if isinstance(part, dict) and part.get("type") == "text")


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def _label(tool: str, args: dict) -> str:
    """One-line human name for a tool call: `bash: ls -la src`."""
    value = next((args[key] for key in PRIMARY_ARGS
                  if isinstance(args.get(key), str) and args[key].strip()), "")
    if not value:
        value = next((v for v in args.values() if isinstance(v, str) and v.strip()), "")
    value = " ".join(str(value).split())
    return f"{tool}: {_clip(value, LABEL_CHARS)}" if value else tool


class ToolCallTracker:
    """Folds pi's tool stream into ONE normalized record per completed call.

    pi announces a call as a `toolCall` content block, then emits
    tool_execution_start / _update / _end for it. Only the end carries the
    result, so that is where a record is emitted — one trace event per real
    tool call, the moment it returns, instead of three shapeless ones.

    The record carries the call's real span (`started_at`/`ended_at`), which the
    tracer writes to columns so the UI can lay tool calls on a time axis without
    parsing every payload.
    """

    def __init__(self) -> None:
        self._open: dict[str, dict] = {}

    def observe(self, event: dict) -> Optional[dict]:
        """Returns the record for a finished tool call, else None."""
        etype = event.get("type", "")
        if etype == "message_end":
            for block in event.get("message", {}).get("content", []) or []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    self._announce(block.get("id"), block.get("name"),
                                   block.get("arguments"))
            return None
        if etype == "tool_execution_start":
            self._announce(event.get("toolCallId"), event.get("toolName"),
                           event.get("args"))
            return None
        if etype != "tool_execution_end":
            return None

        call_id = str(event.get("toolCallId") or "")
        opened = self._open.pop(call_id, {})
        tool = str(event.get("toolName") or opened.get("tool") or "tool")
        args = event.get("args") or opened.get("args") or {}
        record = {
            "tool": tool,
            "tool_call_id": call_id,
            "args": {key: _clip(value, ARG_VALUE_CHARS) if isinstance(value, str) else value
                     for key, value in args.items()},
            "ok": not event.get("isError", False),
            "label": _label(tool, args),
        }
        result_text = _text_of(event.get("result") or {})
        if result_text:
            record["result_snippet"] = _clip(result_text, RESULT_SNIPPET_CHARS)
        record["ended_at"] = now_iso()
        if opened.get("clock"):
            record["duration_ms"] = int((time.monotonic() - opened["clock"]) * 1000)
        if opened.get("started_at"):
            record["started_at"] = opened["started_at"]
        return record

    def _announce(self, call_id, tool, args) -> None:
        """First sighting starts the clock; a later sighting only fills gaps."""
        if not call_id:
            return
        known = self._open.get(str(call_id), {})
        self._open[str(call_id)] = {
            "tool": tool or known.get("tool", ""),
            "args": args or known.get("args", {}),
            "started_at": known.get("started_at") or now_iso(),   # wall clock, for the row
            "clock": known.get("clock") or time.monotonic(),      # monotonic, for duration
        }


def run(request: PiRequest, on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> PiResult:
    """Run one non-interactive pi turn.

    `on_spawn(pid)` and `on_exit(pid)` bracket the child process so the caller
    can record it as killable — a hung coding agent is otherwise a pid you have
    to hunt for in `ps` while the run sits there.
    """
    provider, model_id = resolve_model(request.model)
    cmd = [
        PI_PATH, "-p", "--mode", "json",
        "--provider", provider, "--model", model_id,
        "--thinking", request.thinking,
    ]
    # Only continue a session if its file actually exists. A session dir can
    # be cleaned between runs (operator cleanup) while the db still references
    # the session id; passing --session-id then makes pi exit 1 with ENOENT
    # instead of starting fresh. Mint a new session instead — the agent_map
    # gets the new id on the next save.
    # pi names session files <ISO-timestamp>_<session-id>.jsonl.
    let_session = False
    try:
        sdir = Path(request.session_dir)
        if sdir.is_dir():
            for f in sdir.iterdir():
                if f.name.endswith(f"_{request.session_id}.jsonl"):
                    let_session = True
                    break
    except OSError:
        let_session = False
    if let_session:
        cmd += ["--session-id", request.session_id]
    cmd += ["--session-dir", request.session_dir,
            "--system-prompt", request.system_prompt]
    if request.tools:
        cmd += ["--tools", ",".join(request.tools)]
    for extension in request.extensions:
        # Extensions are auto-discovered from ~/.pi/agent/extensions/ — bare
        # names passed via -e resolve against the PROJECT dir and fail with
        # 'Extension path does not exist'. Resolve bare names to the GLOBAL
        # path if present (still avoids double-load: we only pass what the
        # config explicitly lists, and the config keeps [] so nothing is
        # double-loaded).
        cmd += ["-e", extension]
    cmd.append(request.prompt)

    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    result = PiResult(session_id=request.session_id,
                      context_window=context_window(provider, model_id))
    # stdin is DEVNULL, deliberately. The prompt travels in argv, so the child
    # never needs stdin — but inheriting the parent's means pi sees a non-TTY
    # and can sit forever waiting for piped input that will never arrive or
    # EOF. That failure is silent and total: no request goes out, no bytes come
    # back, and the ADW blocks on a read loop with nothing to read. Observed as
    # a run that sat idle at 0% CPU with an empty raw_output.jsonl.
    process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace",
                               bufsize=1, cwd=request.cwd,
                               env=operator_env())
    if on_spawn:
        on_spawn(process.pid)
    # Cap the raw JSONL so a rogue thinking-blowup (seen: 4GB for one builder
    # run) cannot fill the disk. Past the cap we stop persisting but keep
    # parsing — the trace db still gets the events; only the raw transcript
    # truncates.
    RAW_CAP_BYTES = 100 * 1024 * 1024
    raw_bytes = 0
    # Tool-loop guard state: count completed tool calls and the streak of
    # identical ones (tool + exact args). A stuck agent (seen: 242x the same
    # grep in one decide phase) is killed mid-turn instead of draining the
    # run. Identity compares the full command/args string, so a genuine
    # exploration of distinct files never trips it.
    tool_calls = 0
    identical_streak = 0
    last_signature: Optional[str] = None
    # tool_execution_end does not always carry args; stash them from the
    # start event (mirrors ToolCallTracker) so the signature is exact.
    open_args: dict[str, str] = {}

    def _abort(reason: str, detail: str) -> None:
        result.aborted_reason = reason
        result.aborted_detail = detail
        try:
            process.terminate()
        except OSError:
            pass

    # Wedged-pi guard: a coding agent that emits NOTHING for this long is
    # hung — dead LLM connection, stuck process, or a pi that silently wedged
    # (seen: a builder that did 30 min of real edits then sat 20 HOURS with
    # zero events). Tool calls that legitimately take minutes (builds) also
    # emit nothing, so the threshold is deliberately generous + env-tunable.
    silence_sec = float(os.environ.get("SSSF_SILENCE_TIMEOUT_SEC", "600"))
    last_event_at = time.monotonic()
    if silence_sec > 0:
        def _silence_watchdog() -> None:
            while True:
                time.sleep(5)
                if process.poll() is not None:
                    return                    # already exited — nothing to do
                if time.monotonic() - last_event_at > silence_sec:
                    _abort("silence", f"no events for {silence_sec:.0f}s (wedged pi?)")
                    return
        threading.Thread(target=_silence_watchdog, daemon=True).start()

    with raw_path.open("a", encoding="utf-8") as raw:
        assert process.stdout is not None
        for line in process.stdout:
            if request.deadline_at is not None and time.time() > request.deadline_at:
                _abort("phase_timeout",
                       f"phase deadline passed ({(time.time() - request.deadline_at):.0f}s ago)")
                break
            raw_bytes += len(line.encode("utf-8", "replace"))
            if raw_bytes <= RAW_CAP_BYTES:
                raw.write(line)
                raw.flush()                  # events land on disk as they happen
            last_event_at = time.monotonic() # any output proves the agent is alive
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            abort_pending: Optional[str] = None
            if event.get("type") == "tool_execution_start":
                call_id = str(event.get("toolCallId") or "")
                if call_id:
                    open_args[call_id] = json.dumps(
                        event.get("args") or {}, sort_keys=True, ensure_ascii=False)
            elif event.get("type") == "tool_execution_end":
                tool_calls += 1
                call_id = str(event.get("toolCallId") or "")
                args_json = json.dumps(
                    event.get("args") or {}, sort_keys=True, ensure_ascii=False)
                if args_json == "{}":
                    args_json = open_args.pop(call_id, "{}")
                signature = f"{event.get('toolName')}|{args_json}"
                identical_streak = identical_streak + 1 if signature == last_signature else 1
                last_signature = signature
                if identical_streak >= request.max_identical_tool_calls:
                    abort_pending = "tool_loop"
                elif tool_calls >= request.max_tool_calls:
                    abort_pending = "tool_cap"
            if on_event:
                on_event(event)
            if abort_pending:
                _abort(abort_pending, f"{tool_calls} tool call(s), last {identical_streak} identical ({event.get('toolName')})")
                break

            if event.get("type") == "message_end":
                message = event.get("message", {})
                if message.get("role") == "assistant":
                    text = _text_of(message)
                    if text:
                        result.text = text   # last assistant message wins
                    usage = message.get("usage", {}) or {}
                    turn = _context_tokens(usage)
                    result.tokens += turn
                    result.usage.add_turn(usage, turn)
                    # Occupancy is read off the last VALID assistant turn, the
                    # way pi does it — an aborted or errored turn reports usage
                    # you can't trust, so it must not overwrite a good reading.
                    if turn and message.get("stopReason") not in ("aborted", "error"):
                        result.context_tokens = turn
                    result.cost += (usage.get("cost", {}) or {}).get("total", 0.0) or 0.0
            if on_event:
                on_event(event)

    stderr = process.stderr.read() if process.stderr else ""
    try:
        result.returncode = process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        result.returncode = process.wait()
    if on_exit:
        on_exit(process.pid)
    # A guardrail abort (tool loop / budget / deadline) is a controlled stop,
    # not a crash — the caller re-prompts. Everything else with no final text
    # is a real failure and should surface as one.
    if result.returncode != 0 and not result.text and not result.aborted_reason:
        raise RuntimeError(f"pi exited {result.returncode}: {stderr.strip()[-800:]}")
    return result
