export const ROOT: string;
export const LOCKFILE: string;
export const SEMVER: RegExp;
export const EMBEDDINGS_PACKAGE: string;
export const PLATFORM_PACKAGE: string;
export function readLlamaNativeVersion(lockText: string, packageName?: string): string;
