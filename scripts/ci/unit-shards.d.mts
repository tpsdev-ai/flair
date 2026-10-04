export const ROOT: string;
export const ROOT_UNIT_DIR: string;
export const ROOT_TEST_DIR: string;
export const SHARDS: number;
export const SECONDS_BY_FILE: Record<string, number>;
export const DEFAULT_WEIGHT: number;
export function listUnitFiles(root?: string): string[];
export function weightOf(file: string): number;
export function assignShards(files: string[], shards: number): string[][];
export function shardFiles(index: number, of: number, files?: string[]): string[];
export function coverageReport(
  allFiles: string[],
  shards: string[][],
): { total: number; covered: number; missing: string[]; duplicated: string[]; unknown: string[] };
export function verifyShards(
  of: number,
  files?: string[],
): { total: number; covered: number; missing: string[]; duplicated: string[]; unknown: string[] };
