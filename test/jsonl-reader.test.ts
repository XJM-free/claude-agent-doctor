import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectAll } from "../src/diagnoses.js";
import { readBundle } from "../src/sensors/jsonl-reader.js";

const SINCE = Date.parse("2026-08-10T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL = "claude-sonnet-4-6";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProjectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-reader-"));
  tempRoots.push(root);
  return root;
}

function assistantTurn(
  timestamp: unknown,
  inputTokens: number,
  content: Array<Record<string, unknown>> = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      role: "assistant",
      model: MODEL,
      usage: { input_tokens: inputTokens },
      content,
      ...overrides,
    },
  };
}

function tool(name: string, input?: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_use", name, ...(input ? { input } : {}) };
}

function writeSession(
  projectsRoot: string,
  id: string,
  turns: Array<Record<string, unknown>>,
  mtimeMs = SINCE + 2 * DAY_MS,
): void {
  const projectDir = join(projectsRoot, "project-demo");
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${id}.jsonl`);
  writeFileSync(path, turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n");
  const mtime = new Date(mtimeMs);
  utimesSync(path, mtime, mtime);
}

describe("readBundle turn windows", () => {
  it("uses an inclusive assistant-turn cutoff inside a resumed session", () => {
    const projectsRoot = makeProjectsRoot();
    writeSession(projectsRoot, "mixed-session", [
      assistantTurn(new Date(SINCE - 1).toISOString(), 1_000_000, [tool("Read")]),
      assistantTurn(new Date(SINCE).toISOString(), 2_000_000, [tool("Edit")]),
      assistantTurn(new Date(SINCE + DAY_MS).toISOString(), 3_000_000, [tool("Bash")]),
    ]);

    const bundle = readBundle({ projectsRoot, sinceMs: SINCE });

    expect(bundle.sessions).toHaveLength(1);
    const session = bundle.sessions[0]!;
    expect(session.turns).toBe(2);
    expect(session.modelCost).toEqual({ [MODEL]: 15 });
    expect(session.toolCount).toEqual({ Edit: 1, Bash: 1 });
    expect(session.startedAt.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(session.endedAt.toISOString()).toBe("2026-08-11T00:00:00.000Z");
    expect(bundle.from.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(bundle.to.toISOString()).toBe("2026-08-11T00:00:00.000Z");
    expect(bundle.totalCost).toBe(15);
  });

  it("drops a recently modified session when every assistant turn is outside the window", () => {
    const projectsRoot = makeProjectsRoot();
    writeSession(projectsRoot, "all-old-session", [
      assistantTurn(new Date(SINCE - DAY_MS).toISOString(), 1_000_000),
    ]);

    const bundle = readBundle({ projectsRoot, sinceMs: SINCE });

    expect(bundle.sessions).toEqual([]);
    expect(bundle.totalCost).toBe(0);
    expect(detectAll(bundle)).toEqual([]);
  });

  it("uses turn timestamps even when a restored file has an older mtime", () => {
    const projectsRoot = makeProjectsRoot();
    writeSession(
      projectsRoot,
      "restored-session",
      [assistantTurn(new Date(SINCE + DAY_MS).toISOString(), 1_000_000)],
      SINCE - 1,
    );

    const bundle = readBundle({ projectsRoot, sinceMs: SINCE });

    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]?.fullId).toBe("restored-session");
    expect(bundle.sessions[0]?.turns).toBe(1);
    expect(bundle.totalCost).toBe(3);
  });

  it("fails closed on unknown timestamps only in windowed scans", () => {
    const projectsRoot = makeProjectsRoot();
    writeSession(projectsRoot, "mixed-unknown", [
      assistantTurn(undefined, 1_000_000, [tool("Read")]),
      assistantTurn("not-a-date", 2_000_000, [tool("Edit")]),
      assistantTurn(new Date(SINCE).toISOString(), 3_000_000, [tool("Bash")]),
    ]);
    writeSession(projectsRoot, "unknown-only", [
      assistantTurn(undefined, 4_000_000),
      assistantTurn({ unexpected: "shape" }, 5_000_000),
    ]);

    const windowed = readBundle({ projectsRoot, sinceMs: SINCE });
    expect(windowed.sessions).toHaveLength(1);
    expect(windowed.sessions[0]?.fullId).toBe("mixed-unknown");
    expect(windowed.sessions[0]?.turns).toBe(1);
    expect(windowed.sessions[0]?.toolCount).toEqual({ Bash: 1 });

    const unbounded = readBundle({ projectsRoot });
    expect(unbounded.sessions).toHaveLength(2);
    expect(unbounded.sessions.find((session) => session.fullId === "mixed-unknown")?.turns).toBe(3);
    expect(unbounded.sessions.find((session) => session.fullId === "unknown-only")?.turns).toBe(2);
  });

  it("excludes old turns from every cost, token, and tool aggregate", () => {
    const projectsRoot = makeProjectsRoot();
    const oldTools = [
      tool("Bash"),
      tool("Write", { file_path: "/synthetic/old.ts" }),
      tool("Read", { file_path: "/synthetic/old.ts" }),
      tool("Agent", { subagent_type: "old-helper" }),
      ...Array.from({ length: 8 }, () => tool("Bash")),
    ];
    writeSession(projectsRoot, "aggregate-session", [
      assistantTurn(new Date(SINCE - 2).toISOString(), 9_000_000, oldTools, {
        model: "claude-opus-4-7",
      }),
      assistantTurn(new Date(SINCE - 1).toISOString(), 8_000_000),
      assistantTurn(new Date(SINCE).toISOString(), 0, [], {
        model: "claude-haiku-4-5",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 11,
            ephemeral_1h_input_tokens: 13,
          },
          cache_read_input_tokens: 40,
        },
      }),
    ]);

    const bundle = readBundle({ projectsRoot, sinceMs: SINCE });
    const session = bundle.sessions[0]!;

    expect(session.turns).toBe(1);
    expect(session.modelCost["claude-haiku-4-5"]).toBeCloseTo(0.000129, 12);
    expect(session.modelCost["claude-opus-4-7"]).toBeUndefined();
    expect(bundle.totalCost).toBeCloseTo(0.000129, 12);
    expect(session.inputTokens).toBe(10);
    expect(session.outputTokens).toBe(20);
    expect(session.cache1hWriteTokens).toBe(13);
    expect(session.cache5mWriteTokens).toBe(11);
    expect(session.cacheReadTokens).toBe(40);
    expect(session.toolCount).toEqual({});
    expect(session.subagentCount).toBe(0);
    expect(session.editedFiles).toEqual({});
    expect(session.readFiles).toEqual({});
    expect(session.noToolTurns).toBe(1);
    expect(session.noToolCost).toBeCloseTo(0.000129, 12);
    expect(session.maxToolRun).toBe(0);
    expect(session.maxToolCallsPerTurn).toBe(0);
    expect(session.peakTotalInputTokens).toBe(74);
    expect(session.totalInputTokensSum).toBe(74);
  });

  it("does not carry a consecutive tool run across the cutoff", () => {
    const projectsRoot = makeProjectsRoot();
    const turns = [assistantTurn(new Date(SINCE - 1).toISOString(), 1, [tool("Bash")])];
    for (let i = 0; i < 7; i++) {
      turns.push(assistantTurn(new Date(SINCE + i).toISOString(), 1, [tool("Bash")]));
    }
    writeSession(projectsRoot, "loop-session", turns);

    const bundle = readBundle({ projectsRoot, sinceMs: SINCE });
    const session = bundle.sessions[0]!;

    expect(session.turns).toBe(7);
    expect(session.toolCount).toEqual({ Bash: 7 });
    expect(session.maxToolRun).toBe(7);
    expect(session.maxToolRunName).toBe("Bash");
  });
});
