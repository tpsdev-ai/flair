/**
 * Types for scripts/ci/check-cli-spawn-budgets.mjs (flair#1807's CLI-spawn
 * class gate; extended for Bun.spawn + a trusted baseline in flair#1825). The
 * matching primitives are imported by test/unit/check-cli-spawn-budgets*.test.ts,
 * which type-checks under strict — and an untyped `.mjs` import fails that check,
 * so the exported surface the tests touch is declared here.
 */

/** True when `ch` is a JS identifier character — `[A-Za-z0-9_$]`. */
export function isIdentChar(ch: string): boolean;

/**
 * Index of the next occurrence of `id` in `text` at or after `from` that is a
 * WHOLE identifier — neither the character before it nor the one after it is an
 * identifier character. Returns -1 when there is none.
 */
export function findIdentifier(text: string, id: string, from?: number): number;

/**
 * `idx` points just past an identifier. True when the next non-whitespace
 * character in `text` is `(` — i.e. the identifier is called.
 */
export function identifierCallFollows(text: string, idx: number): boolean;

/** One spawn-family call found in a file (Bun forms and node forms). */
export interface SpawnCall {
  fn: string;
  index: number;
  line: number;
  text: string;
  isCliEntry: boolean;
  hasTimeout: boolean;
  scope?: string;
}

/** One `it()`/`test()` case. */
export interface CaseRecord {
  fn: string;
  line: number;
  name: string;
  argCount: number;
  reachesSpawn: boolean;
  hasBudget: boolean;
  open: number;
  close: number;
}

/** One offender: keyed on file + scope + fingerprint + kind (+ occurrence). */
export interface SpawnOffender {
  file: string;
  line: number;
  kind: string;
  detail: string;
  scope: string;
  fingerprint: string;
  occurrence?: number;
}

export function topLevelArgs(src: string, open: number): { spans: Array<{ start: number; end: number; text: string }>; close: number } | null;
export function cliEntryIdentifiers(source: string): Set<string>;
export function aliasedSpawnFns(source: string): Map<string, string>;
export function findSpawnCalls(source: string): { calls: SpawnCall[]; ids: Set<string> };
export function functionBodies(source: string): Array<{ name: string; start: number; end: number }>;
export function localHelpersThatSpawn(source: string, calls: SpawnCall[]): Set<string>;
export function findCases(source: string, calls: SpawnCall[], helpers: Set<string>): CaseRecord[];
export function analyzeTestFile(source: string): { calls: SpawnCall[]; ids: Set<string>; helpers: Set<string>; cases: CaseRecord[]; bodies: Array<{ name: string; start: number; end: number }> };
export function normalizeFingerprint(text: string): string;
export function offenderKey(o: { file: string; scope: string; fingerprint: string; kind: string; occurrence?: number }): string;
export function scanTree(root: string): { files: string[]; spawnOffenders: SpawnOffender[]; caseOffenders: SpawnOffender[] };
export function testFilesUnder(root: string): string[];

/** A single baseline entry. */
export interface BaselineEntry {
  file: string;
  scope: string;
  fingerprint: string;
  kind: string;
  occurrence?: number;
  reason: string;
}

export const BASELINE_PATH: string;
export function isLineKey(entry: unknown): boolean;
export function validateBaseline(entries: unknown): string[];
export function diffAgainstBaseline(
  spawnOffenders: SpawnOffender[],
  caseOffenders: SpawnOffender[],
  baselineEntries: BaselineEntry[],
): { newOffenders: SpawnOffender[]; staleEntries: BaselineEntry[]; ok: boolean };
export function loadBaseline(path?: string): BaselineEntry[];
