// agent-put-immutable-2696.test.ts — flair#2696.
//
// An Agent PUT updates an EXISTING row: the STORED createdAt and publicKey are
// carried into the replacement, ignoring any value the body sends. A PUT whose
// target id has no stored row is refused with 404
// `agent_put_requires_existing` (its message names POST /AgentSeed, a creation
// path; POST /Agent/ also creates a row) and writes nothing. Authorization is
// unchanged, and PATCH keeps its merge behaviour. A deletion or a key rotation
// committed between the PUT's read and its write is covered by
// agent-put-race-2696.test.ts.
//
// Each case runs against a real Harper; the stored-row assertions use an
// operations search_by_id in a separate request, so they read the committed
// row rather than the write's response.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

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
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid) throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
}

const ADMIN = mkAgent("put2696-admin");
const OTHER = mkAgent("put2696-other");
const TARGET = mkAgent("put2696-target");

// Fixed stored values so "carried forward" is checked against exact bytes.
const STORED_CREATED_AT = "2026-01-02T03:04:05.000Z";
const STORED_PUBLIC_KEY = TARGET.publicKey;

let harper: HarperInstance;

describe("flair#2696 — an Agent PUT updates an existing row and carries its immutable fields", () => {
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

  async function put(path: string, body: unknown, caller: TestAgent | null): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (caller) headers.Authorization = ed25519Header(caller, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);

    const seed = async (rec: Record<string, any>) => {
      const res = await fetch(harper.opsURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
        },
        body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [rec] }),
      });
      expect(res.status, `seed ${rec.id} returned ${res.status}: ${await res.text()}`).toBe(200);
    };

    await seed({
      id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, status: "active",
      publicKey: ADMIN.publicKey, createdAt: STORED_CREATED_AT,
    });
    await seed({
      id: OTHER.id, name: OTHER.id, role: "agent", admin: false, status: "active",
      runtime: "stored-runtime", publicKey: OTHER.publicKey, createdAt: STORED_CREATED_AT,
    });
    await seed({
      id: TARGET.id, name: TARGET.id, role: "agent", admin: false, status: "active",
      displayName: "stored-name", runtime: "stored-runtime",
      publicKey: STORED_PUBLIC_KEY, createdAt: STORED_CREATED_AT,
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  test("an admin PUT replaces other fields and keeps the stored createdAt and publicKey", async () => {
    const before = await rowIn(TARGET.id);
    expect(before?.createdAt).toBe(STORED_CREATED_AT);
    expect(before?.publicKey).toBe(STORED_PUBLIC_KEY);

    const path = `/Agent/${TARGET.id}`;
    const res = await put(path, {
      id: TARGET.id,
      name: TARGET.id,
      displayName: "put-name",
      runtime: "put-runtime",
      // Deliberately different immutable values: the stored ones must win.
      createdAt: "1999-01-01T00:00:00.000Z",
      publicKey: "client-supplied-public-key",
    }, ADMIN);
    expect(res.status, `admin PUT returned ${res.status}: ${res.text}`).toBeLessThan(300);

    const after = await rowIn(TARGET.id);
    expect(after?.createdAt, "stored createdAt was replaced").toBe(STORED_CREATED_AT);
    expect(after?.publicKey, "stored publicKey was replaced").toBe(STORED_PUBLIC_KEY);
    expect(after?.displayName, "the PUT's displayName was not stored").toBe("put-name");
    expect(after?.runtime, "the PUT's runtime was not stored").toBe("put-runtime");
  }, 30_000);

  test("a PUT to an id with no stored row is refused and writes no row", async () => {
    const id = `put2696-new-${randomUUID()}`;
    const path = `/Agent/${id}`;
    const res = await put(path, {
      id,
      name: id,
      publicKey: "new-key",
      createdAt: "2026-02-03T04:05:06.000Z",
    }, ADMIN);

    expect(res.status, `create-through-PUT returned ${res.status}, expected 404: ${res.text}`).toBe(404);
    const body = JSON.parse(res.text);
    expect(body.error).toBe("agent_put_requires_existing");
    expect(String(body.message)).toContain("POST /AgentSeed");
    expect(await rowIn(id), "a refused PUT wrote a row").toBeNull();
  }, 30_000);

  test("an unauthorized PUT is refused and leaves the row byte-identical", async () => {
    const before = await rowIn(TARGET.id);
    expect(before).not.toBeNull();
    const path = `/Agent/${TARGET.id}`;

    const other = await put(path, { id: TARGET.id, name: TARGET.id, displayName: "hijacked" }, OTHER);
    expect(other.status, `another agent's PUT returned ${other.status}: ${other.text}`).toBe(403);
    expect(await rowIn(TARGET.id), "another agent's refused PUT changed the row").toEqual(before);

    const anonymous = await put(path, { id: TARGET.id, name: TARGET.id, displayName: "hijacked" }, null);
    expect(anonymous.status, `anonymous PUT returned ${anonymous.status}: ${anonymous.text}`).toBeGreaterThanOrEqual(400);
    expect(await rowIn(TARGET.id), "an anonymous refused PUT changed the row").toEqual(before);
  }, 60_000);

  test("PATCH keeps its merge behaviour", async () => {
    const before = await rowIn(TARGET.id);
    expect(before).not.toBeNull();
    const path = `/Agent/${TARGET.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(ADMIN, "PATCH", path),
      },
      body: JSON.stringify({ runtime: "patched-runtime" }),
    });
    expect(res.status, `admin PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);

    const after = await rowIn(TARGET.id);
    expect(after?.runtime).toBe("patched-runtime");
    expect(after?.createdAt, "PATCH changed createdAt").toBe(before?.createdAt);
    expect(after?.publicKey, "PATCH changed publicKey").toBe(before?.publicKey);
  }, 30_000);
});
