/**
 * Typings for `pyproject-version.mjs` (flair#1671 / slice 3 of #1928). The
 * module is dependency-free JavaScript; these declarations exist so the strict
 * test-suite typecheck can resolve it (as it does the sibling
 * `lockstep-packages.d.mts`).
 */

/** The test seams: point the reader at a stub and/or shrink the timeout. */
export interface PythonReaderOptions {
  pythonBin?: string;
  timeoutMs?: number;
}

export type ReadProjectVersionResult =
  | { kind: "version"; version: string; lineIndex: number }
  | { kind: "none"; reason: string }
  | { kind: "unsupported"; line: string; reason: string };

/** The default wall-clock ceiling for the python child. */
export const PYTHON_TIMEOUT_MS: number;

export function readProjectVersion(
  text: string | null | undefined,
  opts?: PythonReaderOptions,
): ReadProjectVersionResult;
export function projectVersionFromPyproject(
  text: string | null | undefined,
  opts?: PythonReaderOptions,
): string | null;
export function replaceProjectVersion(
  text: string,
  version: string,
  opts?: PythonReaderOptions,
): string | null;
