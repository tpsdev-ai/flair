/**
 * Hermetic tests for flair#1332 (customMetadata + subject) and flair#1333
 * (listMemories) — the JS-package parity port of #1334 (flair#1335).
 *
 * Mirrors packages/adk-flair/tests/test_metadata_and_list.py's hermetic tier:
 * mocked fetch — write-body shape, caps (64KB / depth / key-count /
 * subject-512), precedence, read-path fail-soft, listMemories URL
 * construction + scoping + validation. The live tier is ported to
 * test/integration/metadata_and_list.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { FlairMemoryService } from "../../src/memory_service.js";
import type { FlairMemoryEntry } from "../../src/memory_service.js";
import type { MemoryEntry } from "@google/adk";
import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTestKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const b64 = Buffer.from(der).toString("base64");
  const keyfilePath = path.join(os.tmpdir(), `adk-flair-js-meta-${crypto.randomUUID()}.key`);
  fs.writeFileSync(keyfilePath, b64, "utf-8");
  return keyfilePath;
}

function entry(text: string, id?: string, timestamp?: string): MemoryEntry & { id?: string } {
  return {
    id,
    content: { role: "user", parts: [{ text }] } as Content,
    timestamp,
  };
}

function makeSimpleEvent(eventId: string, text: string): Event {
  return {
    id: eventId,
    invocationId: crypto.randomUUID(),
    author: "user",
    actions: {} as Event["actions"],
    timestamp: Date.now(),
    content: { role: "user", parts: [{ text }] } as Content,
  };
}

interface CapturedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Install a mock fetch that records calls and answers with `responder`. */
function captureFetch(
  responder: (call: CapturedCall, index: number) => Response = () =>
    new Response(JSON.stringify({ ok: true }), { status: 201 }),
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = mock(async (url, init) => {
    const rawBody = (init as RequestInit | undefined)?.body;
    const call: CapturedCall = {
      method: (init as RequestInit | undefined)?.method ?? "GET",
      url: String(url),
      body: typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : null,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  return calls;
}

function searchResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({ results }), { status: 200 });
}

function listResponse(rows: unknown): Response {
  return new Response(JSON.stringify(rows), { status: 200 });
}

/** Capture console.warn lines for the duration of `fn`. */
async function withCapturedWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.warn = origWarn;
  }
  return warnings;
}

// ─── Shared fixture ──────────────────────────────────────────────────────────

let keyfilePath: string;
let service: FlairMemoryService;
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  keyfilePath = generateTestKey();
  service = new FlairMemoryService({
    url: "http://localhost:19926",
    agentId: "test-agent",
    keyfile: keyfilePath,
  });
  origFetch = globalThis.fetch;
});

afterEach(() => {
  try { fs.unlinkSync(keyfilePath); } catch {}
  globalThis.fetch = origFetch;
});

// ─── Metadata write path ─────────────────────────────────────────────────────

