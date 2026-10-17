export function isEmptyEmbedding(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) ||
    (ArrayBuffer.isView(value) && value.byteLength === 0);
}

export function normalizeEmptyEmbedding(row: Record<string, any>): void {
  if (isEmptyEmbedding(row.embedding)) row.embedding = null;
}
