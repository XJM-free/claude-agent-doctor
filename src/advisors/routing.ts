// Suggests per-subagent model changes based on (a) the subagent's declared
// description + name, and (b) how it was used in recent sessions.
//
// Philosophy: a suggestion, never an apply. We emit a plan the user reviews
// and, if they want, applies with `--export-patch`. No automatic writes.
//
// Rules are deliberately simple and explainable. Each verdict carries a
// "why" string the user can audit.

import type { AgentFile } from "./agent-files.js";
import { normalizeModelAlias } from "./agent-files.js";
import type { SessionStatsBundle } from "../types.js";

export type ModelTier = "haiku" | "sonnet" | "opus" | "keep";

export interface RoutingSuggestion {
  agent: AgentFile;
  currentTier: string;        // "haiku" | "sonnet" | "opus" | "" (unset)
  suggestedTier: ModelTier;   // "keep" = no change
  reason: string;
  confidence: "high" | "med" | "low";
  invocations: number;        // how many times this subagent was invoked in the window
}

export interface RoutingPlan {
  suggestions: RoutingSuggestion[];
  envVarAdvice?: string;      // e.g. the CLAUDE_CODE_SUBAGENT_MODEL=haiku tip
}

// Keyword banks. Order matters: higher-cost keywords (opus) override
// lower-cost ones when a description matches both.
const OPUS_KEYWORDS = [
  "architect", "architecture", "system design", "research deep",
  "orchestrator", "orchestrate", "strategy", "novel", "creative",
  "复杂", "架构", "战略", "设计",
];

const SONNET_KEYWORDS = [
  "dev", "engineer", "implement", "build", "refactor", "migrate",
  "backend", "frontend", "fullstack", "api", "database", "infra",
  "release", "deploy", "ci/cd",
  "开发", "重构", "迁移", "发布", "工程师",
];

const HAIKU_KEYWORDS = [
  "explore", "search", "grep", "read", "fetch", "trace", "log",
  "docs", "summarize", "triage", "format", "style",
  "扫描", "清单",
];

// Roles where a "cheap" misroute is high-blast-radius. These agents stay at
// their current tier regardless of keyword hits. Conservative by design.
const NEVER_DOWNGRADE_KEYWORDS = [
  // Orchestration — downgrading breaks routing of all children
  "orchestrator", "orchestrate", "factory", "coordinator", "dispatcher",
  "总指挥", "协调", "总控", "调度",
  // Payments / subscriptions — misroutes can cost real money or compliance
  "storekit", "payment", "billing", "subscription", "checkout", "invoice",
  "支付", "订阅", "购买", "付费", "promo", "promotional",
  // Safety / compliance / reality-check — the whole point is strong reasoning
  "reality", "critical", "safety", "security", "compliance", "审查", "合规", "安全",
  "关键", "事故", "incident", "postmortem",
];

export function suggest(bundle: SessionStatsBundle, agents: AgentFile[]): RoutingPlan {
  const invocations = countSubagentInvocations(bundle);
  const suggestions: RoutingSuggestion[] = [];

  for (const a of agents) {
    const count = invocations.get(a.name) ?? 0;
    const current = normalizeModelAlias(a.model);
    const verdict = classify(a);

    let suggestedTier: ModelTier = verdict.tier;
    // If the agent is used heavily but we'd downgrade it, back off a tier
    // when the current model is opus and suggestion is haiku — safer.
    if (current === "opus" && suggestedTier === "haiku" && count > 30) {
      suggestedTier = "sonnet";
    }

    if (suggestedTier === current) suggestedTier = "keep";

    suggestions.push({
      agent: a,
      currentTier: current,
      suggestedTier,
      reason: verdict.reason,
      confidence: verdict.confidence,
      invocations: count,
    });
  }

  // Sort: changes first, grouped by highest-confidence savings.
  suggestions.sort((a, b) => {
    const aChange = a.suggestedTier !== "keep" ? 0 : 1;
    const bChange = b.suggestedTier !== "keep" ? 0 : 1;
    if (aChange !== bChange) return aChange - bChange;
    return (b.invocations ?? 0) - (a.invocations ?? 0);
  });

  // If the user never uses `haiku` anywhere AND has several keep-worthy opus
  // agents, surface the env-var trick as a safe, instantly-reversible win.
  const anyHaikuConfigured = agents.some((a) => normalizeModelAlias(a.model) === "haiku");
  const hasOpusConfigured = agents.some((a) => normalizeModelAlias(a.model) === "opus");
  let envVarAdvice: string | undefined;
  if (!anyHaikuConfigured && hasOpusConfigured) {
    envVarAdvice =
      "No agent currently targets Haiku. For a zero-risk experiment, try:\n" +
      "  export CLAUDE_CODE_SUBAGENT_MODEL=haiku\n" +
      "This forces all subagent invocations to Haiku 4.5 for the current session.\n" +
      "Unset the variable to instantly revert.";
  }

  return { suggestions, envVarAdvice };
}

