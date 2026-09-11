/** Typings for `materialize-bundled-descriptors.mjs` (flair#1580 pack/install). */

export const BUNDLED_NAME: "@tpsdev-ai/flair-tool-descriptors";
export const BUNDLED_REL: "packages/flair-tool-descriptors";

/**
 * Extra paths a `files[]`-only pack stage must copy so `prepack` can run.
 * Docker pack images COPY the script next to write-build-info.mjs; federation
 * upgrade-liveness stages the same list alongside `package.json` `files[]`.
 */
export const PACK_STAGE_EXTRAS: readonly string[];

export function buildDescriptors(src: string, repoRoot: string): void;
export function findRepoRoot(from: string): string;
export function materializeBundledDescriptors(callerRoot: string, repoRoot?: string): string;
