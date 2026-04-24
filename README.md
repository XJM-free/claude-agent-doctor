# claude-agent-doctor

> **Lint your Claude Code sessions.**
> Static analysis on `~/.claude/projects/*.jsonl` — zero tokens, zero network, catches cost leaks and agent loops before you do.

[![npm](https://img.shields.io/npm/v/claude-agent-doctor.svg)](https://www.npmjs.com/package/claude-agent-doctor)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![tests](https://img.shields.io/badge/tests-53_passing-success)](test/)
![pathologies: 12](https://img.shields.io/badge/pathologies-12-orange)

---

## Why

Your Claude Code subagents write every turn to `~/.claude/projects/`. If
nothing reads those logs, your only feedback loop is the end-of-month
invoice. By then, the expensive habit is already 30 days old.

`doctor` is a static analyzer. It reads the same local JSONL files that
[agent-ledger](https://github.com/XJM-free/claude-agent-ledger) reports on,
but instead of showing you totals it looks for *patterns you probably want
to fix*. The patterns are documented in [PATHOLOGY.md](PATHOLOGY.md) — think
of it as a lint rule catalog, with a mechanism and a copy-paste fix for each
rule.

- **Zero tokens.** No LLM is called, ever. It's grep + arithmetic.
- **Zero network.** Nothing leaves your machine.
- **Zero surprise.** Each finding names a rule in `PATHOLOGY.md`; you can
  read the rule and decide for yourself.

## Install

```bash
npm install -g claude-agent-doctor
# or: bun install -g claude-agent-doctor
```

## Quick start

```bash
doctor check                  # scan the last 7 days
doctor check --days 30        # scan the last month
doctor check <session-id>     # deep-scan one session
doctor explain                # browse the catalog (8 pathologies)
doctor explain BASH_STORM     # one pathology, in detail
doctor suggest-routing        # per-subagent model suggestions (new in v0.2)
```

Output is colorized in a TTY and plain when piped. JSON and Markdown are
available with `--format json` / `--format md`.

## Example output

Real output from a `doctor check` run on the author's own 7-day window
(actual numbers, not a mock):

```
Doctor report  ·  54 sessions  ·  $20,027 total shadow spend

  15 high · 25 med · 1 low
  potential weekly savings: $2,889

│ RUNAWAY_SESSION  [cost · high]
│ session b87c4e13  ~/ZStack/zstack/workspace
│
│ A single session consumed > 25% of weekly spend.
│
│ Detected:
│   session cost: $6,247
│   share of weekly total: 31.2%  (threshold: 25%)
│   turns: 5052
│
│ Fix:
│   Inspect the transcript:
│     agent-ledger explain b87c4e13
│   Add a guardrail to your agent config:
│     max_turns: 80
│     max_cost_usd: 50
│
│ doctor explain RUNAWAY_SESSION  # mechanism & full case study
```

Every finding has four parts: a rule, evidence from *your* data, a
copy-pasteable fix, and a link to the rule's mechanism. If you don't agree
with the rule, skip it — `doctor` doesn't change anything on your machine.

## The catalog

Twelve rules ship in v0.3, in three categories. Full mechanisms and case
studies in [PATHOLOGY.md](PATHOLOGY.md).

| Code | Category | Severity | Summary |
|------|----------|----------|---------|
| `MODEL_MONOCULTURE` | cost  | high | One model dominates > 95% of spend |
| `HAIKU_NEGLECT`     | cost  | med  | Haiku used in < 5% of sessions |
| `RUNAWAY_SESSION`   | cost  | high | A single session consumed > 25% of weekly spend |
| `CACHE_TTL_MISMATCH`| cost  | med  | Short session, heavy 1h cache writes |
| `BASH_STORM`        | loops | high | > 500 Bash calls in one session |
| `SUBAGENT_SPRAWL`   | loops | med  | > 8 distinct subagents per session |
| `LOOP_DEATH`        | loops | high | Same tool fired 8+ consecutive turns (**v0.3**) |
| `RETRY_THRASH`      | loops | med  | One file both heavily read and heavily edited (**v0.3**) |
| `EDIT_THRASH`       | tools | med  | Same file edited > 10 times in one session |
| `NO_TOOL_BURN`      | tools | low  | > 40% of spend in no-tool turns |
| `CONTEXT_BLOAT`     | tools | med  | Peak turn input > 150K tokens (**v0.3**) |
| `TOOL_CALL_STORM`   | tools | low  | Single turn fires 12+ tool_use blocks (**v0.3**) |

## `suggest-routing` — config advisor (v0.2)

`doctor suggest-routing` reads every subagent definition under
`~/.claude/agents/` (and `<project>/.claude/agents/`), infers intended role
from the frontmatter, and proposes per-agent model changes.

Two things make this different from a runtime router like
[musistudio/claude-code-router](https://github.com/musistudio/claude-code-router):

1. **No proxy.** We don't sit in front of the API. You apply suggestions
   yourself; nothing in your request path changes.
2. **Guarded by default.** Orchestrators, payment / subscription agents,
   safety / compliance auditors, and reality checkers are never auto-
   downgraded. The blast radius of a mis-route on those is too large.

```
Routing suggestions

  1 change suggested:

  dingding                  sonnet → haiku  high conf  [user]
    ~/.claude/agents/dingding.md
    read-only work signals (search, fetch, log) — haiku at 1/10 the cost

  15 agents left unchanged (guarded roles or low-signal descriptions).

Safer first experiment
  export CLAUDE_CODE_SUBAGENT_MODEL=haiku
  (Anthropic-official env var — instantly reversible by unsetting.)
```

Export as a unified diff and apply yourself:

```bash
doctor suggest-routing --export-patch > routing.patch
patch -p0 < routing.patch
```

## How it relates to `/cost` and `agent-ledger`

- **`/cost`** (built-in) tells you the current session's cost. That's it.
- **[agent-ledger](https://github.com/XJM-free/claude-agent-ledger)** aggregates past sessions into a ledger (per subagent, per model, per day).
- **`doctor`** reads the same files and looks for *patterns worth fixing*.

Think of it as: ledger is `top(1)`, doctor is `pylint`. They don't overlap;
they answer different questions.

You don't need ledger installed to use doctor — doctor reads JSONL directly.
But if you do have ledger, `doctor`'s session-level prescriptions will
reference `agent-ledger explain <id>` for deeper forensics.

## What it doesn't do

- **Doesn't call the API.** Ever. Not for analysis, not for LLM-assisted
  diagnosis. Zero tokens.
- **Doesn't change your config.** Prescriptions are suggestions. You apply
  them by hand.
- **Doesn't upload anything.** Not even anonymized telemetry. If you want
  to share a finding, `doctor check --format md > report.md` and you
  decide what to do with it.
- **Doesn't replace code review or good judgment.** A pathology is a
  hypothesis about your workflow. Your context may make the "fix" wrong.

## Development

```bash
git clone https://github.com/XJM-free/claude-agent-doctor
cd claude-agent-doctor
bun install
bun test           # 25 pass
bun run build
bun run link
doctor check
```

## Contributing a new pathology

See [CONTRIBUTING.md](CONTRIBUTING.md). A good pathology proposal has: a
deterministic detection rule, a mechanism explanation, at least one real
case study, and a copy-pasteable fix. That's the bar.

## Status

v0.1.0 — 8 pathologies, 25 tests, validated on the author's own 219-session
corpus. Pricing matches Anthropic published rates as of 2026-04; values may
drift ±5-10% in edge cases (retries, server-tool calibration). Calibration
PRs welcome.

v0.3 ships 4 new pathologies (`LOOP_DEATH`, `RETRY_THRASH`, `CONTEXT_BLOAT`,
`TOOL_CALL_STORM`) and grows to 53 tests.

Roadmap:
- `v0.4` — per-subagent invocation + cost tracking (feeds better routing suggestions)
- `v0.5` — per-project profiles, custom thresholds via `.doctor.yml`
- `v1.0` — cross-agent support (Codex, Cursor logs)

## Author

[@XJM-free](https://jiexiang.dev). Also maintains
[agent-ledger](https://github.com/XJM-free/claude-agent-ledger) (cost
attribution for Claude Code) and
[apple-presubmit-audit](https://github.com/XJM-free/apple-presubmit-audit)
(70+ App Store rejection checks).

## License

MIT.
