/**
 * Embeddings-only degrade for the flair engine. Registration skips; keyword
 * search remains. HealthDetail reads this. It is not a process boot failure.
 */
import { EmbeddingModelError } from "./errors.js";
import { hostLabel, prebuiltForPlatform } from "./platforms.js";

export interface EmbeddingDegrade {
  platform: string;
  packageName: string;
  message: string;
}

let degrade: EmbeddingDegrade | null = null;

export function setEmbeddingDegrade(next: EmbeddingDegrade | null): void {
  degrade = next;
}

export function getEmbeddingDegrade(): EmbeddingDegrade | null {
  return degrade;
}

export function _resetEmbeddingDegradeForTests(): void {
  degrade = null;
}

export function degradeForPrebuiltFailure(err: unknown, platform = process.platform, arch = process.arch): EmbeddingDegrade {
  const match = prebuiltForPlatform(platform, arch);
  const packageName = match?.packageName ?? "unsupported";
  const label = hostLabel(platform, arch);
  const detail = err instanceof Error ? err.message : String(err);
  const message = match
    ? `[embeddings] degraded to keyword search on ${label}: ${packageName} did not load. ${detail}`
    : `[embeddings] degraded to keyword search on ${label}: no supported prebuilt (supported packages: @node-llama-cpp/linux-x64, @node-llama-cpp/linux-arm64, @node-llama-cpp/mac-arm64-metal). ${detail}`;
  return { platform: label, packageName, message };
}

function degradeForModelFailure(err: unknown, platform: string, arch: string): EmbeddingDegrade {
  const match = prebuiltForPlatform(platform, arch);
  const packageName = match?.packageName ?? "unsupported";
  const label = hostLabel(platform, arch);
  const detail = err instanceof Error ? err.message : String(err);
  const message = `[embeddings] degraded to keyword search on ${label}: the model file could not be verified or fetched. ${detail}`;
  return { platform: label, packageName, message };
}

function degradeForOtherFailure(err: unknown, platform: string, arch: string): EmbeddingDegrade {
  const match = prebuiltForPlatform(platform, arch);
  const packageName = match?.packageName ?? "unsupported";
  const label = hostLabel(platform, arch);
  const detail = err instanceof Error ? err.message : String(err);
  const message = `[embeddings] degraded to keyword search on ${label}: embeddings did not start. ${detail}`;
  return { platform: label, packageName, message };
}

function isProvenancePrebuiltMiss(err: unknown): boolean {
  if (err instanceof EmbeddingModelError) return false;
  const message = err instanceof Error ? err.message : "";
  return message.includes("prebuilt") || message.includes("Refusing to record provenance") || message.includes("Refusing to record a llama.cpp build");
}

/**
 * Boot records this when registration throws. A missing platform package is
 * a prebuilt failure. A rejected download, or a models-directory mkdir,
 * chmod, or stat failure, arrives as EmbeddingModelError (code unreadable)
 * and takes the model-file wording. A provenance read that fails after a
 * successful registration must not use this classifier: the backend is still
 * active, and this wording says keyword search.
 */
export function degradeForActivationFailure(err: unknown, platform = process.platform, arch = process.arch): EmbeddingDegrade {
  if (err instanceof EmbeddingModelError && err.code === "prebuilt") {
    return degradeForPrebuiltFailure(err, platform, arch);
  }
  if (isProvenancePrebuiltMiss(err)) return degradeForPrebuiltFailure(err, platform, arch);
  if (err instanceof EmbeddingModelError && err.code !== "engine") {
    return degradeForModelFailure(err, platform, arch);
  }
  return degradeForOtherFailure(err, platform, arch);
}
