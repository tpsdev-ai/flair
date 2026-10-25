export type BundledCopy = { name: string; version: string; path: string };
export type BundledListing = {
  harperVersion: string;
  declared: string[];
  copies: BundledCopy[];
  bundledDir: string;
};
export function listBundledCopies(nodeModulesDir: string): BundledListing;
export function main(argv?: string[]): number;
