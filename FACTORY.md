# FACTORY.md — PetRockStudios factory setup

This repo has the SSSF factory installed (adws/).

## Quality commands (auto-detected from package.json)

- **test**: `not detected — placeholder`
- **lint**: `not detected — placeholder`
- **typecheck**: `not detected — placeholder`
- **build**: `not detected — placeholder`

## Run

```bash
uv run adws/adw_prompt.py "ask the factory something" --agent scout   # explore
uv run adws/adw_build_test.py "fix the jump physics"                  # quick fix + test
uv run adws/adw_simple_sdlc_stack.py "add a settings screen"          # full pipeline
uv run adws/adw_research.py "research WebGPU"                         # internet research
```

Or use the PRS Factory dashboard → Projects → pick this project → Run Factory.
