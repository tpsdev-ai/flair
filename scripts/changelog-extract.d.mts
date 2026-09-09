/** Typings for `changelog-extract.mjs` — one CHANGELOG version section. */

export const SEMVER_RE: RegExp;

export class ExtractError extends Error {
  exitCode: number;
  constructor(message: string, exitCode?: number);
}

export function extractChangelogSection(version: string, path?: string): string;
