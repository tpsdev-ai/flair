// relationship-write-surface-e2e.test.ts — relationship-write-path spec
//
// End-to-end coverage (real Harper, via test/helpers/harper-lifecycle.ts) for
// the ergonomic agent-directed relationship-write surface: RelationshipApi
// (flair-client) → Relationship.put()'s reconciled auth + canonical-id dedup
// + provenance stamp → the attention read in MemoryBootstrap.ts.
//
// Covers the five spec-mandated test categories:
//   1. round-trip:            write via RelationshipApi -> surfaces in bootstrap
//      for a predicted subject (proves lowercasing + the read contract).
//   2. dedup:                 same triple written twice -> exactly ONE row;
//      a different confidence upserts rather than duplicating.
//   3. auth:                  anonymous -> 401; a caller cannot write a triple
//      claiming another agent's agentId.
//   4. provenance:             written triple carries verified.agentId; a
//      pre-provenance row (inserted directly, bypassing the resource) still
//      reads back fine (migration-equivalence, same discipline as #684's
//      usageCount).
//   5. render-escape:          the attention read's `subject -> predicate ->
//      object` line is plain-text (not HTML-escaped, none needed — nothing in
//      this repo renders bootstrap output into an HTML/DOM context) and safe:
//      special characters pass through literally, no crash, no injection into
//      the surrounding text structure.
//
// Pattern: test/integration/relationship-delete-authz.test.ts (mkAgent/
// ed25519Header/adminOp helpers) + test/integration/bootstrap-supersede-
// resurface.test.ts (the bootstrap() helper), one shared Harper instance.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { FlairClient, canonicalRelationshipId } from "../../packages/flair-client/src/client";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; keyPath: string }

let keyDir: string;

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  const keyPath = join(keyDir, `${id}.key`);
  // loadPrivateKey() (flair-client/src/auth.ts) treats an exactly-32-byte file
  // as a raw Ed25519 seed — nacl's secretKey is a 64-byte (seed || pubkey)
  // buffer, so the first 32 bytes ARE the seed it expects.
  writeFileSync(keyPath, Buffer.from(kp.secretKey.slice(0, 32)));
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey, keyPath };
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
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

async function bootstrap(harper: HarperInstance, client: FlairClient, opts: Record<string, any>): Promise<any> {
  return client.bootstrap(opts);
}

async function searchRelationshipsById(harper: HarperInstance, id: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value",
    database: "flair", table: "Relationship",
    search_attribute: "id", search_value: id,
    get_attributes: ["id", "agentId", "subject", "predicate", "object", "confidence", "provenance", "validTo"],
  });
  const body: any = await res.json();
  return Array.isArray(body) ? body : [];
}

let harper: HarperInstance;
let ownerAgent: TestAgent;
let attackerAgent: TestAgent;
let ownerClient: FlairClient;
let attackerClient: FlairClient;

