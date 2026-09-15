/** Types for scripts/check-shipped-descriptors.mjs (flair#1683). */

/** `packages/flair-tool-descriptors/src/index.ts` — the build-time source of truth. */
export const DESCRIPTORS_SRC_REL: string;
/** Every shipped copy is a module named exactly `tool-descriptors/index.js`. */
export const SHIPPED_REL_SUFFIX: string;

/** Repo root, resolved from this script's location (scripts/ → repo root). */
export function repoRoot(): string;

export interface DescriptorSignature {
  count: number;
  names: string[];
  native: string[];
  stdio: string[];
  /** sha256 over the serialized descriptors (names, descriptions, inputSchemas). */
  digest: string;
}

export interface SignatureDiff {
  missing: string[];
  extra: string[];
  countDelta: number;
  digestMatches: boolean;
}

/** Signature of an evaluated descriptor module (`TOOL_DESCRIPTORS` et al.). */
export function descriptorSignature(mod: unknown): DescriptorSignature;

/** Name-level diff between two signatures, for a failure that says WHAT diverged. */
export function diffSignatures(expected: DescriptorSignature, actual: DescriptorSignature): SignatureDiff;

/**
 * Evaluate a module URL in a child runtime and return its signature. `runtime`
 * is the interpreter used for BOTH halves (bun, which can import the TS source);
 * `--print-signature` is that child entrypoint.
 */
export function signatureOfModule(
  moduleUrl: string,
  runtime: string,
): { ok: true; signature: DescriptorSignature } | { ok: false; error: string };

/** Shipped descriptor modules under an extracted tarball's `package/` dir. */
export function findShippedModules(dir: string): string[];
