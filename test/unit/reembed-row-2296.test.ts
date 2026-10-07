/**
 * reembed-row-2296.test.ts — the request `flair reembed` sends per row, and
 * when it counts that row as re-embedded (flair#2296). The real-server
 * behaviour is covered by test/integration/reembed-preserves-fields-2296.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { reembedRow } from "../../src/commands/reembed.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function keyFile(): string {
  const path = join(tempDir("reembed-row-2296-"), "agent-a.key");
  writeFileSync(path, nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
  return path;
}

function stubFetch(response: () => Response): Array<{ url: string; init: any }> {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
  return calls;
}

test("sends a signed PATCH that names only the two embedding fields", async () => {
  const calls = stubFetch(() => Response.json({ id: "a/b", embeddingModel: "gguf:model" }));
  expect(await reembedRow("http://127.0.0.1:1", "agent-a", keyFile(), "a/b", "gguf:model")).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://127.0.0.1:1/Memory/a%2Fb");
  expect(calls[0].init.method).toBe("PATCH");
  expect(calls[0].init.headers.Authorization).toStartWith("TPS-Ed25519 agent-a:");
  expect(JSON.parse(calls[0].init.body)).toEqual({ embedding: null, embeddingModel: null });
}, 10_000);

test.each([
  ["a 204 with no body", () => new Response(null, { status: 204 })],
  ["a 200 without embeddingModel", () => Response.json({ id: "x" })],
  ["a 200 with a stale embeddingModel", () => Response.json({ id: "x", embeddingModel: "gguf:old-model" })],
  ["a 200 with a different embeddingModel", () => Response.json({ id: "x", embeddingModel: "onnx:model" })],
  ["a 200 that is not JSON", () => new Response("ok", { status: 200 })],
  ["a 403", () => Response.json({ error: "forbidden" }, { status: 403 })],
  ["a 503", () => Response.json({ error: "embedding_unavailable" }, { status: 503 })],
])("%s is not counted as re-embedded", async (_label, response) => {
  stubFetch(response);
  expect(await reembedRow("http://127.0.0.1:1", "agent-a", keyFile(), "x", "gguf:model")).toBe(false);
}, 10_000);
