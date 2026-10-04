export const ROOT: string;
export const ROOT_UNIT_DIR: string;
export const ROOT_TEST_DIR: string;
export const SHARDS: number;
export function listUnitFiles(root?: string): string[];
export function assignShards(files: string[], shards: number): string[][];
export function shardFiles(index: number, of: number, files?: string[]): string[];
export function coverageReport(
  allFiles: string[],
  shards: string[][],
): { total: number; covered: number; missing: string[]; duplicated: string[]; unknown: string[]; empty: number[] };
export function verifyShards(
  of: number,
  files?: string[],
): { total: number; covered: number; missing: string[]; duplicated: string[]; unknown: string[]; empty: number[] };
