/**
 * persistLocalPeerLastSyncAt — flair#1146.
 *
 * Callers stamp lastSyncAt only after confirmed FederationSync contact.
 * The helper read-then-upserts the full Peer row (hardening, not because
 * today's Harper partial `update` fails — Kern probed 5.2.8 / 5.1.22).
 * Search-miss must refuse to write rather than upsert `{id, lastSyncAt}`.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { persistLocalPeerLastSyncAt } from "../../src/commands/federation.ts";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("persistLocalPeerLastSyncAt (flair#1146)", () => {
  test("searches the full Peer row and upserts lastSyncAt without dropping publicKey", async () => {
    const calls: Array<{ body?: any }> = [];
    const existing = {
      id: "hub-1",
      publicKey: "hub-public-key",
      role: "hub",
      status: "paired",
      endpoint: "https://hub.example",
      pairedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const stamp = "2026-09-18T20:00:00.000Z";

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ body });
      if (body?.operation === "search_by_value") {
        return {
          ok: true,
          status: 200,
          json: async () => [existing],
          text: async () => JSON.stringify([existing]),
        } as Response;
      }
      if (body?.operation === "upsert") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => "{}",
        } as Response;
      }
      throw new Error(`unexpected op ${body?.operation}`);
    }) as any;

    const result = await persistLocalPeerLastSyncAt({
      opsEndpoint: "http://127.0.0.1:19925",
      auth: "Basic dGVzdA==",
      peerId: "hub-1",
      lastSyncAt: stamp,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.body?.operation).toBe("search_by_value");
    expect(calls[0]?.body?.table).toBe("Peer");
    expect(calls[0]?.body?.search_value).toBe("hub-1");
    expect(calls[1]?.body?.operation).toBe("upsert");
    const row = calls[1]?.body?.records?.[0];
    expect(row.id).toBe("hub-1");
    expect(row.publicKey).toBe("hub-public-key");
    expect(row.status).toBe("paired");
    expect(row.lastSyncAt).toBe(stamp);
    expect(row.updatedAt).toBe(stamp);
  });

  test("search-miss refuses to upsert a partial Peer (no publicKey wipe path)", async () => {
    const calls: Array<{ body?: any }> = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ body });
      if (body?.operation === "search_by_value") {
        return {
          ok: true,
          status: 200,
          json: async () => [],
          text: async () => "[]",
        } as Response;
      }
      throw new Error(`upsert must not run on search-miss; got ${body?.operation}`);
    }) as any;

    const result = await persistLocalPeerLastSyncAt({
      opsEndpoint: "http://127.0.0.1:19925",
      auth: "Basic dGVzdA==",
      peerId: "hub-1",
      lastSyncAt: "2026-09-18T20:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused to upsert a partial Peer/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.operation).toBe("search_by_value");
  });
});
