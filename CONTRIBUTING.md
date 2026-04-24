# Contributing

Thanks for reading this far. `doctor` is small and I intend to keep it that way, but pathology submissions, calibration PRs, and adapter work are all welcome.

## Proposing a new pathology

A pathology is accepted into the catalog when it has all four of:

1. **Detection signature.** A short, deterministic rule over session stats. It must be computable from the `SessionStat` shape in `src/types.ts`. If you need new fields, open an issue first to discuss.
2. **Mechanism.** Why does this pattern appear? Understanding the cause beats naming the symptom. Aim for 2-3 sentences.
3. **Case study.** At least one real session where the signature fires, plus a matching transcript excerpt (anonymized is fine). If you have a corpus, even a summary of prevalence strengthens the case.
4. **Prescription.** Something a reader can copy and apply in under 5 minutes — a config change, a prompt edit, a subagent re-route.

Open an issue with those four sections. We promote candidates to the catalog when they've been validated on ≥ 3 independent datasets (one from the submitter is fine, two more from the community raises the bar).

## Naming conventions

- `UPPER_SNAKE_CASE`
- Two words max (three if one is a qualifier)
- Describe the *pattern*, not the *fix*: `BASH_STORM`, not `USE_GREP_TOOL`
- Avoid medical cosplay. This is a lint catalog; every extra "clinical" word is a tax on the reader.

## Code contributions

```bash
bun install
bun test           # 25 pass baseline
bun run typecheck
bun run build
```

Style:

- Strict TypeScript. No `any` without a comment explaining why.
- Pure functions in `src/diagnoses.ts` and `src/lib/`.
- Side effects live in `src/sensors/` (file I/O) and `src/cli.ts` (stdio).
- No dependencies on `claude-agent-ledger` runtime — parity by data format, not linkage.

## Calibration

If you run `doctor check --format json` against a real Anthropic invoice and the totals diverge by > 10%, please open an issue with:

- Anthropic invoice period + total
- `doctor check --format json` output for the same period
- Your model usage (Max plan / API / Team / etc.)

Calibration errors compound — early reports are extremely valuable.

## Code of conduct

Be kind. Assume good faith. If you're unsure whether a pathology is worth submitting, open a draft issue and we'll shape it together.
