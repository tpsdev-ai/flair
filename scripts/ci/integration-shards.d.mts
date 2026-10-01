export const ROOT: string;
export const INTEGRATION_DIR: string;
export const SECONDS_BY_FILE: Record<string, number>;
export const DEFAULT_WEIGHT: number;
export function listIntegrationFiles(dir?: string): string[];
export function weightOf(file: string): number;
export function assignShards(files: string[], shards: number): string[][];
export function shardFiles(index: number, of: number, files?: string[]): string[];
export function verifyShards(
  of: number,
  files?: string[],
): { total: number; covered: number; missing: string[]; duplicated: string[]; unknown: string[] };