describe("metadata write path", () => {
  it("addMemory serializes customMetadata into body.metadata", async () => {
    const nested = {
      merchant: "acme", price: { amount: 12.5, ccy: "EUR" },
      tags: ["a", "b"], nested: { deep: { ok: true } },
    };
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("fact")], nested);
    expect(calls).toHaveLength(1);
    const metadata = calls[0].body?.["metadata"];
    expect(typeof metadata).toBe("string");
    expect(JSON.parse(metadata as string)).toEqual(nested);
  });

  it("addEventsToMemory serializes customMetadata into every event body", async () => {
    const calls = captureFetch();
    await service.addEventsToMemory(
      "app", "user",
      [makeSimpleEvent("evt-0", "turn 0"), makeSimpleEvent("evt-1", "turn 1")],
      "s1", { source: "cam-1" },
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.parse(call.body?.["metadata"] as string)).toEqual({ source: "cam-1" });
    }
  });

  it("no customMetadata means no metadata key and no subject key", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("plain")]);
    expect(calls[0].body).not.toContainKey("metadata");
    expect(calls[0].body).not.toContainKey("subject");
  });

  it("oversize metadata (64KB) rejects before any HTTP call", async () => {
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], { blob: "y".repeat(64 * 1024) }),
    ).rejects.toThrow(/64|byte/);
    expect(calls).toHaveLength(0);
  });

  it("nesting over 16 levels rejects before any HTTP call", async () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 17; i++) deep = { n: deep };
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], deep),
    ).rejects.toThrow(/nesting/);
    expect(calls).toHaveLength(0);
  });

  it("nesting of exactly 16 levels is accepted (boundary control)", async () => {
    // The depth guard must not fire early.
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 15; i++) node = { n: node }; // 16 object levels total
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("x")], node);
    expect(calls).toHaveLength(1);
  });

  it("key count over 512 rejects before any HTTP call", async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 513; i++) wide[`k${i}`] = i;
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], wide),
    ).rejects.toThrow(/keys/);
    expect(calls).toHaveLength(0);
  });

  it("key count counts nested keys", async () => {
    // 2 top-level + 511 nested = 513 total → reject
    const inner: Record<string, unknown> = {};
    for (let i = 0; i < 511; i++) inner[`k${i}`] = i;
    await expect(
      service.addMemory("app", "user", [entry("x")], { a: inner, b: 1 }),
    ).rejects.toThrow(/keys/);
  });

  it("non-serializable value skips that key with a warning naming the session", async () => {
    const calls = captureFetch();
    const warnings = await withCapturedWarnings(async () => {
      await service.addEventsToMemory(
        "app", "user", [makeSimpleEvent("evt-1", "hello")], "sess-9",
        { good: "kept", bad: () => "not serializable" },
      );
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body?.["metadata"] as string)).toEqual({ good: "kept" });
    const joined = warnings.join(" | ");
    expect(joined).toContain("bad");
    // The warning must carry the session key so the skip is traceable.
    expect(joined).toContain("app:user:sess-9");
  });

  it("all values non-serializable yields no metadata key", async () => {
    const calls = captureFetch();
    await withCapturedWarnings(async () => {
      await service.addMemory("app", "user", [entry("x")], { bad: () => 1 });
    });
    expect(calls[0].body).not.toContainKey("metadata");
  });

  it("a circular blob is rejected by the depth cap, never serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], circular),
    ).rejects.toThrow(/nesting/);
    expect(calls).toHaveLength(0);
  });
});

// ─── Subject write path ──────────────────────────────────────────────────────

describe("subject write path", () => {
  it("explicit subject option lands top-level", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("x")], undefined, {
      subject: "Receipt: Acme",
    });
    expect(calls[0].body?.["subject"]).toBe("Receipt: Acme");
    expect(calls[0].body).not.toContainKey("metadata"); // subject alone stores no blob
  });

  it("customMetadata.subject lands top-level and stays in the blob", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("x")], { subject: "From Blob", k: 1 });
    expect(calls[0].body?.["subject"]).toBe("From Blob");
    // The blob is stored verbatim — promotion copies, never strips.
    expect(JSON.parse(calls[0].body?.["metadata"] as string))
      .toEqual({ subject: "From Blob", k: 1 });
  });

  it("explicit option is authoritative over customMetadata.subject", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("x")],
      { subject: "blob-says" }, { subject: "param-says" });
    expect(calls[0].body?.["subject"]).toBe("param-says");
    expect(JSON.parse(calls[0].body?.["metadata"] as string)["subject"]).toBe("blob-says");
  });

  it("subject over 512 chars rejects before any HTTP call", async () => {
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], undefined, {
        subject: "s".repeat(513),
      }),
    ).rejects.toThrow(/512/);
    expect(calls).toHaveLength(0);
  });

  it("subject of exactly 512 chars is accepted", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user", [entry("x")], undefined, {
      subject: "s".repeat(512),
    });
    expect(calls[0].body?.["subject"]).toBe("s".repeat(512));
  });

  it("non-string customMetadata.subject rejects", async () => {
    const calls = captureFetch();
    await expect(
      service.addMemory("app", "user", [entry("x")], { subject: { not: "a string" } }),
    ).rejects.toThrow(/string/);
    expect(calls).toHaveLength(0);
  });

  it("subject is never auto-extracted from content", async () => {
    const calls = captureFetch();
    await service.addMemory("app", "user",
      [entry("A very titled-looking first line\nbody")]);
    expect(calls[0].body).not.toContainKey("subject");
  });

  it("customMetadata.subject applies on event writes too", async () => {
    const calls = captureFetch();
    await service.addEventsToMemory(
      "app", "user", [makeSimpleEvent("evt-1", "hello")], "s1",
      { subject: "Session Topic" },
    );
    expect(calls[0].body?.["subject"]).toBe("Session Topic");
  });
});

