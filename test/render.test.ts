import { describe, expect, it, beforeAll } from "bun:test";

import { renderCatalog, renderHit, renderJSON, renderMarkdown, renderSummary } from "../src/lib/render.js";
import { PATHOLOGIES } from "../src/diagnoses.js";
import type { DiagnosisHit } from "../src/types.js";

beforeAll(() => {
  process.env.NO_COLOR = "1"; // deterministic assertions
});

const hitFixture: DiagnosisHit = {
  code: "MODEL_MONOCULTURE",
  evidence: [
    { metric: "claude-opus-4-7 share", value: "99.6%", threshold: "95%" },
    { metric: "total weekly cost", value: "$13,031" },
  ],
  prescription: "Route ReadOnly subagents to Haiku.",
  estimatedSavingsUSD: 3000,
};

describe("render", () => {
  it("renderHit includes code, evidence, and fix", () => {
    const p = PATHOLOGIES.find((x) => x.code === "MODEL_MONOCULTURE")!;
    const out = renderHit(p, hitFixture);
    expect(out).toContain("MODEL_MONOCULTURE");
    expect(out).toContain("99.6%");
    expect(out).toContain("Fix:");
    expect(out).toContain("Route ReadOnly");
    expect(out).toContain("Potential savings");
  });

  it("renderCatalog groups by category and lists all 8 pathologies", () => {
    const out = renderCatalog();
    expect(out).toContain("COST");
    expect(out).toContain("LOOPS");
    expect(out).toContain("TOOLS");
    for (const p of PATHOLOGIES) {
      expect(out).toContain(p.code);
    }
  });

  it("renderSummary shows severity tally and savings", () => {
    const out = renderSummary([hitFixture], 13031, 171);
    expect(out).toContain("171 sessions");
    expect(out).toContain("13,031");
    expect(out).toContain("potential weekly savings");
  });

  it("renderSummary handles the no-findings case cleanly", () => {
    const out = renderSummary([], 500, 10);
    expect(out).toContain("no pathologies detected");
  });

  it("renderJSON is parseable and preserves structure", () => {
    const out = renderJSON([hitFixture], 13031);
    const parsed = JSON.parse(out);
    expect(parsed.totalCost).toBe(13031);
    expect(parsed.hits[0].code).toBe("MODEL_MONOCULTURE");
  });

  it("renderMarkdown uses fenced code blocks for prescriptions", () => {
    const out = renderMarkdown([hitFixture], 13031, 171);
    expect(out).toContain("# Doctor report");
    expect(out).toContain("```");
    expect(out).toContain("Route ReadOnly");
  });
});
