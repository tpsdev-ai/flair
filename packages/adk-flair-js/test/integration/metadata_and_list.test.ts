/**
 * Live tests for flair#1332/#1333 parity (flair#1335) — the JS port of
 * packages/adk-flair/tests/test_metadata_and_list.py's live tier, against a
 * real ephemeral Harper (via the shared getLiveFlair helper):
 *
 *  - the nested metadata round-trip,
 *  - the STORE-AND-RETURN CONTRACT test (Sherlock hard requirement: metadata
 *    blob keys named after server knobs have ZERO effect on the record's
 *    actual visibility/durability), with a positive control proving the
 *    instrument fires,
 *  - subject persistence + precedence,
 *  - listMemories pagination/scope against real query pushdown.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FlairMemoryService, signRequest } from "../../src/index.js";
import type { FlairMemoryEntry } from "../../src/index.js";
import { getLiveFlair, type LiveFlairConfig } from "../helpers/live-flair.js";
import type { MemoryEntry } from "@google/adk";
import type { Content } from "@google/genai";
import * as crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function entry(text: string, id?: string, timestamp?: string): MemoryEntry & { id?: string } {
  return {
    id,
    content: { role: "user", parts: [{ text }] } as Content,
    timestamp,
  };
}

/**
 * Fetch one Memory record by id via signed REST — ground truth for the
 * stored row, independent of the adapter's read path.
 */
