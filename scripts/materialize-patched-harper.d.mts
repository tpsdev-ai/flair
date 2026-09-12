/** Types for scripts/materialize-patched-harper.mjs (flair#847). */

export const VENDOR_DIR: "vendor";
export const HARPER_TGZ_PREFIX: "harper-";
export const PREPACK_BACKUP: "package.json.prepack-harper";

export function registryHarperSpec(dep: string | undefined): string | null;
export function vendorHarperPath(version: string): string;
export function rewriteHarperDepForPack(pkg: Record<string, unknown>, version: string): Record<string, unknown>;
export function restoreHarperDep(pkg: Record<string, unknown>, version: string): Record<string, unknown>;
export function buildPatchedHarperTarball(args: {
  harperVersion: string;
  workDir: string;
  destTgz: string;
  npmPack?: (name: string, version: string, destDir: string) => string;
}): string;
export function materializePatchedHarper(callerRoot?: string): string;
export function restorePatchedHarper(callerRoot?: string): string | null;
