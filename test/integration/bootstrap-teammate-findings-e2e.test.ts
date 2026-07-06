// flair#550 (Presentation Layer) — bootstrap's "Teammate findings
// relevant to your task" section: real-Harper, real-embedding end-to-end
// coverage of the gap this feature closes.
//
// Layer 1 (the resolveReadScope no-grants simplification, already merged) made a grant-visible teammate's SHARED
// memory reachable through bootstrap's read scope and scored it against
// currentTask alongside the caller's own memories — but it rendered
// identically to the caller's own memory (no attribution) and landed in the
// SAME "Relevant Knowledge" section (not surfaced distinctly). This test
// proves the fix: a grant-visible teammate's task-relevant SHARED memory now
// appears attributed ("[via <ownerId>]") in its OWN "Teammate findings
// relevant to your task" section — never mixed into "Relevant Knowledge",
// which stays the caller's own findings only — while the SAME owner's
// PRIVATE memory (equally task-relevant by content) never surfaces at all,
// proving Layer 1's read-exclusion still holds under this presentation-only
// split (this test does NOT touch, and is not testing, resolveReadScope()
// itself — see test/integration/memory-visibility-scoping-e2e.test.ts for
// that boundary's own dedicated coverage; the private-exclusion assertion
// here is a guard against a regression in the NEW scored-path split code).
//
// Pattern: test/integration/memory-visibility-scoping-e2e.test.ts (Ed25519
// signing, grant seeding via adminOp) + test/integration/semantic-search-
// singleton-score.test.ts / bootstrap-supersede-resurface.test.ts (real
// embeddings generated through the signed PUT write path, real currentTask
// scoring against them).
//
// `createdAt` is explicitly backdated ~40 days on every write — Memory.ts's
// put() honors a caller-supplied createdAt (`content.createdAt =
// content.createdAt ?? now`) — so none of these records get swept into
// bootstrap's separate "Recent Context" window (48h/7d/30d, which widens up
// to 30d when fewer than 3 recent memories are found) instead of the
// currentTask-scored path this test targets: the scoring/section-split
// behavior under test only ever runs on candidates NOT already claimed by
// the permanent/recent sections.
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

