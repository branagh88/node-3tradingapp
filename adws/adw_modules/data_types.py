"""Concrete data types for the SSSF ADW system.

RULE (four-param rule): any function that takes more than 4 parameters takes
ONE of these objects instead. AgentCall and PhaseParams are the pattern.

Every agent call declares a concrete output type — an EnvelopeBase subclass —
that its final JSON response is parsed against. No untyped handoffs.
"""

from __future__ import annotations

from typing import Any, Callable, Literal, Optional, Type

from pydantic import (BaseModel, Field, ValidationInfo, field_validator,
                          model_validator)

PhaseKind = Literal["engineer", "agent", "code"]
PhaseStatus = Literal["queued", "running", "success", "fail"]


# ── Phases ────────────────────────────────────────────────────────────────────

class PhaseParams(BaseModel):
    """Everything run.phase() needs. Passed as one object, never loose params."""

    name: str                       # short id, unique within the run: "plan", "build"
    kind: PhaseKind                 # which lane the block renders in
    owner: str                      # engineer's name, "git", or an agent name from config
    description: str                # REQUIRED: what this phase does and why — see below
    retries: int = 0                # agent phases: gate-failure retries via continue
    # Phase guardrails (enforced in agent_pi.run via agents.execute): a phase
    # whose agent loops on identical tool calls, burns its tool budget, or
    # overruns its deadline is killed mid-turn, gets ONE corrective retry,
    # then the phase fails — no more unbounded hangs. 0 = no deadline.
    timeout_sec: int = 0
    max_tool_calls: int = 100
    max_identical_tool_calls: int = 6

    @field_validator("description")
    @classmethod
    def _description_must_be_earned(cls, value: str, info: ValidationInfo) -> str:
        """A phase name identifies; a description explains. Both are required.

        The description is the only sentence the trace, the console, and the
        phase block in the UI ever show about intent — everything else is ids,
        statuses, and timings. `commit_plan: "Commit the plan"` tells a reader
        nothing they could not already see, so an echo is rejected the same way
        a blank one is. This is a construction-time error on purpose: it fires
        before the phase opens, not after a run is already in the trace.
        """
        text = " ".join(value.split())
        name = str(info.data.get("name", "?"))
        if not text:
            raise ValueError(
                f"phase {name!r}: description is required — one sentence on what this "
                f"phase does and why. It is what the trace and the UI show.")
        if text.rstrip(".").casefold() == name.replace("_", " ").casefold():
            raise ValueError(
                f"phase {name!r}: description {text!r} only restates the phase name — "
                f"say what it does and why instead.")
        return text


class Phase(BaseModel):
    """The persisted phase record — PhaseParams plus lifecycle."""

    phase_id: str
    adw_id: str
    seq: int
    params: PhaseParams
    status: PhaseStatus = "fail"    # success must be earned
    attempt: int = 0
    error: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None


# ── Envelopes (agent output types) ───────────────────────────────────────────

class EnvelopeBase(BaseModel):
    """Base of every agent's final JSON response. Output types extend this."""

    status: Literal["success", "fail"]
    summary: str = ""
    artifacts: list[str] = Field(default_factory=list)
    notes_for_next_agent: str = ""

    @field_validator("artifacts", mode="before")
    @classmethod
    def coerce_artifacts(cls, v: Any) -> Any:
        """LLMs sometimes emit artifacts as {path: note} instead of a list —
        coerce dict keys to a path list so a format slip doesn't fail the run
        (artifacts are advisory; the git diff is the source of truth)."""
        if isinstance(v, dict):
            return list(v.keys())
        return v


class GenericOutput(EnvelopeBase):
    pass


class ManagerDecision(EnvelopeBase):
    """The Factory Manager's call: which agent runs next — or that work is done.

    Emitted after every phase in a manager-driven run. `next_phase` names a
    configured agent exactly, or the literal "done". When "done", `commit`
    controls the closing git phase and `commit_message` supplies its subject.
    """

    next_phase: str = ""           # a config agent name, or "done"
    task: str = ""                 # what the next agent should do (when next_phase set)
    reason: str = ""               # why this next step — the trace shows it
    commit: bool = True            # done: whether to commit the accumulated work
    commit_message: str = ""       # done: subject for the closing commit


