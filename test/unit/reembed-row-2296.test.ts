/**
 * reembed-row-2296.test.ts — the request `flair reembed` sends per row, and
 * when it counts that row as re-embedded (flair#2296). flair#2561: the PATCH
 * answers `{ id, updatedAt }`; the row counts when that response names it and
 * the stored row then carries the intended model, read with a
 * StoredModelReader (the operations API, or a signed GET as the agent). The
 * real-server behaviour is covered by
 * test/integration/reembed-preserves-fields-2296.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { tempDir } from "../helpers/temp-dir";
import { agentStoredModelReader, opsStoredModelReader, reembedRow } from "../../src/commands/reembed.ts";

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

/** A StoredModelReader that answers `model` and records the ids it read. */
function storedModel(model: unknown): { read: (id: string) => Promise<unknown>; ids: string[] } {
  const ids: string[] = [];
  return { ids, read: async (id: string) => { ids.push(id); return model; } };
}

test("sends a signed PATCH that names only the two embedding fields, then reads the stored model", async () => {
  const calls = stubFetch(() => Response.json({ id: "a/b", updatedAt: "2026-10-13T00:00:00.000Z" }));
  const reader = storedModel("gguf:model");
  expect(await reembedRow("http://127.0.0.1:1", "agent-a", keyFile(), "a/b", "gguf:model", reader.read)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://127.0.0.1:1/Memory/a%2Fb");
  expect(calls[0].init.method).toBe("PATCH");
  expect(calls[0].init.headers.Authorization).toStartWith("TPS-Ed25519 agent-a:");
  expect(JSON.parse(calls[0].init.body)).toEqual({ embedding: null, embeddingModel: null });
  expect(reader.ids).toEqual(["a/b"]);
}, 10_000);

test.each([
  ["a 204 with no body", () => new Response(null, { status: 204 })],
  ["a 200 that is not JSON", () => new Response("ok", { status: 200 })],
  ["a 200 that names another row", () => Response.json({ id: "y", updatedAt: "t" })],
  ["a 403", () => Response.json({ error: "forbidden" }, { status: 403 })],
  ["a 503", () => Response.json({ error: "embedding_unavailable" }, { status: 503 })],
])("%s is not counted as re-embedded, and the stored model is not read", async (_label, response) => {
  stubFetch(response);
  const reader = storedModel("gguf:model");
  expect(await reembedRow("http://127.0.0.1:1", "agent-a", keyFile(), "x", "gguf:model", reader.read)).toBe(false);
  expect(reader.ids).toEqual([]);
}, 10_000);

test.each([
  ["no stored model (the read failed)", undefined],
  ["a stale stored model", "gguf:old-model"],
  ["a different stored model", "onnx:model"],
  ["a null stored model", null],
])("a 200 for the row with %s is not counted as re-embedded", async (_label, model) => {
  stubFetch(() => Response.json({ id: "x", updatedAt: "t" }));
  const reader = storedModel(model);
  expect(await reembedRow("http://127.0.0.1:1", "agent-a", keyFile(), "x", "gguf:model", reader.read)).toBe(false);
  expect(reader.ids).toEqual(["x"]);
}, 10_000);

test("opsStoredModelReader reads only the row's id and embeddingModel through the operations API", async () => {
  const calls = stubFetch(() => Response.json([{ id: "a/b", embeddingModel: "gguf:model" }]));
  expect(await opsStoredModelReader(1, "Basic abc")("a/b")).toBe("gguf:model");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://127.0.0.1:1/");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].init.headers.Authorization).toBe("Basic abc");
  expect(JSON.parse(calls[0].init.body)).toEqual({
    operation: "search_by_id", database: "flair", table: "Memory", ids: ["a/b"], get_attributes: ["id", "embeddingModel"],
  });
}, 10_000);

test.each([
  ["a 401", () => Response.json({ error: "unauthorized" }, { status: 401 })],
  ["no row", () => Response.json([])],
  ["another row", () => Response.json([{ id: "y", embeddingModel: "gguf:model" }])],
  ["a body that is not JSON", () => new Response("ok", { status: 200 })],
  ["a request that fails", () => { throw new Error("connection refused"); }],
])("opsStoredModelReader answers undefined for %s", async (_label, response) => {
  stubFetch(response);
  expect(await opsStoredModelReader(1, "Basic abc")("x")).toBeUndefined();
}, 10_000);

test("agentStoredModelReader reads the row with a signed GET as the agent", async () => {
  const calls = stubFetch(() => Response.json({ id: "a/b", content: "text", embeddingModel: "gguf:model" }));
  expect(await agentStoredModelReader("http://127.0.0.1:1", "agent-a", keyFile())("a/b")).toBe("gguf:model");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://127.0.0.1:1/Memory/a%2Fb");
  expect(calls[0].init.method).toBe("GET");
  expect(calls[0].init.headers.Authorization).toStartWith("TPS-Ed25519 agent-a:");
  expect(calls[0].init.body).toBeUndefined();
}, 10_000);

test.each([
  ["a 404", () => Response.json({ error: "not_found" }, { status: 404 })],
  ["another row", () => Response.json({ id: "y", embeddingModel: "gguf:model" })],
  ["a body that is not JSON", () => new Response("ok", { status: 200 })],
  ["a request that fails", () => { throw new Error("connection refused"); }],
])("agentStoredModelReader answers undefined for %s", async (_label, response) => {
  stubFetch(response);
  expect(await agentStoredModelReader("http://127.0.0.1:1", "agent-a", keyFile())("x")).toBeUndefined();
}, 10_000);
