import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FlairClient, FlairError } from "../src/client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function client() {
  return new FlairClient({ agentId: "me", url: "http://localhost:19926", privateKey: generateKeyPairSync("ed25519").privateKey, adminUser: "", adminPassword: "" });
}

test("the response cap cancels oversized error bodies before the status branch", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1024))); },
    pull(controller) { controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  globalThis.fetch = (async () => new Response(body, { status: 503 })) as typeof fetch;
  await expect(client().request("GET", "/Memory", undefined, { maxResponseBytes: 32 })).rejects.toThrow("response body exceeds 32 bytes");
  expect(cancelled).toBe(true);
});

test("an error body within the cap still returns FlairError", async () => {
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  await expect(client().request("GET", "/Memory", undefined, { maxResponseBytes: 32 })).rejects.toBeInstanceOf(FlairError);
});

test("memory.write sends signed JSON metadata with all supplied keys", async () => {
  let record: any;
  let authorization = "";
  globalThis.fetch = (async (_url, init) => {
    record = JSON.parse(init!.body as string);
    authorization = (init!.headers as Record<string, string>).Authorization;
    return new Response("{}");
  }) as typeof fetch;
  const metadata = { other: { keep: true }, flairActionRecall: { v: 1, triggers: [] } };
  await client().memory.write("lesson", { metadata });
  expect(JSON.parse(record.metadata)).toEqual(metadata);
  expect(authorization).toStartWith("TPS-Ed25519 me:");
});

for (const preserveHistory of [false, true]) {
  test(`memory.update merges metadata keys (preserveHistory=${preserveHistory})`, async () => {
    let written: any;
    globalThis.fetch = (async (_url, init) => {
      if (init!.method === "GET") return new Response(JSON.stringify({ id: "m1", agentId: "me", content: "lesson", metadata: JSON.stringify({ other: { keep: true }, flairActionRecall: { v: 1, triggers: ["old"] } }) }));
      written = JSON.parse(init!.body as string);
      return new Response("{}");
    }) as typeof fetch;
    const flairActionRecall = { v: 1, triggers: [] };
    await client().memory.update("m1", "lesson", { preserveHistory, metadata: { flairActionRecall } });
    expect(JSON.parse(written.metadata)).toEqual({ other: { keep: true }, flairActionRecall });
  });
}

test("memory.update accepts absent metadata and refuses malformed metadata without writing", async () => {
  for (const metadata of [null, undefined, "broken", "[]"]) {
    let writes = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init!.method === "GET") return new Response(JSON.stringify({ id: "m1", agentId: "me", content: "lesson", metadata }));
      writes++;
      return new Response("{}");
    }) as typeof fetch;
    const updated = client().memory.update("m1", "lesson", { metadata: { other: 1 } });
    if (metadata == null) {
      expect(JSON.parse((await updated).metadata!)).toEqual({ other: 1 });
      expect(writes).toBe(1);
    } else {
      await expect(updated).rejects.toThrow();
      expect(writes).toBe(0);
    }
  }
});