// ─── Read path (searchMemory) ────────────────────────────────────────────────

describe("metadata read path (searchMemory)", () => {
  it("metadata blob parses into customMetadata", async () => {
    const blob = { merchant: "acme", n: { deep: [1, 2] } };
    captureFetch(() => searchResponse([{
      id: "m1", agentId: "test-agent", content: "c",
      createdAt: "2026-08-22T00:00:00.000Z",
      tags: ["adk:app:user"], metadata: JSON.stringify(blob),
    }]));
    const result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    expect((result.memories[0] as FlairMemoryEntry).customMetadata).toEqual(blob);
  });

  it("search body opts into the metadata projection", async () => {
    const calls = captureFetch(() => searchResponse([]));
    await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    expect(calls[0].body?.["includeMetadata"]).toBe(true);
  });

  it("malformed metadata fails soft with a warning naming the record id", async () => {
    captureFetch(() => searchResponse([{
      id: "m-broken", agentId: "test-agent", content: "still readable",
      tags: ["adk:app:user"], metadata: "{not json",
    }]));
    let result: Awaited<ReturnType<typeof service.searchMemory>> | undefined;
    const warnings = await withCapturedWarnings(async () => {
      result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    });
    // A corrupt blob must not drop the memory.
    expect(result!.memories).toHaveLength(1);
    expect((result!.memories[0] as FlairMemoryEntry).customMetadata).toEqual({});
    // The warning must name the record id.
    expect(warnings.join(" | ")).toContain("m-broken");
  });

  it("non-object JSON metadata fails soft to {}", async () => {
    captureFetch(() => searchResponse([{
      id: "m-arr", agentId: "test-agent", content: "c",
      tags: ["adk:app:user"], metadata: "[1,2,3]",
    }]));
    let result: Awaited<ReturnType<typeof service.searchMemory>> | undefined;
    await withCapturedWarnings(async () => {
      result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    });
    expect((result!.memories[0] as FlairMemoryEntry).customMetadata).toEqual({});
  });

  it("subject column is authoritative over a divergent blob key", async () => {
    captureFetch(() => searchResponse([{
      id: "m1", agentId: "test-agent", content: "c",
      tags: ["adk:app:user"],
      metadata: JSON.stringify({ subject: "stale-blob-value" }),
      subject: "column-value",
    }]));
    const result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    const hit = result.memories[0] as FlairMemoryEntry;
    expect(hit.customMetadata["subject"]).toBe("column-value");
    expect(hit.subject).toBe("column-value");
  });

  it("subject column surfaces without a blob — both channels", async () => {
    // A subject written via the explicit option has no blob — it must still
    // round-trip. JS MemoryEntry is a plain object, so Flair surfaces it
    // top-level (entry.subject) AND as customMetadata.subject (the Python
    // package's only channel — kept for cross-language parity).
    captureFetch(() => searchResponse([{
      id: "m1", agentId: "test-agent", content: "c",
      tags: ["adk:app:user"], subject: "Param Subject",
    }]));
    const result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    const hit = result.memories[0] as FlairMemoryEntry;
    expect(hit.customMetadata).toEqual({ subject: "Param Subject" });
    expect(hit.subject).toBe("Param Subject");
  });

  it("author derives from agentId", async () => {
    captureFetch(() => searchResponse([{
      id: "m1", agentId: "test-agent", content: "c", tags: ["adk:app:user"],
    }]));
    const result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    expect(result.memories[0].author).toBe("test-agent");
  });

  it("no metadata and no subject yields an empty customMetadata object", async () => {
    captureFetch(() => searchResponse([{
      id: "m1", agentId: "test-agent", content: "c", tags: ["adk:app:user"],
    }]));
    const result = await service.searchMemory({ appName: "app", userId: "user", query: "q" });
    expect((result.memories[0] as FlairMemoryEntry).customMetadata).toEqual({});
  });
});

// ─── listMemories ────────────────────────────────────────────────────────────

