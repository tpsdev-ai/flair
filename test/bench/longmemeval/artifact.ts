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
 * The artifact is partitioned into hashed CONTENT (schema, validationSlice,
 * configHash, config, runHashes, aggregate, gitCommit) and unhashed PROVENANCE
 * (generatedAt, host, notice, artifactHash). Provenance is stamped AFTER hashing
 * and stripped BEFORE verification, so two runs with identical content hash
 * identically regardless of wall clock or host — host-invariance IS the
 * reproducibility claim.
 *
 * A human sign-off is recorded against a specific artifactHash — "approved to
 * publish artifact <hash>", not "the number seemed fine at some point". A
 * reviewer can recompute the hash from the committed config + the recorded
 * per-run outputs and confirm the published number is the one that was signed.
 *
 * There is deliberately NO publish function and NO --publish flag here. The
 * artifact carries a NOTICE stating exactly that.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256hex } from "./config";
import type { ArmAggregate, ArmRunMetrics } from "./metrics";

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
  // These describe WHERE/WHEN the number was produced, not WHAT it is, so they
  // must never enter the hash (host-invariance IS the reproducibility claim).
  notice: string;
  generatedAt: string;
  host: { ollama: string; benchHost: string };
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
}

/** Provenance fields — stamped AFTER hashing and stripped BEFORE verification.
 *  Everything else is hashed content. This list is the single source of truth
 *  for the partition, so buildArtifact and verifyArtifactHash can never drift. */
const PROVENANCE_KEYS = ["generatedAt", "host", "notice", "artifactHash"] as const;

/** The hashed-content partition of an artifact: everything except provenance. */
function hashedContent(art: Artifact): Record<string, unknown> {
  const content: Record<string, unknown> = { ...art };
  for (const key of PROVENANCE_KEYS) delete content[key];
  return content;
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
  // Hash the CONTENT partition only — provenance (generatedAt, host, notice) is
  // excluded so two runs with identical content hash identically regardless of
  // wall clock or host. canonicalJson sorts keys, and artifactHash is absent at
  // this point, so it cannot address itself.
  art.artifactHash = sha256hex(canonicalJson(hashedContent(art)));
  return art;
}

/** Recompute the hash of an artifact object (verification): strip the provenance
 *  partition (generatedAt, host, notice, artifactHash), canonicalise, sha256 —
 *  must equal the stored artifactHash. */
export function verifyArtifactHash(art: Artifact): boolean {
  return sha256hex(canonicalJson(hashedContent(art))) === art.artifactHash;
}

export function writeArtifact(art: Artifact, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `longmemeval-s-artifact-${art.artifactHash!.slice(0, 16)}.json`);
  writeFileSync(path, JSON.stringify(art, null, 2));
  return path;
}
