/**
 * integration-row-write-serialization-2340.test.ts — flair#2340, real Harper.
 *
 * An Integration write (put, patch, by-id delete) makes one per-row decision
 * (resources/Integration.ts): the stored-row read, the operator-only decision
 * and the write run in one owned transaction. These cases change the target
 * AFTER that transaction has read the row and BEFORE it commits: the spawned
 * Harper carries the test-only pause
 * (resources/txn-pause-point.ts, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION
 * and FLAIR_TEST_PAUSE_DIR, set for this file's Harper only), the test arms it,
 * starts one write, waits until it is paused inside its transaction, runs a
 * competing write against the same row, then releases the first. The committed
 * row is re-read before the commit, so a change committed before that re-read is
 * visible. Some cases pause an owner's write and have the operator publish the
 * same row; the reverse case pauses the operator's write while the owner writes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const POINT = "integration-row-write";
const PLATFORM = "tps-mail";

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
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
/** A request over the real HTTP route, as Basic admin (the operator) or signed as `a`. */
async function requestAs(harper: HarperInstance, a: TestAgent | "operator", method: string, path: string, body?: unknown): Promise<Response> {
  const authorization = a === "operator"
    ? "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`)
    : ed25519Header(a, method, path);
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", status: "active", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}
/** Seed an unpublished, owner-held Integration contact row through the operations API. */
async function seedRow(harper: HarperInstance, id: string, agentId: string, email: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Integration",
    records: [{ id, agentId, platform: PLATFORM, email, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  });
  expect(res.status, `Integration insert of ${id} returned ${res.status}`).toBe(200);
}
/** The stored Integration row, read through the operations API (not the resource under test). */
async function storedRow(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_id", database: "flair", table: "Integration", ids: [id],
    get_attributes: ["id", "agentId", "platform", "email", "metadata", "directoryPublishedAt"],
  });
  expect(res.status, `search_by_id returned ${res.status}`).toBe(200);
  const rows: any = await res.json();
  return Array.isArray(rows) ? rows[0] ?? null : null;
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
 * Arm the pause, start `write`, and once it is paused inside its transaction
 * run `compete`, then release the write. Returns the first write's response,
 * the competing step's result and how the pause ended.
 */
