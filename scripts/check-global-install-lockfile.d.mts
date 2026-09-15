/** Types for scripts/check-global-install-lockfile.mjs (flair#1683). */

/** Minimum "added N packages" count for a healthy installed tree (0.53.0 = 543). */
export const MIN_PACKAGES: number;

export interface TreePaths {
  /** `<prefix>/lib/node_modules/@tpsdev-ai/flair` */
  flair: string;
  /** harper's CLI entrypoint inside that tree */
  harperJs: string;
  /** harper's logging dir — where the fs-extra resolve probe starts */
  harperLoggingDir: string;
}

export interface ResolveCheck {
  ok: boolean;
  resolved?: string;
  error?: string;
}

export interface HarperCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface InstallEvaluation {
  added: number | null;
  fsExtra: ResolveCheck;
  harper: HarperCheck;
  failures: string[];
  ok: boolean;
}

export function treePaths(prefix: string): TreePaths;
export function parseAddedCount(log: string): number | null;
export function hasDamagedLockfileWarning(log: string): boolean;
export function resolveFromLoggingDir(paths: TreePaths): ResolveCheck;
export function harperVersion(paths: TreePaths): HarperCheck;
export function evaluateInstall(args: { log: string; paths: TreePaths; minPackages?: number }): InstallEvaluation;
