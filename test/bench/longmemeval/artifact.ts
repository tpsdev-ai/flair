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
  schema: string;
  notice: string;
  validationSlice: boolean;
  generatedAt: string;
  gitCommit: string | null;
  host: { ollama: string; benchHost: string };
  configHash: string;
  config: unknown;          // the full pinned manifest (self-describing artifact)
  runHashes: string[];
  aggregate: ArmAggregate[];
  /** Filled in AFTER hashing (excluded from the hash — the hash addresses
   *  everything above it). */
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
  // Hash everything above artifactHash. canonicalJson sorts keys, and
  // artifactHash is absent at this point, so it cannot address itself.
  art.artifactHash = sha256hex(canonicalJson(art));
  return art;
}

/** Recompute the hash of an artifact object (verification): strip artifactHash,
 *  canonicalise, sha256 — must equal the stored artifactHash. */
export function verifyArtifactHash(art: Artifact): boolean {
  const { artifactHash, ...rest } = art;
  return sha256hex(canonicalJson(rest)) === artifactHash;
}

export function writeArtifact(art: Artifact, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `longmemeval-s-artifact-${art.artifactHash!.slice(0, 16)}.json`);
  writeFileSync(path, JSON.stringify(art, null, 2));
  return path;
}
