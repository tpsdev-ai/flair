/**
 * artifact.ts — content-addressed artifact for the ingest-only throughput
 * benchmark (flair#1436). Schema v2 adds the gpuLayers axis, doc/s + spread,
 * quiet-box, Metal readback, ranking, and the positive-control record.
 *
 * Same partition as longmemeval/artifact.ts: hashed CONTENT vs unhashed
 * PROVENANCE. `configHash` is the anchor. `artifactHash` is a SEAL.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_SCHEMA, canonicalJson, sha256hex } from "./config";
import { assertBenchGitCommit } from "../git-commit";
import type { SettingMetrics } from "./measure";
import type {
  Interval, NegativeControlDecision, PositiveControlDecision, RankingResult,
} from "../../unit/ingest-throughput-control";
import type { QuietBoxSnapshot } from "./quiet-box";

export interface SettingAggregate {
  requestedThreads: number | "default";
  requestedGpuLayers: number;
  runs: SettingMetrics[];
  meanObservedThreads: number;
  meanWallClockMs: number;
  meanDocuments: number;
  meanTokensIngested: number;
  meanTokPerSec: number;
  meanTokPerSecPerCore: number;
  meanDocsPerSec: number;
  docsPerSecSpread: Interval;
  tokPerSecSpread: Interval;
  meanPeakRssBytes: number;
  metalEngaged: boolean;
}

export interface NegativeControlResult extends NegativeControlDecision {
  low: number;
  high: number;
  gpuLayers: number;
}

export interface Artifact {
  schema: string;
  gitCommit: string | null;
  configHash: string;
  config: unknown;
  runHashes: string[];
  settings: SettingAggregate[];
  negativeControl: NegativeControlResult;
  positiveControl: PositiveControlDecision;
  ranking: Record<string, RankingResult>;
  gpuSweep: { sweep: number[]; skipped: boolean; reason: string };

  notice: string;
  generatedAt: string;
  host: {
    benchHost: string;
    platform: string;
    arch: string;
    metalCapable: boolean;
    quietBox: QuietBoxSnapshot;
  };
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
  positiveControl: PositiveControlDecision;
  ranking: Record<string, RankingResult>;
  gpuSweep: { sweep: number[]; skipped: boolean; reason: string };
  gitCommit: string;
  benchHost: string;
  platform: string;
  arch: string;
  metalCapable: boolean;
  quietBox: QuietBoxSnapshot;
}

export function buildArtifact(input: BuildArtifactInput): Artifact {
  const art: Artifact = {
    schema: ARTIFACT_SCHEMA,
    notice:
      "VALIDATION ARTIFACT — NOT FOR PUBLICATION. This harness produces numbers; it does not " +
      "publish them. Publishing any number requires a recorded human sign-off referencing this " +
      "artifact's artifactHash. Overlapping intervals are INCONCLUSIVE — this file must not be " +
      "read as picking a winner when ranking.verdict is inconclusive or refused.",
    generatedAt: new Date().toISOString(),
    gitCommit: assertBenchGitCommit(input.gitCommit, "ingest-throughput artifact"),
    host: {
      benchHost: input.benchHost,
      platform: input.platform,
      arch: input.arch,
      metalCapable: input.metalCapable,
      quietBox: input.quietBox,
    },
    configHash: input.configHash,
    config: input.config,
    runHashes: input.runHashes,
    settings: input.settings,
    negativeControl: input.negativeControl,
    positiveControl: input.positiveControl,
    ranking: input.ranking,
    gpuSweep: input.gpuSweep,
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

export function aggregate(runs: SettingMetrics[]): SettingAggregate {
  const mean = (f: (m: SettingMetrics) => number) => runs.reduce((s, m) => s + f(m), 0) / runs.length;
  const docs = runs.map((m) => m.docsPerSec);
  const toks = runs.map((m) => m.tokPerSec);
  const minMax = (values: number[]): Interval => ({
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((s, v) => s + v, 0) / values.length,
  });
  return {
    requestedThreads: runs[0]!.requestedThreads,
    requestedGpuLayers: runs[0]!.requestedGpuLayers,
    runs,
    meanObservedThreads: mean((m) => m.observedThreads),
    meanWallClockMs: mean((m) => m.wallClockMs),
    meanDocuments: mean((m) => m.documents),
    meanTokensIngested: mean((m) => m.tokensIngested),
    meanTokPerSec: mean((m) => m.tokPerSec),
    meanTokPerSecPerCore: mean((m) => m.tokPerSecPerCore),
    meanDocsPerSec: mean((m) => m.docsPerSec),
    docsPerSecSpread: minMax(docs),
    tokPerSecSpread: minMax(toks),
    meanPeakRssBytes: mean((m) => m.peakRssBytes),
    metalEngaged: runs[0]!.requestedGpuLayers > 0 && runs.every((m) => m.metalEngaged),
  };
}
