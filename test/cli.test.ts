import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./fixtures/run-cli.ts", import.meta.url));

function run(args: string[]) {
  const isolatedHome = mkdtempSync(join(tmpdir(), "doctor-cli-test-"));
  mkdirSync(join(isolatedHome, ".claude", "projects"), { recursive: true });
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, runner, ...args],
      cwd: isolatedHome,
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, NO_COLOR: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

describe("CLI argument validation", () => {
  it("rejects invalid input instead of silently scanning another window or format", () => {
    const invalid = [
      ["check", "--days"], ["check", "--days", "0"],
      ["check", "--days", "-1"], ["check", "--days", "1.5"],
      ["check", "--days", "1junk"], ["check", "--days", "Infinity"],
      ["check", "--days", "36501"], ["check", "--days", "NaN"],
      ["check", "--category", "PRIVATE-SENTINEL"],
      ["check", "--format", "PRIVATE-SENTINEL"],
      ["check", "--unknown", "PRIVATE-SENTINEL"],
      ["check", "first", "second"], ["check", "--format"],
      ["explain", "BASH_STORM", "extra"], ["explain", "--days", "7"],
      ["suggest-routing", "--format", "md"],
      ["suggest-routing", "--export-patch", "--format", "json"],
      ["suggest-routing", "PRIVATE-SENTINEL"],
    ];
    for (const args of invalid) {
      const result = run(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("doctor:");
      expect(result.stderr).not.toContain("PRIVATE-SENTINEL");
    }
  });

  it("keeps an empty valid scan as JSON with no findings", () => {
    const result = run(["check", "--days", "1", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).hits).toEqual([]);
  });

  it("shows command help without scanning local sessions", () => {
    for (const command of ["check", "explain", "suggest-routing"]) {
      const result = run([command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).toBe("");
    }
  });
});