async function withPausedWrite<T>(write: () => Promise<Response>, compete: () => Promise<T>) {
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
const owner = mkAgent("irw-owner");
const other = mkAgent("irw-other");
const PUB_EMAIL = "irw-published@example.test";

/** The operator's publish of a row held by `owner`: a fresh email and a fresh stamp. */
function publish(harper: HarperInstance, id: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return requestAs(harper, "operator", "PUT", `/Integration/${id}`, {
    id, agentId: owner.id, platform: PLATFORM, email: PUB_EMAIL,
    directoryPublishedAt: new Date().toISOString(), ...extra,
  });
}

/** The operator's publish as a PATCH (a merge): a fresh stamp. */
function publishPatch(harper: HarperInstance, id: string, email: string): Promise<Response> {
  return requestAs(harper, "operator", "PATCH", `/Integration/${id}`, {
    id, agentId: owner.id, platform: PLATFORM, email,
    directoryPublishedAt: new Date().toISOString(),
  });
}

/** The operator's transfer of a row to another active agent, published: a new agentId and stamp. */
function transferPublish(harper: HarperInstance, id: string, agentId: string): Promise<Response> {
  return requestAs(harper, "operator", "PUT", `/Integration/${id}`, {
    id, agentId, platform: PLATFORM, email: PUB_EMAIL,
    directoryPublishedAt: new Date().toISOString(),
  });
}

/** The operator's transfer-and-publish as a PATCH (a merge): a new agentId and stamp. */
function transferPublishPatch(harper: HarperInstance, id: string, agentId: string): Promise<Response> {
  return requestAs(harper, "operator", "PATCH", `/Integration/${id}`, {
    id, agentId, platform: PLATFORM, email: PUB_EMAIL,
    directoryPublishedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-irw-pause-"));
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
  await registerAgent(harper, owner);
  await registerAgent(harper, other);
  await seedRow(harper, "irw-put", owner.id, "irw-put-before@example.test");
  await seedRow(harper, "irw-patch", owner.id, "irw-patch-before@example.test");
  await seedRow(harper, "irw-del", owner.id, "irw-del-before@example.test");
  await seedRow(harper, "irw-rev", owner.id, "irw-rev-before@example.test");
  await seedRow(harper, "irw-xfer-put", owner.id, "irw-xfer-put-before@example.test");
  await seedRow(harper, "irw-xfer-patch", owner.id, "irw-xfer-patch-before@example.test");
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2340 — the Integration per-row write under a publish committed after its read (real Harper)", () => {
  it("an owner PUT that changes the email is refused once the row was published during the write", async () => {
    const { response, competed, released } = await withPausedWrite(
      () => requestAs(harper, owner, "PUT", "/Integration/irw-put", { id: "irw-put", agentId: owner.id, platform: PLATFORM, email: "irw-put-after@example.test" }),
      () => publish(harper, "irw-put").then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the operator publish failed: ${competed?.body}`).toBeLessThan(300);
    expect(response.status, (await response.text()).slice(0, 300)).toBe(409);
    const row = await storedRow(harper, "irw-put");
    expect(row?.directoryPublishedAt).toBeString(); // assertion: the operator's publication is kept
    expect(row?.email).toBe(PUB_EMAIL); // assertion: the owner's email change is not committed over it
  }, 60_000);

  it("an owner PATCH that changes the email is refused once the row was published during the write", async () => {
    const { response, competed, released } = await withPausedWrite(
      () => requestAs(harper, owner, "PATCH", "/Integration/irw-patch", { email: "irw-patch-after@example.test" }),
      () => publish(harper, "irw-patch").then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the operator publish failed: ${competed?.body}`).toBeLessThan(300);
    expect(response.status, (await response.text()).slice(0, 300)).toBe(409);
    const row = await storedRow(harper, "irw-patch");
    expect(row?.directoryPublishedAt).toBeString(); // assertion: the operator's publication is kept
    expect(row?.email).toBe(PUB_EMAIL); // assertion: the owner's email change is not committed over it
  }, 60_000);

  it("an operator PATCH publish that raced an owner's metadata write keeps both changes", async () => {
    // The reverse interleaving: the OPERATOR's write is the one that spans the
    // race. It reads the unpublished row, pauses before it commits, the owner
    // commits a different field (metadata), then the operator resumes. On the
    // retry the operator's write must be built from the row read inside that
    // attempt — the owner's metadata — rather than from the request instance's
    // stale entry; both changes are kept.
    const before = await storedRow(harper, "irw-rev");
    const { response, competed, released } = await withPausedWrite(
      () => publishPatch(harper, "irw-rev", before.email),
      () => requestAs(harper, owner, "PATCH", "/Integration/irw-rev", { metadata: "owner-metadata" })
        .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the owner's metadata write failed: ${competed?.body}`).toBeLessThan(300);
    expect(response.status, (await response.text()).slice(0, 300)).toBeLessThan(300);
    const row = await storedRow(harper, "irw-rev");
    expect(row?.directoryPublishedAt).toBeString(); // the operator's publication is kept
    expect(row?.metadata).toBe("owner-metadata"); // the owner's different field is kept too
  }, 60_000);

  it("an owner by-id DELETE is refused once the row was published during the write", async () => {
    const { response, competed, released } = await withPausedWrite(
      () => requestAs(harper, owner, "DELETE", "/Integration/irw-del"),
      () => publish(harper, "irw-del").then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the operator publish failed: ${competed?.body}`).toBeLessThan(300);
    expect(response.status, (await response.text()).slice(0, 300)).toBe(403);
    const row = await storedRow(harper, "irw-del");
    expect(row, "the published row was deleted over the operator's publication").not.toBeNull();
    expect(row?.directoryPublishedAt).toBeString(); // assertion: the operator's publication is kept
  }, 60_000);

  it("an owner PATCH is refused once the operator transferred and published its row via PUT during the write", async () => {
    const { response, competed, released } = await withPausedWrite(
      () => requestAs(harper, owner, "PATCH", "/Integration/irw-xfer-put", { metadata: "former-owner-metadata" }),
      () => transferPublish(harper, "irw-xfer-put", other.id)
        .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300), row: await storedRow(harper, "irw-xfer-put") })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the operator transfer failed: ${competed?.body}`).toBeLessThan(300);
    expect(competed?.row?.agentId, "the operator's transfer is the committed row").toBe(other.id);
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(403);
    expect(JSON.parse(text).error).toBe("integration_owner_changed");
    const row = await storedRow(harper, "irw-xfer-put");
    expect(JSON.stringify(row), "the former owner's write changed the transferred row").toBe(JSON.stringify(competed?.row));
  }, 60_000);

  it("an owner PATCH is refused once the operator transferred and published its row via PATCH during the write", async () => {
    const { response, competed, released } = await withPausedWrite(
      () => requestAs(harper, owner, "PATCH", "/Integration/irw-xfer-patch", { metadata: "former-owner-metadata" }),
      () => transferPublishPatch(harper, "irw-xfer-patch", other.id)
        .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300), row: await storedRow(harper, "irw-xfer-patch") })),
    );
    expect(released, "the write was not paused and released by this test").toBe("go");
    expect(competed?.status, `the operator transfer failed: ${competed?.body}`).toBeLessThan(300);
    expect(competed?.row?.agentId, "the operator's transfer is the committed row").toBe(other.id);
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(403);
    expect(JSON.parse(text).error).toBe("integration_owner_changed");
    const row = await storedRow(harper, "irw-xfer-patch");
    expect(JSON.stringify(row), "the former owner's write changed the transferred row").toBe(JSON.stringify(competed?.row));
  }, 60_000);
});
