import { describe, expect, it, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentFile } from "../src/advisors/agent-files.js";
import {
  findAllAgentFiles,
  normalizeModelAlias,
} from "../src/advisors/agent-files.js";
import { generatePatch, rewriteModelField, suggest } from "../src/advisors/routing.js";
import type { SessionStat, SessionStatsBundle } from "../src/types.js";

beforeAll(() => {
  process.env.NO_COLOR = "1";
});

function bundle(): SessionStatsBundle {
  return { from: new Date(), to: new Date(), sessions: [], totalCost: 0 };
}

function agentFile(overrides: Partial<AgentFile>): AgentFile {
  return {
    path: "/tmp/test.md",
    scope: "user",
    name: "test-agent",
    description: "test description",
    model: "sonnet",
    frontmatterRaw: "---\nname: test-agent\nmodel: sonnet\n---",
    body: "",
    ...overrides,
  };
}

describe("normalizeModelAlias", () => {
  it("handles short names", () => {
    expect(normalizeModelAlias("sonnet")).toBe("sonnet");
    expect(normalizeModelAlias("opus")).toBe("opus");
    expect(normalizeModelAlias("haiku")).toBe("haiku");
  });

  it("handles fully-qualified names", () => {
    expect(normalizeModelAlias("claude-opus-4-7")).toBe("opus");
    expect(normalizeModelAlias("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("returns empty for empty", () => {
    expect(normalizeModelAlias("")).toBe("");
    expect(normalizeModelAlias("   ")).toBe("");
  });
});

describe("classify (via suggest)", () => {
  it("suggests haiku for pure read-only agents", () => {
    const a = agentFile({
      name: "Log Reader",
      description: "read logs, grep for errors, fetch alerts",
      model: "sonnet",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("haiku");
  });

  it("guards orchestrator-class agents from downgrade", () => {
    const a = agentFile({
      name: "Main Orchestrator",
      description: "coordinator that dispatches reviews and checks across subagents",
      model: "opus",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("keep");
    expect(plan.suggestions[0]!.reason).toContain("guarded role");
  });

  it("guards payment / compliance agents from downgrade", () => {
    const a = agentFile({
      name: "StoreKit Checker",
      description: "reviews subscription checkout flows for compliance",
      model: "sonnet",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("keep");
    expect(plan.suggestions[0]!.reason).toContain("guarded role");
  });

  it("never auto-upgrades to opus", () => {
    const a = agentFile({
      name: "System Architect",
      description: "architecture design strategy",
      model: "sonnet",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("keep");
  });

  it("suggests sonnet for implementation-heavy agents", () => {
    const a = agentFile({
      name: "Backend Dev",
      description: "implement api endpoints; refactor backend services; database migrations",
      model: "opus",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("sonnet");
  });

  it("keeps when description has no signals", () => {
    const a = agentFile({
      name: "Mystery Agent",
      description: "does things sometimes",
      model: "sonnet",
    });
    const plan = suggest(bundle(), [a]);
    expect(plan.suggestions[0]!.suggestedTier).toBe("keep");
  });

  it("keeps routing advice agent-specific instead of bypassing role guards", () => {
    const a = agentFile({ model: "opus", description: "implement api" });
    const plan = suggest(bundle(), [a]);
    expect(plan.envVarAdvice).toContain("agent-specific");
    expect(plan.envVarAdvice).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL=haiku");
  });

  it("uses measured invocation counts to moderate heavily used agent downgrades", () => {
    const input = bundle();
    const base: SessionStat = {
      id: "fixture", fullId: "fixture-session", project: "synthetic",
      startedAt: new Date(0), endedAt: new Date(0), turns: 0,
      modelCost: {}, toolCount: {}, subagentCount: 0,
      inputTokens: 0, outputTokens: 0, cache1hWriteTokens: 0,
      cache5mWriteTokens: 0, cacheReadTokens: 0, noToolTurns: 0,
      noToolCost: 0, editedFiles: {}, readFiles: {}, maxToolRun: 0,
      maxToolRunName: "", maxToolCallsPerTurn: 0, peakTotalInputTokens: 0,
      totalInputTokensSum: 0,
    };
    input.sessions = [
      { ...base, subagentInvocations: { "Log Reader": 21 } },
      { ...base, subagentInvocations: { "Log Reader": 11 } },
    ];
    const plan = suggest(input, [agentFile({
      name: "Log Reader", model: "opus", description: "read logs, grep errors, fetch alerts",
    })]);
    expect(plan.suggestions[0]?.invocations).toBe(32);
    expect(plan.suggestions[0]?.suggestedTier).toBe("sonnet");
  });

  it("skips env-var advice when haiku already configured", () => {
    const already = agentFile({ model: "haiku", name: "fast" });
    const other = agentFile({ model: "opus", name: "slow", path: "/tmp/b.md" });
    const plan = suggest(bundle(), [already, other]);
    expect(plan.envVarAdvice).toBeUndefined();
  });
});

describe("rewriteModelField", () => {
  it("replaces an existing model line", () => {
    const before = "---\nname: x\nmodel: opus\n---";
    const after = rewriteModelField(before, "haiku");
    expect(after).toContain("model: haiku");
    expect(after).not.toContain("model: opus");
  });

  it("inserts model when missing", () => {
    const before = "---\nname: x\ndescription: y\n---";
    const after = rewriteModelField(before, "haiku");
    expect(after).toContain("model: haiku");
    expect(after.split("---").length).toBe(3); // opening + closing fences intact
  });

  it("is idempotent", () => {
    const before = "---\nname: x\nmodel: haiku\n---";
    expect(rewriteModelField(before, "haiku")).toBe(before);
  });
});

describe("generatePatch", () => {
  it("skips agents marked 'keep'", () => {
    const a = agentFile({ description: "design architecture" });
    const plan = suggest(bundle(), [a]);
    expect(generatePatch(plan)).toBe("");
  });

  it("emits a diff header for each change", () => {
    const a = agentFile({
      name: "Log Agent",
      description: "read log, grep, fetch",
      model: "sonnet",
    });
    const plan = suggest(bundle(), [a]);
    const diff = generatePatch(plan);
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    expect(diff).toContain("+model: haiku");
  });
});

describe("findAllAgentFiles", () => {
  // Note: we don't test "returns empty when HOME is empty" because homedir()
  // is cached by libuv and doesn't re-read the env var reliably across runs.

  it("parses a local agent file", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-"));
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sample.md"),
      "---\nname: Sample Agent\ndescription: logs and reads\nmodel: sonnet\n---\nbody\n",
    );
    const found = findAllAgentFiles(root);
    const local = found.find((a) => a.scope === "project");
    expect(local?.name).toBe("Sample Agent");
    expect(local?.model).toBe("sonnet");
  });
});
