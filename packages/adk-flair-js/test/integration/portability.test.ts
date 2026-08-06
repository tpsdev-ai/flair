/**
 * Integration test 2: Portability proof — memory written via ADK is readable
 * outside ADK (and vice versa).
 *
 * Spec Scenario 4: a memory written through an ADK session is found by a direct
 * Flair REST search authenticating as the same app principal, and vice versa.
 *
 * Ported from packages/adk-flair/tests/test_portability.py.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FlairMemoryService, compoundTag, signRequest } from "../../src/index.js";
import { getLiveFlair, type LiveFlairConfig } from "../helpers/live-flair.js";
import type { MemoryEntry } from "@google/adk";
import type { Session } from "@google/adk";
import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function flairPutMemory(
  httpUrl: string,
  agentId: string,
  privateKey: crypto.KeyObject,
  recordId: string,
  content: string,
  tags: string[],
): Promise<Record<string, unknown>> {
  const path = `/Memory/${recordId}`;
  const auth = signRequest(privateKey, agentId, "PUT", path);
  const resp = await fetch(`${httpUrl}${path}`, {
    method: "PUT",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: recordId,
      agentId,
      content,
      type: "session",
      durability: "standard",
      tags,
    }),
  });
  if (resp.status >= 400) {
    throw new Error(`PUT ${path} → ${resp.status} ${(await resp.text().catch(() => ""))}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function flairSearch(
  httpUrl: string,
  agentId: string,
  privateKey: crypto.KeyObject,
  query: string,
  tag?: string,
): Promise<Array<Record<string, unknown>>> {
  const path = "/SemanticSearch";
  const auth = signRequest(privateKey, agentId, "POST", path);
  const body: Record<string, unknown> = { agentId, q: query, limit: 20 };
  if (tag) body["tag"] = tag;

  const resp = await fetch(`${httpUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (resp.status >= 400) {
    throw new Error(`POST ${path} → ${resp.status} ${(await resp.text().catch(() => ""))}`);
  }
  const data = (await resp.json()) as { results?: Array<Record<string, unknown>> };
  return data.results ?? [];
}

function makeMemoryEntry(text: string): MemoryEntry {
  return {
    content: { role: "user", parts: [{ text }] } as Content,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Portability", () => {
  let config: LiveFlairConfig | null = null;
  let service: FlairMemoryService | null = null;

  beforeAll(async () => {
    config = await getLiveFlair();
    if (!config) {
      console.log("SKIP: no live Flair available — skipping portability integration tests");
      return;
    }
    service = new FlairMemoryService({
      url: config.httpUrl,
      agentId: config.agentId,
      keyfile: config.keyfilePath,
    });
  });

  afterAll(async () => {
    if (service) await service.close();
    if (config?.cleanup) await config.cleanup();
  });

  it("ADK write readable via REST", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "portability-test-js";
    const user = "adk-writer";
    const tag = compoundTag(app, user);

    const uniqueMarker = `portability-marker-${crypto.randomUUID().slice(0, 8)}`;
    const memory = makeMemoryEntry(`ADK wrote this: ${uniqueMarker}`);

    await service.addMemory(app, user, [memory]);

    // Read via direct REST search
    const results = await flairSearch(
      config.httpUrl,
      config.agentId,
      config.privateKey,
      uniqueMarker,
      tag,
    );

    expect(results.length).toBeGreaterThan(0);
    const found = results.some((r) => String(r["content"] ?? "").includes(uniqueMarker));
    expect(found).toBe(true);
  });

  it("REST write readable via ADK", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "portability-test-js";
    const user = "rest-writer";
    const tag = compoundTag(app, user);

    const uniqueMarker = `rest-marker-${crypto.randomUUID().slice(0, 8)}`;
    const recordId = `rest-test-${crypto.randomUUID().slice(0, 8)}`;

    await flairPutMemory(
      config.httpUrl,
      config.agentId,
      config.privateKey,
      recordId,
      `REST wrote this: ${uniqueMarker}`,
      [tag],
    );

    // Read via ADK adapter
    const result = await service.searchMemory({
      appName: app,
      userId: user,
      query: uniqueMarker,
    });

    expect(result.memories.length).toBeGreaterThan(0);
    const found = result.memories.some((m) => {
      const text = (m.content?.parts?.[0] as { text?: string })?.text ?? "";
      return text.includes(uniqueMarker);
    });
    expect(found).toBe(true);
  });

  it("ADK session write readable via REST", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "portability-test-js";
    const user = "session-writer";
    const tag = compoundTag(app, user);

    const uniqueMarker = `session-marker-${crypto.randomUUID().slice(0, 8)}`;
    const session: Session = {
      id: `sess-${crypto.randomUUID().slice(0, 8)}`,
      appName: app,
      userId: user,
      state: {},
      events: [
        {
          id: `evt-${crypto.randomUUID().slice(0, 8)}`,
          invocationId: crypto.randomUUID(),
          author: "test-agent",
          actions: {} as Event["actions"],
          timestamp: Date.now(),
          content: {
            role: "user",
            parts: [{ text: `Session event: ${uniqueMarker}` }],
          } as Content,
        } as Event,
      ],
      lastUpdateTime: Date.now(),
    };

    await service.addSessionToMemory(session);

    // Read via direct REST
    const results = await flairSearch(
      config.httpUrl,
      config.agentId,
      config.privateKey,
      uniqueMarker,
      tag,
    );

    expect(results.length).toBeGreaterThan(0);
    const found = results.some((r) => String(r["content"] ?? "").includes(uniqueMarker));
    expect(found).toBe(true);
  });
});
