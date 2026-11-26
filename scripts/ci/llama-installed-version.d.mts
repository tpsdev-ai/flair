export const DEFAULT_PACKAGE: string;
export const FAMILY_PACKAGE: string;
export type InstalledPackage = { version: string; source: string };
export function resolutionRoots(dir: string): string[];
export function findInstalledPackage(dir: string, packageName: string): InstalledPackage | null;
export function findInstalledVersion(dir: string, packageName: string): string | null;
export function readLlamaInstalledPackage(dir: string, packageName?: string): InstalledPackage;
export function readLlamaInstalledVersion(dir: string, packageName?: string): string;
