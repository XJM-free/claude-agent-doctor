// Output rendering. UX constraints (from the pre-launch review):
//   - left-bar "│" style, not rounded Unicode boxes
//   - severity via ANSI color, but respect --no-color / NO_COLOR / non-TTY
//   - English only (no Chinese AKA aliases)
//   - no medical emoji
//   - "Fix:" must be copy-pasteable

import type { DiagnosisHit, Evidence, Pathology } from "../types.js";
import { PATHOLOGIES } from "../diagnoses.js";
import { fmtUSD } from "./pricing.js";

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

function severityTag(sev: "high" | "med" | "low"): string {
  if (sev === "high") return red("high");
  if (sev === "med") return yellow("med");
  return dim("low");
}

function categoryTag(cat: string): string {
  return dim(cat);
}

export function renderHit(p: Pathology, h: DiagnosisHit): string {
  const out: string[] = [];
  const head = `${bold(p.code)}  [${categoryTag(p.category)} · ${severityTag(p.severity)}]`;
  out.push("│ " + head);
  if (h.sessionId) out.push("│ " + dim(`session ${h.sessionId}  ${h.project ?? ""}`));
  out.push("│");
  out.push("│ " + p.summary);
  out.push("│");
  out.push("│ " + bold("Detected:"));
  for (const e of h.evidence) out.push("│   " + fmtEvidence(e));
  if (h.estimatedSavingsUSD !== undefined && h.estimatedSavingsUSD > 0) {
    out.push("│   " + green("Potential savings: ~" + fmtUSD(h.estimatedSavingsUSD) + "/week"));
  }
  out.push("│");
  out.push("│ " + bold("Fix:"));
  for (const line of h.prescription.split("\n")) out.push("│   " + line);
  out.push("│");
  out.push("│ " + dim(`doctor explain ${p.code}  # mechanism & full case study`));
  return out.join("\n");
}

function fmtEvidence(e: Evidence): string {
  const base = `${e.metric}: ${bold(e.value)}`;
  return e.threshold ? base + dim(`  (threshold: ${e.threshold})`) : base;
}

export function renderSummary(hits: DiagnosisHit[], totalCost: number, sessionsCount: number): string {
  const savings = hits.reduce((a, h) => a + (h.estimatedSavingsUSD ?? 0), 0);
  const high = hits.filter((h) => {
    const p = PATHOLOGIES.find((x) => x.code === h.code);
    return p?.severity === "high";
  }).length;
  const med = hits.filter((h) => {
    const p = PATHOLOGIES.find((x) => x.code === h.code);
    return p?.severity === "med";
  }).length;
  const low = hits.length - high - med;

  const lines: string[] = [];
  lines.push("");
  lines.push(bold("Doctor report") + dim(`  ·  ${sessionsCount} sessions  ·  ${fmtUSD(totalCost)} total shadow spend`));
  lines.push("");
  if (hits.length === 0) {
    lines.push(green("  ✓ no pathologies detected"));
    lines.push("");
    return lines.join("\n");
  }
  const sevLine = `  ${red(high + " high")} · ${yellow(med + " med")} · ${dim(low + " low")}`;
  lines.push(sevLine);
  if (savings > 0) lines.push("  " + green(`potential weekly savings: ${fmtUSD(savings)}`));
  lines.push("");
  return lines.join("\n");
}

export function renderCatalog(): string {
  const lines: string[] = [];
  const byCat: Record<string, Pathology[]> = {};
  for (const p of PATHOLOGIES) (byCat[p.category] ??= []).push(p);

  lines.push("");
  lines.push(bold("Pathology catalog") + dim(`  (${PATHOLOGIES.length} total)  ·  run \`doctor check\` to scan your own logs`));
  lines.push("");
  const order = ["cost", "loops", "tools"];
  for (const cat of order) {
    const list = byCat[cat];
    if (!list || list.length === 0) continue;
    lines.push(bold(cat.toUpperCase()) + dim(`  (${list.length})`));
    for (const p of list) {
      lines.push(`  ${p.code.padEnd(22)} ${severityTag(p.severity)}  ${dim(p.summary)}`);
    }
    lines.push("");
  }
  lines.push(dim("  doctor explain <CODE>  for mechanism and case study"));
  lines.push("");
  return lines.join("\n");
}

export function renderExplain(p: Pathology): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(bold(p.code) + `  [${categoryTag(p.category)} · ${severityTag(p.severity)}]`);
  lines.push("");
  lines.push(cyan("Summary"));
  lines.push("  " + p.summary);
  lines.push("");
  lines.push(cyan("Mechanism"));
  for (const line of wrap(p.mechanism, 76)) lines.push("  " + line);
  lines.push("");
  lines.push(dim("  Full case study: https://github.com/XJM-free/claude-agent-doctor/blob/main/PATHOLOGY.md#" + p.code.toLowerCase().replace(/_/g, "-")));
  lines.push("");
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// JSON/markdown output -----------------------------------------------------

export function renderJSON(hits: DiagnosisHit[], totalCost: number): string {
  return JSON.stringify({ totalCost, hits }, null, 2);
}

export function renderMarkdown(hits: DiagnosisHit[], totalCost: number, sessionsCount: number): string {
  const lines: string[] = [];
  lines.push(`# Doctor report`);
  lines.push("");
  lines.push(`- sessions analyzed: **${sessionsCount}**`);
  lines.push(`- total shadow spend: **${fmtUSD(totalCost)}**`);
  lines.push(`- findings: **${hits.length}**`);
  const savings = hits.reduce((a, h) => a + (h.estimatedSavingsUSD ?? 0), 0);
  if (savings > 0) lines.push(`- potential weekly savings: **${fmtUSD(savings)}**`);
  lines.push("");
  for (const h of hits) {
    const p = PATHOLOGIES.find((x) => x.code === h.code);
    if (!p) continue;
    lines.push(`## ${p.code} — ${p.severity}`);
    if (h.sessionId) lines.push(`session \`${h.sessionId}\`${h.project ? " · " + h.project : ""}`);
    lines.push("");
    lines.push(p.summary);
    lines.push("");
    lines.push(`**Detected**`);
    for (const e of h.evidence) {
      lines.push(`- ${e.metric}: **${e.value}**${e.threshold ? ` (threshold: ${e.threshold})` : ""}`);
    }
    if (h.estimatedSavingsUSD && h.estimatedSavingsUSD > 0) {
      lines.push(`- _Potential savings: ~${fmtUSD(h.estimatedSavingsUSD)}/week_`);
    }
    lines.push("");
    lines.push(`**Fix**`);
    lines.push("```");
    lines.push(h.prescription);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}
