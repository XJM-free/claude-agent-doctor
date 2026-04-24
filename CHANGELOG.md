# Changelog

## v0.3.0 — 2026-04-24

Four new pathologies in the loops and tools categories, plus expanded data
extraction from session transcripts.

- **Added**: `LOOP_DEATH` (loops, high) — same primary tool 8+ consecutive turns
- **Added**: `RETRY_THRASH` (loops, med) — one file both heavily read and heavily edited
- **Added**: `CONTEXT_BLOAT` (tools, med) — peak turn input > 150K tokens
- **Added**: `TOOL_CALL_STORM` (tools, low) — single turn with 12+ tool_use blocks
- **Added**: `SessionStat` now tracks `readFiles`, `maxToolRun`, `maxToolCallsPerTurn`, `peakTotalInputTokens`
- **Added**: 11 new tests covering the four new pathologies
- **Added**: `docs/drafts/v0.4-pathologies.md` with the next four pathology drafts
- Live-validated on the author's 14-day window: 17 LOOP_DEATH, 22 CONTEXT_BLOAT,
  13 EDIT_THRASH, 11 RETRY_THRASH hits — real patterns, not synthetic.

## v0.2.0 — 2026-04-24

- **Added**: `doctor suggest-routing` — per-subagent model advisor
  - Scans every agent definition under `~/.claude/agents/` and `<cwd>/.claude/agents/`
  - Infers role from frontmatter description + name via keyword heuristics
  - Guards against high-blast-radius downgrades (orchestrators, payment/
    subscription, safety/compliance, reality checkers)
  - Never auto-upgrades to Opus (cost risk without user intent)
  - Surfaces `CLAUDE_CODE_SUBAGENT_MODEL=haiku` as the safer first experiment
- **Added**: `--export-patch` flag to produce a unified diff the user applies manually
- **Added**: 17 new tests for routing classification + guards + patch generation
- Live-validated on 17 agent files: 12 aggressive suggestions → 1 safe suggestion after guards.

## v0.1.0 — 2026-04-24

Initial public release. Eight pathologies documented in `PATHOLOGY.md`,
two CLI verbs (`check`, `explain`), 25 tests, CI on Bun latest.

- Zero LLM calls, zero network — static JSONL analysis only.
- Three output formats: TTY (colorized), Markdown, JSON.
- Pricing matches Anthropic published rates as of 2026-04.
