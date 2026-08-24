/**
 * artifact.ts — the STRUCTURAL publish gate.
 *
 * The harness PRODUCES a number; it never publishes one. Publishing is a
 * separate, gated human decision (spend / outward-publish are the founder's
 * gates). To make that gate structural rather than a conversation (Sherlock #4),
 * the run emits a CONTENT-ADDRESSED artifact:
 *
 *   artifactHash = sha256( canonical( configHash + per-run hashes + numbers ) )
 *
 * ── artifactHash IS A SEAL, NOT A PROOF ──────────────────────────────────────
 *
 * State this correction before anything else, because the file used to imply
 * the opposite. `artifactHash` is TAMPER-EVIDENCE. It binds a human sign-off to
 * one exact set of numbers — "approved to publish artifact <hash>", not "the
 * number seemed fine at some point" — so a later edit to a published artifact is
 * detectable. It is NOT a reproducibility proof and never was, even locally: it
 * covers wall-clock latency percentiles and (through the run hashes) completion
 * text, neither of which a faithful re-run reproduces.
 *
 * The three identities, in the order a reader should trust them (Sherlock,
 * flair#1368):
 *
 *   configHash    THE ANCHOR. A pure function of the pinned config; anyone with
 *                 the repo re-derives it exactly. It survives cloud
 *                 nondeterminism because it hashes CONFIGURATION, not output.
 *                 "Did they run what they said they ran" rests on this.
 *   runHash       THE DECISION SET (answer / verdict / tokensFed / extraction).
 *                 Expected re-derivable under the `local` profile — expected,
 *                 not measured, so it is not claimed. Under `cloud` the
 *                 completion text is not bitwise-stable, so this does not
 *                 re-derive; accuracy is a statistical result there.
 *   artifactHash  THE SEAL. Tamper-evidence for a signed-off artifact.
 *
 * "Verify it yourself" therefore rests on `configHash` plus the exact prompts,
 * the dataset selection and the judge rubric — NOT on `artifactHash`.
 *
 * ── The partition ────────────────────────────────────────────────────────────
 *
 * Hashed CONTENT: schema, validationSlice, configHash, config, runHashes,
 * aggregate, gitCommit. Unhashed PROVENANCE: generatedAt, host, notice,
 * readerDeterminism, artifactHash. Provenance is stamped AFTER hashing and
 * stripped BEFORE verification, so two runs with identical content hash
 * identically regardless of wall clock, host, or measured reader
 * nondeterminism.
 *
 * `readerDeterminism` (flair#1368) is provenance for a specific reason worth
 * stating: a determinism measurement legitimately differs run to run, so if it
 * fed the hash, every honest re-run would look like tampering — the seal would
 * fire on exactly the thing it is not meant to detect.
 *
 * There is deliberately NO publish function and NO --publish flag here. The
 * artifact carries a NOTICE stating exactly that.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256hex } from "./config";
import type { ArmAggregate, ArmRunMetrics } from "./metrics";
import type { ReaderDeterminism } from "./determinism";

export interface RunRecord {
  runIndex: number;
  /** sha256 of this run's canonical raw per-(question,arm) outcomes. */
  runHash: string;
  /** Per-arm metrics for this single run. */
  arms: ArmRunMetrics[];
}

export interface Artifact {
  // ── Hashed CONTENT — everything that determines the measured number. ──
  schema: string;
  validationSlice: boolean;
  gitCommit: string | null;
  configHash: string;
  config: unknown;          // the full pinned manifest (self-describing artifact)
  runHashes: string[];
  aggregate: ArmAggregate[];

  // ── Unhashed PROVENANCE — stamped AFTER hashing, stripped BEFORE verify. ──
  // These describe WHERE/WHEN/HOW-STABLY the number was produced, not WHAT it
  // is, so they must never enter the hash: the seal must fire on a changed
  // NUMBER, and never on a different host, a different clock, or a different
  // (honest) determinism reading.
  notice: string;
  generatedAt: string;
  host: { ollama: string; benchHost: string };
  /** MEASURED reader nondeterminism (determinism.ts, flair#1368): N calls with a
   *  byte-identical prompt, M distinct completions, common-prefix length, and
   *  verdict-agreement rate, on a FIXED question sample recorded alongside.
   *
   *  This is the published variance that makes "re-run and compare within
   *  variance" a checkable instruction instead of an empty one. It is
   *  PROVENANCE, never content: it legitimately differs between honest runs, so
   *  hashing it would make every faithful re-run look like tampering. */
  readerDeterminism?: ReaderDeterminism;
  /** Filled in AFTER hashing (excluded from the hash — the hash addresses
   *  the content partition above it). */
  artifactHash?: string;
}

