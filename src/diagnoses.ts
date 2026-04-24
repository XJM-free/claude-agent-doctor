// 8 pathologies shipped with v0.1. Each is a pure function over SessionStatsBundle.
//
// These thresholds are calibrated from the author's own 219-session corpus
// (documented in PATHOLOGY.md). Users can override via CLI flags later.

import type { DiagnosisHit, Pathology, SessionStat, SessionStatsBundle } from "./types.js";
import { fmtUSD, priceFor } from "./lib/pricing.js";

// Shared helpers ---------------------------------------------------------

function sumModelCost(s: SessionStat): number {
  let total = 0;
  for (const v of Object.values(s.modelCost)) total += v;
  return total;
}

function sumInputTokens(s: SessionStat): number {
  return s.inputTokens + s.cache1hWriteTokens + s.cache5mWriteTokens + s.cacheReadTokens;
}

function dominantModel(s: SessionStat): [string, number] {
  let best = ["", 0] as [string, number];
  for (const [m, c] of Object.entries(s.modelCost)) {
    if (c > best[1]) best = [m, c];
  }
  return best;
}

function durationMinutes(s: SessionStat): number {
  // Wall-clock span. Note: Claude Code sessions can be resumed across days,
  // so this is not "active time". For the cache-TTL check we also guard on
  // turn count.
  return (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000;
}

// 1. MODEL_MONOCULTURE ---------------------------------------------------

const MODEL_MONOCULTURE: Pathology = {
  code: "MODEL_MONOCULTURE",
  category: "cost",
  severity: "high",
  summary: "One model dominates > 95% of spend; cheaper models entirely unused.",
  mechanism:
    "When a single model handles every task regardless of complexity, you pay Opus rates for ReadOnly " +
    "grep-and-summarize work that Haiku 4.5 would finish at 1/10 the cost with near-identical output. " +
    "This is typically a subagent-config bug, not a deliberate choice.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    const totals: Record<string, number> = {};
    for (const s of bundle.sessions) {
      for (const [m, c] of Object.entries(s.modelCost)) totals[m] = (totals[m] ?? 0) + c;
    }
    if (bundle.totalCost < 10) return hits;
    let top = ["", 0] as [string, number];
    for (const [m, c] of Object.entries(totals)) if (c > top[1]) top = [m, c];
    const share = top[1] / bundle.totalCost;
    if (share < 0.95) return hits;
    const potentialSavings = bundle.totalCost * 0.3;
    hits.push({
      code: "MODEL_MONOCULTURE",
      evidence: [
        { metric: `${top[0]} share`, value: `${(share * 100).toFixed(1)}%`, threshold: "95%" },
        { metric: "total weekly cost", value: fmtUSD(bundle.totalCost) },
      ],
      prescription:
        `Route ReadOnly / grep-heavy subagents to Haiku 4.5:\n` +
        `  # in your subagent config\n  model: claude-haiku-4-5\n` +
        `  # when: task is primarily Read/Grep and output < 5K tokens`,
      estimatedSavingsUSD: potentialSavings,
    });
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 2. HAIKU_NEGLECT -------------------------------------------------------

const HAIKU_NEGLECT: Pathology = {
  code: "HAIKU_NEGLECT",
  category: "cost",
  severity: "med",
  summary: "Haiku usage < 5% of sessions; low-complexity work is billed at Opus rates.",
  mechanism:
    "Haiku 4.5 handles at least three task classes adequately: structural edits, format " +
    "conversion, and deterministic rule checks. Never invoking it means every such task pays the " +
    "Opus premium. The fix is almost always a subagent-level model override.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    const perModelSessions: Record<string, number> = {};
    for (const s of bundle.sessions) {
      for (const m of Object.keys(s.modelCost)) perModelSessions[m] = (perModelSessions[m] ?? 0) + 1;
    }
    const haiku = Object.entries(perModelSessions).filter(([m]) => m.includes("haiku")).reduce((a, [, c]) => a + c, 0);
    const total = bundle.sessions.length || 1;
    const share = haiku / total;
    if (share >= 0.05) return hits;
    hits.push({
      code: "HAIKU_NEGLECT",
      evidence: [
        { metric: "Haiku session share", value: `${(share * 100).toFixed(1)}%`, threshold: "≥ 5%" },
        { metric: "sessions analyzed", value: `${total}` },
      ],
      prescription:
        `Add a fast-lane subagent pointed at Haiku for predictable work:\n` +
        `  name: Fast Editor\n  model: claude-haiku-4-5\n  description: "ReadOnly + small mechanical edits"`,
    });
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 3. RUNAWAY_SESSION -----------------------------------------------------

const RUNAWAY_SESSION: Pathology = {
  code: "RUNAWAY_SESSION",
  category: "cost",
  severity: "high",
  summary: "A single session consumed > 25% of weekly spend.",
  mechanism:
    "Healthy usage spreads cost across many short-to-medium sessions. One whale session usually " +
    "indicates a runaway loop, an over-ambitious one-shot task, or an agent refusing to stop. " +
    "Catch it here and consider `--max-turns` guardrails next time.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    if (bundle.totalCost < 10 || bundle.sessions.length < 3) return hits;
    for (const s of bundle.sessions) {
      const cost = sumModelCost(s);
      const share = cost / bundle.totalCost;
      if (share < 0.25) continue;
      hits.push({
        code: "RUNAWAY_SESSION",
        sessionId: s.id,
        project: s.project,
        evidence: [
          { metric: "session cost", value: fmtUSD(cost) },
          { metric: "share of weekly total", value: `${(share * 100).toFixed(1)}%`, threshold: "25%" },
          { metric: "turns", value: `${s.turns}` },
          { metric: "duration", value: `${durationMinutes(s).toFixed(0)} min` },
        ],
        prescription:
          `Inspect the transcript:\n  agent-ledger explain ${s.id}\n` +
          `Add a guardrail to your agent config:\n  max_turns: 80\n  max_cost_usd: 50`,
      });
    }
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 4. CACHE_TTL_MISMATCH --------------------------------------------------

const CACHE_TTL_MISMATCH: Pathology = {
  code: "CACHE_TTL_MISMATCH",
  category: "cost",
  severity: "med",
  summary: "Short session writing heavily to 1h cache — paying 2x input rate for nothing.",
  mechanism:
    "Anthropic's 1h cache costs 2x base input; the 5m cache costs 1.25x. If a session finishes in " +
    "< 20 minutes yet writes millions of tokens to the 1h bucket, you overpaid. The correct setting " +
    "depends on the longest reuse interval you actually need, not the longest supported.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    for (const s of bundle.sessions) {
      if (s.cache1hWriteTokens < 2_000_000) continue;
      // A short session here is one with few turns — wall-clock duration is
      // unreliable because Claude Code sessions can span days across resumes.
      if (s.turns >= 60) continue;
      const [model] = dominantModel(s);
      const price = priceFor(model);
      const overpay = (s.cache1hWriteTokens / 1_000_000) * (price.cache1hWrite - price.cache5mWrite);
      hits.push({
        code: "CACHE_TTL_MISMATCH",
        sessionId: s.id,
        project: s.project,
        evidence: [
          { metric: "1h cache writes", value: `${(s.cache1hWriteTokens / 1_000_000).toFixed(1)}M tok` },
          { metric: "turns", value: `${s.turns}`, threshold: "≥ 60 justifies 1h" },
          { metric: "overpayment vs 5m", value: fmtUSD(overpay) },
        ],
        prescription:
          `Drop 1h cache on short sessions. If using the SDK:\n` +
          `  cache_control: { type: "ephemeral", ttl: "5m" }\n` +
          `Reserve "1h" for long-running agents (IDE + sustained interactive work).`,
        estimatedSavingsUSD: overpay,
      });
    }
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 5. BASH_STORM ----------------------------------------------------------

const BASH_STORM: Pathology = {
  code: "BASH_STORM",
  category: "loops",
  severity: "high",
  summary: "Bash called > 500 times in one session — usually a loop or a missing higher-level tool.",
  mechanism:
    "Hundreds of Bash calls in one session almost always mean a loop: searching repeatedly, listing " +
    "the same directory, re-running tests, or emulating a higher-level tool with shell one-liners. " +
    "Consider adding a purpose-built subagent tool or raising `max_turns`.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    for (const s of bundle.sessions) {
      const bash = s.toolCount["Bash"] ?? 0;
      if (bash < 500) continue;
      const cost = sumModelCost(s);
      hits.push({
        code: "BASH_STORM",
        sessionId: s.id,
        project: s.project,
        evidence: [
          { metric: "Bash invocations", value: `${bash}`, threshold: "< 500" },
          { metric: "session cost", value: fmtUSD(cost) },
          { metric: "turns", value: `${s.turns}` },
        ],
        prescription:
          `Inspect for a repeating command pattern:\n  agent-ledger explain ${s.id}\n` +
          `If the agent is grep-looping, add a purpose-built Grep/Search tool with ` +
          `higher result cap, or raise max_turns so it can batch its work.`,
      });
    }
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 6. SUBAGENT_SPRAWL -----------------------------------------------------

const SUBAGENT_SPRAWL: Pathology = {
  code: "SUBAGENT_SPRAWL",
  category: "loops",
  severity: "med",
  summary: "One session invoked > 8 distinct subagents — coordination overhead likely exceeds value.",
  mechanism:
    "Each subagent spawn carries context setup, tool-list inflation, and a new reasoning budget. " +
    "Beyond a handful of distinct subagents per task, the orchestrator spends more tokens routing " +
    "than the children spend doing work.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    for (const s of bundle.sessions) {
      if (s.subagentCount < 8) continue;
      hits.push({
        code: "SUBAGENT_SPRAWL",
        sessionId: s.id,
        project: s.project,
        evidence: [
          { metric: "distinct subagents", value: `${s.subagentCount}`, threshold: "≤ 8" },
          { metric: "session cost", value: fmtUSD(sumModelCost(s)) },
        ],
        prescription:
          `Consolidate subagents with overlapping roles. A good rule of thumb: if two subagents ` +
          `share ≥ 70% of their tool-list, they should be one subagent with mode flags.`,
      });
    }
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 7. EDIT_THRASH ---------------------------------------------------------

const EDIT_THRASH: Pathology = {
  code: "EDIT_THRASH",
  category: "tools",
  severity: "med",
  summary: "Same file edited > 10 times in one session — strong signal of corrective looping.",
  mechanism:
    "Repeated edits to the same file usually mean the agent is fighting with test/build feedback, " +
    "making a change, seeing it fail, reverting or patching again. Either the test is flaky or the " +
    "agent lacks a complete mental model. Both cost real tokens to no useful effect.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    for (const s of bundle.sessions) {
      // Emit at most one hit per session, focused on the worst offender.
      let worst: [string, number] = ["", 0];
      let thrashFiles = 0;
      for (const [path, n] of Object.entries(s.editedFiles)) {
        if (n >= 10) thrashFiles++;
        if (n > worst[1]) worst = [path, n];
      }
      if (worst[1] < 10) continue;
      hits.push({
        code: "EDIT_THRASH",
        sessionId: s.id,
        project: s.project,
        evidence: [
          { metric: "worst file", value: shortPath(worst[0]) },
          { metric: "edit count", value: `${worst[1]}`, threshold: "≤ 10" },
          ...(thrashFiles > 1 ? [{ metric: "thrashed files", value: `${thrashFiles}` }] : []),
          { metric: "session cost", value: fmtUSD(sumModelCost(s)) },
        ],
        prescription:
          `Read the file once before the first edit and map out the whole change, then apply in ` +
          `one pass. If the loop was test-driven, consider pinning the test before the edit cycle.`,
      });
    }
    return hits;
  },
  prescribe: (h) => h.prescription,
};

// 8. NO_TOOL_BURN --------------------------------------------------------

const NO_TOOL_BURN: Pathology = {
  code: "NO_TOOL_BURN",
  category: "tools",
  severity: "low",
  summary: "More than 40% of spend is in turns with no tool_use — pure reasoning tax.",
  mechanism:
    "High no-tool spend usually means long explanations, pre-flight planning, or an agent monologuing " +
    "between actions. A small share is healthy (context-setting); a large share means you're paying " +
    "for thought the model could compress.",
  detect(bundle) {
    const hits: DiagnosisHit[] = [];
    let noTool = 0;
    for (const s of bundle.sessions) noTool += s.noToolCost;
    const share = noTool / (bundle.totalCost || 1);
    if (share < 0.4) return hits;
    hits.push({
      code: "NO_TOOL_BURN",
      evidence: [
        { metric: "no-tool share of spend", value: `${(share * 100).toFixed(1)}%`, threshold: "≤ 40%" },
        { metric: "no-tool dollars", value: fmtUSD(noTool) },
      ],
      prescription:
        `Tighten system prompts to demand action-first responses. Add to your CLAUDE.md:\n` +
        `  "Prefer tool calls over narration. Reserve prose for required user decisions."\n` +
        `Lower output verbosity via \`effort: low\` when the task allows.`,
      estimatedSavingsUSD: noTool * 0.3,
    });
    return hits;
  },
  prescribe: (h) => h.prescription,
};

function shortPath(p: string): string {
  return p.length > 50 ? "…" + p.slice(-47) : p;
}

// Registry ---------------------------------------------------------------

export const PATHOLOGIES: Pathology[] = [
  MODEL_MONOCULTURE,
  HAIKU_NEGLECT,
  RUNAWAY_SESSION,
  CACHE_TTL_MISMATCH,
  BASH_STORM,
  SUBAGENT_SPRAWL,
  EDIT_THRASH,
  NO_TOOL_BURN,
];

export function findByCode(code: string): Pathology | undefined {
  return PATHOLOGIES.find((p) => p.code === code.toUpperCase());
}

export function detectAll(bundle: SessionStatsBundle, category?: string): DiagnosisHit[] {
  const hits: DiagnosisHit[] = [];
  for (const p of PATHOLOGIES) {
    if (category && p.category !== category) continue;
    hits.push(...p.detect(bundle));
  }
  return hits;
}
