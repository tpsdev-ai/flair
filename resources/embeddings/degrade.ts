/**
 * Embeddings-only degrade for the flair engine. Registration skips; keyword
 * search remains. HealthDetail reads this. It is not a process boot failure.
 */
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
