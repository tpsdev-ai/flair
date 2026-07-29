// admin-field-truth.test.ts — flair#941.
//
// The Agent record carries TWO fields that both read as "is this principal an
// administrator": `role` (admin when === "admin") and `admin: Boolean`. Before
// this change they were consulted by DIFFERENT consumers:
//
//   - resources/agent-auth.ts's isAdmin() — the ONE gate behind allowAdmin() —
//     read `role` and ignored `admin` entirely.
//   - resources/mcp-handler.ts's isAgentAdmin() read BOTH (OR-combined).
//   - every reporter (flair principal show/list, the admin dashboard) and every
//     writer except AgentSeed used `admin`.
//
// So `flair principal add --admin` wrote a field the gate never reads, and the
// dashboard printed "admin: yes" for a principal allowAdmin() rejects. These
// tests pin the three properties that make that unrepresentable:
//
//   1. a write through the Agent resource can no longer STORE a disagreement
//      (either field asks for admin → both are set; neither → both cleared),
//   2. a non-admin can no longer grant itself admin by writing either field,
//   3. a privilege change is effective immediately, not up to 60s later.
//
// MODEL: test/integration/gate4-authgate.test.ts (the admin-vs-non-admin agent
// seeding + Ed25519 signing pattern for allowAdmin-gated resources).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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
    ids: [id], get_attributes: ["id", "role", "admin", "defaultTrustTier"],
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

/** ADMIN-ONLY probe: FederationInstance.allowRead() is allowAdmin(). */
const ADMIN_ONLY_PATH = "/FederationInstance";

async function probeAdminOnly(harper: HarperInstance, agent: TestAgent): Promise<number> {
  const res = await fetch(`${harper.httpURL}${ADMIN_ONLY_PATH}`, {
    headers: { Authorization: ed25519Header(agent, "GET", ADMIN_ONLY_PATH) },
  });
  return res.status;
}

let harper: HarperInstance;

// role:"admin" — a legitimately-admin principal. THE POSITIVE CONTROL.
const roleAdmin = mkAgent("aft-role-admin");
// admin:true with no admin role — the record `flair principal add --admin`
// used to produce. Never had gate admin; must still not have it.
const boolOnly = mkAgent("aft-bool-only");
// an ordinary non-admin, used for the self-promotion probes.
const plain = mkAgent("aft-plain");

