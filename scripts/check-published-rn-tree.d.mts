/** Types for scripts/check-published-rn-tree.mjs (flair#847). */

export const EXIT_OK: 0;
export const EXIT_FAIL: 1;
export const EXIT_DID_NOT_RUN: 2;
export const NPM12_SPEC: string;
export const FORBIDDEN_DIRS: string[];

export interface PublishedTreeResult {
  didNotRun: boolean;
  reason?: string;
  forbidden?: string[];
  harperPresent?: boolean;
  rocksdbJsPresent?: boolean;
  bindingPresent?: boolean;
  bindings?: string[];
  expectedBinding?: string | null;
  harperDirs?: string[];
  alasqlFailed?: string;
}

export function parseArgs(argv: string[]): { tree: string | null; tarball: string | null; npm: string | null; help?: boolean };
export function findPackageDirs(nodeModulesDir: string, name: string): string[];
export function listForbiddenPresent(nodeModulesDir: string): string[];
export function findRocksdbBindings(nodeModulesDir: string): string[];
export function expectedRocksdbBindingName(opts?: { platform?: string; arch?: string; libc?: string }): string | null;
export function evaluatePublishedTree(nodeModulesDir: string): PublishedTreeResult;
export function formatReport(result: PublishedTreeResult): string;
export function npmMajor(version: string): number;
export function resolveNpm12(
  explicit: string | null,
  spawn?: typeof import("node:child_process").spawnSync,
): { ok: boolean; reason?: string; command?: string; args?: string[]; version?: string };
export function installTarballAsDependency(
  tarball: string,
  npmSpec: { command: string; args: string[] },
  prefix?: string,
): { didNotRun: boolean; reason?: string; prefix: string; tree?: string };
export function runAlasqlControl(nodeModulesDir: string): { ok: boolean; reason?: string };
export function run(
  argv?: string[],
  io?: { log: (...args: unknown[]) => void; err: (...args: unknown[]) => void },
  spawn?: typeof import("node:child_process").spawnSync,
): 0 | 1 | 2;
