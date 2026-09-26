/**
 * Typings for `pyproject-version.mjs` (flair#1671 / slice 3 of #1928). The
 * module is dependency-free JavaScript; these declarations exist so the strict
 * test-suite typecheck can resolve it (as it does the sibling
 * `lockstep-packages.d.mts`).
 */

export type ReadProjectVersionResult =
  | { kind: "version"; version: string; lineIndex: number }
  | { kind: "none"; reason: string }
  | { kind: "unsupported"; line: string; reason: string };

export function readProjectVersion(text: string | null | undefined): ReadProjectVersionResult;
export function projectVersionFromPyproject(text: string | null | undefined): string | null;
export function replaceProjectVersion(text: string, version: string): string | null;
