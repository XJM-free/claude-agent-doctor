# Pathology catalog (v0.1)

> A field guide to recurring failure modes in Claude Code sessions. Each entry
> names a pattern, gives a detection signature, explains the mechanism, and
> offers a copy-pasteable fix. Drawn from 219 real sessions and $13K of shadow
> spend on the author's own laptop — then cross-checked against public
> Anthropic documentation.

This catalog is **descriptive, not prescriptive**. If `doctor` flags a
pathology but your team genuinely wants to behave that way, turn it off.
The goal is to make the pattern *visible*, not to enforce a style.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to
propose a new pathology.

---

## Table of contents

### Cost
- [`MODEL_MONOCULTURE`](#model_monoculture) — one model dominates > 95% of spend
- [`HAIKU_NEGLECT`](#haiku_neglect) — Haiku used in < 5% of sessions
- [`RUNAWAY_SESSION`](#runaway_session) — a single session consumed > 25% of weekly spend
- [`CACHE_TTL_MISMATCH`](#cache_ttl_mismatch) — short session, heavy 1h cache writes

### Loops
- [`BASH_STORM`](#bash_storm) — > 500 Bash calls in one session
- [`SUBAGENT_SPRAWL`](#subagent_sprawl) — > 8 distinct subagents per session

### Tools
- [`EDIT_THRASH`](#edit_thrash) — same file edited > 10 times in one session
- [`NO_TOOL_BURN`](#no_tool_burn) — > 40% of spend in turns with no tool_use

---

## `MODEL_MONOCULTURE`

**Category:** cost · **Severity:** high · **Prevalence:** observed in 1 of 1 audited heavy-use accounts (author's own).

### Summary
One model, typically Opus, handles every task — cheaper models remain entirely unused.

### Mechanism
Claude Code lets you configure per-subagent models. If you never do, every subagent inherits the session default. For a heavy Opus user that means grep-and-summarize work, mechanical edits, and format conversions all bill at Opus rates — 10-20× more than Haiku 4.5 would cost for near-identical output.

### Detection
```
totalCost(bundle) > $10
AND  max(costByModel) / totalCost > 95%
```

### Case study (author's own data, 2026-04-17 → 2026-04-24)
- Shadow cost: **$13,029**
- Opus share: **99.6%** ($12,977 of $13,031)
- Sonnet share: 0.4% ($51)
- Haiku share: 0.01% ($1.29)

Several subagents — `Swift Developer`, `Market Researcher`, `Explore`, `claude-code-guide` — have output profiles that fit Haiku (sub-10K output tokens, Read/Grep-heavy, no long-form reasoning). Routing those would reclaim ~30% of weekly spend at almost no quality risk.

### Prescription
```yaml
# ~/.claude/agents/swift-developer.md (frontmatter)
name: Swift Developer
model: claude-haiku-4-5
description: "Structural Swift edits and ReadOnly review"
```

### Related
- [`HAIKU_NEGLECT`](#haiku_neglect) (correlated; one often implies the other)

---

## `HAIKU_NEGLECT`

**Category:** cost · **Severity:** medium

### Summary
Haiku runs in under 5% of sessions, meaning no "fast lane" exists for mechanical work.

### Mechanism
Haiku 4.5 is not a downgrade; it's a different engine, well-suited to deterministic, short-context tasks. If nothing in your agent fleet is pointed at it, every short task waits in the Opus queue and costs Opus money.

### Detection
```
sessions_with_haiku / total_sessions < 5%
```

### Case study
The author's own fleet used Haiku in 5 of 176 model-invocations (3%). Those 5 sessions cost $1.29 total — strong evidence that when Haiku is used, it works.

### Prescription
Add a single Haiku-backed subagent with a clear trigger:
```yaml
name: Fast Editor
model: claude-haiku-4-5
description: "ReadOnly scans + single-purpose mechanical edits"
```
Then let the orchestrator route to it whenever the task fits.

---

## `RUNAWAY_SESSION`

**Category:** cost · **Severity:** high

### Summary
One session consumed more than a quarter of the entire week's spend.

### Mechanism
Usage in healthy agent fleets is power-law distributed: several medium sessions plus a long tail of small ones. A single session cracking 25% of weekly spend usually means one of three things: (a) a tight loop that the agent refused to exit, (b) an over-ambitious one-shot task that should have been decomposed, or (c) a long-running interactive session the user never wrapped.

### Detection
```
per-session cost / weekly total > 25%  (on a dataset of ≥ 3 sessions, ≥ $10 total)
```

### Case study
Session `63063a38` on the author's machine consumed **$8,540 across 10,348 assistant turns** — 43% of that week. `agent-ledger explain 63063a38` surfaced 2,965 Bash calls and three $26 turns back-to-back, each writing 880K cache tokens.

### Prescription
```yaml
# Apply at subagent-config level
max_turns: 80
max_cost_usd: 50
```
And use `agent-ledger explain <session-id>` to identify the stopping-point the agent missed.

### Related
- [`BASH_STORM`](#bash_storm) (frequent co-morbidity)
- [`SUBAGENT_SPRAWL`](#subagent_sprawl) (when the session is long because of orchestration overhead)

---

## `CACHE_TTL_MISMATCH`

**Category:** cost · **Severity:** medium

### Summary
A session that finished in few turns nevertheless wrote millions of tokens into the 1-hour cache tier.

### Mechanism
Anthropic prices the 1-hour cache at **2× base input**; the 5-minute cache at **1.25×**. If a session doesn't actually reuse prompts over the 1-hour window, every 1h write is a 60% overpayment against the 5m equivalent. This is a pure pricing mistake — same functional outcome, different receipt.

### Detection
```
session.turns < 60
AND  session.cache1h_write_tokens > 2M
```

### Prescription
When invoking the SDK directly:
```python
cache_control = {"type": "ephemeral", "ttl": "5m"}
```
Reserve `1h` for long-lived interactive sessions (IDE agents, live pair work).

---

## `BASH_STORM`

**Category:** loops · **Severity:** high

### Summary
More than 500 Bash invocations in a single session — almost always a loop.

### Mechanism
Hundreds of Bash calls in one session typically mean one of: repeated grep searches, directory listing loops, re-running tests without caching results, or reinventing a higher-level tool as a shell one-liner. Each Bash call is cheap in isolation; compounded 500-3000 times they dominate a session's tool-use budget.

### Detection
```
session.toolCount["Bash"] > 500
```

### Case study
Session `63063a38` on the author's machine issued **2,965 Bash calls** in a single session. A disproportionate number were `grep` variants — a purpose-built Grep tool with a higher result cap would have replaced dozens of those with one call.

### Prescription
Inspect the transcript:
```bash
agent-ledger explain <session-id>
```
If the agent is looping on grep-like commands, add a first-class Grep tool (rather than relying on `Bash("grep ...")`). If it's re-running tests, cache test artifacts between attempts.

---

## `SUBAGENT_SPRAWL`

**Category:** loops · **Severity:** medium

### Summary
One session invoked more than 8 distinct subagent types — coordination overhead likely exceeds delegated value.

### Mechanism
Each subagent spawn costs: context setup (the new system prompt), tool-list setup, and a new reasoning budget for the child. Past a handful of distinct subagents per task, the orchestrator spends more tokens routing than the children spend doing real work.

### Detection
```
session.distinctSubagents > 8
```

### Prescription
Consolidate overlapping subagents. Rule of thumb: if two subagents share ≥ 70% of their tool list, merge them into one with mode flags:
```yaml
name: Swift Engineer
description: "Swift development — use mode=read for review, mode=edit for changes"
```

---

## `EDIT_THRASH`

**Category:** tools · **Severity:** medium

### Summary
The same file was edited more than 10 times in one session — a strong signal of corrective looping.

### Mechanism
Agents rarely edit the same file 10+ times when they have a clear mental model of the change. Repeated edits usually mean: fighting with test feedback, reverting and re-patching, or chasing a bug through secondary effects. Each corrective edit costs tokens for minimal forward progress.

### Detection
```
session.editedFiles[path] > 10  for any path
```

### Prescription
Pin the test before the edit cycle begins. Read the full file once and plan the entire change before the first Edit. If the agent is cycling on a red test, consider running the test once, posting the full failure, then making a single consolidated edit.

---

## `NO_TOOL_BURN`

**Category:** tools · **Severity:** low

### Summary
Over 40% of weekly spend was in turns where the agent used no tools — pure reasoning and narration.

### Mechanism
Some no-tool spend is healthy: initial planning, context setup, decision summaries. But when it crosses ~40%, the agent is narrating at length between actions — restating the problem, walking through hypotheses, listing alternatives. These turns produce words, not outcomes.

### Detection
```
sum(session.noToolCost) / totalCost > 40%
```

### Prescription
Tighten the system prompt:
```
Prefer tool calls over narration. Reserve prose for required user decisions.
```
For tasks that allow it, lower verbosity with `effort: low`.

### Related
- This pathology is the hardest to act on — sometimes long reasoning is exactly what you want. Treat the threshold as a prompt to review, not a verdict.

---

## Proposing a new pathology

A good pathology has four properties:

1. **A detection signature.** A short, deterministic rule on session stats.
2. **A mechanism.** Why does this happen? Understanding root cause beats naming symptoms.
3. **A case study.** At least one real session where the signature fires.
4. **A prescription.** Something a reader can copy and apply in < 5 minutes.

If you have a candidate, open an issue with those four sections. We add a new
pathology to the catalog when it's been validated on ≥ 3 independent
datasets (anyone can contribute datasets — anonymized session summaries are
fine).

The goal is for this catalog to grow the way a11y violations or linter rules
grow: slowly, with evidence, and with real names that the community starts
using in bug reports.