describe("flair#941 — one meaning, one answer, on every surface", () => {
  beforeAll(async () => {
    harper = await startHarper();

    const seed = async (rec: Record<string, any>) => {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent", records: [rec],
      });
      expect(res.status, `seed ${rec.id} returned ${res.status}: ${await res.text()}`).toBe(200);
    };

    const now = new Date().toISOString();
    await seed({ id: roleAdmin.id, name: roleAdmin.id, role: "admin", admin: true, publicKey: roleAdmin.publicKey, createdAt: now });
    await seed({ id: boolOnly.id, name: boolOnly.id, admin: true, publicKey: boolOnly.publicKey, createdAt: now });
    await seed({ id: plain.id, name: plain.id, role: "agent", admin: false, publicKey: plain.publicKey, createdAt: now });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // ── POSITIVE CONTROL ──────────────────────────────────────────────────────
  // Without this, every "denied" assertion below would also pass if the change
  // had simply broken admin outright.
  describe("positive control", () => {
    test("a legitimately-admin principal (role:\"admin\") still passes the admin gate", async () => {
      const status = await probeAdminOnly(harper, roleAdmin);
      expect(status, `admin GET ${ADMIN_ONLY_PATH} returned ${status}, expected 200`).toBe(200);
    }, 30_000);
  });

  // ── The two fields can no longer disagree about an existing record ────────
  describe("the stored record cannot express a contradiction", () => {
    test("a principal carrying ONLY admin:true is not an admin on the gate (unchanged)", async () => {
      const status = await probeAdminOnly(harper, boolOnly);
      expect(status, `admin:true-only GET ${ADMIN_ONLY_PATH} returned ${status}, expected 403`).toBe(403);
    }, 30_000);

    // AgentSeed is the ONE product path that has ever written role:"admin", and
    // it writes the raw table, so the Agent resource's reconciliation does not
    // cover it. Seeding an admin here used to produce exactly the record this
    // issue is about: an administrator that every reporter displays as an
    // ordinary agent.
    test("seeding an admin principal writes BOTH fields — the record cannot lie to either reader", async () => {
      const id = `aft-seed-admin-${randomUUID().slice(0, 8)}`;
      const path = "/AgentSeed";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(roleAdmin, "POST", path),
        },
        body: JSON.stringify({ agentId: id, role: "admin" }),
      });
      expect(res.status, `admin POST /AgentSeed returned ${res.status}: ${await res.text()}`).toBeLessThan(300);

      const rec = await rawAgent(harper, id);
      expect(rec, `no Agent record written for ${id}`).toBeTruthy();
      // BOTH, or the record is a lie to one of its two readers.
      expect(rec.role).toBe("admin");
      expect(rec.admin).toBe(true);
    }, 30_000);

    test("seeding an ordinary principal leaves both fields non-admin, and preserves a free-text role", async () => {
      const id = `aft-seed-plain-${randomUUID().slice(0, 8)}`;
      const path = "/AgentSeed";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(roleAdmin, "POST", path),
        },
        body: JSON.stringify({ agentId: id, role: "researcher" }),
      });
      expect(res.status, `admin POST /AgentSeed returned ${res.status}`).toBeLessThan(300);

      const rec = await rawAgent(harper, id);
      expect(rec.admin).toBe(false);
      expect(rec.role).toBe("researcher"); // a human label is not an authority value
    }, 30_000);
  });

  // ── A principal's admin status is admin-only to change ───────────────────
  // The per-record rules for this table were written in put(), and Harper routes
  // PATCH to update(), which had no override — so allowUpdate()=allowVerified
  // was the only check a PATCH ever met. Both verbs now share one authorization
  // helper. These use PATCH deliberately: PUT is not a substitute, because
  // put() strips the schema-required publicKey/createdAt and so rejects every
  // request it receives (see the separate note in the PR).
  describe("changing admin status is refused for a non-admin", () => {
    test("a non-admin patching role:\"admin\" onto its OWN record is refused, and the record is unchanged", async () => {
      const path = `/Agent/${plain.id}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(plain, "PATCH", path),
        },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status, `self-promote via role returned ${res.status}, expected 403`).toBe(403);

      const rec = await rawAgent(harper, plain.id);
      expect(rec.role, "role was persisted despite the refusal").not.toBe("admin");
      expect(await probeAdminOnly(harper, plain)).toBe(403);
    }, 30_000);

    test("a non-admin patching admin:true onto its OWN record is refused, and the record is unchanged", async () => {
      const path = `/Agent/${plain.id}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(plain, "PATCH", path),
        },
        body: JSON.stringify({ admin: true }),
      });
      expect(res.status, `self-promote via admin returned ${res.status}, expected 403`).toBe(403);

      const rec = await rawAgent(harper, plain.id);
      expect(rec.admin, "admin was persisted despite the refusal").not.toBe(true);
      expect(rec.role).not.toBe("admin");
    }, 30_000);

    test("a non-admin patching ANOTHER principal's record is refused", async () => {
      const path = `/Agent/${roleAdmin.id}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(plain, "PATCH", path),
        },
        body: JSON.stringify({ runtime: "tampered" }),
      });
      expect(res.status, `cross-principal patch returned ${res.status}, expected 403`).toBe(403);
    }, 30_000);

    test("a non-admin may still patch its own record's ordinary fields", async () => {
      const path = `/Agent/${plain.id}`;
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(plain, "PATCH", path),
        },
        body: JSON.stringify({ runtime: "headless" }),
      });
      expect(res.status, `benign self-update returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
    }, 30_000);
  });

  // ── The privilege change is effective immediately ────────────────────────
  // getAdminAgents() caches for 60s. A correctness fix that only manifests a
  // minute later is still confusing, so the write path invalidates the cache.
  describe("a privilege change takes effect without waiting out the cache", () => {
    test("an agent promoted through the resource is an admin on its very next request", async () => {
      const fresh = mkAgent(`aft-promoted-${randomUUID().slice(0, 8)}`);
      const now = new Date().toISOString();
      const seedRes = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: fresh.id, name: fresh.id, role: "agent", admin: false, publicKey: fresh.publicKey, createdAt: now }],
      });
      expect(seedRes.status).toBe(200);

      // Populate the admin cache with a verdict that predates the promotion.
      expect(await probeAdminOnly(harper, fresh)).toBe(403);

      const path = `/Agent/${fresh.id}`;
      const promote = await fetch(`${harper.httpURL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: ed25519Header(roleAdmin, "PATCH", path),
        },
        // Granted through the Boolean — the field an operator reaches for. It
        // carries the record into the authority field, so this actually grants.
        body: JSON.stringify({ admin: true }),
      });
      expect(promote.status, `admin promote returned ${promote.status}: ${await promote.text()}`).toBeLessThan(300);

      // No sleep. Pre-fix this stayed 403 for up to 60 seconds.
      const status = await probeAdminOnly(harper, fresh);
      expect(status, `promoted agent got ${status}, expected 200 immediately`).toBe(200);
    }, 60_000);
  });

  // ── The public roster does not disclose administrator status ─────────────
  // Presence.allowRead() is `true` and `role` is in ROSTER_ALLOWLIST, so making
  // `role` the stored authority would otherwise publish admin status to
  // unauthenticated readers.
  describe("public presence roster", () => {
    test("an admin principal appears on the public roster but its admin status is not disclosed", async () => {
      // Seed presence for BOTH principals so the assertion is not vacuous: the
      // roster must actually contain the admin before "it does not say admin"
      // means anything.
      const seedPresence = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Presence",
        records: [
          { agentId: roleAdmin.id, lastHeartbeatAt: Date.now(), activity: "planning" },
          { agentId: plain.id, lastHeartbeatAt: Date.now(), activity: "coding" },
        ],
      });
      expect(seedPresence.status, `Presence seed returned ${seedPresence.status}`).toBe(200);

      const res = await fetch(`${harper.httpURL}/Presence`);
      expect(res.status).toBe(200);
      const body = await res.text();

      // Positive control for THIS assertion — the roster is populated and the
      // admin principal is on it.
      expect(body.includes(roleAdmin.id), "roster did not contain the admin principal — assertion would be vacuous").toBe(true);
      // ...and it is presented as an ordinary agent.
      expect(body.includes("\"role\":\"admin\""), "public roster disclosed admin status").toBe(false);
    }, 30_000);
  });
});
