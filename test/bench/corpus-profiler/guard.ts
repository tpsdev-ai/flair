// ─── corpus-profiler privacy guard ──────────────────────────────────────────
//
// The profiler (./compute.ts) measures a REAL memory corpus and must emit
// nothing that maps back to a record. This module is the mechanical check on
// that claim: it walks a serialised profile and asserts that every leaf is a
// finite number, with the single exception of a fixed, closed-enum `meta`
// block.
//
// Why a guard module and not just careful review: "emit no content" is a
// NEGATIVE constraint, and negative constraints are unbounded — you cannot
// prove you removed everything (flair#893, both reviewers, independently).
// The only tractable version is to INVERT it into a positive one: the output
// is numbers, and anything that is not a number is a failure. That is
// checkable, and it stays checkable after everyone has stopped paying
// attention.
//
// Two rules make this actually load-bearing rather than decorative:
//
//   1. The `meta` allowlist is a CLOSED ENUM, not a regex over "looks
//      harmless". A free-form string field is exactly where a hostname, a
//      codename, or a path would eventually be parked "just for debugging".
//      Adding a new meta value requires editing this file, which means it
//      goes through review. A gate that can be widened silently is not a gate.
//
//   2. Violation reports carry the PATH and the typeof — never the value.
//      A guard that prints the string it caught has published it to the
//      terminal, the CI log, and the PR comment that quotes the CI log. That
//      is the same failure shape as redacting a secret with sed: the control
//      leaks the thing it exists to contain.
//
// See ./README.md for the per-field privacy rationale of the schema itself.

/** Month stamp — `YYYY-MM`. Month granularity is the finest allowed (flair#893). */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Closed enum of every non-numeric value the profile may carry, keyed by its
 * `meta` field name. `MONTH` means "any well-formed YYYY-MM"; an array means
 * "exactly one of these literals".
 *
 * Widening this set is a deliberate, reviewable act. If the profiler starts
 * reporting an embedding model that is not listed here, the guard FAILS — and
 * that failure is correct: a profile computed in a different embedding space
 * measures a different geometry and should not be silently comparable to the
 * ones already committed.
 */
export const META_ALLOWLIST: Record<string, readonly string[] | typeof MONTH> = {
  // Which embedding vectors the geometry was computed over. "stored" = read
  // back from the live instance (production geometry). "computed" = generated
  // by the profiler (a DIFFERENT space unless the model matches exactly).
  embeddingSource: ["stored", "computed"],

  // The embedding model id, verbatim from Memory.embeddingModel. A public
  // model identifier, not a corpus fact — but enumerated anyway so that a
  // space change cannot pass unnoticed.
  embeddingModel: [
    "nomic-embed-text-v1.5-Q4_K_M+searchprefix",
    "nomic-embed-text-v1.5-Q4_K_M",
  ],

  // Which lexical tokenizer produced the vocabulary shape. "flair-bm25" is
  // resources/bm25.ts's own tokenize() — the same one production BM25 uses,
  // so the vocabulary numbers correspond to the retrieval path rather than to
  // an approximation of it.
  tokenizer: ["flair-bm25"],

  // Clustering algorithm. Seeded so a profile is reproducible from the same
  // corpus snapshot.
  clusterAlgorithm: ["kmeans++-seeded"],

  // Whether the pairwise-similarity statistics are over every pair or a
  // random sample. Exhaustive is preferred and feasible at our corpus size;
  // this records which one actually ran rather than assuming.
  pairwiseMode: ["exhaustive", "sampled"],

  // Whether archived records were included. Production SemanticSearch pushes
  // `archived != true`, so the RETRIEVABLE corpus excludes them — profiling
  // the wrong one silently measures a corpus no query can ever reach.
  scope: ["retrievable", "all-records"],

  // Month granularity only.
  firstMonth: MONTH,
  lastMonth: MONTH,
  profiledMonth: MONTH,
};

export interface Violation {
  /** Dotted path to the offending leaf. Field names only — never values. */
  path: string;
  /** Why it failed. Describes the TYPE, never the content. */
  reason: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Describe a rejected value WITHOUT reproducing it. `typeof` plus, for
 * strings, a length — enough to debug a schema mistake, not enough to
 * reconstruct a secret. Deliberately does not include the value.
 */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(len=${v.length})`;
  if (typeof v === "string") return `string(len=${v.length})`;
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "non-finite number";
  return typeof v;
}

/**
 * Walk a profile and collect every leaf that is not a finite number, other
 * than allowlisted `meta` values. Returns [] for a clean profile.
 *
 * Structural rules:
 *  - Top level must be an object with a `meta` object.
 *  - Every `meta` key must appear in META_ALLOWLIST and match its rule.
 *  - Everywhere else: objects and arrays may nest freely, but every LEAF must
 *    be a finite number. No strings, no booleans, no null, no NaN/Infinity.
 *
 * NaN and Infinity are rejected on purpose and not merely on principle:
 * `JSON.stringify` turns both into `null`, so a profile containing them is a
 * profile that silently changes shape on serialisation — and a downstream
 * generator reading `null` where it expects a quantile has no way to tell a
 * missing metric from a broken one.
 */
export function findViolations(profile: unknown): Violation[] {
  const out: Violation[] = [];

  if (!isPlainObject(profile)) {
    return [{ path: "$", reason: `root must be an object, got ${describe(profile)}` }];
  }

  const meta = (profile as Record<string, unknown>).meta;
  if (!isPlainObject(meta)) {
    out.push({ path: "meta", reason: `meta must be an object, got ${describe(meta)}` });
  } else {
    for (const [key, value] of Object.entries(meta)) {
      const rule = META_ALLOWLIST[key];
      if (!rule) {
        out.push({
          path: `meta.${key}`,
          reason: "key is not in META_ALLOWLIST — add it there deliberately, or drop the field",
        });
        continue;
      }
      if (typeof value !== "string") {
        out.push({ path: `meta.${key}`, reason: `meta values must be strings, got ${describe(value)}` });
        continue;
      }
      const ok = rule instanceof RegExp ? rule.test(value) : rule.includes(value);
      if (!ok) {
        out.push({
          path: `meta.${key}`,
          reason:
            rule instanceof RegExp
              ? `value does not match the allowed pattern ${rule.source}`
              : "value is not one of the allowed literals for this key",
        });
      }
    }
  }

  const walk = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        out.push({ path, reason: "numeric leaf is NaN or Infinity (JSON.stringify would emit null)" });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    out.push({ path, reason: `leaf must be a finite number, got ${describe(node)}` });
  };

  for (const [k, v] of Object.entries(profile)) {
    if (k === "meta") continue;
    walk(v, k);
  }

  return out;
}

/**
 * Throw if the profile carries anything content-bearing. The profiler calls
 * this before it writes, so a leak fails the RUN rather than producing a file
 * someone then commits.
 *
 * The thrown message lists paths and reasons only — see the module header for
 * why it must never quote the value.
 */
export function assertNumericOnly(profile: unknown): void {
  const violations = findViolations(profile);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  ${v.path}: ${v.reason}`);
  throw new Error(
    `corpus profile failed the privacy guard (${violations.length} violation(s)).\n` +
      `Every emitted leaf must be a finite number; only allowlisted meta strings may survive.\n` +
      `Offending paths (values deliberately NOT shown):\n${lines.join("\n")}`,
  );
}
