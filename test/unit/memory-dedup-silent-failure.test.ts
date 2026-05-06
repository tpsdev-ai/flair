import { describe, it, expect, mock } from "bun:test";
import { FlairClient } from "../../packages/flair-client/src/client";
import type { Memory } from "../../packages/flair-client/src/types";

/**
 * P0 regression: The dedup branch in write() returned the existing memory
 * without any signal, so callers got a success-shaped response with a real
 * ID + content + "Memory stored" when nothing was actually written.
 *
 * Fix: dedup branch sets `deduped: true` on the return so callers can detect
 * that a new write was suppressed.
 */
describe("memory dedup silent failure (P0 regression)", () => {
  const content1 = "Test memory about widgets and gadgets";
  const content2 = "Test memory about widgets";

  const fakeMemory: Memory = {
    id: "mem-abc-123",
    agentId: "test-agent",
    content: content1,
    type: "session",
    durability: "standard",
    tags: [],
    createdAt: new Date().toISOString(),
  };

  it("first write succeeds and returns the written memory", async () => {
    // For the first write: search returns empty (no dup), then PUT succeeds.
    const requestSpy = mock(async (_method: string, _path: string, _body?: unknown) => ({}));

    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    // Override search to return empty (no duplicate)
    const searchSpy = mock(async () => []);
    (client.memory as any).search = searchSpy;

    const result = await client.memory.write(content1, {
      dedup: true,
      dedupThreshold: 0.95,
    });

    expect(result.id).toBeDefined();
    expect(result.content).toBe(content1);
    expect(result.deduped).toBeUndefined();
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalled();
  });

  it("second write (near-duplicate) returns deduped: true with first write's content", async () => {
    // For the second write: search returns a hit, then get resolves to fakeMemory.
    // No PUT should be called.
    const requestSpy = mock(async (_method: string, _path: string, _body?: unknown) => {
      throw new Error("PUT should not be called on dedup hit");
    });

    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    // Simulate search returning a near-duplicate hit
    const searchSpy = mock(async () => [{ id: fakeMemory.id, content: fakeMemory.content, score: 0.97 }]);
    (client.memory as any).search = searchSpy;

    // get returns the existing memory
    const getSpy = mock(async () => fakeMemory);
    (client.memory as any).get = getSpy;

    const result = await client.memory.write(content2, {
      dedup: true,
      dedupThreshold: 0.95,
    });

    // Must signal dedup was suppressed
    expect((result as any).deduped).toBe(true);
    // ID matches the first write's ID, not a newly generated one
    expect(result.id).toBe(fakeMemory.id);
    // Content matches the FIRST write, not the second
    expect(result.content).toBe(content1);
    // Search was called
    expect(searchSpy).toHaveBeenCalledTimes(1);
    // get was called
    expect(getSpy).toHaveBeenCalled();
  });

  it("reads the originally-written memory — content matches first write, not second", async () => {
    const client = new FlairClient({ agentId: "test-agent" });

    const getSpy = mock(async () => fakeMemory);
    (client.memory as any).get = getSpy;

    const mem = await client.memory.get(fakeMemory.id);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe(content1);
  });

  it("dedup not triggered when content is short (< 20 chars)", async () => {
    const shortContent = "ok";
    const requestSpy = mock(async () => ({}));

    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    const searchSpy = mock(async () => [{ id: "match", content: "ok", score: 0.99 }]);
    (client.memory as any).search = searchSpy;

    await client.memory.write(shortContent, {
      dedup: true,
      dedupThreshold: 0.95,
    });

    // Search should NOT have been called for short content
    expect(searchSpy).not.toHaveBeenCalled();
    // PUT should have been called (it creates a new entry)
    expect(requestSpy).toHaveBeenCalled();
  });
});