interface Classification {
  tier: ModelTier;
  reason: string;
  confidence: "high" | "med" | "low";
}

function classify(a: AgentFile): Classification {
  const hay = `${a.name}\n${a.description}\n${a.body.slice(0, 2000)}`.toLowerCase();

  const matches = (kws: string[]) => kws.filter((k) => hay.includes(k.toLowerCase()));
  const guardHits = matches(NEVER_DOWNGRADE_KEYWORDS);
  const haikuHits = matches(HAIKU_KEYWORDS);
  const sonnetHits = matches(SONNET_KEYWORDS);
  const opusHits = matches(OPUS_KEYWORDS);

  // Guard: high-blast-radius roles (orchestrator / payment / safety) never
  // get an auto-suggested downgrade. The user can still move them by hand.
  if (guardHits.length > 0) {
    return {
      tier: "keep",
      reason: `guarded role (${guardHits.slice(0, 2).join(", ")}) — auto-downgrade disabled, change by hand if needed`,
      confidence: "high",
    };
  }

  if (opusHits.length > 0 && opusHits.length >= sonnetHits.length) {
    // We won't auto-suggest upgrading to opus (cost risk > quality benefit
    // without user intent). Emit "keep" with an advisory reason instead.
    return {
      tier: "keep",
      reason: `opus-class signals (${opusHits.slice(0, 2).join(", ")}) — consider opus manually if you see quality gaps`,
      confidence: "low",
    };
  }

  if (sonnetHits.length >= 2 && sonnetHits.length > haikuHits.length) {
    return {
      tier: "sonnet",
      reason: `implementation-style work (${sonnetHits.slice(0, 3).join(", ")}) — sonnet is the natural fit`,
      confidence: sonnetHits.length >= 3 ? "high" : "med",
    };
  }

  if (haikuHits.length >= 2) {
    return {
      tier: "haiku",
      reason: `read-only work signals (${haikuHits.slice(0, 3).join(", ")}) — haiku handles this at 1/10 the cost`,
      confidence: haikuHits.length >= 3 ? "high" : "med",
    };
  }

  return {
    tier: "keep",
    reason: "no clear tier signal in description — leave as-is",
    confidence: "low",
  };
}

function countSubagentInvocations(bundle: SessionStatsBundle): Map<string, number> {
  // The JSONL reader doesn't currently record per-subagent-type counts (only
  // distinct count). This is a best-effort pass over the already-aggregated
  // tool counts: the subagent_type value lives in the tool_use input, which
  // the reader throws away. We return an empty map for now; callers will
  // show suggestions without invocation data, which is still useful.
  //
  // Wiring the raw subagent_type into SessionStat is a v0.3 improvement.
  void bundle;
  return new Map();
}

export function generatePatch(plan: RoutingPlan): string {
  // Produces a unified diff the user can review and `patch -p0 < file.diff`.
  const chunks: string[] = [];
  for (const s of plan.suggestions) {
    if (s.suggestedTier === "keep") continue;
    const before = s.agent.frontmatterRaw;
    const after = rewriteModelField(before, tierToCanonical(s.suggestedTier));
    if (before === after) continue;
    chunks.push(unifiedDiff(s.agent.path, before, after));
  }
  return chunks.join("\n");
}

function tierToCanonical(t: ModelTier): string {
  switch (t) {
    case "haiku":
      return "haiku";
    case "sonnet":
      return "sonnet";
    case "opus":
      return "opus";
    default:
      return "";
  }
}

export function rewriteModelField(frontmatter: string, newValue: string): string {
  const lines = frontmatter.split("\n");
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^model\s*:/.test(lines[i]!)) {
      lines[i] = `model: ${newValue}`;
      modified = true;
      break;
    }
  }
  if (!modified) {
    // Insert before the closing `---`.
    const closingIdx = lines.lastIndexOf("---");
    if (closingIdx > 0) {
      lines.splice(closingIdx, 0, `model: ${newValue}`);
    }
  }
  return lines.join("\n");
}

function unifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const header = `--- ${path}\n+++ ${path}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@`;
  const body: string[] = [];
  for (const l of beforeLines) body.push(`-${l}`);
  for (const l of afterLines) body.push(`+${l}`);
  return `${header}\n${body.join("\n")}`;
}
