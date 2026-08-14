// flair#1189 — a preserveHistory memory_update must mint a successor whose
// retrieval statistics are RESET, not inherited from the superseded record.
//
// The bug (observed on 0.44.4): memory_update with preserveHistory:true
// correctly mints a supersedes-linked successor, but the successor INHERITED
// `retrievalCount` and `lastRetrieved` from the superseded record via the
// `...existing` spread that constructs it. A successor created at 18:48:46
// carried lastRetrieved 10:59:34 — "retrieved" ~8 hours BEFORE it existed —
// silently corrupting anything that reads those fields for recency- or
// usage-based ranking.
//
// The fix (resources/mcp-tools.ts memoryUpdate + packages/flair-client
// update()): retrievalCount and lastRetrieved are RECORD-scoped — a brand-new
// successor has no retrieval history of its own — so both are reset at
// succession construction (retrievalCount → 0, lastRetrieved → unset).
//
// This drives the REAL path via the flair-client SDK's
// `memory.update(id, content, { preserveHistory })` — the SAME entry point
// packages/flair-mcp (the MCP connector) calls — against a real, HOME-isolated
// ephemeral Harper (helpers/harper-lifecycle spawns it with HOME=ROOTPATH=a
// fresh temp dir, never ~/.flair). Model: dedup-supersede-e2e.test.ts (Ed25519
// + admin-op seeding) and relationship-write-surface-e2e.test.ts (FlairClient
// construction from a raw-seed keyPath).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
let keyDir: string;

describe("flair#1189 — preserveHistory successor RESETS retrievalCount + lastRetrieved (record-scoped, not inherited)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-1189-keys-"));
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  test("a memory_update {preserveHistory:true} mints a successor with retrievalCount 0 and a lastRetrieved that never predates its own createdAt", async () => {
    const agent = mkAgent(`retstats-1189-${randomUUID()}`);
    await registerAgent(harper, agent);

    // loadPrivateKey() (flair-client/src/auth.ts) treats an exactly-32-byte
    // file as a raw Ed25519 seed; nacl's secretKey is 64 bytes (seed||pubkey),
    // so write only the leading 32-byte seed.
    const keyPath = join(keyDir, `${agent.id}.key`);
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));

    // The REAL succession path: the flair-client SDK — the same entry point
    // packages/flair-mcp's memory_update calls.
    const client = new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });

    // 1) Write the original record.
    const original: any = await client.memory.write(
      "Original finding: the deploy pipeline gates on both K&S review and green CI before any merge.",
      { durability: "standard" },
    );
    const originalId: string = original.id;
    expect(typeof originalId, `write must hand back an id: ${JSON.stringify(original)}`).toBe("string");

    // 2) Establish the PRECONDITION deterministically: the original carries real
    //    retrieval history — retrievalCount > 0 and a lastRetrieved timestamp in
    //    the PAST. In production SemanticSearch.ts sets these on every search
    //    hit; the mechanism-of-origin is irrelevant to the invariant under test,
    //    so we seed them directly with Harper's partial-merge admin `update` op
    //    (a deterministic, non-flaky precondition — no HNSW-indexing race).
    const seededRetrievalCount = 7;
    const seededLastRetrieved = new Date(Date.now() - 8 * 3600_000).toISOString(); // 8h ago
    const seed = await adminOp(harper, {
      operation: "update", database: "flair", table: "Memory",
      records: [{ id: originalId, retrievalCount: seededRetrievalCount, lastRetrieved: seededLastRetrieved }],
    });
    expect(seed.status, `seed update → ${seed.status}: ${await seed.text()}`).toBe(200);

    // Confirm the seed landed AND reads back through the SAME resource read path
    // the succession code itself uses (client.memory.get → GET /Memory/:id →
    // Memory.get()). If this read stripped the fields the bug would be
    // unreachable — so this is a load-bearing precondition, asserted explicitly.
    const before: any = await client.memory.get(originalId);
    expect(before?.retrievalCount, "precondition: original must carry the seeded retrievalCount").toBe(seededRetrievalCount);
    expect(before?.lastRetrieved, "precondition: original must carry the seeded lastRetrieved").toBe(seededLastRetrieved);

    // 3) THE FIX UNDER TEST: memory_update with preserveHistory:true constructs
    //    the successor (client.ts update()) and PUTs it to real Harper.
    const successor: any = await client.memory.update(
      originalId,
      "Updated finding: the deploy pipeline gates on both K&S review and green CI, plus a signed release tag, before any merge.",
      { preserveHistory: true },
    );
    const successorId: string = successor.id;
    expect(typeof successorId, `update must mint a new successor id: ${JSON.stringify(successor)}`).toBe("string");
    expect(successorId, "successor must be a NEW record, not the same id").not.toBe(originalId);

    // 4) Assert on the PERSISTED successor (stored state, not the in-memory
    //    return value).
    const stored: any = await client.memory.get(successorId);
    expect(stored, `successor ${successorId} must exist in the store`).toBeTruthy();
    // Sanity: this really is the freshly-created supersede successor.
    expect(stored.supersedes, "successor must be supersedes-linked to the original").toBe(originalId);
    expect(typeof stored.createdAt, "successor must have its own createdAt").toBe("string");

    // ── The #1189 invariant ────────────────────────────────────────────────
    // retrievalCount is RECORD-scoped: a brand-new successor has been retrieved
    // zero times of its own — it must NOT inherit the superseded record's count.
    expect(stored.retrievalCount ?? 0,
      `successor must RESET retrievalCount to 0, not inherit the superseded record's (${seededRetrievalCount})`)
      .toBe(0);

    // lastRetrieved must be null/unset OR — if ever present — never earlier than
    // the record's OWN createdAt. The "retrieved before it existed" impossibility
    // the bug produced must be structurally impossible.
    const lr: string | null = stored.lastRetrieved ?? null;
    if (lr !== null) {
      expect(new Date(lr).getTime(),
        `successor lastRetrieved (${lr}) must not predate its own createdAt (${stored.createdAt})`)
        .toBeGreaterThanOrEqual(new Date(stored.createdAt).getTime());
    }
    // And concretely: it must NOT be the superseded record's stale timestamp.
    expect(lr, "successor must not carry the superseded record's stale lastRetrieved").not.toBe(seededLastRetrieved);
  }, 90_000);
});
