import type { RoutingPlan, RoutingSuggestion } from "../advisors/routing.js";

const COLOR = useColor();

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!(process.stdout && process.stdout.isTTY);
}

function c(code: string, s: string): string {
  return COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string) => c("2", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const green = (s: string) => c("32", s);
const cyan = (s: string) => c("36", s);
const bold = (s: string) => c("1", s);

export function renderPlan(plan: RoutingPlan): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(bold("Routing suggestions") + dim("  (based on your agent definitions + keyword heuristics)"));
  lines.push("");

  const changes = plan.suggestions.filter((s) => s.suggestedTier !== "keep");
  const keeps = plan.suggestions.filter((s) => s.suggestedTier === "keep");

  if (changes.length === 0) {
    lines.push(green("  ✓ no changes suggested — all agent tiers look reasonable."));
  } else {
    lines.push(bold(`  ${changes.length} change${changes.length === 1 ? "" : "s"} suggested:`));
    lines.push("");
    for (const s of changes) lines.push(renderChange(s));
  }
  lines.push("");

  if (keeps.length > 0) {
    lines.push(dim(`  ${keeps.length} agent${keeps.length === 1 ? "" : "s"} left unchanged (low-signal descriptions or already well-tiered).`));
    lines.push("");
  }

  if (plan.envVarAdvice) {
    lines.push(bold("Safer first experiment"));
    for (const line of plan.envVarAdvice.split("\n")) lines.push("  " + line);
    lines.push("");
  }

  if (changes.length > 0) {
    lines.push(dim("Export as a unified diff:  doctor suggest-routing --export-patch > routing.patch"));
    lines.push(dim("Apply it yourself:         patch -p0 < routing.patch"));
    lines.push("");
  }

  return lines.join("\n");
}

function renderChange(s: RoutingSuggestion): string {
  const arrow = arrowFor(s.currentTier, s.suggestedTier);
  const name = bold(s.agent.name.padEnd(24));
  const conf = confidenceTag(s.confidence);
  const scope = dim(`[${s.agent.scope}${s.agent.group ? "/" + s.agent.group : ""}]`);

  const lines: string[] = [];
  lines.push(`  ${name}  ${arrow}  ${conf}  ${scope}`);
  lines.push("    " + dim(s.agent.path));
  lines.push("    " + s.reason);
  if (s.invocations > 0) {
    lines.push("    " + dim(`observed ${s.invocations} invocations in the window`));
  }
  return lines.join("\n");
}

function arrowFor(from: string, to: string): string {
  const fromLbl = from || "(unset)";
  return `${labelColor(from)(fromLbl)} → ${labelColor(to)(to)}`;
}

function labelColor(tier: string): (s: string) => string {
  switch (tier) {
    case "opus":
      return red;
    case "sonnet":
      return yellow;
    case "haiku":
      return green;
    default:
      return dim;
  }
}

function confidenceTag(c: "high" | "med" | "low"): string {
  if (c === "high") return green("high conf");
  if (c === "med") return yellow("med conf");
  return dim("low conf");
}

export function renderJSON(plan: RoutingPlan): string {
  return JSON.stringify(
    {
      suggestions: plan.suggestions.map((s) => ({
        name: s.agent.name,
        path: s.agent.path,
        scope: s.agent.scope,
        group: s.agent.group,
        current: s.currentTier,
        suggested: s.suggestedTier,
        reason: s.reason,
        confidence: s.confidence,
        invocations: s.invocations,
      })),
      envVarAdvice: plan.envVarAdvice,
    },
    null,
    2,
  );
}

// Unused import suppression (cyan is imported for future expansion);
void cyan;
