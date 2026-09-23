/**
 * Type declarations for scripts/ci/registry-tarball-sha256.mjs (flair#1856).
 * The strict test-suite typecheck resolves the sibling .mjs through this file.
 */

/** The default package hashed when no package argument is given. */
export declare const DEFAULT_PACKAGE: string;

/** The official strict SemVer 2.0.0 (semver.org) regex, anchored with ^…$. */
export declare const STRICT_SEMVER: RegExp;

/** True iff `version` is exactly a canonical strict SemVer 2.0.0 string. */
export declare function isStrictSemver(version: string): boolean;
