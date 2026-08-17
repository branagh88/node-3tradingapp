"""Prompt rendering: load system/user refs from config, replace {{placeholders}}."""

from __future__ import annotations

import sys
from pathlib import Path

# Windows defaults to cp1252, which cannot encode the arrow/dash glyphs in the
# prompt templates (→ ▶ —). Force UTF-8 on every prompt read/write so the
# audit copies are byte-identical to what was sent.
_ENC = "utf-8"


def render(template_path: str | Path, variables: dict[str, str]) -> str:
    text = Path(template_path).read_text(encoding=_ENC)
    for key, value in variables.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def save(directory: str | Path, name: str, content: str) -> Path:
    """Save the exact prompt sent, before execution — the audit copy."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(content, encoding=_ENC)
    return path
