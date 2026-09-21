/**
 * Type declarations for scripts/ci/lockstep-packages.mjs (flair#1781).
 * The strict test-suite typecheck resolves the sibling .mjs through this file.
 */

/** Repo root (scripts/ci/ -> scripts/ -> repo). */
export declare const ROOT: string;

/** The CLI package, ordered last in every emitted list. */
export declare const FLAIR_ROOT_PACKAGE: string;

/**
 * The lockstep package names, derived from the manifests and ordered with
 * `@tpsdev-ai/flair` last.
 */
export declare function lockstepPackages(root?: string): string[];
