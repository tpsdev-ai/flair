/**
 * memory-bootstrap-scoping.test.ts — ops-2dm3 Layer 1 unit coverage for
 * resources/MemoryBootstrap.ts's read-scoping.
 *
 * Originally (ops-2dm3 Layer 1), bootstrap only ever loaded the caller's OWN
 * memories (`record.agentId !== agentId → continue`) — no grant traversal at
 * all, so an agent holding a MemoryGrant on a teammate never saw that
 * teammate's memories through bootstrap (the gap flair#550 was filed
 * against). Layer 1 fixed that via grant-gated cross-agent reads; the
 * within-org-read-open change (see resources/memory-read-scope.ts's module
 * doc) supersedes the grant gate entirely. Bootstrap now resolves its scope
 * through the SAME centralized helper every other read path uses
 * (resources/memory-read-scope.ts resolveReadScope()): own (any visibility)
 * + EVERY other agent's non-private memories — a MemoryGrant is no longer
 * consulted at all.
 *
 * Same in-memory-store mocking technique as memory-integrity.test.ts /
 * semantic-search-scoping.test.ts. This file owns MemoryBootstrap.ts's
 * mock+import exclusively (no other test/unit/ file imports it).
 */
import { describe, it, expect, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// Deterministic task-relevance scoring without a real embedding model — same
// technique as test/unit/memory-integrity.test.ts (constant vector → cosine
// 1.0 between any two records using it), sized to clear MemoryBootstrap.ts's
// OWN scored-path candidate filter (`m.embedding?.length > 100` — a record
// with a short/absent embedding is never even considered "task-relevant").
// MemoryBootstrap.ts's task-relevant path calls getEmbedding(currentTask) for
// the query vector and reads `record.embedding` directly off whatever's in
// the mock store, so the SAME 128-length vector on both sides deterministically
// clears both the length gate and the `score > 0.3` threshold (dot product
// with itself = 1). memory-integrity.test.ts's own mock of this module only
// needs "a constant vector returned every call" (never compares its literal
// values against anything) — length differing between the two files' mocks
// doesn't matter to either.
const FAKE_EMBEDDING = [1, ...Array(127).fill(0)];
mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (_text: string) => FAKE_EMBEDDING,
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
}));

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const fieldVal = record[cond.attribute];
  if (cond.comparator === "equals") return fieldVal === cond.value;
  if (cond.comparator === "not_equal") return fieldVal !== cond.value;
  return true;
}

let memoryStore: Map<string, any>;
let memoryGrants: any[];

function memorySearchGen(query: any) {
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  let records = Array.from(memoryStore.values());
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
  async function* gen() {
    for (const r of records) yield r;
  }
  return gen();
}

function emptyGen() {
  async function* gen() {}
  return gen();
}

const databasesMock = {
  flair: {
    Memory: { search: (query: any) => memorySearchGen(query) },
    MemoryGrant: {
      search: (query: any) => {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        let grants = memoryGrants.slice();
        for (const cond of conditions) grants = grants.filter((g) => matchesCondition(g, cond));
        async function* gen() {
          for (const g of grants) yield g;
        }
        return gen();
      },
    },
    Soul: { search: () => emptyGen() },
    Agent: { search: () => emptyGen(), get: async () => null },
    Relationship: { search: () => emptyGen() },
    OrgEvent: { search: () => emptyGen() },
  },
};

class ResourceBase {}

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: ResourceBase }));

const { BootstrapMemories } = await import("../../resources/MemoryBootstrap.ts");