describe("relationship-write-surface e2e (RelationshipApi -> Relationship.put() -> MemoryBootstrap read)", () => {
  beforeAll(async () => {
    keyDir = mkdtempSync(join(tmpdir(), "flair-rel-e2e-keys-"));
    ownerAgent = mkAgent(`rel-e2e-owner-${randomUUID()}`);
    attackerAgent = mkAgent(`rel-e2e-attacker-${randomUUID()}`);

    harper = await startHarper();
    await registerAgent(harper, ownerAgent);
    await registerAgent(harper, attackerAgent);

    ownerClient = new FlairClient({ agentId: ownerAgent.id, url: harper.httpURL, keyPath: ownerAgent.keyPath });
    attackerClient = new FlairClient({ agentId: attackerAgent.id, url: harper.httpURL, keyPath: attackerAgent.keyPath });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  test("round-trip: a triple written via RelationshipApi surfaces in bootstrap for a predicted subject (lowercasing + read contract)", async () => {
    const subject = `Flair-${randomUUID().slice(0, 8)}`;
    const written = await ownerClient.relationship.write({ subject, predicate: "Manages", object: "Cofounder-X" });
    expect(written.written).not.toBe(false);

    const result = await bootstrap(harper, ownerClient, { maxTokens: 8000, subjects: [subject] });
    const context: string = result.context ?? "";
    // Lowercased on write — the bootstrap line must show the LOWERCASED triple,
    // proving MemoryBootstrap.ts's predicted-subject match (which lowercases
    // the query subject) actually found this row.
    expect(context).toContain(`${subject.toLowerCase()} → manages → cofounder-x`);
  }, 60_000);

  test("dedup: re-asserting the SAME triple upserts one row; a different confidence updates it in place", async () => {
    const subject = `dedup-subject-${randomUUID().slice(0, 8)}`;
    const first = await ownerClient.relationship.write({ subject, predicate: "manages", object: "target", confidence: 1.0 });
    const second = await ownerClient.relationship.write({ subject, predicate: "manages", object: "target", confidence: 0.4 });

    expect(second.id).toBe(first.id);

    const rows = await searchRelationshipsById(harper, first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(0.4);
    expect(rows[0].agentId).toBe(ownerAgent.id);
  }, 60_000);

  test("dedup: a DIFFERENT predicate on the same subject/object is a SEPARATE row (not auto-superseded)", async () => {
    const subject = `dedup-diffpred-${randomUUID().slice(0, 8)}`;
    const a = await ownerClient.relationship.write({ subject, predicate: "manages", object: "target" });
    const b = await ownerClient.relationship.write({ subject, predicate: "advises", object: "target" });
    expect(b.id).not.toBe(a.id);
    expect((await searchRelationshipsById(harper, a.id))).toHaveLength(1);
    expect((await searchRelationshipsById(harper, b.id))).toHaveLength(1);
  }, 60_000);

  test("auth: anonymous PUT (no Authorization header) is denied with 401, nothing written", async () => {
    const id = canonicalRelationshipId(ownerAgent.id, "anon-subject", "manages", "anon-object");
    const res = await fetch(`${harper.httpURL}/Relationship/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, subject: "anon-subject", predicate: "manages", object: "anon-object" }),
    });
    expect(res.status).toBe(401);
    expect(await searchRelationshipsById(harper, id)).toHaveLength(0);
  }, 30_000);

  test("auth: a caller cannot write a relationship claiming ANOTHER agent's agentId — 403, agentId always comes from the signature", async () => {
    // The attacker computes the OWNER's canonical id (guessable — ids are not
    // secret, reads/writes are what's gated) and signs the request as itself,
    // but claims the owner's agentId in the body.
    const subject = "forged-subject";
    const predicate = "manages";
    const object = "forged-object";
    const forgedId = canonicalRelationshipId(ownerAgent.id, subject, predicate, object);
    const path = `/Relationship/${forgedId}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: {
        Authorization: ed25519Header(attackerAgent, "PUT", path),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: forgedId, agentId: ownerAgent.id, subject, predicate, object }),
    });
    expect(res.status).toBe(403);
    expect(await searchRelationshipsById(harper, forgedId)).toHaveLength(0);
  }, 30_000);

  test("auth: the SAME attacker writing under ITS OWN canonical id (agentId omitted) succeeds normally", async () => {
    const subject = "attacker-own-subject";
    const predicate = "manages";
    const object = "attacker-own-object";
    const written = await attackerClient.relationship.write({ subject, predicate, object });
    expect(written.agentId).toBe(attackerAgent.id);
    const rows = await searchRelationshipsById(harper, written.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(attackerAgent.id);
  }, 30_000);

  test("provenance: a written relationship carries verified.agentId matching the authenticated writer", async () => {
    const written = await ownerClient.relationship.write({ subject: "prov-subject", predicate: "manages", object: "prov-object" });
    const rows = await searchRelationshipsById(harper, written.id);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].provenance).toBe("string");
    const prov = JSON.parse(rows[0].provenance);
    expect(prov.v).toBe(1);
    expect(prov.verified.agentId).toBe(ownerAgent.id);
  }, 30_000);

  test("migration-equivalence: a pre-existing Relationship row with NO provenance field still reads back fine after the schema add", async () => {
    const legacyId = `legacy-rel-${randomUUID()}`;
    const insertRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Relationship",
      records: [{
        id: legacyId, agentId: ownerAgent.id, subject: "legacy-subject", predicate: "manages", object: "legacy-object",
        createdAt: new Date().toISOString(),
      }],
    });
    expect(insertRes.status).toBe(200);

    const path = `/Relationship/${legacyId}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(ownerAgent, "GET", path) },
    });
    const text = await res.text();
    expect(res.status, `GET of a pre-provenance row returned ${res.status}: ${text}`).toBe(200);
    const body: any = JSON.parse(text);
    expect(body.subject).toBe("legacy-subject");
    expect(body.provenance == null).toBe(true);
  }, 30_000);

  test("render-escape: special characters in the triple pass through bootstrap's attention-read line as literal, safe plain text", async () => {
    const subject = `escape-subject-${randomUUID().slice(0, 8)}`;
    const weirdObject = `<script>alert(1)</script> & "quoted" 'text'`;
    await ownerClient.relationship.write({ subject, predicate: "mentions", object: weirdObject });

    const result = await bootstrap(harper, ownerClient, { maxTokens: 8000, subjects: [subject] });
    const context: string = result.context ?? "";
    // Plain-text passthrough is the correct behavior here: MemoryBootstrap's
    // output is consumed by agent/CLI/MCP text contexts in this repo, never
    // rendered into an HTML/DOM surface — so the literal, un-escaped
    // substring appearing intact (no crash, no truncation, no mangled
    // structure) IS the safety property to verify.
    expect(context).toContain(weirdObject.toLowerCase());
  }, 60_000);
});
