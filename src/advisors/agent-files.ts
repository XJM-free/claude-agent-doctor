// Scans all locations where Claude Code recognizes a subagent definition and
// parses their YAML-ish frontmatter. Deliberately avoids a YAML dependency —
// we only need three keys.
//
// Search order (higher = wins on duplicate `name`):
//   1. <cwd>/.claude/agents/*.md              (project-local)
//   2. <cwd>/.claude/agents/<group>/*.md
//   3. ~/.claude/agents/*.md                  (user-global)
//   4. ~/.claude/agents/<group>/*.md          (user-global, grouped)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentFile {
  /** Full absolute path on disk. */
  path: string;
  /** Scope: "user" (from ~/.claude) or "project" (from cwd/.claude). */
  scope: "user" | "project";
  /** Optional group name if the file lives in ~/.claude/agents/<group>/. */
  group?: string;
  /** The `name:` frontmatter value, falling back to filename stem. */
  name: string;
  description: string;
  /** Current model. Empty string if not set. */
  model: string;
  /** Raw frontmatter text (used for diff generation). */
  frontmatterRaw: string;
  /** Body after the frontmatter. */
  body: string;
}

export function findAllAgentFiles(cwd: string = process.cwd()): AgentFile[] {
  const results: AgentFile[] = [];
  const roots: Array<{ dir: string; scope: "user" | "project" }> = [
    { dir: join(cwd, ".claude", "agents"), scope: "project" },
    { dir: join(homedir(), ".claude", "agents"), scope: "user" },
  ];

  for (const { dir, scope } of roots) {
    if (!existsSync(dir)) continue;
    walkAgentsDir(dir, scope, undefined, results);
  }
  return results;
}

function walkAgentsDir(
  dir: string,
  scope: "user" | "project",
  group: string | undefined,
  out: AgentFile[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      // One level of nesting: treat as a group (the ios-factory pattern).
      if (group !== undefined) continue;
      walkAgentsDir(full, scope, name, out);
      continue;
    }

    if (!name.endsWith(".md")) continue;
    if (name.toLowerCase() === "readme.md") continue;

    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed) continue;

    out.push({
      path: full,
      scope,
      group,
      name: parsed.fields.name ?? name.replace(/\.md$/, ""),
      description: parsed.fields.description ?? "",
      model: parsed.fields.model ?? "",
      frontmatterRaw: parsed.raw,
      body: parsed.body,
    });
  }
}

/** Very narrow frontmatter parser: only handles simple `key: value` lines.
 * Multi-line strings (folded scalars, quoted blocks) are captured as their
 * raw unparsed contents — that's fine, we only need three well-behaved keys. */
function parseFrontmatter(text: string): { fields: Record<string, string>; raw: string; body: string } | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const raw = lines.slice(0, end + 1).join("\n");
  const body = lines.slice(end + 1).join("\n");
  const fields: Record<string, string> = {};

  // Track whether we're inside a quoted multi-line value and ignore those lines.
  let inQuoted = false;
  let quoteChar = "";
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (inQuoted) {
      if (line.includes(quoteChar)) inQuoted = false;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const trimmed = rest!.trim();
    if ((trimmed.startsWith('"') && !trimmed.slice(1).includes('"')) ||
        (trimmed.startsWith("'") && !trimmed.slice(1).includes("'"))) {
      inQuoted = true;
      quoteChar = trimmed[0]!;
      fields[key!] = trimmed;
      continue;
    }
    fields[key!] = trimmed.replace(/^["']|["']$/g, "");
  }
  return { fields, raw, body };
}

/** Normalizes a model value that may be `sonnet` / `claude-sonnet-4-6` / etc. */
export function normalizeModelAlias(m: string): string {
  const s = m.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("opus")) return "opus";
  return s;
}
