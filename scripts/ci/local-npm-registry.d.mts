/** Types for scripts/ci/local-npm-registry.mjs (flair#1671, SSRF guard #1684). */

export const LOCKSTEP_PACKAGE_NAMES: Set<string>;

export function parseArgs(argv: string[]): Record<string, string | boolean>;

export function resolveUpstreamPath(pathname: string): string | null;

export function main(argv?: string[]): Promise<number>;
