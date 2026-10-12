/**
 * memory-update-host-source-2482.test.ts — flair#2482, against a REAL Harper.
 *
 * Ordinary, non-skill, same-ID updates without a host source preserve the
 * stored pointer. A `preserveHistory` successor carries a pointer only for a
 * host source the caller supplies.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

let harper: HarperInstance;
let keyDir: string;
const agent = mkAgent("agent-a-2482");

const adminBasic = () => `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`;

async function adminOp(op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminBasic() },
    body: JSON.stringify(op),
  });
}

async function registerAgent(a: TestAgent): Promise<void> {
  const res = await adminOp({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200); // assertion: the agent was seeded
}

/** The STORED MemoryHostSource row(s) for a memory id, as raw JSON. */
async function pointerRows(memoryId: string): Promise<unknown[]> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "MemoryHostSource",
    search_attribute: "memoryId",
    search_type: "equals",
    search_value: memoryId,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200); // assertion: the pointer read succeeded
  return JSON.parse(await res.text());
}

async function clientFor(a: TestAgent): Promise<FlairClient> {
  const keyPath = join(keyDir, `${a.id}.key`);
  // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
  await writeFile(keyPath, Buffer.from(a.secretKey.slice(0, 32)));
  return new FlairClient({ agentId: a.id, url: harper.httpURL, keyPath });
}

const HOST_SOURCE = {
  v: 1 as const,
  host: "openclaw",
  kind: "run",
  id: "run-1a2b3c4d",
  url: "https://host-a.example/things/42?page=7#frag",
};

describe("flair#2482 — ordinary, non-skill memory.update() host pointers (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-2482-keys-"));
    await registerAgent(agent);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  test("an ordinary, non-skill, same-ID update without a host source preserves the stored pointer", async () => {
    const client = await clientFor(agent);
    const id = `${agent.id}-${randomUUID()}`;
    await client.memory.write("original content", {
      id,
      hostSource: HOST_SOURCE,
      hostSourceScope: "record",
      visibility: "shared",
    });
    const before = JSON.stringify(await pointerRows(id));
    expect(JSON.parse(before).length).toBe(1); // assertion: the pointer row exists

    await client.memory.update(id, "rewritten content");

    expect(JSON.stringify(await pointerRows(id))).toBe(before); // assertion: the stored pointer is byte-identical
  }, 120_000);

  test("an ordinary, non-skill preserveHistory successor without a host source carries no pointer; the predecessor pointer is unchanged", async () => {
    const client = await clientFor(agent);
    const id = `${agent.id}-${randomUUID()}`;
    await client.memory.write("v1", { id, hostSource: HOST_SOURCE, hostSourceScope: "record", visibility: "shared" });
    const before = JSON.stringify(await pointerRows(id));

    const successor = await client.memory.update(id, "v2", { preserveHistory: true });

    expect(successor.id).not.toBe(id); // assertion: a NEW successor row was written
    expect(await pointerRows(successor.id)).toEqual([]); // assertion: the successor carries no pointer
    expect(JSON.stringify(await pointerRows(id))).toBe(before); // assertion: the superseded pointer is unchanged
  }, 120_000);

  test("an ordinary, non-skill preserveHistory successor carries a supplied pointer", async () => {
    const client = await clientFor(agent);
    const id = `${agent.id}-${randomUUID()}`;
    await client.memory.write("v1", { id });

    const successor = await client.memory.update(id, "v2", {
      preserveHistory: true,
      hostSource: HOST_SOURCE,
      hostSourceScope: "record",
    });

    const successorPointers = await pointerRows(successor.id);
    expect(successorPointers.length).toBe(1); // assertion: the successor carries the supplied pointer
  }, 120_000);
});