class PlanOutput(EnvelopeBase):
    # Subject for committing the PLAN — the spec file the planner wrote, not the
    # implementation it describes. Each agent's commit_message covers its own
    # work product, so a chain that commits per step never reuses one agent's
    # words for another agent's diff.
    commit_message: str = ""


class BuildOutput(EnvelopeBase):
    changed_files: list[str] = Field(default_factory=list)
    commit_message: str = ""        # consumed by the git commit phase


class ScoutFinding(BaseModel):
    file: str
    note: str = ""


class ScoutOutput(EnvelopeBase):
    findings: list[ScoutFinding] = Field(default_factory=list)


class ReviewFinding(BaseModel):
    """One thing the request (or plan) asked for, and whether it is there."""

    requirement: str                # the ask, in the requester's words
    met: bool
    evidence: str = ""              # where it lives, or what is missing


class ReviewOutput(EnvelopeBase):
    """Confirmation that what was built is what was asked for — not a test run."""

    approved: bool = False
    findings: list[ReviewFinding] = Field(default_factory=list)
    blocking: list[str] = Field(default_factory=list)   # what must change before approval


class DocumentOutput(EnvelopeBase):
    """Where the write-up of a completed change landed."""

    document_path: str = ""         # the doc in the repo, e.g. app_docs/<adw_id>_<slug>.md
    documented_files: list[str] = Field(default_factory=list)
    commit_message: str = ""


# ── PRS custom agents (stack-guard / test-writer / release-manager) ──────────

class StackGuardViolation(BaseModel):
    """One stack-rule violation found by the stack-guard audit."""

    rule: str                       # e.g. "threejs-disposal", "phaser4-filters", "webperf-loop"
    file: str                       # file:line where it lives
    severity: Literal["blocking", "warning"] = "blocking"
    detail: str = ""               # what is wrong and why it matters


class StackGuardOutput(EnvelopeBase):
    """Audit of a change against PetRockStudios stack rules — not a task review."""

    approved: bool = False
    violations: list[StackGuardViolation] = Field(default_factory=list)  # empty = approved


class TestWriterOutput(EnvelopeBase):
    """Tests written for a change, with proof the suite ran green."""

    tests_written: list[str] = Field(default_factory=list)
    tests_pass: bool = False        # true ONLY after the suite actually ran green
    command_run: str = ""           # e.g. "bun test"


class ReleaseOutput(EnvelopeBase):
    """Release prep: version bump + changelog + notes. Never commits."""

    version_from: str = ""
    version_to: str = ""
    bump: str = ""                 # patch | minor | major
    changelog_written: bool = False
    notes_written: bool = False
    notes_path: str = ""           # e.g. release/<project>-vX.Y.Z.md
    commit_message: str = ""       # suggested only — the agent never commits


class ResearchFinding(BaseModel):
    """One material claim from the research, with its source."""

    finding: str
    source: str = ""               # URL or primary reference


class ResearchSource(BaseModel):
    """A source the researcher actually read."""

    url: str
    kind: str = "primary"          # primary | secondary
    note: str = ""


class ResearchOutput(EnvelopeBase):
    """Internet-enabled research on a hard topic, with a feasibility verdict."""

    topic: str = ""
    verdict: Literal["adopt", "prototype", "watch", "drop"] = "watch"
    findings: list[ResearchFinding] = Field(default_factory=list)
    sources: list[ResearchSource] = Field(default_factory=list)
    next_steps: str = ""           # what a builder would do next


# ── PRS custom agent #5: art-director (asset generation + visual appeal) ─────

class GeneratedAsset(BaseModel):
    """One asset the art-director created or selected."""

    path: str                       # repo-relative path, e.g. assets/sprites/hero.png
    kind: Literal["character", "item", "tile", "background", "ui", "icon", "effect", "other"] = "other"
    size_bytes: int = 0
    prompt: str = ""               # the generation prompt (or source for reused)


