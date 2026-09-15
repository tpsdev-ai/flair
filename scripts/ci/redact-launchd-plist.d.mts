/** Types for scripts/ci/redact-launchd-plist.mjs (flair#1684 review, F1). */

export const REDACTED_KEYS: string[];

export function adminPassFileCandidates(env?: Record<string, string | undefined>): string[];

export function collectAdminPassSecrets(paths?: string[]): string[];

export function redactPlist(text: string, extraSecrets?: string[]): string;

export function main(argv?: string[]): number;
