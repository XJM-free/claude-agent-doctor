// CLI entry. Two verbs only (UX review mandate):
//   doctor check [session-id] [--category cost|loops|tools] [--format md|json] [--days N]
//   doctor explain [CODE]

import { PATHOLOGIES, detectAll, findByCode } from "./diagnoses.js";
import { readBundle, sinceDays } from "./sensors/jsonl-reader.js";
import {
  renderCatalog,
  renderExplain,
  renderHit,
  renderJSON,
  renderMarkdown,
  renderSummary,
} from "./lib/render.js";

const HELP = `doctor — lint your Claude Code sessions (zero tokens, zero network)

Usage:
  doctor check [session-id]  [--category cost|loops|tools] [--format md|json] [--days N]
  doctor explain [CODE]      # no arg: full catalog; with arg: one pathology

Options:
  --days N        Window size in days (default: 7)
  --category C    Only run diagnoses in this category
  --format F      Output format: tty (default) | md | json
  --no-color      Disable ANSI color

Examples:
  doctor check                 # scan the last 7 days
  doctor check --days 30       # scan the last month
  doctor check abc12345        # deep-scan one session
  doctor check --format md > report.md
  doctor explain               # browse the catalog (${PATHOLOGIES.length} pathologies)
  doctor explain OPUS_OVERSPEND
`;

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case "check":
      return cmdCheck(rest);
    case "explain":
      return cmdExplain(rest);
    case "--version":
    case "-v":
      process.stdout.write("claude-agent-doctor v0.1.0\n");
      return;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      process.stderr.write(HELP);
      process.exitCode = 2;
  }
}

function cmdCheck(args: string[]): void {
  const opts = parseCheckArgs(args);

  const sinceMs = opts.days ? sinceDays(opts.days) : sinceDays(7);
  const bundle = readBundle({ sinceMs });

  // If a session id was passed positionally, filter to that one.
  if (opts.sessionId) {
    bundle.sessions = bundle.sessions.filter(
      (s) => s.id === opts.sessionId || s.fullId.startsWith(opts.sessionId!),
    );
    bundle.totalCost = bundle.sessions.reduce((a, s) => {
      let c = 0;
      for (const v of Object.values(s.modelCost)) c += v;
      return a + c;
    }, 0);
  }

  const hits = detectAll(bundle, opts.category);

  if (opts.format === "json") {
    process.stdout.write(renderJSON(hits, bundle.totalCost));
    process.stdout.write("\n");
    return;
  }
  if (opts.format === "md") {
    process.stdout.write(renderMarkdown(hits, bundle.totalCost, bundle.sessions.length));
    return;
  }

  process.stdout.write(renderSummary(hits, bundle.totalCost, bundle.sessions.length));
  for (const h of hits) {
    const p = PATHOLOGIES.find((x) => x.code === h.code);
    if (!p) continue;
    process.stdout.write(renderHit(p, h));
    process.stdout.write("\n\n");
  }
}

function cmdExplain(args: string[]): void {
  const code = args.find((a) => !a.startsWith("-"));
  if (!code) {
    process.stdout.write(renderCatalog());
    return;
  }
  const p = findByCode(code);
  if (!p) {
    process.stderr.write(`unknown pathology: ${code}\n`);
    process.stderr.write(`run \`doctor explain\` to list all codes.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(renderExplain(p));
}

interface CheckOpts {
  days?: number;
  category?: string;
  format?: "md" | "json" | "tty";
  sessionId?: string;
}

function parseCheckArgs(args: string[]): CheckOpts {
  const out: CheckOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--days":
        out.days = parseInt(args[++i]!, 10);
        break;
      case "--category":
        out.category = args[++i];
        break;
      case "--format":
        out.format = args[++i] as CheckOpts["format"];
        break;
      case "--no-color":
        process.env.NO_COLOR = "1";
        break;
      default:
        if (!a.startsWith("-")) {
          out.sessionId = a;
        }
    }
  }
  return out;
}