function makeBootstrap(ctxRequest: any) {
  const r: any = new (BootstrapMemories as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

function reset() {
  memoryStore = new Map();
  memoryGrants = [];
}

// formatMemory() (resources/MemoryBootstrap.ts) renders each memory's content
// verbatim into its section, so asserting on `result.context` is a reasonable
// proxy for "was this memory actually surfaced" without reaching into internal
// state. NOTE (#550 design boundary): for a TEAMMATE (grant-visible) record
// that proxy holds ONLY when the record is task-relevant — the permanent /
// recent / predicted sections are own-only, so a teammate record entering
// read-scope (`memoriesAvailable`) is decoupled from whether it renders. The
// read-scope tests below therefore assert `memoriesAvailable` for teammate
// records, and rendering is covered by the #550 describe block further down.

describe("MemoryBootstrap.post() — ops-2dm3 Layer 1 centralized read-scoping", () => {
  it("read-scope includes the caller's own memories PLUS any other agent's non-private memory — no grant required (within-org-read-open)", async () => {
    reset();
    memoryStore.set("m1", { id: "m1", agentId: "agent-1", content: "MY-OWN-FINDING", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });
    memoryStore.set("m2", { id: "m2", agentId: "agent-other", content: "NOT-MINE-BUT-ORG-OPEN-FINDING", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" }); // no visibility field
    memoryStore.set("m3", { id: "m3", agentId: "agent-other", content: "NOT-MINE-PRIVATE-FINDING", visibility: "private", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });

    const b = makeBootstrap(agentCtx("agent-1"));
    const res: any = await b.post({ agentId: "agent-1", includeSoul: false });
    expect(res.context).toContain("MY-OWN-FINDING");
    // m2 is in read-scope (memoriesAvailable) but — per the #550 own-context
    // design boundary — a teammate record only RENDERS via the task-relevant
    // "Teammate findings" section; with no currentTask here it doesn't bleed
    // into the reader's own-context sections. m3 (private) never enters
    // scope at all.
    expect(res.context).not.toContain("NOT-MINE-BUT-ORG-OPEN-FINDING");
    expect(res.context).not.toContain("NOT-MINE-PRIVATE-FINDING");
    expect(res.memoriesAvailable).toBe(2);
  });

  it("a grant-holder's read-scope now includes the owner's SHARED memory (the flair#550 gap this closes) — but it does NOT bleed into own-context sections", async () => {
    reset();
    memoryStore.set("shared-1", { id: "shared-1", agentId: "agent-owner", content: "TEAMMATE-SHARED-FINDING", visibility: "shared", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false }); // no currentTask
    // Layer 1: the SHARED memory is in the reader's read-scope ...
    expect(res.memoriesAvailable).toBe(1);
    // ... but the #550 design boundary keeps it out of the reader's OWN
    // permanent/recent/predicted view — with no currentTask, its only surface
    // (the task-relevant "Teammate findings" section) is inactive, so it
    // renders nowhere. This is the non-bleed guarantee.
    expect(res.context).not.toContain("TEAMMATE-SHARED-FINDING");
  });

  it("private-exclusion: a grant-holder does NOT see the owner's PRIVATE memory", async () => {
    reset();
    memoryStore.set("private-1", { id: "private-1", agentId: "agent-owner", content: "TEAMMATE-PRIVATE-NOTE", visibility: "private", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false });
    expect(res.context).not.toContain("TEAMMATE-PRIVATE-NOTE");
    expect(res.memoriesAvailable).toBe(0);
  });

  it("migration invariant: a grant-holder's read-scope includes a NO-visibility-field owner record (absent reads as shared) — but it too stays out of own-context sections", async () => {
    reset();
    memoryStore.set("legacy-1", { id: "legacy-1", agentId: "agent-owner", content: "LEGACY-PRE-MIGRATION-FINDING", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" }); // no visibility field
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "search" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false });
    // Migration invariant lives at the READ-SCOPE layer: an absent visibility
    // field reads as shared, so the legacy record enters the grantee's scope
    // (vs. a private record, which would not — see the private-exclusion test's
    // memoriesAvailable === 0). Rendering is still own-only, so with no
    // currentTask it doesn't bleed into the reader's own-context view.
    expect(res.memoriesAvailable).toBe(1);
    expect(res.context).not.toContain("LEGACY-PRE-MIGRATION-FINDING");
  });

  it("within-org-read-open: an ungranted owner's SHARED memory IS now in read-scope (memoriesAvailable), though it still doesn't bleed into own-context sections without a currentTask", async () => {
    reset();
    memoryStore.set("shared-no-grant", { id: "shared-no-grant", agentId: "agent-owner", content: "SHARED-BUT-UNGRANTED", visibility: "shared", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });

    const b = makeBootstrap(agentCtx("agent-stranger"));
    const res: any = await b.post({ agentId: "agent-stranger", includeSoul: false });
    expect(res.context).not.toContain("SHARED-BUT-UNGRANTED");
    expect(res.memoriesAvailable).toBe(1);
  });

  it("private-exclusion still holds without a grant: a stranger's read-scope never includes another agent's PRIVATE memory", async () => {
    reset();
    memoryStore.set("private-no-grant", { id: "private-no-grant", agentId: "agent-owner", content: "PRIVATE-AND-UNGRANTED", visibility: "private", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });

    const b = makeBootstrap(agentCtx("agent-stranger"));
    const res: any = await b.post({ agentId: "agent-stranger", includeSoul: false });
    expect(res.context).not.toContain("PRIVATE-AND-UNGRANTED");
    expect(res.memoriesAvailable).toBe(0);
  });

  it("the caller always sees its own private memory through bootstrap", async () => {
    reset();
    memoryStore.set("mine-private", { id: "mine-private", agentId: "agent-1", content: "MY-OWN-PRIVATE-NOTE", visibility: "private", durability: "permanent", createdAt: "2026-01-01T00:00:00Z" });

    const b = makeBootstrap(agentCtx("agent-1"));
    const res: any = await b.post({ agentId: "agent-1", includeSoul: false });
    expect(res.context).toContain("MY-OWN-PRIVATE-NOTE");
  });
});

// ─── flair#550 — teammate findings attribution + "Teammate findings" section ─
//
// Layer 1 (above) already made grant-visible teammate SHARED memories
// reachable through bootstrap's read scope; these tests cover the
// PRESENTATION gap: (1) formatMemory() attributes a cross-agent record with
// "[via <ownerId>]" and composes with the safety wrap, and (2) the
// currentTask-scored path splits by origin into sections.relevant (own) vs
// the new sections.teammate (grant-visible teammate), never mixing them, and
// never letting a teammate's PRIVATE memory reach the scored path at all
// (Layer 1's exclusion, re-asserted here as a guard on the NEW split code).
//
// All records below carry embedding: FAKE_EMBEDDING so they clear the
// `score > 0.3` deterministic-cosine-1.0 threshold against any currentTask
// (mocked getEmbedding returns the same vector, see top of file). createdAt
// is pinned far in the past so nothing here is ever swept into the
// recent/permanent sections instead — the point is to isolate the
// task-relevant scored path exclusively.
const OLD_DATE = "2020-01-01T00:00:00Z";

describe("MemoryBootstrap.post() — flair#550 teammate-findings attribution + section", () => {
  it("formatMemory attributes a grant-visible teammate SHARED memory with [via <ownerId>]", async () => {
    reset();
    // A teammate record only RENDERS via the task-relevant teammate section
    // (own-context sections are own-only), so make it task-relevant: embedding
    // + currentTask (mocked getEmbedding → cosine 1.0 clears score > 0.3).
    memoryStore.set("shared-attr", {
      id: "shared-attr", agentId: "agent-owner", content: "TEAMMATE-ATTR-FINDING",
      visibility: "shared", durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    expect(res.context).toContain("[via agent-owner] TEAMMATE-ATTR-FINDING");
  });

  it("the caller's own memory renders WITHOUT any [via ...] attribution (unchanged)", async () => {
    reset();
    memoryStore.set("own-attr", {
      id: "own-attr", agentId: "agent-1", content: "MY-OWN-UNATTRIBUTED-FINDING",
      durability: "permanent", createdAt: "2026-01-01T00:00:00Z",
    });

    const b = makeBootstrap(agentCtx("agent-1"));
    const res: any = await b.post({ agentId: "agent-1", includeSoul: false });
    // durability: "permanent" → 🔒 tag (see formatMemory's tag selection).
    expect(res.context).toContain("🔒 MY-OWN-UNATTRIBUTED-FINDING");
    expect(res.context).not.toContain("[via");
  });

  it("attribution composes with the safety wrap — a flagged teammate memory shows BOTH", async () => {
    reset();
    // Task-relevant (embedding + currentTask) so the flagged teammate record
    // reaches the teammate section where it renders — see the note above.
    memoryStore.set("shared-flagged", {
      id: "shared-flagged", agentId: "agent-owner", content: "TEAMMATE-FLAGGED-FINDING",
      visibility: "shared", durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
      _safetyFlags: ["prompt_injection"],
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    // Both markers present ...
    expect(res.context).toContain("[⚠️ SAFETY:");
    expect(res.context).toContain("[via agent-owner]");
    expect(res.context).toContain("TEAMMATE-FLAGGED-FINDING");
    // ... and the attribution is INSIDE the safety wrapper (attribution is
    // baked into `base` before wrapUntrusted() wraps it), not appended after.
    const safetyStart = res.context.indexOf("[⚠️ SAFETY:");
    const safetyEnd = res.context.indexOf("[/SAFETY]");
    const viaIdx = res.context.indexOf("[via agent-owner]");
    expect(viaIdx).toBeGreaterThan(safetyStart);
    expect(viaIdx).toBeLessThan(safetyEnd);
  });

  it("a task-relevant teammate SHARED memory lands in the new 'Teammate findings' section, attributed", async () => {
    reset();
    memoryStore.set("teammate-task", {
      id: "teammate-task", agentId: "agent-owner", content: "TEAMMATE-TASK-RELEVANT-FINDING",
      visibility: "shared", durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    expect(res.context).toContain("## Teammate findings relevant to your task");
    expect(res.context).toContain("[via agent-owner] TEAMMATE-TASK-RELEVANT-FINDING");
    expect(res.sections.teammate).toBe(1);
    expect(res.sections.relevant).toBe(0);
  });

  it("the agent's OWN task-relevant memory lands in 'relevant', never 'teammate'", async () => {
    reset();
    memoryStore.set("own-task", {
      id: "own-task", agentId: "agent-grantee", content: "MY-OWN-TASK-RELEVANT-FINDING",
      durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    expect(res.context).toContain("## Relevant Knowledge");
    expect(res.context).toContain("📝 MY-OWN-TASK-RELEVANT-FINDING");
    expect(res.context).not.toContain("## Teammate findings relevant to your task");
    expect(res.sections.relevant).toBe(1);
    expect(res.sections.teammate).toBe(0);
  });

  it("own + teammate task-relevant findings both surface, correctly split, in one bootstrap", async () => {
    reset();
    memoryStore.set("own-task-2", {
      id: "own-task-2", agentId: "agent-grantee", content: "MIXED-OWN-FINDING",
      durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryStore.set("teammate-task-2", {
      id: "teammate-task-2", agentId: "agent-owner", content: "MIXED-TEAMMATE-FINDING",
      visibility: "shared", durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    expect(res.context).toContain("📝 MIXED-OWN-FINDING");
    expect(res.context).toContain("[via agent-owner] MIXED-TEAMMATE-FINDING");
    expect(res.sections.relevant).toBe(1);
    expect(res.sections.teammate).toBe(1);
  });

  it("guard: a teammate's PRIVATE memory never reaches the task-relevant scored path (Layer 1 exclusion holds under the new split)", async () => {
    reset();
    memoryStore.set("teammate-private-task", {
      id: "teammate-private-task", agentId: "agent-owner", content: "TEAMMATE-PRIVATE-TASK-FINDING",
      visibility: "private", durability: "standard", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    expect(res.context).not.toContain("TEAMMATE-PRIVATE-TASK-FINDING");
    expect(res.context).not.toContain("## Teammate findings relevant to your task");
    expect(res.sections.teammate).toBe(0);
  });

  it("no currentTask, no teammate matches → the 'Teammate findings' header never renders (empty section renders nothing)", async () => {
    reset();
    memoryStore.set("shared-no-task", {
      id: "shared-no-task", agentId: "agent-owner", content: "SHARED-NO-TASK-QUERY",
      visibility: "shared", durability: "permanent", createdAt: "2026-01-01T00:00:00Z",
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false }); // no currentTask
    expect(res.context).not.toContain("## Teammate findings relevant to your task");
    expect(res.sections.teammate).toBe(0);
  });

  // ─── Own-context sections are OWN-ONLY (the design-correction boundary) ─────
  // Post-Layer-1 `activeMemories` carries grant-visible teammate records; the
  // permanent / recent / predicted sections must NOT blend them into the
  // reader's own working context. Grant-visibility feeds ONLY the
  // task-relevant "Teammate findings" surface (or an explicit memory_search).

  it("a teammate's grant-visible PERMANENT memory does NOT appear in the reader's Core Principles (permanent) section", async () => {
    reset();
    // Give the reader an OWN permanent memory too, so the section renders and
    // we're asserting the teammate one is absent from a LIVE section (not just
    // that the section is empty).
    memoryStore.set("own-perm", {
      id: "own-perm", agentId: "agent-grantee", content: "MY-OWN-PERMANENT-RULE",
      durability: "permanent", createdAt: "2026-01-01T00:00:00Z",
    });
    memoryStore.set("teammate-perm", {
      id: "teammate-perm", agentId: "agent-owner", content: "TEAMMATE-PERMANENT-RULE",
      visibility: "shared", durability: "permanent", createdAt: "2026-01-01T00:00:00Z",
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false }); // no currentTask
    expect(res.context).toContain("## Core Principles");
    expect(res.context).toContain("MY-OWN-PERMANENT-RULE");         // own → renders
    expect(res.context).not.toContain("TEAMMATE-PERMANENT-RULE");   // teammate → no bleed
    expect(res.memoriesAvailable).toBe(2);                          // both in read-scope
  });

  it("a teammate's grant-visible RECENT memory does NOT appear in the reader's Recent Context section", async () => {
    reset();
    const recentDate = new Date(Date.now() - 3600_000).toISOString(); // 1h ago — inside the 48h window
    memoryStore.set("own-recent", {
      id: "own-recent", agentId: "agent-grantee", content: "MY-OWN-RECENT-NOTE",
      durability: "standard", createdAt: recentDate,
    });
    memoryStore.set("teammate-recent", {
      id: "teammate-recent", agentId: "agent-owner", content: "TEAMMATE-RECENT-NOTE",
      visibility: "shared", durability: "standard", createdAt: recentDate,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false }); // no currentTask
    expect(res.context).toContain("## Recent Context");
    expect(res.context).toContain("MY-OWN-RECENT-NOTE");        // own → renders
    expect(res.context).not.toContain("TEAMMATE-RECENT-NOTE");  // teammate → no bleed
  });

  it("a teammate's grant-visible subject-tagged memory does NOT appear in the reader's Predicted Context section", async () => {
    reset();
    memoryStore.set("own-subj", {
      id: "own-subj", agentId: "agent-grantee", content: "MY-OWN-SUBJECT-NOTE",
      durability: "standard", subject: "billing", createdAt: "2026-01-01T00:00:00Z",
    });
    memoryStore.set("teammate-subj", {
      id: "teammate-subj", agentId: "agent-owner", content: "TEAMMATE-SUBJECT-NOTE",
      visibility: "shared", durability: "standard", subject: "billing", createdAt: "2026-01-01T00:00:00Z",
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({ agentId: "agent-grantee", includeSoul: false, subjects: ["billing"] });
    expect(res.context).toContain("## Predicted Context");
    expect(res.context).toContain("MY-OWN-SUBJECT-NOTE");       // own → renders
    expect(res.context).not.toContain("TEAMMATE-SUBJECT-NOTE"); // teammate → no bleed
  });

  it("a teammate's grant-visible PERMANENT memory that IS task-relevant surfaces in 'Teammate findings' (not 'Core Principles')", async () => {
    reset();
    // durability: "permanent" — proves the teammate surface is by ORIGIN, not
    // durability: a permanent-durability teammate record is excluded from the
    // (own-only) permanent section yet still reaches the scored teammate path.
    memoryStore.set("teammate-perm-task", {
      id: "teammate-perm-task", agentId: "agent-owner", content: "TEAMMATE-PERMANENT-TASK-FINDING",
      visibility: "shared", durability: "permanent", createdAt: OLD_DATE, embedding: FAKE_EMBEDDING,
    });
    memoryGrants.push({ granteeId: "agent-grantee", ownerId: "agent-owner", scope: "read" });

    const b = makeBootstrap(agentCtx("agent-grantee"));
    const res: any = await b.post({
      agentId: "agent-grantee", includeSoul: false, currentTask: "investigate the thing",
    });
    // Surfaces in the teammate section, attributed ...
    expect(res.context).toContain("## Teammate findings relevant to your task");
    expect(res.context).toContain("[via agent-owner] TEAMMATE-PERMANENT-TASK-FINDING");
    expect(res.sections.teammate).toBe(1);
    // ... and never in Core Principles (the permanent section stayed own-only,
    // which here is empty → no header at all).
    expect(res.context).not.toContain("## Core Principles");
    expect(res.sections.permanent).toBe(0);
  });
});
