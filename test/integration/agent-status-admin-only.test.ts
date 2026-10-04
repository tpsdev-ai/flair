// agent-status-admin-only.test.ts — flair#2108.
//
// `Agent.status` is the principal's LIFECYCLE state: any present value other
// than "active" means deactivated, and a missing or undefined `status` is
// treated as active (resources/agent-auth.ts's isPrincipalDeactivated). The
// Agent resource's PUT and PATCH admit a trusted internal call and an
// administrator. A non-admin agent's PUT or PATCH whose body includes `status`
// is refused with 403 on any row, including its own; without `status`, it goes
// on to the existing per-record rules. (A federation peer's record merges
// through the raw table — test/integration/agent-status-federation-2108.test.ts.)
//
// These run against real Harper, booted from a private copy of the built
// component with one test-only resource added
// (test/fixtures/agent-status-internal-2108/probe.js, composed by
// test/helpers/component-with-replay-probe.ts). Each case asserts the stored row:
//   1. an administrator's PATCH (Ed25519 over HTTP) sets `status`;
//   2. a non-admin agent's PATCH or PUT (Ed25519 over HTTP) that includes
//      `status` is refused with a clean 403 and writes NOTHING — neither the
//      status nor the other fields in that request;
//   3. a trusted internal call sets `status`: the probe calls the Agent
//      resource's PATCH in-process with internalContext();
//   4. a non-admin agent's PATCH of another self-editable field on its own
//      record is admitted.
//
// The refusal case is deliberately sent with a second field so "nothing was
// written" covers the whole request, not just the field named in the error.
//
// MODEL: test/integration/admin-field-truth.test.ts (admin-vs-non-admin agent
// seeding + Ed25519 signing against a real instance).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

/** The test-only resource that calls the Agent resource with internalContext(). */
const INTERNAL_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "agent-status-internal-2108", "probe.js"),
  target: join("dist", "resources", "zz-agent-status-internal-2108.js"),
  out: "agent-status-internal-2108", // unused: the probe answers over HTTP and writes no files
};

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
let composed: ProbeComponent | undefined;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const adminAgent = mkAgent("asg-admin");
const plainRefuse = mkAgent("asg-refuse");
const plainBenign = mkAgent("asg-benign");
const target = mkAgent("asg-target");
const internalTarget = mkAgent("asg-internal-target");

describe("flair#2108 — a PUT or PATCH that includes Agent.status needs an administrator or a trusted internal call", () => {
  beforeAll(async () => {
    // The probe is added to a private copy of the built component, so this
    // needs a local spawn; an external instance cannot carry it.
    if (process.env.HARPER_HTTP_URL) throw new Error("agent-status-admin-only requires an isolated Harper instance; unset HARPER_HTTP_URL");
    composed = componentWithReplayProbe({ probe: INTERNAL_PROBE });
    harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
    assertOwnInstance(harper);

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
    await seed({ id: internalTarget.id, name: internalTarget.id, role: "agent", admin: false, status: "active", runtime: "orig", publicKey: internalTarget.publicKey, createdAt: now });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    composed?.cleanup();
  });

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

  test("a trusted internal call through the Agent resource sets status (in-process PATCH with internalContext())", async () => {
    const res = await fetch(`${harper.httpURL}/AgentStatusInternalProbe2108`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify({ id: internalTarget.id, data: { status: "deactivated" } }),
    });
    const text = await res.text();
    expect(res.status, `internal-call probe returned ${res.status}: ${text}`).toBe(200);
    expect(JSON.parse(text).refused, `the Agent resource refused the internal call: ${text}`).toBeNull();

    const rec = await rawAgent(harper, internalTarget.id);
    expect(rec?.status, "the internal call's status write was not persisted").toBe("deactivated");
  }, 30_000);

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
