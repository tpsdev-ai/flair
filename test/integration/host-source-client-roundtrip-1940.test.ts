/**
 * host-source-client-roundtrip-1940.test.ts — flair#1940 slice 2a.
 *
 * Real-Harper coverage that a host source travels THROUGH the production
 * client: a `memory.write()` with a `hostSource` is returned by `search()`,
 * `get()` and `list()`; a write without one carries none; a reader who may read
 * the record but not the pointer sees the server's `"withheld"` marker; and an
 * invalid pointer is refused with the server's named error. The pointer is
 * bound to the server-stamped row incarnation, so the row is written and read
 * back through the client's own paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient, FlairError } from "../../packages/flair-client/src/client";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
let keyDir: string;

describe("flair#1940 slice 2a — a host source through the production client (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-1940-2a-keys-"));
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  async function clientFor(agent: TestAgent): Promise<FlairClient> {
    await registerAgent(harper, agent);
    const keyPath = join(keyDir, `${agent.id}.key`);
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    return new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
  }

  test("write with a hostSource → search, get and list return it; withheld for another reader; invalid refused", async () => {
    const a = mkAgent(`agent-a-${randomUUID()}`);
    const b = mkAgent(`agent-b-${randomUUID()}`);
    const clientA = await clientFor(a);
    const clientB = await clientFor(b);

    const id = `${a.id}-${randomUUID()}`;
    const hostSource = { v: 1 as const, host: "openclaw", kind: "run", id: "run-1a2b3c4d" };
    const written = await clientA.memory.write("a sourced note", {
      id,
      hostSource,
      sessionId: "sess-1",
      visibility: "shared",
    });
    expect(written.id).toBe(id); // assertion: the write landed

    const got = await clientA.memory.get(id);
    expect(got?.hostSource).toEqual(hostSource); // assertion: get() returns the pointer
    expect(got?.sessionId).toBe("sess-1"); // assertion: get() returns the session

    const found = await clientA.memory.search("sourced note", { limit: 10 });
    const hit = found.find((r) => r.id === id);
    expect(hit, `search must return ${id}`).toBeTruthy(); // assertion: search found the row
    expect(hit?.hostSource).toEqual(hostSource); // assertion: search carries the pointer
    expect(hit?.author).toBe(a.id); // assertion: search carries the author

    const listed = await clientA.memory.list({ limit: 100 });
    expect(listed.find((m) => m.id === id)?.hostSource).toEqual(hostSource); // assertion: list carries the pointer

    const other = await clientB.memory.get(id);
    expect(other?.hostSource).toBe("withheld"); // assertion: a non-author reader gets the marker

    const plainId = `${a.id}-${randomUUID()}`;
    await clientA.memory.write("a plain note", { id: plainId });
    const plain = await clientA.memory.get(plainId);
    expect(plain?.hostSource).toBeUndefined(); // assertion: a write without a pointer carries none

    let invalid: unknown;
    try {
      await clientA.memory.write("bad pointer", {
        id: `${a.id}-${randomUUID()}`,
        hostSource: { v: 1, host: "openclaw", kind: "run", id: "bad id with spaces" },
      });
    } catch (e) {
      invalid = e;
    }
    expect(invalid).toBeInstanceOf(FlairError); // assertion: an invalid pointer is refused
    expect((invalid as FlairError).status).toBe(400); // assertion: 400
    expect((invalid as FlairError).body).toContain("invalid_host_source"); // assertion: the server's named error
  }, 120_000);
});
