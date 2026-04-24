// Tests for v0.3 pathologies: LOOP_DEATH, RETRY_THRASH, CONTEXT_BLOAT, TOOL_CALL_STORM.
import { describe, expect, it } from "bun:test";

import { detectAll } from "../src/diagnoses.js";
import type { SessionStat, SessionStatsBundle } from "../src/types.js";

function stat(partial: Partial<SessionStat> = {}): SessionStat {
  return {
    id: "abc12345",
    fullId: "abc12345-0000-0000-0000-000000000000",
    project: "~/demo",
    startedAt: new Date("2026-04-20T09:00:00Z"),
    endedAt: new Date("2026-04-20T09:30:00Z"),
    turns: 10,
    modelCost: { "claude-opus-4-7": 5 },
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
    ...partial,
  };
}

function bundle(sessions: SessionStat[]): SessionStatsBundle {
  const totalCost = sessions.reduce((acc, s) => {
    for (const v of Object.values(s.modelCost)) acc += v;
    return acc;
  }, 0);
  return { from: new Date(), to: new Date(), sessions, totalCost };
}

describe("LOOP_DEATH", () => {
  it("fires at 8 consecutive same-tool turns", () => {
    const s = stat({ maxToolRun: 10, maxToolRunName: "Bash" });
    expect(detectAll(bundle([s])).some((h) => h.code === "LOOP_DEATH")).toBe(true);
  });

  it("does not fire at 7", () => {
    const s = stat({ maxToolRun: 7, maxToolRunName: "Bash" });
    expect(detectAll(bundle([s])).some((h) => h.code === "LOOP_DEATH")).toBe(false);
  });

  it("reports which tool the agent was stuck on", () => {
    const s = stat({ maxToolRun: 15, maxToolRunName: "Edit" });
    const hit = detectAll(bundle([s])).find((h) => h.code === "LOOP_DEATH");
    expect(hit?.evidence.some((e) => e.value === "Edit")).toBe(true);
  });
});

describe("RETRY_THRASH", () => {
  it("fires when one file has 5+ edits AND 5+ reads", () => {
    const s = stat({
      editedFiles: { "a.ts": 8 },
      readFiles: { "a.ts": 6 },
    });
    expect(detectAll(bundle([s])).some((h) => h.code === "RETRY_THRASH")).toBe(true);
  });

  it("does not fire on edit-heavy but read-free files (that's EDIT_THRASH, not this)", () => {
    const s = stat({
      editedFiles: { "a.ts": 20 },
      readFiles: { "a.ts": 1 },
    });
    expect(detectAll(bundle([s])).some((h) => h.code === "RETRY_THRASH")).toBe(false);
  });

  it("does not fire on a single-edit, many-read file", () => {
    const s = stat({
      editedFiles: { "a.ts": 1 },
      readFiles: { "a.ts": 50 },
    });
    expect(detectAll(bundle([s])).some((h) => h.code === "RETRY_THRASH")).toBe(false);
  });

  it("emits at most one hit per session (picks worst file)", () => {
    const s = stat({
      editedFiles: { "a.ts": 5, "b.ts": 10 },
      readFiles: { "a.ts": 5, "b.ts": 20 },
    });
    const hits = detectAll(bundle([s])).filter((h) => h.code === "RETRY_THRASH");
    expect(hits.length).toBe(1);
    expect(hits[0]!.evidence.some((e) => e.value.includes("b.ts"))).toBe(true);
  });
});

describe("CONTEXT_BLOAT", () => {
  it("fires when peak turn input exceeds 150K", () => {
    const s = stat({ peakTotalInputTokens: 180_000, totalInputTokensSum: 900_000, turns: 10 });
    expect(detectAll(bundle([s])).some((h) => h.code === "CONTEXT_BLOAT")).toBe(true);
  });

  it("does not fire below threshold", () => {
    const s = stat({ peakTotalInputTokens: 80_000 });
    expect(detectAll(bundle([s])).some((h) => h.code === "CONTEXT_BLOAT")).toBe(false);
  });
});

describe("TOOL_CALL_STORM", () => {
  it("fires at 12 tool_use blocks in one turn", () => {
    const s = stat({ maxToolCallsPerTurn: 15 });
    expect(detectAll(bundle([s])).some((h) => h.code === "TOOL_CALL_STORM")).toBe(true);
  });

  it("does not fire at 11 (healthy batch size)", () => {
    const s = stat({ maxToolCallsPerTurn: 11 });
    expect(detectAll(bundle([s])).some((h) => h.code === "TOOL_CALL_STORM")).toBe(false);
  });
});