class ArtDirectorOutput(EnvelopeBase):
    """Generated game assets + the art direction that makes them consistent."""

    style: str = ""                # e.g. pixel-art, isometric, warmpastel
    style_lora: str = ""           # LoRA used, or "" if none
    palette: list[str] = Field(default_factory=list)   # hex colors, 4-6 max
    assets_generated: list[GeneratedAsset] = Field(default_factory=list)
    assets_reused: list[GeneratedAsset] = Field(default_factory=list)
    next_steps: str = ""           # what would make it pop next


class UIAsset(BaseModel):
    """One UI asset the ui-ux-designer created."""

    path: str                       # repo-relative path, e.g. assets/ui/panel.png
    kind: Literal["panel", "button", "slot", "meter", "icon", "frame", "hud", "cursor", "other"] = "other"
    size_bytes: int = 0
    prompt: str = ""               # generation prompt (or source for reused)

    @field_validator("path", mode="before")
    @classmethod
    def coerce_string_entry(cls, v):
        # Lenient: the model sometimes emits a bare string like
        # "assets/ui/panel.png (256x256, 51,027 bytes)" instead of an object.
        # Coerce it into a usable path (strip size/parentheticals).
        if isinstance(v, str):
            return v.split("(")[0].strip()
        return v


class UIDesignOutput(EnvelopeBase):
    """UI/UX design: screens, flow, layout, and UI assets in one style."""

    @model_validator(mode="before")
    @classmethod
    def coerce_string_assets(cls, data):
        # The model sometimes emits ui_assets_generated as plain strings like
        # "assets/ui/panel.png (256x256, 51,027 bytes)". Coerce each to an object.
        if isinstance(data, dict):
            assets = data.get("ui_assets_generated")
            if isinstance(assets, list):
                out = []
                for a in assets:
                    if isinstance(a, str):
                        clean = a.split("(")[0].strip()
                        out.append({"path": clean, "kind": "other", "size_bytes": 0})
                    else:
                        out.append(a)
                data = {**data, "ui_assets_generated": out}
        return data

    screens: list[str] = Field(default_factory=list)   # menu, gameplay-hud, inventory...
    flow: str = ""                 # menu -> gameplay-hud -> inventory -> ...
    components: list[str] = Field(default_factory=list)  # panel, button, slot, meter...
    style: str = ""
    palette: list[str] = Field(default_factory=list)
    ui_assets_generated: list[UIAsset] = Field(default_factory=list)
    next_steps: str = ""           # what the builder must wire in


class FactoryDevOutput(EnvelopeBase):
    """A factory self-improvement change — the ONLY agent allowed to edit adws/."""

    files_changed: list[str] = Field(default_factory=list)
    change_type: str = ""          # bugfix | feature | config | prompts | docs
    verification: str = ""         # what was run to confirm it parses/loads
    notes_for_next_agent: str = "" # migration / behavior change others must know


# ── Deterministic quality blocks ─────────────────────────────────────────────

QualityArea = Literal["frontend", "backend"]
QualityOperation = Literal["lint", "typecheck", "build"]


class QualityCheckSpec(BaseModel):
    """One deterministic quality command."""

    name: str
    area: QualityArea
    operation: QualityOperation
    argv: list[str]
    timeout_seconds: int = 120


class QualityCheckResult(BaseModel):
    """Captured evidence from one quality command."""

    name: str
    area: QualityArea
    operation: QualityOperation
    command: str
    returncode: int
    passed: bool
    duration_seconds: float
    output_artifact: str
    # The tail of stdout+stderr, verbatim and unparsed. A failure has to travel
    # back to the builder as an envelope, and the builder cannot open a log file
    # it was never handed — so the evidence rides along. Deliberately raw: every
    # runner formats failures differently and a generic parser would be
    # confidently wrong. The full log is always at output_artifact.
    output_tail: str = ""


class QualityResult(BaseModel):
    """Aggregate result from a quality block: every check it ran, and the verdict."""

    passed: bool
    checks: list[QualityCheckResult] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    artifacts: list[str] = Field(default_factory=list)


