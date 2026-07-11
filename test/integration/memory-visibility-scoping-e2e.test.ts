// within-org-read-open — private/shared visibility + centralized read-scoping.
// Real-Harper end-to-end coverage of the security boundary: a memory written
// `private` must NEVER cross to a non-owner (the ONE remaining exception);
// every other memory (`shared`, or a pre-existing no-visibility-field record)
// is readable by ANY verified agent on the instance — no MemoryGrant required
// (superseding the original grant-gated read model; see resources/memory-
// read-scope.ts's module doc for the full design, Kern-approved). All four
// read paths the design doc calls out are exercised against a real spawned
// Harper: Memory.get() (by-id), Memory.search() (collection), SemanticSearch,
// and MemoryBootstrap — plus the auth-middleware.ts by-id guard, which is the
// pre-check `GET /Memory/<id>` passes through before ever reaching Memory.get().
//
// The `grantee`/`insertGrant` machinery below is kept ONLY to prove a grant
// is now IRRELEVANT to reads (the grantee sees exactly what the ungranted
// `stranger` sees) — resolveAllowedOwners() is still exported and grants
// still exist as a real relationship, they just no longer gate Memory reads.
//
// Pattern: test/integration/agent-journey.test.ts (Ed25519 signing helpers,
// admin-op seeding) + test/integration/durability-guard.test.ts (raw `insert`
// via the ops API to seed records that BYPASS resources/Memory.ts's write
// path entirely — needed to simulate a genuine pre-migration record with NO
// visibility field, since a signed PUT through Memory.put() would have the
// new durability-keyed default stamped onto it).
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

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  expect(res.status).toBe(200);
}

/** Raw insert — bypasses resources/Memory.ts's post()/put() ENTIRELY (no
 *  durability-keyed default stamped). Used to simulate records exactly as
 *  they exist pre-migration. */
async function insertMemoryRaw(harper: HarperInstance, record: Record<string, any>): Promise<void> {
  const res = await adminOp(harper, { operation: "insert", database: "flair", table: "Memory", records: [record] });
  expect(res.status, `raw insert of ${record.id} returned ${res.status}`).toBe(200);
}

