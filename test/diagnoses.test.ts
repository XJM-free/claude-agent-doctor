import { describe, expect, it } from "bun:test";

import { PATHOLOGIES, detectAll, findByCode } from "../src/diagnoses.js";
import type { SessionStat, SessionStatsBundle } from "../src/types.js";

// Helpers ---------------------------------------------------------------

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

// Registry -------------------------------------------------------------

describe("registry", () => {
  it("ships 8 pathologies in v0.1", () => {
    expect(PATHOLOGIES.length).toBe(8);
  });

  it("codes are upper_snake_case and unique", () => {
    const codes = PATHOLOGIES.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("findByCode is case-insensitive", () => {
    expect(findByCode("opus_overspend")).toBeUndefined(); // renamed to MODEL_MONOCULTURE
    expect(findByCode("model_monoculture")?.code).toBe("MODEL_MONOCULTURE");
    expect(findByCode("MODEL_MONOCULTURE")?.code).toBe("MODEL_MONOCULTURE");
  });

  it("every pathology has non-empty summary and mechanism", () => {
    for (const p of PATHOLOGIES) {
      expect(p.summary.length).toBeGreaterThan(10);
      expect(p.mechanism.length).toBeGreaterThan(40);
    }
  });
});

// Pathology-specific tests ----------------------------------------------

describe("MODEL_MONOCULTURE", () => {
  it("fires when one model dominates > 95% of > $10 spend", () => {
    const s = stat({ modelCost: { "claude-opus-4-7": 100, "claude-haiku-4-5": 1 } });
    const hits = detectAll(bundle([s]));
    expect(hits.some((h) => h.code === "MODEL_MONOCULTURE")).toBe(true);
  });

  it("does not fire on diverse usage", () => {
    const s = stat({ modelCost: { "claude-opus-4-7": 60, "claude-sonnet-4-6": 40 } });
    const hits = detectAll(bundle([s]));
    expect(hits.some((h) => h.code === "MODEL_MONOCULTURE")).toBe(false);
  });

  it("does not fire below cost floor", () => {
    const s = stat({ modelCost: { "claude-opus-4-7": 5 } });
    const hits = detectAll(bundle([s]));
    expect(hits.some((h) => h.code === "MODEL_MONOCULTURE")).toBe(false);
  });
});

describe("RUNAWAY_SESSION", () => {
  it("fires on the whale session only", () => {
    const whale = stat({ id: "whale111", modelCost: { "claude-opus-4-7": 100 } });
    const smalls = Array.from({ length: 5 }, (_, i) =>
      stat({ id: `small${i}`, modelCost: { "claude-opus-4-7": 10 } }),
    );
    const hits = detectAll(bundle([whale, ...smalls]));
    const runaway = hits.filter((h) => h.code === "RUNAWAY_SESSION");
    expect(runaway.length).toBe(1);
    expect(runaway[0]!.sessionId).toBe("whale111");
  });

  it("does not fire when dataset is too small", () => {
    const whale = stat({ id: "whale111", modelCost: { "claude-opus-4-7": 100 } });
    const hits = detectAll(bundle([whale]));
    expect(hits.some((h) => h.code === "RUNAWAY_SESSION")).toBe(false);
  });
});

describe("BASH_STORM", () => {
  it("fires at 500 bash calls", () => {
    const s = stat({ toolCount: { Bash: 600 } });
    expect(detectAll(bundle([s])).some((h) => h.code === "BASH_STORM")).toBe(true);
  });

  it("does not fire at 499", () => {
    const s = stat({ toolCount: { Bash: 499 } });
    expect(detectAll(bundle([s])).some((h) => h.code === "BASH_STORM")).toBe(false);
  });
});

describe("EDIT_THRASH", () => {
  it("emits one hit per session even with many thrashed files", () => {
    const s = stat({
      editedFiles: { "a.ts": 12, "b.ts": 15, "c.ts": 11 },
    });
    const hits = detectAll(bundle([s])).filter((h) => h.code === "EDIT_THRASH");
    expect(hits.length).toBe(1);
    expect(hits[0]!.evidence.some((e) => e.value.includes("b.ts"))).toBe(true);
  });
});

describe("CACHE_TTL_MISMATCH", () => {
  it("fires on short (by turns) sessions with heavy 1h writes", () => {
    const s = stat({ turns: 20, cache1hWriteTokens: 5_000_000 });
    expect(detectAll(bundle([s])).some((h) => h.code === "CACHE_TTL_MISMATCH")).toBe(true);
  });

  it("does not fire on long-running sessions", () => {
    const s = stat({ turns: 200, cache1hWriteTokens: 5_000_000 });
    expect(detectAll(bundle([s])).some((h) => h.code === "CACHE_TTL_MISMATCH")).toBe(false);
  });
});

describe("SUBAGENT_SPRAWL", () => {
  it("fires when > 8 distinct subagents used", () => {
    const s = stat({ subagentCount: 9 });
    expect(detectAll(bundle([s])).some((h) => h.code === "SUBAGENT_SPRAWL")).toBe(true);
  });
});

describe("HAIKU_NEGLECT", () => {
  it("fires when no haiku usage at all", () => {
    const s = stat({ modelCost: { "claude-opus-4-7": 50 } });
    expect(detectAll(bundle([s])).some((h) => h.code === "HAIKU_NEGLECT")).toBe(true);
  });

  it("does not fire when haiku is used regularly", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      stat({
        id: `s${i}`,
        modelCost: i < 2 ? { "claude-haiku-4-5": 1 } : { "claude-opus-4-7": 5 },
      }),
    );
    expect(detectAll(bundle(sessions)).some((h) => h.code === "HAIKU_NEGLECT")).toBe(false);
  });
});

describe("NO_TOOL_BURN", () => {
  it("fires when > 40% of cost is in no-tool turns", () => {
    const s = stat({
      modelCost: { "claude-opus-4-7": 100 },
      noToolCost: 60,
    });
    expect(detectAll(bundle([s])).some((h) => h.code === "NO_TOOL_BURN")).toBe(true);
  });
});

// Category filter -------------------------------------------------------

describe("category filter", () => {
  it("only returns hits from requested category", () => {
    const s = stat({
      modelCost: { "claude-opus-4-7": 100 }, // triggers MONOCULTURE + HAIKU_NEGLECT
      toolCount: { Bash: 1000 },             // triggers BASH_STORM (loops)
    });
    const cost = detectAll(bundle([s]), "cost");
    expect(cost.every((h) => {
      const p = PATHOLOGIES.find((x) => x.code === h.code);
      return p?.category === "cost";
    })).toBe(true);
    const loops = detectAll(bundle([s]), "loops");
    expect(loops.some((h) => h.code === "BASH_STORM")).toBe(true);
    expect(loops.every((h) => PATHOLOGIES.find((x) => x.code === h.code)?.category === "loops")).toBe(true);
  });
});
