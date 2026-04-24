// Shared types for the doctor.
//
// The data flow is: JSONL files → SessionStats (aggregate) → Diagnoses (detect).
// Each Diagnosis is a pure function over SessionStats — no I/O, no network.

export type Severity = "high" | "med" | "low";
export type Category = "cost" | "loops" | "tools";

/** Per-session aggregate derived from one *.jsonl transcript. */
export interface SessionStat {
  id: string;                          // short session id (8-char prefix)
  fullId: string;                      // full uuid
  project: string;                     // derived from directory name
  startedAt: Date;
  endedAt: Date;
  turns: number;                       // assistant turns
  modelCost: Record<string, number>;   // model -> dollars
  toolCount: Record<string, number>;   // tool name -> invocations
  subagentCount: number;               // distinct Agent spawns
  inputTokens: number;
  outputTokens: number;
  cache1hWriteTokens: number;
  cache5mWriteTokens: number;
  cacheReadTokens: number;
  noToolTurns: number;                 // turns with no tool_use block
  noToolCost: number;                  // cost of those turns
  editedFiles: Record<string, number>; // path -> Edit count (for EDIT_THRASH)
}

export interface SessionStatsBundle {
  from: Date;
  to: Date;
  sessions: SessionStat[];
  totalCost: number;
}

export interface Evidence {
  metric: string;                      // human-readable metric name
  value: string;                       // formatted value
  threshold?: string;                  // formatted threshold
}

/** A single diagnosed occurrence of a pathology. */
export interface DiagnosisHit {
  code: string;                        // matches Pathology.code
  sessionId?: string;                  // if session-scoped
  project?: string;
  evidence: Evidence[];
  prescription: string;                // copy-pasteable fix
  estimatedSavingsUSD?: number;        // when applicable
}

/** One pathology entry in the catalog. */
export interface Pathology {
  code: string;                        // "MODEL_MONOCULTURE"
  category: Category;
  severity: Severity;
  summary: string;                     // one-liner (≤ 80 chars)
  mechanism: string;                   // paragraph (≤ 3 sentences)
  detect: (bundle: SessionStatsBundle) => DiagnosisHit[];
  prescribe: (hit: DiagnosisHit) => string;
}