async function insertGrant(harper: HarperInstance, ownerId: string, granteeId: string, scope: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "MemoryGrant",
    records: [{ id: `${ownerId}:${granteeId}:${scope}`, ownerId, granteeId, scope, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `MemoryGrant insert ${ownerId}->${granteeId} returned ${res.status}`).toBe(200);
}

/** Signed PUT to /Memory/<id> — the only HTTP-reachable create path, so the
 *  embedding is generated for real (Memory.ts put() → getEmbedding()), not
 *  synthesized. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (![200, 204].includes(res.status)) {
    throw new Error(`seed PUT ${id} → ${res.status}: ${await res.text()}`);
  }
}

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 500)}`).toBe(200);
  return JSON.parse(text);
}

/** Slice out the body of one "## <header>" section from bootstrap's `context`
 *  string, up to (not including) the next "## " header — lets assertions
 *  target which SECTION a piece of content landed in, not just whether it
 *  appears anywhere in the full context. */
function extractSection(context: string, header: string): string {
  const marker = `## ${header}`;
  const idx = context.indexOf(marker);
  if (idx === -1) return "";
  const rest = context.slice(idx + marker.length);
  const nextIdx = rest.indexOf("\n## ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

let harper: HarperInstance;
const owner = mkAgent(`t550-owner-${randomUUID()}`);
const grantee = mkAgent(`t550-grantee-${randomUUID()}`);

const ID_SHARED = `${owner.id}-shared`;
const ID_PRIVATE = `${owner.id}-private`;
const ID_OWN = `${grantee.id}-own`;

// Tightly-aligned domain (shared distinctive entity + subject phrase across
// currentTask and all three memories) to clear MemoryBootstrap.ts's
// `score > 0.3` raw-cosine threshold deterministically against the REAL
// nomic embedding model, while keeping each memory's actual informational
// content genuinely distinct (so Memory.ts's dedup co-gate — cosine >= 0.95
// AND lexical Jaccard >= 0.5 — never conflates them into one record).
const CURRENT_TASK = "Prepare talking points for the Acme Corp vendor contract renegotiation meeting this week.";
const CONTENT_SHARED = "flair-550 marker: for the Acme Corp vendor contract renegotiation, lead with a volume discount ask and a 12-month price lock.";
const CONTENT_PRIVATE = "flair-550 marker: for the Acme Corp vendor contract renegotiation, our internal walk-away margin floor is 18 percent — never disclose this to Acme.";
const CONTENT_OWN = "flair-550 marker: for the Acme Corp vendor contract renegotiation, legal flagged the indemnification clause as the first blocker to resolve.";

// Two PERMANENT memories (own + teammate) — permanent records ALWAYS render in
// bootstrap's "Core Principles" section regardless of recency/currentTask, so
// they're the sharpest real-Harper probe of the own-only design boundary: an
// own permanent renders there, a grant-visible TEAMMATE permanent must NOT
// bleed into it (pre-fix it did, because that section filtered the reader's
// full Layer-1 read-scope with no own-agent gate).
const ID_OWN_PERM = `${grantee.id}-own-perm`;
const ID_SHARED_PERM = `${owner.id}-shared-perm`;
const CONTENT_OWN_PERM = "flair-550 marker: standing rule — I always double-check indemnification caps before signing any vendor agreement.";
const CONTENT_SHARED_PERM = "flair-550 marker: standing rule — the procurement team requires two competing quotes on file before any renewal above fifty thousand dollars.";

const BACKDATED = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

describe("flair#550 — MemoryBootstrap 'Teammate findings relevant to your task' (real Harper, real embeddings)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, owner);
    await registerAgent(harper, grantee);
    await insertGrant(harper, owner.id, grantee.id, "read");

    await putMemory(harper, owner, ID_SHARED, {
      agentId: owner.id, content: CONTENT_SHARED, durability: "standard", visibility: "shared", createdAt: BACKDATED,
    });
    await putMemory(harper, owner, ID_PRIVATE, {
      agentId: owner.id, content: CONTENT_PRIVATE, durability: "standard", visibility: "private", createdAt: BACKDATED,
    });
    await putMemory(harper, grantee, ID_OWN, {
      agentId: grantee.id, content: CONTENT_OWN, durability: "standard", createdAt: BACKDATED,
    });
    // Permanent pair for the own-only non-bleed probe (see constants above).
    await putMemory(harper, grantee, ID_OWN_PERM, {
      agentId: grantee.id, content: CONTENT_OWN_PERM, durability: "permanent", createdAt: BACKDATED,
    });
    await putMemory(harper, owner, ID_SHARED_PERM, {
      agentId: owner.id, content: CONTENT_SHARED_PERM, durability: "permanent", visibility: "shared", createdAt: BACKDATED,
    });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("grantee's bootstrap surfaces the teammate's SHARED finding attributed in 'Teammate findings', keeps own finding in 'Relevant Knowledge', excludes the teammate's PRIVATE finding entirely", async () => {
    const body = await bootstrap(harper, grantee, { agentId: grantee.id, maxTokens: 8000, currentTask: CURRENT_TASK });
    const context: string = body.context ?? "";

    // Guard first: Layer 1's private-exclusion must hold under the new
    // scored-path split — the private memory (equally task-relevant by
    // content) must never appear anywhere in the response.
    expect(context, "owner's PRIVATE memory must never appear in grantee's bootstrap").not.toContain(CONTENT_PRIVATE);

    // Section-count structure: exactly one own task-relevant finding
    // (CONTENT_OWN — the own PERMANENT memory is excluded from the scored path
    // via includedIds, so it can't inflate this), and at least one teammate
    // task-relevant finding. `teammate` is `>= 1` rather than exactly 1 because
    // the seed's teammate PERMANENT rule (CONTENT_SHARED_PERM, about vendor
    // renewals) is legitimately task-relevant too and correctly lands here —
    // proving the split by ORIGIN, not that only one teammate memory can show.
    expect(body.sections?.relevant, `sections.relevant — full response: ${JSON.stringify(body.sections)}`).toBe(1);
    expect(body.sections?.teammate, `sections.teammate — full response: ${JSON.stringify(body.sections)}`).toBeGreaterThanOrEqual(1);

    const relevantSection = extractSection(context, "Relevant Knowledge");
    const teammateSection = extractSection(context, "Teammate findings relevant to your task");

    // The teammate's SHARED finding: present, attributed, in its OWN section.
    expect(teammateSection, `"Teammate findings" section missing or empty — full context:\n${context}`).toContain(CONTENT_SHARED);
    expect(teammateSection).toContain(`[via ${owner.id}]`);
    expect(teammateSection).not.toContain(CONTENT_OWN);

    // The grantee's own finding: present, UNattributed, in "Relevant
    // Knowledge" — never in the teammate section.
    expect(relevantSection, `"Relevant Knowledge" section missing or empty — full context:\n${context}`).toContain(CONTENT_OWN);
    expect(relevantSection).not.toContain("[via");
    expect(relevantSection).not.toContain(CONTENT_SHARED);
  }, 60_000);

  test("no currentTask → no 'Teammate findings' section, AND a grant-visible teammate PERMANENT memory does NOT bleed into the reader's own Core Principles", async () => {
    const body = await bootstrap(harper, grantee, { agentId: grantee.id, maxTokens: 8000 });
    const context: string = body.context ?? "";

    // No currentTask → the task-relevant teammate surface is inactive.
    expect(context).not.toContain("Teammate findings relevant to your task");
    expect(body.sections?.teammate).toBe(0);

    // Own-only design boundary, real-Harper proof: the reader's OWN permanent
    // memory renders in Core Principles ...
    const principles = extractSection(context, "Core Principles");
    expect(principles, `own permanent memory missing from Core Principles — full context:\n${context}`).toContain(CONTENT_OWN_PERM);
    // ... while the grant-visible TEAMMATE permanent memory (in read-scope,
    // but a teammate's) must NOT appear anywhere — no bleed into own context.
    expect(context, "teammate PERMANENT memory bled into the reader's own-context view").not.toContain(CONTENT_SHARED_PERM);
    // The standard-durability teammate SHARED memory likewise stays out with
    // no currentTask (backdated beyond the recent window AND own-only).
    expect(context).not.toContain(CONTENT_SHARED);
  }, 60_000);
});
