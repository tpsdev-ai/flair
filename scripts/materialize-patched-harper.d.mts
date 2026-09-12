/** Types for scripts/materialize-patched-harper.mjs (flair#847). */

export const PATCHED_HARPER_NAME: "@tpsdev-ai/harper";
export const PREPACK_BACKUP: "package.json.prepack-harper";

export function npmAliasHarperSpec(version: string): string;
export function registryHarperSpec(dep: string | undefined): string | null;
export function rewriteHarperDepForPublish(pkg: Record<string, unknown>, version: string): Record<string, unknown>;
export function rewriteHarperDepForPack(pkg: Record<string, unknown>, version: string): Record<string, unknown>;
export function restoreHarperDep(pkg: Record<string, unknown>, version: string): Record<string, unknown>;
export function stampPatchedHarperManifest(harperPkg: Record<string, unknown>): Record<string, unknown>;
export function buildPatchedHarperPackage(args: {
  harperVersion: string;
  workDir: string;
  destDir: string;
  npmPack?: (name: string, version: string, destDir: string) => string;
}): string;
export function emitPatchedHarper(callerRoot: string | undefined, destDir: string): string;
export function rewriteHarperAlias(callerRoot?: string): string;
export function restorePatchedHarper(callerRoot?: string): string | null;