# ── Change capture (git diff, deterministic) ─────────────────────────────────

class ChangeCapture(BaseModel):
    """Everything documentation.capture() needs. One object, never loose params."""

    base: str = "main"              # the ref the work is measured against
    max_diff_lines: int = 2000      # the diff artifact is truncated past this
    include_untracked: bool = True  # a brand-new file is part of the change


class BaseRef(BaseModel):
    """The commit a change is measured from, and why that one.

    `reason` is the line the trace shows. A diff is only as trustworthy as the
    thing it was taken against, so the ADW records that choice instead of
    leaving the reader to infer it.
    """

    ref: str                        # what was asked for: "main", or a pinned sha
    commit: str                     # the commit actually diffed against
    reason: str = ""

    @property
    def label(self) -> str:
        """Display form — a named ref as itself, a pinned raw sha shortened."""
        if len(self.ref) == 40 and all(c in "0123456789abcdef" for c in self.ref):
            return self.ref[:7]
        return self.ref


class ChangeSet(BaseModel):
    """What changed since the base commit — pure git facts, no judgement."""

    base: BaseRef
    files: list[str] = Field(default_factory=list)
    untracked: list[str] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    stat: str = ""                  # `git diff --stat` output, verbatim
    diff_path: str = ""             # the full diff, written into context_handoff/
    truncated: bool = False

    @property
    def empty(self) -> bool:
        return not (self.files or self.untracked)


class ChangesOutput(EnvelopeBase):
    """A ChangeSet shaped as an envelope so an agent can be handed it directly.

    Same adapter idea as VerifyOutput: code computes the diff, the documenter
    consumes it through the one door every agent handoff uses.
    """

    base: str = ""                  # "<ref> @ <commit> — <reason>"
    changed_files: list[str] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    stat: str = ""
    diff_path: str = ""             # read this for the full diff


class VerifyOutput(EnvelopeBase):
    """A deterministic result, shaped as an envelope so an agent can consume it.

    Agents hand each other typed envelopes; code blocks return QualityResult.
    This is the adapter, so a failing lint or test run flows back into the
    builder through exactly the same door a tester agent's report used to —
    the ADW script is the only thing that knows the difference.
    """

    passed: bool = False
    failures: list[str] = Field(default_factory=list)


# ── Agent calls ──────────────────────────────────────────────────────────────

class GateCheck(BaseModel):
    """One thing a gate looked at, and what it found.

    `note` is the evidence — "exists, 2.1KB", "exit 0", "not in the diff". On a
    failed check it doubles as the reason, so it is what the agent is told.
    """

    item: str                       # what was checked: a path, a command, a test
    ok: bool
    note: str = ""


class GateReport(BaseModel):
    """What every gate returns: the checks it ran. Violations are derived.

    Authoring stays a one-liner per item — `report.check(...)` appends and
    returns self, so a gate is a loop and a return.
    """

    checks: list[GateCheck] = Field(default_factory=list)

    def check(self, item: str, ok: bool, note: str = "") -> "GateReport":
        self.checks.append(GateCheck(item=item, ok=ok, note=note))
        return self

    @property
    def violations(self) -> list[str]:
        return [f"{c.item}: {c.note or 'failed'}" for c in self.checks if not c.ok]

    @property
    def passed(self) -> bool:
        return not self.violations


class AgentCall(BaseModel):
    """One agent invocation: prompt in, typed envelope out, gates verified."""

    model_config = {"arbitrary_types_allowed": True}

    output_type: Type[EnvelopeBase]
    prompt: str
    previous: Optional[EnvelopeBase] = None
    gates: list[Callable] = Field(default_factory=list)   # gate(envelope, run) -> list[str]


# ── Config ───────────────────────────────────────────────────────────────────

class PromptEngineering(BaseModel):
    system: str                     # path to system.md
    user: str                       # path to user.md


