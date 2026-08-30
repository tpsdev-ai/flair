/** Types for scripts/ci/first-run-hostile-verdict.mjs (flair#1462). */

export interface ExpectedEntry {
  issue: number;
  marker: string;
}

export interface Verdict {
  ok: boolean;
  known: number[];
  missing: number[];
  unexpected: number[];
  unmarked: string[];
  abort: boolean;
  summary: string;
}

export interface ParsedArgs {
  expected: string | null;
  log: string | null;
  containerStatus: string | null;
  help: boolean;
}

export interface VerdictIo {
  readFile?: (path: string) => string;
  readStdin?: () => string;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

export function loadExpected(raw: string, source?: string): ExpectedEntry[];
export function observedFailIssues(log: string): number[];
export function unmarkedFailLines(log: string): string[];
export function judge(args: {
  expected: ExpectedEntry[];
  log: string;
  containerStatus?: number | null;
}): Verdict;
export function parseArgs(argv: string[]): ParsedArgs;
export function main(argv: string[], io?: VerdictIo): number;
