/**
 * Named failures for the in-process embedding engine. A probe that cannot be
 * read is one of these — never treated as "missing" or "ok".
 */
export type EmbeddingModelErrorCode =
  | "missing-dir"
  | "unreadable"
  | "symlink"
  | "not-file"
  | "digest-mismatch"
  | "truncated"
  | "empty-body"
  | "bad-registry-path"
  | "pooling"
  | "dims"
  | "engine"
  | "prebuilt";

export class EmbeddingModelError extends Error {
  readonly code: EmbeddingModelErrorCode;
  readonly remedy: string;

  constructor(code: EmbeddingModelErrorCode, message: string, remedy: string) {
    super(`${message} Remedy: ${remedy}`);
    this.name = "EmbeddingModelError";
    this.code = code;
    this.remedy = remedy;
  }
}
