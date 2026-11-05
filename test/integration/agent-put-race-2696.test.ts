// agent-put-race-2696.test.ts — flair#2696, against a REAL Harper.
//
// An Agent PUT is an administrator operation. It reads the stored row, then
// re-reads it inside its own write transaction and writes a full replacement
// that carries the re-read row's createdAt, publicKey, originatorInstanceId and
// receiver federation fields, with updatedAt set by the handler, role and admin
// reconciled and the id bound by the URL; every other field comes from its
// body. A deletion or a key rotation that commits after an administrator's
// PUT's first read and BEFORE that re-read stands after the PUT:
//   (a) a deleted agent stays deleted (the PUT never re-creates it), and the
//       PUT is refused with 404 `agent_put_requires_existing`;
//   (b) the stored publicKey is the ROTATED key, never the one the first read
//       saw, and the PUT's other fields are stored.
// A competing transaction whose time is taken before the re-read and that
// commits after it is not exercised here; per-id serialization is tracked in
// flair#2478.
//
// Each interleaving holds the PUT at its test-only pause point after the
// first stored-row read (`agent-put-pre` in resources/Agent.ts; resources/
// txn-pause-point.ts, enabled for THIS file's Harper only by
// FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR), commits the
// competing write through the operations API — the same `delete` `flair agent
// remove` sends and the same `update` `flair agent rotate-key` sends — then
// releases the PUT. The committed row is read through a separate operations
// search_by_id.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

/** The PUT's pause point after its stored-row read (resources/Agent.ts). */
const AGENT_PUT_PRE_PAUSE_POINT = "agent-put-pre";

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

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const ADMIN = mkAgent("put2696race-admin");
const STORED_CREATED_AT = "2026-01-02T03:04:05.000Z";

let harper: HarperInstance;
let pauseDir: string;

async function adminOp(op: Record<string, any>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}

async function rowIn(id: string): Promise<any | null> {
  const rows = await adminOp({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function seed(rec: Record<string, any>): Promise<void> {
  await adminOp({ operation: "insert", database: "flair", table: "Agent", records: [rec] });
}

async function put(path: string, body: unknown, caller: TestAgent): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(caller, "PUT", path) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm the PUT's pause point, start the PUT, and once it is paused commit
 * `compete`, then release it. Returns the PUT's response and the pause's
 * release marker ("go" only when the pause fired and this test released it).
 */
async function withPausedPut<R>(
  work: () => Promise<R>,
  compete: () => Promise<void>,
): Promise<{ result: R; released: string }> {
  const point = AGENT_PUT_PRE_PAUSE_POINT;
  for (const marker of ["claimed", "paused", "go", "released"]) {
    rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  }
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = work();
  const paused = await waitForFile(join(pauseDir, `paused.${point}`), 15_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const result = await pending;
  return { result, released: paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused" };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2696-pause-"));
  harper = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(harper);
  await seed({
    id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, status: "active",
    publicKey: ADMIN.publicKey, createdAt: STORED_CREATED_AT,
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2696 — a deletion or key rotation committed between an administrator's Agent PUT's first read and its re-read stands after the PUT", () => {
  test("(a) a deletion committed after the PUT's first read and before its re-read leaves the agent deleted", async () => {
    const target = mkAgent(`put2696race-del-${randomUUID()}`);
    await seed({
      id: target.id, name: target.id, role: "agent", admin: false, status: "active",
      displayName: "stored-name", publicKey: target.publicKey, createdAt: STORED_CREATED_AT,
    });
    expect(await rowIn(target.id)).not.toBeNull();

    const path = `/Agent/${target.id}`;
    const { result, released } = await withPausedPut(
      () => put(path, { id: target.id, name: target.id, displayName: "put-name" }, ADMIN),
      async () => {
        // The delete `flair agent remove` sends (src/commands/agent.ts).
        await adminOp({ operation: "delete", database: "flair", table: "Agent", ids: [target.id] });
        expect(await rowIn(target.id), "the competing delete did not commit").toBeNull();
      },
    );

    expect(released, "the PUT never reached its pause after the first stored-row read").toBe("go");
    expect(await rowIn(target.id), `the PUT (status ${result.status}: ${result.text}) re-created a deleted agent`).toBeNull();
    expect(result.status, `the PUT on a deleted agent answered ${result.status}: ${result.text}`).toBe(404);
    expect(JSON.parse(result.text).error).toBe("agent_put_requires_existing");
  }, 60_000);

  test("(b) a key rotation committed after the PUT's first read and before its re-read keeps the rotated publicKey", async () => {
    const target = mkAgent(`put2696race-rot-${randomUUID()}`);
    const rotated = mkAgent(target.id);
    await seed({
      id: target.id, name: target.id, role: "agent", admin: false, status: "active",
      displayName: "stored-name", publicKey: target.publicKey, createdAt: STORED_CREATED_AT,
    });
    expect((await rowIn(target.id))?.publicKey).toBe(target.publicKey);

    const path = `/Agent/${target.id}`;
    const { result, released } = await withPausedPut(
      () => put(path, { id: target.id, name: target.id, displayName: "put-name", publicKey: "client-supplied-public-key" }, ADMIN),
      async () => {
        // The update `flair agent rotate-key` sends (src/commands/agent.ts).
        await adminOp({
          operation: "update", database: "flair", table: "Agent",
          records: [{ id: target.id, publicKey: rotated.publicKey, updatedAt: new Date().toISOString() }],
        });
        expect((await rowIn(target.id))?.publicKey, "the competing rotation did not commit").toBe(rotated.publicKey);
      },
    );

    expect(released, "the PUT never reached its pause after the first stored-row read").toBe("go");
    const after = await rowIn(target.id);
    expect(after, `the agent row is gone after the PUT (status ${result.status}: ${result.text})`).not.toBeNull();
    expect(after?.publicKey, `the PUT (status ${result.status}: ${result.text}) restored the rotated-out publicKey`).toBe(rotated.publicKey);
    expect(after?.createdAt, "the stored createdAt was replaced").toBe(STORED_CREATED_AT);
    expect(result.status, `the PUT answered ${result.status}: ${result.text}`).toBeLessThan(300);
    expect(after?.displayName, "the PUT's displayName was not stored").toBe("put-name");
  }, 60_000);
});
