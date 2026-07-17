// Pins the shared embeddings-provider mock's export surface to the real
// module's named exports. If someone adds an export to
// resources/embeddings-provider.ts and a test file imports it by name, an
// incomplete mock would poison that import in the shared `bun test` process
// (SyntaxError: Export named 'x' not found) — latent until file scheduling
// shifts. This test fails loudly at the source instead. See
// helpers/embeddings-provider-mock.ts. (flair#691 flake-hardening.)
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embeddingsProviderMock } from "./helpers/embeddings-provider-mock";

describe("embeddings-provider mock completeness (flair#691)", () => {
  it("stubs every named export the real module declares", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../resources/embeddings-provider.ts"),
      "utf8",
    );
    // Match `export function|const NAME` and `export { NAME, ... }`; skip
    // type-only exports (erased at runtime, never break a value import).
    const named = new Set<string>();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)) {
      named.add(m[1]);
    }
    for (const m of src.matchAll(/^export\s+\{([^}]+)\}/gm)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !part.includes("type ")) named.add(name);
      }
    }
    const stub = embeddingsProviderMock();
    const missing = [...named].filter((n) => !(n in stub));
    expect(missing).toEqual([]);
  });
});