async function insertGrant(harper: HarperInstance, ownerId: string, granteeId: string, scope: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${ownerId}:${granteeId}:${scope}`, ownerId, granteeId, scope, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

let harper: HarperInstance;
const owner = mkAgent("vis-owner");
const grantee = mkAgent("vis-grantee");
const stranger = mkAgent("vis-stranger");

const idLegacy = "vis-owner-legacy-no-field";     // no visibility field at all — migration invariant
const idShared = "vis-owner-explicit-shared";     // visibility: "shared"
const idPrivate = "vis-owner-explicit-private";   // visibility: "private"

describe("within-org-read-open — private/shared visibility + centralized read-scoping (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await seedAgent(harper, owner);
    await seedAgent(harper, grantee);
    await seedAgent(harper, stranger);

    const now = new Date().toISOString();
    await insertMemoryRaw(harper, { id: idLegacy, agentId: owner.id, content: "pre-migration finding, no visibility field", durability: "permanent", createdAt: now });
    await insertMemoryRaw(harper, { id: idShared, agentId: owner.id, content: "explicitly shared finding", visibility: "shared", durability: "permanent", createdAt: now });
    await insertMemoryRaw(harper, { id: idPrivate, agentId: owner.id, content: "explicitly private note", visibility: "private", durability: "permanent", createdAt: now });

    // grantee holds a read grant on owner; stranger holds NONE.
    await insertGrant(harper, owner.id, grantee.id, "read");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  // ─── Path 1a: Memory.get() (by-id) + the auth-middleware by-id guard ───────
  describe("Memory GET by id (Memory.get() + auth-middleware's guard, path 1 + 4)", () => {
    test("owner sees all three of its own memories, any visibility", async () => {
      for (const id of [idLegacy, idShared, idPrivate]) {
        const res = await authFetch(harper, owner, "GET", `/Memory/${id}`);
        expect(res.status, `owner GET ${id} → ${res.status}`).toBe(200);
      }
    }, 30_000);

    test("migration invariant: grantee GETs the legacy (no-visibility-field) memory — reads as shared", async () => {
      const res = await authFetch(harper, grantee, "GET", `/Memory/${idLegacy}`);
      expect(res.status, `grantee GET legacy → ${res.status}: ${await res.text()}`).toBe(200);
    }, 30_000);

    test("grantee GETs the explicitly-shared memory", async () => {
      const res = await authFetch(harper, grantee, "GET", `/Memory/${idShared}`);
      expect(res.status).toBe(200);
    }, 30_000);

    test("private-exclusion: grantee's GET of the PRIVATE memory is denied (never 200)", async () => {
      const res = await authFetch(harper, grantee, "GET", `/Memory/${idPrivate}`);
      expect([403, 404], `grantee GET private → ${res.status} (expected denied)`).toContain(res.status);
      const text = await res.text();
      expect(text).not.toContain("explicitly private note");
    }, 30_000);

    test("within-org-read-open: stranger (no grant at all) CAN GET the legacy + shared memories — only the PRIVATE one is denied", async () => {
      for (const id of [idLegacy, idShared]) {
        const res = await authFetch(harper, stranger, "GET", `/Memory/${id}`);
        expect(res.status, `stranger GET ${id} → ${res.status} (expected 200 — no grant needed)`).toBe(200);
      }
      const privRes = await authFetch(harper, stranger, "GET", `/Memory/${idPrivate}`);
      expect([403, 404], `stranger GET private → ${privRes.status} (expected denied)`).toContain(privRes.status);
    }, 30_000);
  });

  // ─── Path 1b: Memory.search() (collection GET) ─────────────────────────────
  describe("Memory GET collection (Memory.search(), path 1)", () => {
    test("grantee's collection GET includes owner's legacy + shared memories, not the private one", async () => {
      const res = await authFetch(harper, grantee, "GET", "/Memory/");
      const body: any = await res.json();
      expect(res.status, `grantee collection GET → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
      const rows: any[] = Array.isArray(body) ? body : (body.results ?? body);
      const ids = new Set(rows.map((r: any) => r.id));
      expect(ids.has(idLegacy)).toBe(true);
      expect(ids.has(idShared)).toBe(true);
      expect(ids.has(idPrivate)).toBe(false);
    }, 30_000);

    test("within-org-read-open: stranger's collection GET includes owner's legacy + shared memories, not the private one — no grant needed", async () => {
      const res = await authFetch(harper, stranger, "GET", "/Memory/");
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const rows: any[] = Array.isArray(body) ? body : (body.results ?? body);
      const ids = new Set(rows.map((r: any) => r.id));
      expect(ids.has(idLegacy)).toBe(true);
      expect(ids.has(idShared)).toBe(true);
      expect(ids.has(idPrivate)).toBe(false);
    }, 30_000);
  });

  // ─── Path 2: SemanticSearch ─────────────────────────────────────────────────
  describe("POST /SemanticSearch (path 2 — within-org-read-open)", () => {
    test("grantee sees the legacy + shared memories via SemanticSearch, never the private one", async () => {
      const res = await authFetch(harper, grantee, "POST", "/SemanticSearch", { agentId: grantee.id, limit: 100 });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const ids = new Set((body.results ?? []).map((r: any) => r.id));
      expect(ids.has(idLegacy)).toBe(true);
      expect(ids.has(idShared)).toBe(true);
      expect(ids.has(idPrivate)).toBe(false);
    }, 60_000);

    test("within-org-read-open: stranger's SemanticSearch surfaces owner's legacy + shared memories, never the private one — no grant needed", async () => {
      const res = await authFetch(harper, stranger, "POST", "/SemanticSearch", { agentId: stranger.id, limit: 100 });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const ids = new Set((body.results ?? []).map((r: any) => r.id));
      expect(ids.has(idShared)).toBe(true);
      expect(ids.has(idLegacy)).toBe(true);
      expect(ids.has(idPrivate)).toBe(false);
    }, 60_000);
  });

  // ─── Path 3: MemoryBootstrap ────────────────────────────────────────────────
  describe("POST /BootstrapMemories (path 3 — flair#550 foundation)", () => {
    test("grantee's bootstrap READ-SCOPE includes owner's legacy + shared findings (not the private one); post-#550 those teammate records don't bleed into own-context sections", async () => {
      const res = await authFetch(harper, grantee, "POST", "/BootstrapMemories", { agentId: grantee.id, maxTokens: 4000 });
      const bodyText = await res.text();
      expect(res.status, `bootstrap → ${res.status}: ${bodyText.slice(0, 2000)}`).toBe(200);
      const body: any = JSON.parse(bodyText);
      // `memoriesAvailable` (flair-bootstrap-scale-fix) is now the OWN-scoped
      // count (agentId==self, a cheap indexed seek) — no longer a read-scope
      // signal. The grantee owns ZERO memories in this fixture (only `owner`
      // does), so it's 0 regardless of what's readable. The actual read-scope
      // proof (legacy + shared readable, private excluded) is Path 1/2's job
      // above (Memory GET/collection, SemanticSearch) — this assertion is
      // just confirming the new count reflects "mine", not "everything I can
      // read".
      expect(body.memoriesAvailable, `grantee's OWN memory count should be 0 (fixture seeds none for grantee) — got ${body.memoriesAvailable}`).toBe(0);
      // #550 design boundary: these owner records are grant-visible TEAMMATE
      // memories, and they were raw-inserted (no embeddings) so they can't
      // surface via the task-relevant "Teammate findings" path either. With
      // own-context sections now own-only, none of them render in this
      // no-currentTask bootstrap — critically, the private note never leaks.
      // (The rendered teammate-findings surfacing is covered end-to-end, with
      // real embeddings, in bootstrap-teammate-findings-e2e.test.ts.)
      expect(body.context ?? "").not.toContain("explicitly private note");
      expect(body.context ?? "").not.toContain("pre-migration finding");
      expect(body.context ?? "").not.toContain("explicitly shared finding");
    }, 60_000);

    test("within-org-read-open: stranger's bootstrap READ-SCOPE also includes owner's legacy + shared findings (no grant needed) — but they still don't render without a currentTask, and the private note never leaks", async () => {
      const res = await authFetch(harper, stranger, "POST", "/BootstrapMemories", { agentId: stranger.id, maxTokens: 4000 });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      // Same reasoning as the grantee above: `memoriesAvailable` is now
      // own-scoped, and the stranger owns zero memories in this fixture too
      // — proving the grant was never what gated read-scope (Path 1/2 above
      // are the read-scope proof) and that this cosmetic count doesn't
      // secretly reintroduce a scope-wide computation either.
      expect(body.memoriesAvailable, `stranger's OWN memory count should be 0 (fixture seeds none for stranger) — got ${body.memoriesAvailable}`).toBe(0);
      expect(body.context ?? "").not.toContain("pre-migration finding");
      expect(body.context ?? "").not.toContain("explicitly shared finding");
      expect(body.context ?? "").not.toContain("explicitly private note");
    }, 60_000);
  });

  // ─── Durability-keyed default (write path, part A) ─────────────────────────
  describe("durability-keyed default visibility (real write path)", () => {
    test("a persistent write with no visibility is stored as shared", async () => {
      const id = "vis-owner-write-persistent";
      const put = await authFetch(harper, owner, "PUT", `/Memory/${id}`, { id, agentId: owner.id, content: "a persistent decision, long enough for the safety scan", durability: "persistent" });
      expect(put.status, `PUT ${id} → ${put.status}: ${await put.text()}`).toBe(200);
      const get = await authFetch(harper, owner, "GET", `/Memory/${id}`);
      const body: any = await get.json();
      expect(body.visibility).toBe("shared");
    }, 30_000);

    test("an ephemeral write with no visibility is stored as private", async () => {
      const id = "vis-owner-write-ephemeral";
      const put = await authFetch(harper, owner, "PUT", `/Memory/${id}`, { id, agentId: owner.id, content: "scratch state, long enough for the safety scan", durability: "ephemeral" });
      expect(put.status).toBe(200);
      const get = await authFetch(harper, owner, "GET", `/Memory/${id}`);
      const body: any = await get.json();
      expect(body.visibility).toBe("private");
    }, 30_000);

    test("an explicit visibility always overrides the durability default", async () => {
      const id = "vis-owner-write-explicit-override";
      const put = await authFetch(harper, owner, "PUT", `/Memory/${id}`, {
        id, agentId: owner.id, content: "explicitly private despite being permanent, long enough for the scan",
        durability: "permanent", visibility: "private",
      });
      expect(put.status).toBe(200);
      const get = await authFetch(harper, owner, "GET", `/Memory/${id}`);
      const body: any = await get.json();
      expect(body.visibility).toBe("private");
    }, 30_000);

    test("a granted owner's freshly-written shared memory is immediately visible to the grantee", async () => {
      const id = "vis-owner-write-fresh-shared";
      const put = await authFetch(harper, owner, "PUT", `/Memory/${id}`, {
        id, agentId: owner.id, content: "fresh shared finding, long enough for the safety scan", durability: "permanent", visibility: "shared",
      });
      expect(put.status).toBe(200);
      const res = await authFetch(harper, grantee, "GET", `/Memory/${id}`);
      expect(res.status).toBe(200);
    }, 30_000);
  });

  // ─── Injection ──────────────────────────────────────────────────────────────
  describe("injection: a reader cannot craft a query to surface a granted owner's private record", () => {
    test("grantee's collection GET with extra (attacker-controlled-shaped) query params never leaks the private id", async () => {
      // Memory.search() no longer translates URL params into conditions at
      // all (see resources/Memory.ts's own doc comment) — any attacker-
      // supplied query string is inert; the resolved scope condition is the
      // only thing that determines the result set.
      const res = await authFetch(harper, grantee, "GET", `/Memory/?visibility=private&agentId=${owner.id}`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const rows: any[] = Array.isArray(body) ? body : (body.results ?? body);
      expect(rows.map((r: any) => r.id)).not.toContain(idPrivate);
    }, 30_000);
  });
});
