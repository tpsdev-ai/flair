/**
 * Type declarations for scripts/ci/package-set-digest.mjs (flair#1671, slice
 * A1c). The strict test-suite typecheck resolves the sibling .mjs through this
 * file (as it does for lockstep-packages.mjs).
 */

/**
 * The canonical package-set digest: sha256 over the sorted list of
 * `<name>@<version> <sha256>` lines (one per lockstep package), the same digest
 * the release run's pack job certifies (A1a, #1877).
 *
 * @param pairs `[name, sha256]` line, one per package.
 * @param version the single lockstep version (same for every package).
 * @param options `expected`: when given, the names in `pairs` must be exactly
 *   this set (each once, none extra, none missing) or the call throws — the
 *   guard `release-pack.mjs` drives with the lockstep package list.
 * @returns the 64-char hex sha256 digest. Throws if `pairs` is empty or any sha
 * is not a 64-char hex — a refusal, never a match.
 */
export declare function computePackageSetDigest(
   pairs: [string, string][],
   version: string,
   options?: { expected?: readonly string[] },
 ): string;
