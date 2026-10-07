/**
 * Space key for the flair engine: `flair:<registry-entry-digest>[+variant]`.
 * The digest covers id, file sha256, revision, dims, pooling, and both
 * template strings. The default `gguf:` stamp is a different function and
 * stays byte-identical when the flag is unset.
 */
import { createHash } from "node:crypto";
import type { EmbeddingModelEntry } from "./models.js";

/** Recorded pipeline provenance. Not the #1475 versioning design. */
export const EMBEDDING_PIPELINE_VERSION = "1";

export const FLAIR_IMPLEMENTATION = "flair";

export function registryEntryDigest(entry: EmbeddingModelEntry): string {
  const body = [
    entry.id,
    entry.sha256,
    entry.revision,
    String(entry.dims),
    entry.pooling,
    entry.templates.document,
    entry.templates.query,
  ].join("\n");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function flairSpaceKey(entry: EmbeddingModelEntry, suffix: string): string {
  return `${FLAIR_IMPLEMENTATION}:${registryEntryDigest(entry)}${suffix}`;
}