export function hashRunResults(raw: unknown): string {
  return sha256hex(canonicalJson(raw));
}

export interface BuildArtifactInput {
  configHash: string;
  config: unknown;
  runHashes: string[];
  aggregate: ArmAggregate[];
  gitCommit: string | null;
  ollamaHost: string;
  benchHost: string;
  validationSlice: boolean;
  /** Optional so a caller that has no probe result (a failed probe supplies a
   *  record with `error` set — see determinism.failedProbe) is not forced to
   *  invent one. Omitted ⇒ the key is absent from the artifact entirely, which
   *  is honestly different from "probed and found deterministic". */
  readerDeterminism?: ReaderDeterminism;
}

/** Provenance fields — stamped AFTER hashing and stripped BEFORE verification.
 *  Everything else is hashed content. This list is the single source of truth
 *  for the partition, so buildArtifact and verifyArtifactHash can never drift —
 *  and it is EXPORTED so a second artifact schema (the payload A/B) inherits
 *  the identical partition instead of re-deciding it. */
export const PROVENANCE_KEYS = [
  "generatedAt", "host", "notice", "readerDeterminism", "artifactHash",
] as const;

/** The hashed-content partition of any artifact: everything except provenance. */
export function hashedContent(art: object): Record<string, unknown> {
  const content: Record<string, unknown> = { ...(art as Record<string, unknown>) };
  for (const key of PROVENANCE_KEYS) delete content[key];
  return content;
}

/** Stamp `artifactHash` onto any artifact-shaped object, addressing only its
 *  content partition. The field is absent while hashing, so it can never
 *  address itself. */
export function stampArtifactHash<T extends object>(art: T): T & { artifactHash: string } {
  const stamped = art as T & { artifactHash?: string };
  delete stamped.artifactHash;
  stamped.artifactHash = sha256hex(canonicalJson(hashedContent(stamped)));
  return stamped as T & { artifactHash: string };
}

/** Recompute and compare the hash of any artifact-shaped object. */
export function verifyStampedHash(art: object & { artifactHash?: string }): boolean {
  return sha256hex(canonicalJson(hashedContent(art))) === art.artifactHash;
}

export function buildArtifact(input: BuildArtifactInput): Artifact {
  const art: Artifact = {
    schema: "longmemeval-s.layer2.artifact/1",
    notice:
      "VALIDATION ARTIFACT — NOT FOR PUBLICATION. This harness produces numbers; it does not " +
      "publish them. Publishing any number requires a recorded human sign-off referencing this " +
      "artifact's artifactHash. Spend and outward-publishing are the founder's gates.",
    validationSlice: input.validationSlice,
    generatedAt: new Date().toISOString(),
    gitCommit: input.gitCommit,
    host: { ollama: input.ollamaHost, benchHost: input.benchHost },
    configHash: input.configHash,
    config: input.config,
    runHashes: input.runHashes,
    aggregate: input.aggregate,
  };
  if (input.readerDeterminism) art.readerDeterminism = input.readerDeterminism;
  // Hash the CONTENT partition only — provenance (generatedAt, host, notice,
  // readerDeterminism) is excluded so two runs with identical content hash
  // identically regardless of wall clock, host, or measured reader
  // nondeterminism. canonicalJson sorts keys, and artifactHash is absent at
  // this point, so it cannot address itself.
  return stampArtifactHash(art);
}

/** Recompute the hash of an artifact object (verification): strip the provenance
 *  partition (generatedAt, host, notice, readerDeterminism, artifactHash),
 *  canonicalise, sha256 — must equal the stored artifactHash. A match proves the
 *  artifact has not been modified since sign-off; it does NOT prove the numbers
 *  are reproducible. See the header. */
export function verifyArtifactHash(art: Artifact): boolean {
  return verifyStampedHash(art);
}

export function writeArtifact(art: Artifact, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `longmemeval-s-artifact-${art.artifactHash!.slice(0, 16)}.json`);
  writeFileSync(path, JSON.stringify(art, null, 2));
  return path;
}
