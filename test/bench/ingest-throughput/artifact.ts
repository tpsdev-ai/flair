/**
 * artifact.ts — content-addressed artifact for the ingest-only throughput
 * benchmark (flair#1436).
 *
 * Same partition as longmemeval/artifact.ts: hashed CONTENT (schema, gitCommit,
 * configHash, config, runHashes, settings, negativeControl) vs unhashed
 * PROVENANCE (generatedAt, host, notice, artifactHash). `configHash` is the
 * anchor — a pure function of the pinned config, re-derivable by anyone with
 * the repo. `artifactHash` is a SEAL (tamper-evidence), not a reproducibility
 * proof: it covers wall-clock latency, which a faithful re-run does not
 * bitwise-reproduce.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256hex } from "./config";
import type { SettingMetrics } from "./measure";

export interface SettingAggregate {
  requestedThreads: number | "default";
  runs: SettingMetrics[];
  meanObservedThreads: number;
  meanWallClockMs: number;
  meanTokensIngested: number;
  meanTokPerSec: number;
  meanTokPerSecPerCore: number;
  meanPeakRssBytes: number;
}

export interface NegativeControlResult {
  low: number;
  high: number;
  /** low.tokPerSec / high.tokPerSec (mean across runs). < 1 means low is slower. */
  ratio: number;
  /** True when low is materially slower than high (ratio below the threshold). */
  passed: boolean;
  threshold: number;
}

export interface Artifact {
  // ── Hashed CONTENT ──
  schema: string;
  gitCommit: string | null;
  configHash: string;
  config: unknown;
  runHashes: string[];
  settings: SettingAggregate[];
  negativeControl: NegativeControlResult;

  // ── Unhashed PROVENANCE ──
  notice: string;
  generatedAt: string;
  host: { benchHost: string };
  artifactHash?: string;
}

export const PROVENANCE_KEYS = ["generatedAt", "host", "notice", "artifactHash"] as const;

export function hashedContent(art: object): Record<string, unknown> {
  const content: Record<string, unknown> = { ...(art as Record<string, unknown>) };
  for (const key of PROVENANCE_KEYS) delete content[key];
  return content;
}

export function stampArtifactHash<T extends object>(art: T): T & { artifactHash: string } {
  const stamped = art as T & { artifactHash?: string };
  delete stamped.artifactHash;
  stamped.artifactHash = sha256hex(canonicalJson(hashedContent(stamped)));
  return stamped as T & { artifactHash: string };
}

export function hashRunResults(raw: unknown): string {
  return sha256hex(canonicalJson(raw));
}

export interface BuildArtifactInput {
  configHash: string;
  config: unknown;
  runHashes: string[];
  settings: SettingAggregate[];
  negativeControl: NegativeControlResult;
  gitCommit: string | null;
  benchHost: string;
}

export function buildArtifact(input: BuildArtifactInput): Artifact {
  const art: Artifact = {
    schema: "ingest-throughput.artifact/1",
    notice:
      "VALIDATION ARTIFACT — NOT FOR PUBLICATION. This harness produces numbers; it does not " +
      "publish them. Publishing any number requires a recorded human sign-off referencing this " +
      "artifact's artifactHash.",
    generatedAt: new Date().toISOString(),
    gitCommit: input.gitCommit,
    host: { benchHost: input.benchHost },
    configHash: input.configHash,
    config: input.config,
    runHashes: input.runHashes,
    settings: input.settings,
    negativeControl: input.negativeControl,
  };
  return stampArtifactHash(art);
}

export function verifyArtifactHash(art: Artifact): boolean {
  return sha256hex(canonicalJson(hashedContent(art))) === art.artifactHash;
}

export function writeArtifact(art: Artifact, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `ingest-throughput-artifact-${art.artifactHash!.slice(0, 16)}.json`);
  writeFileSync(path, JSON.stringify(art, null, 2));
  return path;
}
