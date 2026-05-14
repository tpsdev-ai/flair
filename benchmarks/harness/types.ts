/**
 * Benchmark harness — shared types.
 *
 * A Task defines a scripted multi-turn scenario. A Run executes a Task
 * against an Agent (Flair or baseline) and produces a Result. The Judge
 * scores Results.
 */

/** A single turn in the scripted scenario — user input + optional setup. */
export interface TurnSpec {
  /** Prompt text sent to the agent. */
  prompt: string;
  /** Optional pre-turn setup: e.g., write a memory directly, simulate time passing. */
  before?: (ctx: TurnContext) => Promise<void>;
  /** Success criteria for the agent's response. The Judge uses this. */
  expect: {
    /** Free-form rubric the LLM-judge applies. */
    rubric: string;
    /** Optional substrings the response MUST contain (case-insensitive). */
    mustInclude?: string[];
    /** Optional substrings the response must NOT contain (e.g., "I don't know"). */
    mustNotInclude?: string[];
  };
}

/** A Task is a sequence of turns testing a single capability. */
export interface Task {
  /** Stable task ID, e.g., "01-decision-recall". */
  id: string;
  title: string;
  /** What capability the task isolates. */
  capability: string;
  /** Why this scenario surfaces memory's value. */
  rationale: string;
  /** Ordered turns. Sessions are split via a Session boundary turn. */
  turns: (TurnSpec | SessionBoundary)[];
}

/** Marker between sessions — agent's runtime context is discarded; memory persists (if any). */
export interface SessionBoundary {
  kind: "session-boundary";
  /** Optional gap to simulate (informational only — doesn't affect timing). */
  describedAs?: string;
}

export function isSessionBoundary(t: TurnSpec | SessionBoundary): t is SessionBoundary {
  return (t as any).kind === "session-boundary";
}

export interface TurnContext {
  /** The agent variant running this turn. */
  variant: "flair" | "baseline";
  /** Identifier for this run's persistent state (e.g., flair agent ID). */
  runId: string;
  /** Direct write of a memory into Flair (only valid in flair variant). */
  writeMemoryDirect?: (content: string, tags?: string[]) => Promise<void>;
}

/** Result of one turn within a run. */
export interface TurnResult {
  turnIndex: number;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Whether bootstrap was called at the start of this turn's session. */
  bootstrapCalled: boolean;
  /** Memories returned by bootstrap (Flair variant only). */
  bootstrapMemoryCount?: number;
}

/** Full result of one task × variant × run. */
export interface RunResult {
  runId: string;
  taskId: string;
  variant: "flair" | "baseline";
  model: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
  turns: TurnResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
}

/** Judge's scoring of a single run. */
export interface RunScore {
  runId: string;
  taskId: string;
  variant: "flair" | "baseline";
  turnScores: TurnScore[];
  overallPass: boolean; // all turns passed
  hallucinationFlags: number;
  judgeModel: string;
  judgedAt: string; // ISO
}

export interface TurnScore {
  turnIndex: number;
  pass: boolean;
  rubricNotes: string;
  /** mustInclude / mustNotInclude check results. */
  hardChecks: {
    mustInclude: { phrase: string; present: boolean }[];
    mustNotInclude: { phrase: string; present: boolean }[];
  };
  /** True if the response asserts a fact not supported by context or memory. */
  hallucinated: boolean;
}

/** Aggregate report for one task across many runs. */
export interface TaskReport {
  taskId: string;
  runs: { variant: "flair" | "baseline"; count: number }[];
  perVariant: Record<"flair" | "baseline", {
    passRate: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgDurationMs: number;
    hallucinationRate: number;
  }>;
  /** Per-axis ratios — Flair / baseline. <1.0 means Flair uses fewer tokens / time / hallucinations. */
  flairAdvantage: {
    tokenRatio: number;
    timeRatio: number;
    hallucinationRatio: number;
    passRateDelta: number; // flair.passRate - baseline.passRate
  };
}