class AgentConfig(BaseModel):
    name: str
    coding_agent: Literal["pi", "claude_code"] = "pi"
    model: str = "google/gemini-3.6-flash"
    thinking: str = "medium"        # off | minimal | low | medium | high | xhigh | max
    color: str = ""                 # hex swatch for this agent's lane in the UI
    purpose: str = ""
    prompt_engineering: PromptEngineering
    harness_engineering: list[str] = Field(default_factory=list)
    tools: Optional[list[str]] = None    # allowlist; None = all tools usable
    # What this agent may MODIFY in the repo, enforced in code after every call
    # (see adw_modules/permissions.py). `tools` cannot express this: `bash` runs
    # anything and `write` reaches any path, so an agent's capability list is a
    # statement of intent that nothing checks.
    #   None  -> unrestricted, except the roster-wide `protected_files` paths
    #   []    -> read-only: may modify nothing tracked
    #   [...] -> only these. A trailing "/" means a directory prefix; a "*"
    #            makes it a glob; anything else is an exact path.
    writes: Optional[list[str]] = None


class ConfigDefaults(BaseModel):
    coding_agent: Literal["pi", "claude_code"] = "pi"
    model: str = "google/gemini-3.6-flash"
    thinking: str = "medium"
    color: str = ""
    harness_engineering: list[str] = Field(default_factory=list)
    tools: Optional[list[str]] = None    # roster-wide allowlist; None = all tools usable
    # Off-limits to every agent that has not named them in its own `writes`.
    # The factory's own code is the default: an agent must not be able to edit
    # the machinery that decides whether its work passed.
    protected_files: list[str] = Field(default_factory=lambda: [
        "adws/adw_modules/", "adws/adw_sssf_config/", "adws/adw_*.py",
    ])
    data_dir: str = "adws/adw_data"


class ObservabilityConfig(BaseModel):
    db: str = "adws/adw_data/sssf.db"
    poll_ms: int = 500


class SSSFConfig(BaseModel):
    defaults: ConfigDefaults = Field(default_factory=ConfigDefaults)
    observability: ObservabilityConfig = Field(default_factory=ObservabilityConfig)
    agents: list[AgentConfig] = Field(default_factory=list)


# ── Tracing ──────────────────────────────────────────────────────────────────

class EventRecord(BaseModel):
    """One traced event, always logged against adw_id + phase."""

    adw_id: str
    phase_id: str = ""
    type: str                       # phase_start | agent_start | tool_call | handoff | gate_pass | gate_fail | log | agent_end | phase_end | error
    name: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    parent_id: str = ""
    tokens: Optional[int] = None
    # Spans: set both when an event covers real elapsed time (a tool call), so
    # the UI lays it out on a time axis without parsing payload JSON. Left unset,
    # the tracer stamps started_at with the moment the event was recorded.
    started_at: Optional[str] = None
    ended_at: Optional[str] = None


# ── Pi coding agent interface ────────────────────────────────────────────────

class PiRequest(BaseModel):
    """Everything one non-interactive pi run needs."""

    prompt: str
    system_prompt: str
    model: str                      # registry pattern, resolved to provider + id
    thinking: str = "medium"
    session_id: str                 # pi --session-id: creates or continues
    session_dir: str
    raw_output_path: str            # JSONL stream lands here
    tools: Optional[list[str]] = None
    extensions: list[str] = Field(default_factory=list)
    cwd: str = "."                  # set from run.repo_root — the codebase root agents work in
    # Tool-loop guard + phase deadline (enforced in agent_pi.run): a stuck
    # agent is killed mid-turn instead of burning tokens forever. deadline_at
    # is epoch seconds; the turn is SIGTERM'd once the clock passes it.
    max_tool_calls: int = 100
    max_identical_tool_calls: int = 6
    deadline_at: Optional[float] = None