async function restGetMemory(
  config: LiveFlairConfig,
  recordId: string,
): Promise<Record<string, unknown>> {
  const path = `/Memory/${recordId}`;
  const auth = signRequest(config.privateKey, config.agentId, "GET", path);
  const resp = await fetch(`${config.httpUrl}${path}`, {
    headers: { Authorization: auth },
  });
  if (resp.status >= 400) {
    throw new Error(`GET ${path} → ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

function liveService(config: LiveFlairConfig): FlairMemoryService {
  return new FlairMemoryService({
    url: config.httpUrl,
    agentId: config.agentId,
    keyfile: config.keyfilePath,
    timeoutMs: 10_000, // ephemeral Harper under test load — not a latency test
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("customMetadata + subject + listMemories (live)", () => {
  let config: LiveFlairConfig | null = null;
  let service: FlairMemoryService | null = null;

  beforeAll(async () => {
    config = await getLiveFlair();
    if (!config) {
      console.log("SKIP: no live Flair available — skipping metadata/list integration tests");
      return;
    }
    service = liveService(config);
  }, { timeout: 200_000 });

  afterAll(async () => {
    if (service) await service.close();
    if (config?.cleanup) await config.cleanup();
  }, { timeout: 15_000 });

  it("nested metadata round-trips through searchMemory", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "meta-rt-js";
    const user = `u-${crypto.randomUUID().slice(0, 8)}`;
    const marker = `rt-marker-${crypto.randomUUID().slice(0, 8)}`;
    const nested = {
      merchant: "acme", price: { amount: 12.5, currency: "EUR" },
      media: ["s3://a.jpg", "s3://b.jpg"],
      flags: { verified: true, score: 0.93, note: null },
    };

    await service.addMemory(app, user, [entry(`receipt ${marker}`)], nested);

    const result = await service.searchMemory({
      appName: app, userId: user, query: marker,
    });
    expect(result.memories.length).toBeGreaterThan(0);
    const hit = result.memories.find((m) => {
      const text = (m.content?.parts?.[0] as { text?: string })?.text ?? "";
      return text.includes(marker);
    }) as FlairMemoryEntry | undefined;
    expect(hit).toBeDefined();
    expect(hit!.customMetadata).toEqual(nested);
  }, { timeout: 60_000 });

  it("metadata is store-and-return ONLY (contract test with positive control)", async () => {
    // SHERLOCK CONTRACT TEST: metadata blob keys that IMPERSONATE server
    // knobs (visibility/durability/residency) have ZERO effect on the
    // record's actual fields. Includes a positive control proving the
    // instrument fires: the EXPLICIT options DO change the stored fields.
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "meta-contract-js";
    const user = `u-${crypto.randomUUID().slice(0, 8)}`;
    const smuggle = {
      visibility: "shared", durability: "permanent", residency: "anywhere",
    };

    // ── The contract half: blob keys must be inert ────────────────────────
    const inertId = `contract-${crypto.randomUUID().slice(0, 8)}`;
    await service.addMemory(
      app, user, [entry("contract probe", inertId)], smuggle,
      // NO explicit durability/visibility → server defaults apply.
    );
    const row = await restGetMemory(config, inertId);
    // blob "durability" key must not leak into the record
    expect(row["durability"]).toBe("standard");
    // blob "visibility" key must not leak into the record
    expect(row["visibility"]).toBe("private");
    // blob key must not materialize as a column
    expect(row).not.toContainKey("residency");
    // And the blob itself is stored verbatim (store-and-return).
    expect(JSON.parse(row["metadata"] as string)).toEqual(smuggle);

    // ── Positive control: the explicit channel DOES move the fields ───────
    // Without this, the inert assertions above prove nothing — the
    // instrument must be shown to detect a moved field.
    const ctlId = `control-${crypto.randomUUID().slice(0, 8)}`;
    await service.addMemory(
      app, user, [entry("positive control", ctlId)], smuggle,
      { durability: "persistent", visibility: "shared" },
    );
    const ctl = await restGetMemory(config, ctlId);
    expect(ctl["durability"]).toBe("persistent");
    expect(ctl["visibility"]).toBe("shared");
  }, { timeout: 60_000 });

  it("subject persists from both sources with explicit-option precedence", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "subj-rt-js";
    const user = `u-${crypto.randomUUID().slice(0, 8)}`;
    const paramId = `subj-param-${crypto.randomUUID().slice(0, 8)}`;
    const blobId = `subj-blob-${crypto.randomUUID().slice(0, 8)}`;
    const bothId = `subj-both-${crypto.randomUUID().slice(0, 8)}`;

    await service.addMemory(app, user, [entry("via param", paramId)], undefined, {
      subject: "Param Subject",
    });
    await service.addMemory(app, user, [entry("via blob", blobId)], {
      subject: "Blob Subject",
    });
    await service.addMemory(app, user, [entry("via both", bothId)], {
      subject: "Blob Says",
    }, { subject: "Param Wins" });

    expect((await restGetMemory(config, paramId))["subject"]).toBe("Param Subject");
    expect((await restGetMemory(config, blobId))["subject"]).toBe("Blob Subject");
    expect((await restGetMemory(config, bothId))["subject"]).toBe("Param Wins");
  }, { timeout: 60_000 });

  it("listMemories: pagination, scope, and createdAt DESC order", async () => {
    if (!config || !service) {
      console.log("SKIP: no live Flair configured");
      return;
    }

    const app = "list-live-js";
    const user = `u-${crypto.randomUUID().slice(0, 8)}`;
    const otherUser = `other-${crypto.randomUUID().slice(0, 8)}`;

    // Three records with controlled createdAt (the adapter passes
    // MemoryEntry.timestamp through as createdAt; POST honors it — #1339).
    const timestamps = [
      "2026-08-20T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z",
    ];
    const ids: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const rid = `list-${i}-${crypto.randomUUID().slice(0, 8)}`;
      ids.push(rid);
      await service.addMemory(
        app, user, [entry(`list item ${i}`, rid, timestamps[i])],
        { idx: i }, { subject: `Item ${i}` },
      );
    }
    // A record for ANOTHER user — must never appear in `user`'s list.
    const foreignId = `foreign-${crypto.randomUUID().slice(0, 8)}`;
    await service.addMemory(app, otherUser, [entry("foreign item", foreignId)]);

    // Full page: newest first, foreign row absent.
    const entries = await service.listMemories(app, user);
    const gotIds = entries.map((e) => e.id);
    expect(gotIds).toEqual([ids[2], ids[1], ids[0]]);
    expect(gotIds).not.toContain(foreignId);
    // Full projection present.
    expect(entries[0].customMetadata).toEqual({ idx: 2, subject: "Item 2" });
    expect(entries[0].author).toBe(config.agentId);
    expect(entries[0].timestamp).toBe("2026-08-22T00:00:00.000Z");

    // Pagination: limit=1 offset=1 → the middle record.
    const page = await service.listMemories(app, user, { limit: 1, offset: 1 });
    expect(page.map((e) => e.id)).toEqual([ids[1]]);
  }, { timeout: 60_000 });
});
