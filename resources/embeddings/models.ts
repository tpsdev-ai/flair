/**
 * Built-in embedding model registry. Entries are data: a pinned Hugging Face
 * blob (commit revision, never a branch), size, SHA-256, dims, pooling, and
 * the document/query templates applied before tokenize.
 */
import { EmbeddingModelError } from "./errors.js";

export type EmbeddingPooling = "none" | "mean" | "cls" | "last" | "rank";

export interface EmbeddingTemplates {
  document: string;
  query: string;
  defaults?: Readonly<Record<string, string>>;
}

export interface EmbeddingModelEntry {
  id: string;
  repo: string;
  /** 40-char lowercase commit. Never a branch name. */
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  dims: number;
  pooling: EmbeddingPooling;
  templates: EmbeddingTemplates;
}

/**
 * Today's production nomic-embed-text v1.5 Q4_K_M. Values are the file
 * production already runs (size + SHA-256 checked against that blob).
 */
export const BUILTIN_EMBEDDING_MODEL: EmbeddingModelEntry = {
  id: "nomic-embed-text-v1.5-Q4_K_M",
  repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
  revision: "0188c9bf409793f810680a5a431e7b899c46104c",
  file: "nomic-embed-text-v1.5.Q4_K_M.gguf",
  bytes: 84106624,
  sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
  dims: 768,
  pooling: "mean",
  templates: {
    document: "search_document: {text}",
    query: "search_query: {text}",
  },
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

function assertSegment(value: string, label: string): void {
  if (!SEGMENT.test(value) || value === "." || value === "..") {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry ${label} ${JSON.stringify(value)} is not a plain path segment.`,
      "Fix the registry entry. repo and file must be single URL path segments with no '..'.",
    );
  }
}

/** Refuse a mutable ref or a path that could escape the models directory. */
export function assertRegistryLocation(entry: EmbeddingModelEntry): void {
  const parts = entry.repo.split("/");
  if (parts.length !== 2) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry repo ${JSON.stringify(entry.repo)} must be owner/name.`,
      "Fix the registry entry to a single owner/name pair.",
    );
  }
  assertSegment(parts[0]!, "repo owner");
  assertSegment(parts[1]!, "repo name");
  if (!COMMIT.test(entry.revision)) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry revision ${JSON.stringify(entry.revision)} is not a 40-character commit.`,
      "Pin a commit SHA. A branch name is not a revision.",
    );
  }
  if (entry.file.includes("/") || entry.file.includes("\\") || entry.file.includes("\0")) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry file ${JSON.stringify(entry.file)} is not a single path segment.`,
      "Fix the registry file name so it cannot leave the models directory.",
    );
  }
  assertSegment(entry.file, "file");
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry sha256 for ${entry.id} is not 64 lowercase hex characters.`,
      "Record the file's SHA-256 in the registry before loading it.",
    );
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes < 1) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry byte count for ${entry.id} is not a positive integer.`,
      "Record the file's exact byte length in the registry.",
    );
  }
}

/** Pinned-revision URL. Caller must have passed `assertRegistryLocation`. */
export function modelDownloadUrl(entry: EmbeddingModelEntry): string {
  assertRegistryLocation(entry);
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`;
}

assertRegistryLocation(BUILTIN_EMBEDDING_MODEL);
