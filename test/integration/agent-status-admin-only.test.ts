// agent-status-admin-only.test.ts — flair#2108.
//
// `Agent.status` is the principal's LIFECYCLE state: anything other than
// "active" means deactivated (resources/agent-auth.ts's isPrincipalDeactivated),
// so a principal that may write its own `status` can deactivate itself. Through
// the Agent resource a body that includes `status` is admitted only from a
// trusted internal call or an administrator; an authenticated non-admin agent's
// write is refused with 403 on any row, including its own. (A federation peer's
// record merges through the raw table and refuses an inbound status change
// separately — test/integration/agent-status-federation-2108.test.ts.)
//
// These exercise real Harper through the actual resource path (Ed25519 agent
// credentials against PATCH and PUT /Agent/<id>), asserting:
//   1. an administrator can set `status`;
//   2. an authenticated non-admin write that includes `status` is refused with a
//      clean 403 and writes NOTHING — neither the status nor the other fields in
//      that request;
//   3. a non-admin write of another self-editable field still works.
//
// The refusal case is deliberately sent with a second field so "nothing was
// written" covers the whole request, not just the field named in the error.
// A trusted internal call has no over-the-wire form (the internal verdict comes
// from the ABSENCE of a request), so its admission is pinned here against the
// pure decision the resource applies.
//
// MODEL: test/integration/admin-field-truth.test.ts (admin-vs-non-admin agent
// seeding + Ed25519 signing against a real instance).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { admitPrincipalWrite } from "../../resources/agent-status-guard.js";

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

/** Read a record straight out of the table, bypassing every resource gate. */
async function rawAgent(harper: HarperInstance, id: string): Promise<any> {
  const res = await adminOp(harper, {
    operation: "search_by_id", database: "flair", table: "Agent",
    ids: [id], get_attributes: ["id", "status", "runtime", "role", "admin"],
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

let harper: HarperInstance;

const adminAgent = mkAgent("asg-admin");
const plainRefuse = mkAgent("asg-refuse");
const plainBenign = mkAgent("asg-benign");
const target = mkAgent("asg-target");

describe("flair#2108 — Agent.status is administrator-only", () => {
  beforeAll(async () => {
    harper = await startHarper();

    const seed = async (rec: Record<string, any>) => {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent", records: [rec],
      });
      expect(res.status, `seed ${rec.id} returned ${res.status}: ${await res.text()}`).toBe(200);
    };

    const now = new Date().toISOString();
    await seed({ id: adminAgent.id, name: adminAgent.id, role: "admin", admin: true, status: "active", publicKey: adminAgent.publicKey, createdAt: now });
    await seed({ id: plainRefuse.id, name: plainRefuse.id, role: "agent", admin: false, status: "active", runtime: "orig", publicKey: plainRefuse.publicKey, createdAt: now });
    await seed({ id: plainBenign.id, name: plainBenign.id, role: "agent", admin: false, status: "active", runtime: "orig", publicKey: plainBenign.publicKey, createdAt: now });
    await seed({ id: target.id, name: target.id, role: "agent", admin: false, status: "active", runtime: "orig", publicKey: target.publicKey, createdAt: now });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("an administrator can set a principal's status", async () => {
    const path = `/Agent/${target.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(adminAgent, "PATCH", path),
      },
      body: JSON.stringify({ status: "deactivated" }),
    });
    expect(res.status, `admin status write returned ${res.status}: ${await res.text()}`).toBeLessThan(300);

    const rec = await rawAgent(harper, target.id);
    expect(rec?.status, "admin status write was not persisted").toBe("deactivated");
  }, 30_000);

  test("a non-admin write that includes `status` is refused as a clean error and writes nothing", async () => {
    const path = `/Agent/${plainRefuse.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(plainRefuse, "PATCH", path),
      },
      // includes `status` AND an ordinary field: the refusal must drop the whole request.
      body: JSON.stringify({ status: "deactivated", runtime: "tampered" }),
    });
    expect(res.status, `non-admin status write returned ${res.status}, expected 403`).toBe(403);

    // A clean, parseable error the client can handle — names the field and Presence.
    const body = await res.json();
    expect(String(body.error)).toContain("status");
    expect(String(body.error)).toContain("Presence");

    // NOTHING was written: neither the status nor the other field in that request.
    const rec = await rawAgent(harper, plainRefuse.id);
    expect(rec?.status, "status was persisted despite the refusal").toBe("active");
    expect(rec?.runtime, "the other field in the refused request was persisted (partial write)").toBe("orig");
  }, 30_000);

  test("a non-admin write that includes `status` alone, restating the current value, is still refused", async () => {
    const path = `/Agent/${plainRefuse.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(plainRefuse, "PATCH", path),
      },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status, `no-op status restatement returned ${res.status}, expected 403`).toBe(403);
    const rec = await rawAgent(harper, plainRefuse.id);
    expect(rec?.status).toBe("active");
  }, 30_000);

  test("a non-admin PUT that includes `status` is refused and writes nothing", async () => {
    const path = `/Agent/${plainRefuse.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(plainRefuse, "PUT", path),
      },
      body: JSON.stringify({ id: plainRefuse.id, name: plainRefuse.id, status: "deactivated", runtime: "tampered-put" }),
    });
    expect(res.status, `non-admin PUT status write returned ${res.status}, expected 403`).toBe(403);
    const rec = await rawAgent(harper, plainRefuse.id);
    expect(rec?.status, "status was persisted by a refused PUT").toBe("active");
    expect(rec?.runtime, "the other field in the refused PUT was persisted").toBe("orig");
  }, 30_000);

  test("a trusted internal call is admitted (no over-the-wire form)", () => {
    // The internal verdict is the ABSENCE of a request, so it is not reachable
    // over HTTP; this pins the admission the resource applies to it.
    expect(admitPrincipalWrite({ kind: "internal" })).toBe("internal");
  });

  test("a non-admin may still write its own ordinary self-editable fields", async () => {
    const path = `/Agent/${plainBenign.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(plainBenign, "PATCH", path),
      },
      body: JSON.stringify({ runtime: "headless" }),
    });
    expect(res.status, `benign self-update returned ${res.status}: ${await res.text()}`).toBeLessThan(300);

    const rec = await rawAgent(harper, plainBenign.id);
    expect(rec?.runtime, "ordinary field was not persisted").toBe("headless");
  }, 30_000);
});
