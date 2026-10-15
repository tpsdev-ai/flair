/**
 * memory-id-checkpoint.test.ts — flair#2218 real-Harper acceptance.
 *
 * A REAL Harper boots here; the checkpoint and the verify go through the REAL
 * admin operations API (search_by_conditions paged, describe_table), not a stub,
 * because the whole point of the guard is that it reads what Harper serves.
 *
 *   - nothing deleted between checkpoint and verify → verified;
 *   - one Memory row deleted between them → integrity failure naming it;
 *   - an unreachable instance → unknown, never verified.
 *
 * Everything is HOME/ROOTPATH-isolated and ephemeral via test/helpers/harper-lifecycle;
 * teardown kills only the PIDs startHarper started. Fixtures use neutral names.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import {
  buildCheckpoint,
  buildOpsPost,
  readMemoryRowCount,
  readMemoryRowsPaged,
  readCheckpointFile,
  writeCheckpointFile,
  verifyCheckpoint,
  type MemoryCheckpoint,
} from "../../src/memory-id-checkpoint.js";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
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
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

/** A loopback port nothing is listening on (bound then released). */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

let harper: HarperInstance;
let dir: string;
let checkpointFile: string;
let checkpoint: MemoryCheckpoint;

const agent = mkAgent(`ckpt-agent-${randomUUID()}`);
const KEEP = `${agent.id}-keep`;
const DROP = `${agent.id}-drop`;
const PLAIN = `${agent.id}-plain`;

beforeAll(async () => {
  harper = await startHarper();
  dir = mkdtempSync(join(tmpdir(), "flair-2218-"));
  checkpointFile = join(dir, "checkpoint.json");

  await registerAgent(harper, agent);
  const seed: [string, string][] = [[KEEP, "permanent"], [DROP, "persistent"], [PLAIN, "standard"]];
  for (const [id, durability] of seed) {
    const res = await putMemory(harper, agent, id, { agentId: agent.id, content: `2218 seed ${id}`, durability });
    expect(res.status, `seed ${id} → ${res.status}`).toBe(200);
  }

  const opsPost = buildOpsPost(harper.opsURL, harper.admin.username, harper.admin.password);
  const expected = await readMemoryRowCount(opsPost);
  const rows = await readMemoryRowsPaged(opsPost, { expected });
  checkpoint = buildCheckpoint({ node: new URL(harper.opsURL).origin, at: new Date().toISOString(), rows });
  writeCheckpointFile(checkpointFile, checkpoint);

  for (const [id] of seed) expect(checkpoint.ids).toContain(id);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("flair#2218 — Memory id checkpoint guard, real Harper", () => {
  test("nothing deleted between checkpoint and verify → verified", async () => {
    const read = readCheckpointFile(checkpointFile);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    const result = await verifyCheckpoint({
      checkpoint: read.checkpoint,
      target: new URL(harper.opsURL).origin,
      user: harper.admin.username,
      password: harper.admin.password,
    });
    expect(result.outcome).toBe("verified");
    expect(result.missing).toEqual([]);
    expect(result.tierDrops).toEqual([]);
  }, 60_000);

  test("one Memory row deleted between checkpoint and verify → integrity failure naming it", async () => {
    const del = await adminOp(harper, { operation: "delete", database: "flair", table: "Memory", ids: [DROP] });
    expect(del.status, `delete ${DROP} → ${del.status}`).toBe(200);

    const result = await verifyCheckpoint({
      checkpoint,
      target: new URL(harper.opsURL).origin,
      user: harper.admin.username,
      password: harper.admin.password,
    });
    expect(result.outcome).toBe("integrity-failure");
    expect(result.missing).toContain(DROP);
    expect(result.detail).toContain(DROP);
  }, 60_000);

  test("an unreachable instance → unknown, never verified", async () => {
    const port = await closedPort();
    const target = `http://127.0.0.1:${port}`;
    const cp = buildCheckpoint({ node: target, at: new Date().toISOString(), rows: [{ id: "mem-x", durability: "permanent" }] });
    const result = await verifyCheckpoint({ checkpoint: cp, target, user: harper.admin.username, password: harper.admin.password });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBeTruthy();
  }, 60_000);
});
