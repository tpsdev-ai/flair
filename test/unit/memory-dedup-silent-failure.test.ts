import { describe, it, expect, mock } from "bun:test";
import { FlairClient } from "../../packages/flair-client/src/client";

/**
 * P0 regression (historical): the dedup branch in write() used to run a
 * client-side pre-flight search and, on a match, return the EXISTING record
 * WITHOUT writing the new content — a success-shaped response with a real
 * ID + content + "Memory stored" when nothing new was actually persisted.
 *
 * Memory-integrity fix (flair#526): the dedup gate moved SERVER-SIDE
 * (resources/Memory.ts, Memory.post()/Memory.put()) and NEVER suppresses a
 * write. write() now always issues exactly one PUT and always returns the
 * record it sent, merged with whatever collision signal the server reports
 * (`deduplicated` / `matchedId` / `matchConfidence`) — never the old
 * `deduped: true` + existing-record-swap shape. These tests guard against
 * that suppression ever being reintroduced client-side.
 */
describe("memory dedup — never-silent-loss (flair#526 fix)", () => {
  const content1 = "Test memory about widgets and gadgets";
  const content2 = "Test memory about widgets";

  it("first write succeeds and returns the written memory", async () => {
    const requestSpy = mock(async (_method: string, _path: string, _body?: unknown) => ({}));
    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    const result = await client.memory.write(content1, { dedup: true, dedupThreshold: 0.95 });

    expect(result.id).toBeDefined();
    expect(result.content).toBe(content1);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toBe("PUT");
  });

  it("a near-duplicate write is STILL written — never suppressed, never dropped", async () => {
    // Simulate the server's dedup gate finding a conservative match: it
    // still returns a normal PUT-success shape, PLUS the collision signal.
    const requestSpy = mock(async (_method: string, _path: string, _body?: unknown) => ({
      deduplicated: true,
      matchedId: "test-agent-existing-1",
      matchConfidence: { cosine: 0.97, lexical: 0.8 },
      written: true,
    }));
    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    const result = await client.memory.write(content2, { dedup: true, dedupThreshold: 0.95 });

    // Exactly one write call — no client-side pre-flight search exists anymore.
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toBe("PUT");
    // The NEW content was written under a NEW id — never swapped for the
    // existing match's id/content (the old bug's exact failure mode).
    expect(result.id).not.toBe("test-agent-existing-1");
    expect(result.content).toBe(content2);
    expect((result as any).written).toBe(true);
    // The collision signal passes through as a SIGNAL, not a suppression flag.
    expect((result as any).deduplicated).toBe(true);
    expect((result as any).matchedId).toBe("test-agent-existing-1");
    expect((result as any).matchConfidence).toEqual({ cosine: 0.97, lexical: 0.8 });
  });

  it("dedup/dedupThreshold are forwarded as passthrough hints in the request body", async () => {
    const requestSpy = mock(async (_method: string, _path: string, body?: unknown) => {
      expect((body as any).dedup).toBe(true);
      expect((body as any).dedupThreshold).toBe(0.8);
      return {};
    });
    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    await client.memory.write(content1, { dedup: true, dedupThreshold: 0.8 });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("short content still writes normally (server applies its own length bypass)", async () => {
    const requestSpy = mock(async () => ({}));
    const client = new FlairClient({ agentId: "test-agent" });
    client.request = requestSpy as any;

    const result = await client.memory.write("ok", { dedup: true, dedupThreshold: 0.95 });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("ok");
  });
});
