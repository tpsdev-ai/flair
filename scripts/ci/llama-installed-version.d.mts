export const DEFAULT_PACKAGE: string;
export const FAMILY_PACKAGE: string;
export function resolutionRoots(dir: string): string[];
export function findInstalledVersion(dir: string, packageName: string): string | null;
export function readLlamaInstalledVersion(dir: string, packageName?: string): string;