class UsageBreakdown(BaseModel):
    """Tokens and the dollars they cost, per component, summed over a call.

    Mirrors pi's `usage` shape one-for-one so the numbers reconcile with what
    pi itself reports: `input` EXCLUDES cache reads, which bill at their own
    (cheaper) rate — add them to learn the size of the prompt that was sent.
    """
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # Thinking tokens. NOT a fifth component: measured across every session on
    # disk, reasoning is always <= output and the four components above always
    # sum to totalTokens, so reasoning is the thinking SHARE of output, billed
    # at the output rate. Report it nested under output, never added to it.
    reasoning_tokens: int = 0
    total_tokens: int = 0
    input_cost: float = 0.0
    output_cost: float = 0.0
    cache_read_cost: float = 0.0
    cache_write_cost: float = 0.0
    total_cost: float = 0.0

    def add_turn(self, usage: dict, total_tokens: int) -> None:
        """Fold in one pi `message_end` usage object.

        `total_tokens` is passed in rather than re-derived: the caller already
        computes it pi's way (totalTokens, else the sum of the parts).
        """
        cost = usage.get("cost") or {}
        self.input_tokens += usage.get("input") or 0
        self.output_tokens += usage.get("output") or 0
        self.cache_read_tokens += usage.get("cacheRead") or 0
        self.cache_write_tokens += usage.get("cacheWrite") or 0
        self.reasoning_tokens += usage.get("reasoning") or 0
        self.total_tokens += total_tokens
        self.input_cost += cost.get("input") or 0.0
        self.output_cost += cost.get("output") or 0.0
        self.cache_read_cost += cost.get("cacheRead") or 0.0
        self.cache_write_cost += cost.get("cacheWrite") or 0.0
        self.total_cost += cost.get("total") or 0.0

    def merge(self, other: "UsageBreakdown") -> None:
        """Add another call's usage — a phase that retries spends more than once."""
        for field in self.model_fields:
            setattr(self, field, getattr(self, field) + getattr(other, field))


class PiResult(BaseModel):
    text: str = ""
    returncode: int = 0
    session_id: str = ""
    tokens: int = 0
    cost: float = 0.0
    usage: UsageBreakdown = Field(default_factory=UsageBreakdown)
    # Context occupancy after the LAST turn — not a sum. `tokens` bills every
    # turn; this is how full the window is right now, which is what the
    # visualizer's context bar measures against `context_window`.
    context_tokens: int = 0
    context_window: int = 0         # 0 when the registry declares no ceiling
    # Non-None when agent_pi.run killed the turn before a final message:
    # "tool_loop" (identical repeated calls), "tool_cap" (budget exhausted),
    # or "phase_timeout" (deadline passed). The caller re-prompts once with a
    # hard "stop using tools" instruction, then fails the phase on a repeat.
    aborted_reason: Optional[str] = None
    aborted_detail: str = ""


class ContentOutput(EnvelopeBase):
    pass


class DesignOutput(EnvelopeBase):
    pass


class QAReportOutput(EnvelopeBase):
    pass


class PerfOutput(EnvelopeBase):
    pass


class AudioOutput(EnvelopeBase):
    pass


class FeelOutput(EnvelopeBase):
    pass


class EconomyOutput(EnvelopeBase):
    pass


class CopyOutput(EnvelopeBase):
    pass


class PlatformOutput(EnvelopeBase):
    pass


class VFXOutput(EnvelopeBase):
    pass


class DevlogOutput(EnvelopeBase):
    pass


class LocalizationOutput(EnvelopeBase):
    pass


class ProcgenOutput(EnvelopeBase):
    pass


class SaveOutput(EnvelopeBase):
    pass


class GrantOutput(EnvelopeBase):
    pass


class AccessibilityOutput(EnvelopeBase):
    pass


class SolanaOutput(EnvelopeBase):
    pass


class AuditOutput(EnvelopeBase):
    pass


class NftOutput(EnvelopeBase):
    pass


class MarketOutput(EnvelopeBase):
    pass


class TokenomicsOutput(EnvelopeBase):
    pass


class PaymentsOutput(EnvelopeBase):
    pass

class AndroidDeveloperOutput(EnvelopeBase):
    """Capacitor conversion (and APK build when the SDK is available)."""

    app_id: str = ""               # com.petrockstudios.<slug>
    app_name: str = ""
    web_dir: str = "www"
    converted: bool = False         # Capacitor platform synced
    apk_built: bool = False
    apk_path: str = ""             # android/app/build/outputs/apk/debug/app-debug.apk
    next_steps: str = ""           # install via adb, or build on the studio machine
