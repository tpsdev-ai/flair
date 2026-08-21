// Deterministic GENERATIVE model backend for integration tests (flair#1257
// slice 3). Registered into a HOME-isolated ephemeral Harper via the
// supported custom-backend channel (harper models bootstrap #1471: a
// `models.generative.<name>.backend` config value that is a module path is
// imported and its default/`register` export invoked in-process) — wired by
// test/helpers/harper-lifecycle.ts's `appendRootConfigYaml` option.
//
// Behavior: every generate() call returns the current contents of the file
// named by the entry's `responseFile` config value, verbatim. The TEST
// process writes that file (before each /ReflectMemories call) with the
// candidate JSON it wants the "model" to produce — making execute-mode
// distillation fully end-to-end (real resource, real staging, real
// validation) and fully deterministic (no live LLM, no network).
//
// Same registration mechanism harper-fabric-embeddings' register() uses in
// production (globalThis.models.registerBackend + defineBackend — see
// resources/embeddings-boot.ts), so this exercises the real registry path.
//
// Fail-loud discipline: misconfiguration (wrong kind, missing responseFile)
// throws at registration so Harper's bootstrap logs and skips the entry —
// the test then fails on 503 "no backend configured" with the cause in the
// Harper log, never on a silent wrong answer. An unreadable responseFile at
// call time throws from generate(), which /ReflectMemories surfaces as its
// 502 distillation_failed — also loud.

import { readFileSync } from "node:fs";

export default function register({ logicalName, kind, config }) {
  if (kind !== "generative") {
    throw new Error(`stub-generative-backend is generative-only; cannot register models.${kind}.${logicalName}`);
  }
  const models = globalThis.models;
  if (typeof models?.registerBackend !== "function" || typeof models?.defineBackend !== "function") {
    throw new Error("global `models` API not available — stub-generative-backend requires a Harper version with model-backend support");
  }
  const responseFile = config?.responseFile;
  if (typeof responseFile !== "string" || responseFile.length === 0) {
    throw new Error(`models.generative.${logicalName}: stub-generative-backend requires a 'responseFile' config value`);
  }
  models.registerBackend(
    kind,
    logicalName,
    models.defineBackend({
      name: "flair-test-stub-generative",
      generate: async () => {
        const content = readFileSync(responseFile, "utf-8");
        return {
          status: "completed",
          output: { content, finishReason: "stop" },
          usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
        };
      },
    }),
  );
}
