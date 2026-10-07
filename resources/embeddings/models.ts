/**
 * Built-in embedding model registry. Entries are data: a pinned Hugging Face
 * blob (commit revision, never a branch), size, SHA-256, dims, pooling, and
 * the document/query templates applied before tokenize.
 *
 * The built-in entry is frozen. `id` is the only field config may name
 * (`FLAIR_EMBEDDING_MODEL` on the default gguf stamp). repo, revision, file,
 * sha256, and bytes are not read from the environment.
 */
import { isAbsolute, resolve, sep } from "node:path";
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(Reflect.get(value, key));
    }
  }
  return value;
}

/**
 * Today's production nomic-embed-text v1.5 Q4_K_M. Values are the file
 * production already runs (size + SHA-256 checked against that blob).
 * Deep-frozen: `id` is the only field a config name may select, and only
 * on the default gguf stamp (`FLAIR_EMBEDDING_MODEL`). The flair digest
 * always uses this entry.
 */
export const BUILTIN_EMBEDDING_MODEL: EmbeddingModelEntry = deepFreeze({
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
});

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

function assertSegment(value: string, label: string): void {
  if (
    !SEGMENT.test(value)
    || value === "."
    || value === ".."
    || value.includes("..")
    || value.startsWith(".")
  ) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry ${label} ${JSON.stringify(value)} is not a plain path segment.`,
      "Fix the registry entry. repo and file must be single URL path segments with no '..' and no leading dot.",
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
  if (isAbsolute(entry.file)) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] registry file ${JSON.stringify(entry.file)} is absolute.`,
      "Use a bare basename. Refusing an absolute path.",
    );
  }
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

/** Encode one URL path segment. Validation still rejects separators. */
export function encodeRegistrySegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Initial download URL. Production fetch follows redirects; this string is
 * only the first request. Segments are URL-encoded.
 */
export function modelDownloadUrl(entry: EmbeddingModelEntry): string {
  assertRegistryLocation(entry);
  const [owner, name] = entry.repo.split("/") as [string, string];
  return buildModelDownloadUrl(owner, name, entry.revision, entry.file);
}

export function buildModelDownloadUrl(owner: string, name: string, revision: string, file: string): string {
  return `https://huggingface.co/${encodeRegistrySegment(owner)}/${encodeRegistrySegment(name)}/resolve/${encodeRegistrySegment(revision)}/${encodeRegistrySegment(file)}`;
}

/**
 * `resolve(modelsDir, file)` must be exactly `modelsDir + sep + file`
 * after both sides are resolved. A `..` segment or a prefix collision fails.
 */
export function assertResolvedModelPath(modelsDir: string, file: string): string {
  if (file.includes("/") || file.includes("\\") || file.includes("\0") || file.includes("..") || file.startsWith(".")) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] refusing to write ${JSON.stringify(file)} — it is not a single path segment.`,
      "Fix the registry file name.",
    );
  }
  const root = resolve(modelsDir);
  const dest = resolve(root, file);
  const expected = root.endsWith(sep) ? `${root}${file}` : `${root}${sep}${file}`;
  if (dest !== expected) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] resolved path ${dest} is not ${expected}.`,
      "Fix the models directory and the registry file name. Refusing to write outside the models directory.",
    );
  }
  return dest;
}

assertRegistryLocation(BUILTIN_EMBEDDING_MODEL);
