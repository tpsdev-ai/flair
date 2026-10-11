/**
 * supersede-grant-revoked-2333.test.ts — flair#2333 slice 4 (H10), real Harper.
 *
 * A cross-agent Memory supersede is authorized by a "write" MemoryGrant. The
 * authorization check and the close that follows it are separate reads: if the
 * grant is revoked after the check but before the close commits, the close used
 * to land anyway and closed the owner's memory. These cases hold the close inside
 * its transaction (the "supersede-close" test pause, before the write is staged),
 * revoke the grant so the revocation is committed, release the close, and assert
 * the target row is NOT closed. The third case pauses at "supersede-close-staged"
 * instead — after the close has staged its write, so the revocation lands in the
 * window the write-back confirm covers — and asserts the same refusal. A control
 * case shows that with the grant intact the close lands.
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
async function grantWrite(harper: HarperInstance, ownerId: string, granteeId: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${ownerId}:${granteeId}:write`, ownerId, granteeId, scope: "write", createdAt: new Date().toISOString() }],
  });
  expect(res.status, `write-grant insert returned ${res.status}`).toBe(200);
}
async function revokeWrite(harper: HarperInstance, ownerId: string, granteeId: string): Promise<number> {
  const res = await adminOp(harper, {
    operation: "delete", database: "flair", table: "MemoryGrant", ids: [`${ownerId}:${granteeId}:write`],
  });
  return res.status;
}
async function readRow(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
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
 * Arm the pause at `point`, start `write`, and once the close is paused run
 * `compete`, then release. Returns the write response and how the pause ended.
 */
async function withPausedClose<T>(write: () => Promise<Response>, compete: () => Promise<T>, point: string = POINT) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released };
}

let harper: HarperInstance;
let pauseDir: string;
const owner = mkAgent("h10-owner");
const grantee = mkAgent("h10-grantee");

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-h10-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  await seedAgent(harper, owner);
  await seedAgent(harper, grantee);
  await insertRow(harper, "h10-revoked-target", owner.id, "A memory the owner shared before revoking the grant.");
  await insertRow(harper, "h10-kept-target", owner.id, "A memory whose writer keeps the grant.");
  await insertRow(harper, "h10-staged-target", owner.id, "A memory whose close is revoked while its write is staged.");
  await grantWrite(harper, owner.id, grantee.id);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2333 H10 — a grant revoked before the close commits stops the close (real Harper)", () => {
  it("a revoked write grant leaves the owner's memory open", async () => {
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, grantee, "PUT", "/Memory/h10-revoked-successor", {
        id: "h10-revoked-successor", agentId: grantee.id, supersedes: "h10-revoked-target",
        content: "Successor written by the granted agent, long enough for the gate.",
      }),
      () => revokeWrite(harper, owner.id, grantee.id),
    );
    expect(released, "the close was not paused and released by this test").toBe("go");
    expect(competed, "the competing grant revocation failed").toBe(200);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    const successor = await readRow(harper, "h10-revoked-successor");
    expect(successor?.supersedes).toBe("h10-revoked-target");
    const target = await readRow(harper, "h10-revoked-target");
    expect(target?.validTo ?? null, "the close landed after the authorizing grant was revoked").toBeNull();
  }, 60_000);

  it("control: with the grant intact the cross-agent close still lands", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const res = await authSend(harper, grantee, "PUT", "/Memory/h10-kept-successor", {
      id: "h10-kept-successor", agentId: grantee.id, supersedes: "h10-kept-target",
      content: "Successor written under an intact grant, long enough for the gate.",
    });
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    const target = await readRow(harper, "h10-kept-target");
    expect(target?.validTo, "the close did not land under an intact grant").toBeTruthy();
  }, 60_000);

  it("a grant revoked while the close's write is staged leaves the owner's memory open", async () => {
    await grantWrite(harper, owner.id, grantee.id);
    const { response, competed, released } = await withPausedClose(
      () => authSend(harper, grantee, "PUT", "/Memory/h10-staged-successor", {
        id: "h10-staged-successor", agentId: grantee.id, supersedes: "h10-staged-target",
        content: "Successor whose close is held after staging, long enough for the gate.",
      }),
      () => revokeWrite(harper, owner.id, grantee.id),
      "supersede-close-staged",
    );
    expect(released, "the staged close was not paused and released by this test").toBe("go");
    expect(competed, "the competing grant revocation failed").toBe(200);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    const successor = await readRow(harper, "h10-staged-successor");
    expect(successor?.supersedes).toBe("h10-staged-target");
    const target = await readRow(harper, "h10-staged-target");
    expect(target?.validTo ?? null, "the close landed after the authorizing grant was revoked while its write was staged").toBeNull();
  }, 60_000);
});
