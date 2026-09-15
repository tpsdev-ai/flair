/** Types for scripts/vendor-tool-descriptors.mjs (flair#1683). */

/** Repo-relative path of the canonical descriptor source. */
export const DESCRIPTORS_SRC_REL: string;
/** Repo-relative path of the descriptor workspace package (private). */
export const DESCRIPTORS_PKG_REL: string;
/** Vendored file name written into each destination directory. */
export const VENDORED_FILE: string;
/** Every consumer that needs a vendored copy, as a repo-relative directory. */
export const VENDOR_TARGETS: string[];

/** Walk up from `from` until the descriptor workspace package is found. */
export function findRepoRoot(from: string): string;
/** The exact bytes written to every vendored copy (banner + source). */
export function vendoredContent(repoRoot?: string): string;
/** Write the vendored copy for one repo-relative destination; returns the abs path. */
export function vendorToolDescriptors(destRel: string, repoRoot?: string): string;