describe("listMemories", () => {
  it("URL construction, default page", async () => {
    const calls = captureFetch(() => listResponse([]));
    await service.listMemories("app", "user");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    const url = calls[0].url;
    expect(url.startsWith("http://localhost:19926/Memory/?")).toBe(true);
    expect(url).toContain("tags=adk%3Aapp%3Auser");
    expect(url).toContain("agentId=test-agent");
    expect(url).toContain("sort(-createdAt)");
    expect(url).toContain("limit(0,50)");
    expect(url).toContain("select(id,agentId,content,metadata,subject,tags,createdAt)");
  });

  it("offset window", async () => {
    const calls = captureFetch(() => listResponse([]));
    await service.listMemories("app", "user", { limit: 25, offset: 10 });
    expect(calls[0].url).toContain("limit(10,35)");
  });

  it("tag percent-escapes survive URL encoding", async () => {
    // A userId containing ':' produces a tag with literal %3A — the URL
    // value must encode the '%' itself so the server-side decode restores
    // the exact stored tag.
    const calls = captureFetch(() => listResponse([]));
    await service.listMemories("app", "alice:admin");
    // tag = adk:app:alice%3Aadmin → encoded: adk%3Aapp%3Aalice%253Aadmin
    expect(calls[0].url).toContain("tags=adk%3Aapp%3Aalice%253Aadmin");
  });

  it("limit over the 200 cap rejects (never clamps)", async () => {
    const calls = captureFetch(() => listResponse([]));
    await expect(service.listMemories("app", "user", { limit: 201 }))
      .rejects.toThrow(/200/);
    expect(calls).toHaveLength(0);
  });

  it("limit at the cap is accepted", async () => {
    const calls = captureFetch(() => listResponse([]));
    await service.listMemories("app", "user", { limit: 200 });
    expect(calls[0].url).toContain("limit(0,200)");
  });

  it("limit zero rejects", async () => {
    await expect(service.listMemories("app", "user", { limit: 0 }))
      .rejects.toThrow(/positive/);
  });

  it("non-integer limit rejects", async () => {
    await expect(service.listMemories("app", "user", { limit: 2.5 }))
      .rejects.toThrow(/positive integer/);
  });

  it("negative offset rejects", async () => {
    await expect(service.listMemories("app", "user", { offset: -1 }))
      .rejects.toThrow(/offset/);
  });

  it("empty userId rejects", async () => {
    const calls = captureFetch(() => listResponse([]));
    await expect(service.listMemories("app", "")).rejects.toThrow(/userId/);
    expect(calls).toHaveLength(0);
  });

  it("empty appName rejects", async () => {
    await expect(service.listMemories("", "user")).rejects.toThrow(/appName/);
  });

  it("rows map to full FlairMemoryEntry projections", async () => {
    const blob = { k: "v" };
    captureFetch(() => listResponse([{
      id: "m1", agentId: "test-agent", content: "hello",
      createdAt: "2026-08-22T01:00:00.000Z",
      tags: ["adk:app:user"],
      metadata: JSON.stringify(blob), subject: "Title",
    }]));
    const entries = await service.listMemories("app", "user");
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.id).toBe("m1");
    expect(e.author).toBe("test-agent");
    expect(e.timestamp).toBe("2026-08-22T01:00:00.000Z");
    expect((e.content?.parts?.[0] as { text?: string }).text).toBe("hello");
    expect(e.customMetadata).toEqual({ k: "v", subject: "Title" });
    expect(e.subject).toBe("Title");
  });

  it("scope re-verification drops foreign rows", async () => {
    captureFetch(() => listResponse([
      { id: "mine", agentId: "test-agent", content: "c", tags: ["adk:app:user"] },
      { id: "wrong-tag", agentId: "test-agent", content: "c", tags: ["adk:app:other"] },
      { id: "wrong-agent", agentId: "someone-else", content: "c", tags: ["adk:app:user"] },
    ]));
    const entries = await service.listMemories("app", "user");
    expect(entries.map((e) => e.id)).toEqual(["mine"]);
  });

  it("non-array response returns empty", async () => {
    captureFetch(() => listResponse({ unexpected: "shape" }));
    expect(await service.listMemories("app", "user")).toEqual([]);
  });

  it("transport error PROPAGATES", async () => {
    // Unlike searchMemory (ADK's swallow-to-empty contract), a browsing API
    // must distinguish "no memories" from "Flair is down".
    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(service.listMemories("app", "user"))
      .rejects.toThrow(/ECONNREFUSED/);
  });

  it("HTTP error PROPAGATES with the status", async () => {
    captureFetch(() => new Response("boom", { status: 500 }));
    await expect(service.listMemories("app", "user"))
      .rejects.toThrow(/500/);
  });
});
