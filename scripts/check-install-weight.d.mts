/** Types for scripts/check-install-weight.mjs (flair#1004). */

export const EXIT_OK: 0;
export const EXIT_OVER: 1;
export const EXIT_DID_NOT_RUN: 2;

export interface TreeEntry {
  name: string;
  bytes: number;
}

export interface PackageEntry extends TreeEntry {
  version: string;
  path: string;
}

export interface Measurement {
  didNotRun: boolean;
  reason?: string;
  bytes?: number;
  packages?: number;
  packageList?: PackageEntry[];
  entries?: TreeEntry[];
}

export interface Budget {
  ok: boolean;
  reason?: string;
  maxBytes?: number;
  maxPackages?: number;
  baseline?: {
    bytes: number;
    packages: number;
    entries: Record<string, number>;
  };
  path?: string;
}

export interface EntryDelta {
  name: string;
  bytes: number;
  delta: number;
  kind: "new" | "grew";
  previous?: number;
}

export interface WeightResult {
  status: "ok" | "over" | "did-not-run";
  reason?: string;
  overBytes?: boolean;
  overPackages?: boolean;
  deltaBytes?: number;
  deltaPackages?: number;
  contributors?: EntryDelta[];
  measured?: Measurement;
  budget?: Budget;
}

export function formatBytes(n: number): string;
export function formatDeltaBytes(n: number): string;
export function dirSize(dir: string, opts?: { skipNodeModules?: boolean }): number;
export function collectPackages(nodeModulesDir: string): PackageEntry[];
export function collectTopLevelEntries(nodeModulesDir: string): TreeEntry[];
export function measureInstalledTree(nodeModulesDir: string): Measurement;
export function loadBudget(path?: string): Budget;
export function diffEntries(current: TreeEntry[], baselineEntries: Record<string, number>): EntryDelta[];
export function evaluateWeight(args: { measured: Measurement; budget: Budget }): WeightResult;
export function formatReport(result: WeightResult): string;
export function parseArgs(argv: string[]): { tree: string | null; tarball: string | null; budget: string; help?: boolean };
export function installTarball(tarball: string, prefix?: string): { didNotRun: boolean; reason?: string; prefix: string; tree?: string };
export function run(argv?: string[], io?: { log: (...args: unknown[]) => void; err: (...args: unknown[]) => void }): 0 | 1 | 2;
