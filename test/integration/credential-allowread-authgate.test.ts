// credential-allowread-authgate.test.ts — Integration test for Credential.ts
// gaining allowRead() (authorizeLocal escalation class / #556-#557 sweep
// follow-up).
//
// Credential.ts stores passkeys/bearer tokens/Ed25519 keys/IdP links but was
// the one sibling in that sensitive class MISSING an allowRead() — every
// structurally-identical sibling (Soul.ts, Relationship.ts, WorkspaceState.ts)
// got allowRead()=allowVerified in the #556/#557 sweep, because Harper routes
// SOME request shapes (collection-describe, i.e. `GET /Credential` with no
// id) OUTSIDE get()/search() entirely — neither method's own in-body checks
// ever ran for that path, so it was ungated. Credential's get()/search() DO
// already call resolveAgentAuth() and deny anonymous/cross-agent reads for
// the shapes they DO see (by-id GET, query search) — this test's first case
// is the one NEW thing the fix adds: the collection-describe path.
//
// MODEL: test/integration/auth-middleware-e2e.test.ts's FAMILY READ-GATE
// block (the Soul/WorkspaceState/Relationship allowRead tests) +
// test/integration/credential-delete-authz.test.ts (Credential-specific
// harness conventions).
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

let harper: HarperInstance;
const owner = mkAgent("credread-owner");
const other = mkAgent("credread-other");
const seededId = `credread-seed-${randomUUID()}`;

describe("Credential allowRead() authgate (authorizeLocal escalation class, #556/#557 follow-up)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    for (const a of [owner, other]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }

    // Seed one Credential record directly via the ops API (bypasses the
    // resource's own put() path — this file exercises READS, not writes).
    const seedRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Credential",
      records: [{
        id: seededId,
        principalId: owner.id,
        kind: "bearer-token",
        status: "active",
        tokenHash: "should-never-be-returned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });
    expect(seedRes.status).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // ── THE FIX: collection-describe, previously ungated ──────────────────────

  test("NEW GATE: anonymous GET /Credential (collection describe, no id) → 403, not a leak", async () => {
    const res = await fetch(`${harper.httpURL}/Credential`);
    const text = await res.text();
    // Pre-fix, this request shape bypassed get()/search() entirely (Harper
    // routes collection-describe outside both) and would have returned 200
    // with credential records — exactly the leak allowRead() closes.
    expect(res.status, `anon GET /Credential returned ${res.status}: ${text.slice(0, 300)}`).toBe(403);
    expect(text).not.toContain("should-never-be-returned");
  }, 30_000);

  // ── Existing get()/search() gates — confirm allowRead() didn't regress them ─

  test("anonymous GET /Credential/<id> (by-id) still denied", async () => {
    const path = `/Credential/${seededId}`;
    const res = await fetch(`${harper.httpURL}${path}`);
    expect([401, 403], `anon GET ${path} returned ${res.status}`).toContain(res.status);
  }, 30_000);

  test("owner GET /Credential/<id> still succeeds, tokenHash still stripped", async () => {
    const path = `/Credential/${seededId}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(owner, "GET", path) },
    });
    const text = await res.text();
    expect(res.status, `owner GET ${path} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text);
    expect(body.principalId).toBe(owner.id);
    expect(body.tokenHash).toBeUndefined();
  }, 30_000);

  test("cross-agent GET /Credential/<id> (non-owner, non-admin) still denied", async () => {
    const path = `/Credential/${seededId}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(other, "GET", path) },
    });
    expect([403, 404], `cross-agent GET ${path} returned ${res.status}`).toContain(res.status);
  }, 30_000);

  // NOTE: a bare authenticated collection GET (/Credential or /Credential/,
  // with or without a query string) 404s on this Harper version regardless
  // of this fix — verified identical pre- and post-fix by testing against
  // the unmodified resources/Credential.ts, so it is a pre-existing routing
  // quirk of this @export'd table, not a regression allowRead() introduces
  // and not something this scoped fix touches. search()'s own ownership
  // scoping is exercised by the unit suite; this file's job is the allowRead()
  // gate + get()'s existing by-id checks, both covered above.
});
