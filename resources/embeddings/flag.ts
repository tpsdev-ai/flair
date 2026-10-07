/**
 * `FLAIR_EMBEDDINGS_ENGINE` — S1 opt-in. Unset, empty, and `hfe` keep today's
 * harper-fabric-embeddings path. `flair` selects the in-tree engine. Any other
 * value refuses; it is not treated as the default.
 */
export type EmbeddingsEngineName = "hfe" | "flair";

export function resolveEmbeddingsEngine(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsEngineName {
  const raw = env.FLAIR_EMBEDDINGS_ENGINE;
  if (raw == null) return "hfe";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "hfe") return "hfe";
  if (trimmed === "flair") return "flair";
  throw new Error(
    `[embeddings] FLAIR_EMBEDDINGS_ENGINE=${JSON.stringify(raw)} is not a known engine. ` +
      `Expected "hfe" or "flair". Remedy: unset FLAIR_EMBEDDINGS_ENGINE or set it to hfe or flair. ` +
      `Refusing to register an embedding backend.`,
  );
}
