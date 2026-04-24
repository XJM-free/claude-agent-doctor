// Reads Claude Code's per-session JSONL files and produces SessionStat[].
//
// Layout on disk (as of 2026-04):
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Each line is one turn. Assistant turns include a `message` object with
// `model`, `usage` (token counts), and `content` (tool_use / text blocks).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionStat, SessionStatsBundle } from "../types.js";
import { priceFor } from "../lib/pricing.js";

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: {
    file_path?: string;
    subagent_type?: string;
  };
}

interface Turn {
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: Usage;
    content?: ToolUseBlock[];
  };
}

export interface ReadOptions {
  sinceMs?: number;     // only include sessions whose mtime is newer
  projectFilter?: RegExp;
}

export function readBundle(opts: ReadOptions = {}): SessionStatsBundle {
  const projects = safeReadDir(PROJECTS_ROOT);
  const sessions: SessionStat[] = [];

  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  let total = 0;

  for (const proj of projects) {
    if (opts.projectFilter && !opts.projectFilter.test(proj)) continue;
    const projDir = join(PROJECTS_ROOT, proj);
    const files = safeReadDir(projDir).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const full = join(projDir, file);
      let mtime: number;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (opts.sinceMs && mtime < opts.sinceMs) continue;

      const stat = parseSession(full, file, proj);
      if (!stat || stat.turns === 0) continue;
      sessions.push(stat);
      total += sumModelCost(stat);
      minStart = Math.min(minStart, stat.startedAt.getTime());
      maxEnd = Math.max(maxEnd, stat.endedAt.getTime());
    }
  }

  return {
    from: new Date(isFinite(minStart) ? minStart : Date.now()),
    to: new Date(maxEnd || Date.now()),
    sessions,
    totalCost: total,
  };
}

function sumModelCost(s: SessionStat): number {
  let total = 0;
  for (const v of Object.values(s.modelCost)) total += v;
  return total;
}

function safeReadDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function parseSession(path: string, file: string, project: string): SessionStat | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const fullId = file.replace(/\.jsonl$/, "");
  const id = fullId.slice(0, 8);

  const stat: SessionStat = {
    id,
    fullId,
    project: normalizeProject(project),
    startedAt: new Date(0),
    endedAt: new Date(0),
    turns: 0,
    modelCost: {},
    toolCount: {},
    subagentCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cache1hWriteTokens: 0,
    cache5mWriteTokens: 0,
    cacheReadTokens: 0,
    noToolTurns: 0,
    noToolCost: 0,
    editedFiles: {},
    readFiles: {},
    maxToolRun: 0,
    maxToolRunName: "",
    maxToolCallsPerTurn: 0,
    peakTotalInputTokens: 0,
    totalInputTokensSum: 0,
  };

  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  const seenSubagents = new Set<string>();
  // Track the most recent "primary tool" (first tool_use name in a turn)
  // across turns to spot consecutive runs.
  let lastPrimaryTool = "";
  let currentRun = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let turn: Turn;
    try {
      turn = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = turn.message;
    if (!msg || msg.role !== "assistant") continue;

    stat.turns++;
    if (turn.timestamp) {
      const t = Date.parse(turn.timestamp);
      if (isFinite(t)) {
        firstTs = Math.min(firstTs, t);
        lastTs = Math.max(lastTs, t);
      }
    }

    const u = msg.usage ?? {};
    const inTok = u.input_tokens ?? 0;
    const outTok = u.output_tokens ?? 0;
    const cache5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const cache1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? (cache5m + cache1h);
    const cacheRead = u.cache_read_input_tokens ?? 0;

    stat.inputTokens += inTok;
    stat.outputTokens += outTok;
    stat.cache1hWriteTokens += cache1h;
    stat.cache5mWriteTokens += cache5m;
    stat.cacheReadTokens += cacheRead;

    const model = msg.model ?? "unknown";
    const p = priceFor(model);
    const turnCost =
      (inTok * p.input +
        outTok * p.output +
        cache1h * p.cache1hWrite +
        cache5m * p.cache5mWrite +
        // When 5m/1h split is missing, treat cache_creation_input_tokens as 5m.
        (cacheCreation - cache5m - cache1h) * p.cache5mWrite +
        cacheRead * p.cacheRead) /
      1_000_000;

    stat.modelCost[model] = (stat.modelCost[model] ?? 0) + turnCost;

    const content = msg.content ?? [];
    const toolUses = content.filter((b) => b.type === "tool_use");

    // CONTEXT_BLOAT signal — total input on this turn.
    const totalInputThisTurn = inTok + cache5m + cache1h + cacheRead;
    if (totalInputThisTurn > stat.peakTotalInputTokens) {
      stat.peakTotalInputTokens = totalInputThisTurn;
    }
    stat.totalInputTokensSum += totalInputThisTurn;

    // TOOL_CALL_STORM signal — tool_use count in this single turn.
    if (toolUses.length > stat.maxToolCallsPerTurn) {
      stat.maxToolCallsPerTurn = toolUses.length;
    }

    if (toolUses.length === 0) {
      stat.noToolTurns++;
      stat.noToolCost += turnCost;
    }

    // LOOP_DEATH signal — same "primary tool" across consecutive turns.
    const primaryTool = toolUses[0]?.name ?? "";
    if (primaryTool && primaryTool === lastPrimaryTool) {
      currentRun++;
    } else {
      currentRun = primaryTool ? 1 : 0;
    }
    if (currentRun > stat.maxToolRun) {
      stat.maxToolRun = currentRun;
      stat.maxToolRunName = primaryTool;
    }
    lastPrimaryTool = primaryTool;

    for (const tu of toolUses) {
      const name = tu.name ?? "unknown";
      stat.toolCount[name] = (stat.toolCount[name] ?? 0) + 1;
      if (name === "Edit" || name === "Write") {
        const fp = tu.input?.file_path;
        if (fp) stat.editedFiles[fp] = (stat.editedFiles[fp] ?? 0) + 1;
      }
      if (name === "Read") {
        const fp = tu.input?.file_path;
        if (fp) stat.readFiles[fp] = (stat.readFiles[fp] ?? 0) + 1;
      }
      if (name === "Agent" || name === "Task") {
        const sub = tu.input?.subagent_type;
        if (sub) seenSubagents.add(sub);
      }
    }
  }

  stat.subagentCount = seenSubagents.size;
  stat.startedAt = new Date(isFinite(firstTs) ? firstTs : 0);
  stat.endedAt = new Date(lastTs || 0);
  return stat;
}

function normalizeProject(encoded: string): string {
  // "-Users-xiangjie-clawbot" → "~/clawbot"
  if (!encoded.startsWith("-Users-")) return encoded;
  const rest = encoded.replace(/^-Users-[^-]+-/, "");
  return "~/" + rest.replace(/-/g, "/").replace(/^\//, "");
}

export function sinceDays(n: number): number {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}
