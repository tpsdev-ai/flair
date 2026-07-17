// Complete stub surface for `mock.module("resources/embeddings-provider.ts")`.
//
// `bun test test/unit` runs every file in ONE process and `mock.module` is
// process-global and unrestored — so whichever test file mocks
// embeddings-provider first wins the module cache for every later file in
// that worker, including files that import the REAL module. If a stub omits
// any export a later consumer imports by name, that consumer dies with
// `SyntaxError: Export named '<x>' not found in module 'embeddings-provider.ts'`
// as an "unhandled error between tests" — and which files collide depends on
// bun's file scheduling, so it stays latent until a new test file shifts the
// order (adding the 140th unit file armed exactly this: getModelId /
// buildEmbedOptions / resolveModelsDir went missing for migrations-embedding-
// stamp et al.).
//
// The rule the memory-integrity stub already documented but wasn't applied
// everywhere: a stub's export surface must be a SUPERSET of every consumer's
// named imports, not just the mocking file's own. This helper makes that
// structural — it returns the full surface; callers override only what they
// assert on. Keep it in sync with embeddings-provider.ts's exports (the
// mock-completeness test pins it).
export function embeddingsProviderMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    getEmbedding: async (_text: string, _inputType?: string) => null,
    getModelId: () => "mock-embedding-model",
    getMode: () => "none",
    getStatus: () => ({ mode: "none" as const }),
    buildEmbedOptions: (inputType?: "document" | "query") => ({
      model: "default" as const,
      ...(inputType ? { inputType } : {}),
    }),
    resolveModelsDir: () => "/tmp/mock-models",
    ...overrides,
  };
}
