/**
 * supersede-close-contention-2307.test.ts — flair#2307, real Harper.
 *
 * The ordinary Memory close (closeSupersededRecord in resources/Memory.ts)
 * reads the target and writes it in one owned transaction. These cases change
 * the target AFTER that transaction has read it and BEFORE it writes: the
 * spawned Harper carries the test-only pause (resources/txn-pause-point.ts,
 * enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and FLAIR_TEST_PAUSE_DIR, which
 * this file sets in the test process's environment while it starts its Harper,
 * then restores), the test arms it, starts a successor
 * write that supersedes the target, waits until the close is paused inside its
 * transaction, commits a competing change to the target, then releases the
 * close. The change is visible at the committed re-read, which aborts; a change
 * after that re-read and before commit follows Harper's timestamp order
 * (see the PR residual-gap note).
 *
 *   - an owner change (a raw table update, as an operator would make): the
 *     competing owner is kept, and the row is not closed;
 *   - a content edit by the owner (a signed PUT through Memory.put): the edit is
 *     kept, and the row is closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const POINT = "supersede-close";

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
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function readRow(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
/** A row the embedding-stamp migration does not pick up (current stamp). */
async function insertRow(harper: HarperInstance, id: string, agentId: string, content: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId, content, contentHash: id, visibility: "shared", archived: false, instanceToken: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z", embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
    }],
  });
  expect(res.status, `raw insert of ${id} returned ${res.status}`).toBe(200);
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Arm the pause, start `write`, and once the close is paused inside its
 * transaction run `compete`, then release the close. Returns the successor
 * write's response, the competing step's result and how the pause ended.
 */
async function withPausedClose<T>(write: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { response, competed, released };
}

let harper: HarperInstance;
let pauseDir: string;
const owner = mkAgent("scc-owner");
const other = mkAgent("scc-other");

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-scc-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  await seedAgent(harper, owner);
  await seedAgent(harper, other);
  await insertRow(harper, "scc-owner-swap", owner.id, "Owner-swap target body, long enough for the gate.");
  await insertRow(harper, "scc-edit", owner.id, "Edit target body before the edit, long enough for the gate.");
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2307 — the supersede close under a change committed after its read (real Harper)", () => {
  it("an owner change visible at the committed re-read aborts the ordinary close", async () => {
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, owner, "PUT", "/Memory/scc-owner-swap-next", {
        id: "scc-owner-swap-next", agentId: owner.id, supersedes: "scc-owner-swap",
        content: "Successor that supersedes the owner-swap target, long enough for the gate.",
      }),
      () => adminOp(harper, {
        operation: "update", database: "flair", table: "Memory", records: [{ id: "scc-owner-swap", agentId: other.id }],
      }).then((r) => r.status),
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the competing owner change failed").toBe(200);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    const target = await readRow(harper, "scc-owner-swap");
    const successor = await readRow(harper, "scc-owner-swap-next");
    console.log("owner-swap target after the close:", JSON.stringify({ agentId: target?.agentId, validTo: target?.validTo ?? null }));
    expect(successor?.supersedes).toBe("scc-owner-swap");
    expect(target?.agentId).toBe(other.id); // assertion: the competing owner change is kept
    expect(target?.validTo ?? null, "the close landed on a row whose owner changed after the close's read").toBeNull();
  }, 60_000);

  it("a content edit visible at the committed re-read retries the ordinary close", async () => {
    const EDITED = "Edit target body AFTER the owner's edit, long enough for the gate.";
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, owner, "PUT", "/Memory/scc-edit-next", {
        id: "scc-edit-next", agentId: owner.id, supersedes: "scc-edit",
        content: "Successor that supersedes the edit target, long enough for the gate.",
      }),
      () => authSend(harper, owner, "PUT", "/Memory/scc-edit", {
        id: "scc-edit", agentId: owner.id, content: EDITED,
      }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) })),
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed?.status, `the competing edit failed: ${competed?.body}`).toBeLessThan(300);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    const target = await readRow(harper, "scc-edit");
    console.log("edit target after the close:", JSON.stringify({ content: target?.content, validTo: target?.validTo ?? null }));
    expect(target?.content).toBe(EDITED); // assertion: the competing edit is kept
    expect(target?.validTo, "the close did not land after the competing edit").toBeTruthy();
  }, 60_000);
});
