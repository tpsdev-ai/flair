/**
 * cli-visibility-backfill.test.ts — unit coverage for `flair migrate
 * visibility-backfill` (src/cli.ts's runVisibilityBackfillOnce), the
 * conservative visibility-backfill that MUST be run before deploying the
 * within-org-read-open change (resources/memory-read-scope.ts).
 *
 * ── Why this migration exists ────────────────────────────────────────────────
 * resources/memory-read-scope.ts's resolveReadScope() now treats every
 * non-private Memory record as org-open — readable by any verified agent, no
 * MemoryGrant required. Before that change, a `shared`/no-visibility-field
 * record was only readable by a grant-holder. A record that was `shared` (or
 * had no visibility field) but had NO grant covering it was, in practice,
 * owner-only. This migration pins that "effectively private" state to
 * `private` BEFORE the open-read code goes live, so nothing effectively-
 * private becomes a surprise org-open exposure. See resources/memory-read-
 * scope.ts's module doc and src/cli.ts's runVisibilityBackfillOnce doc for
 * the full ordering rationale (backfill MUST run first — a documented
 * operator step, deliberately never auto-run).
 *
 * ── Mocking pattern ───────────────────────────────────────────────────────────
 * Same technique as test/unit/federation-sync-push-privacy.test.ts: mock
 * global fetch to intercept the Harper ops-API calls runVisibilityBackfillOnce
 * makes (search_by_conditions on Memory + MemoryGrant, batched `update`
 * writes), dynamically import src/cli.ts, and call the exported function
 * directly — no live Harper needed.
 *
 * ── Migration-equivalence (the key safety test) ──────────────────────────────
 * The last describe block below proves the actual safety property: run the
 * backfill, THEN feed the resulting visibility values through the REAL
 * resources/memory-read-scope.ts resolveReadScope()/isAllowed() predicate
 * (imported directly, per that module's own doc — it's a plain-function
 * module deliberately safe to import under its own fresh "@harperfast/harper"
 * mock alongside this file's independent global-fetch mock for src/cli.ts).
 * This proves the conservative posture end-to-end: nothing that was
 * effectively-private before the open-read change is exposed after
 * (backfill THEN open-read) is applied, in that order.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

const origFetch = globalThis.fetch;

function res(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name === "content-length" ? String(JSON.stringify(body).length) : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Installs a content-dispatched fetch mock for the ops API. `memoryRows` /
 * `grantRows` back the two search_by_conditions calls runVisibilityBackfillOnce
 * makes; every `update` call is captured into `capturedUpdates` (flattened
 * across however many batches the records were split into) rather than
 * applied to a real store — each test asserts on the captured records
 * directly, which is a stronger check than round-tripping through a fake
 * store would be.
 */
function installMock(memoryRows: any[], grantRows: any[] = []): { capturedUpdates: any[]; updateCallCount: () => number } {
  const capturedUpdates: any[] = [];
  let updateCalls = 0;
  globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.operation === "search_by_conditions" && body.table === "Memory") {
      return res(true, 200, memoryRows);
    }
    if (body?.operation === "search_by_conditions" && body.table === "MemoryGrant") {
      return res(true, 200, grantRows);
    }
    if (body?.operation === "update" && body.table === "Memory") {
      updateCalls++;
      for (const r of body.records ?? []) capturedUpdates.push(r);
      return res(true, 200, { ok: true });
    }
    throw new Error(`Unexpected fetch call: ${JSON.stringify(body)}`);
  }) as any;
  return { capturedUpdates, updateCallCount: () => updateCalls };
}

describe("runVisibilityBackfillOnce — grant-aware backfill logic", () => {
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("null-visibility memory whose owner has an active read/search MemoryGrant → backfilled to 'shared'", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-1", agentId: "agent-owner", visibility: undefined }],
      [{ ownerId: "agent-owner", scope: "read" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.error).toBeUndefined();
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.backfilledShared).toBe(1);
    expect(r.backfilledPrivate).toBe(0);
    expect(capturedUpdates).toEqual([{ id: "mem-1", visibility: "shared" }]);
  });

  it("null-visibility memory whose owner has a 'search'-scoped grant → also backfilled to 'shared' (read OR search both count)", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-1", agentId: "agent-owner" }], // no visibility key at all
      [{ ownerId: "agent-owner", scope: "search" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.backfilledShared).toBe(1);
    expect(capturedUpdates).toEqual([{ id: "mem-1", visibility: "shared" }]);
  });

  it("null-visibility memory with NO grant covering its owner → backfilled to 'private'", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-2", agentId: "agent-lonely" }],
      [], // no grants at all
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.backfilledShared).toBe(0);
    expect(r.backfilledPrivate).toBe(1);
    expect(capturedUpdates).toEqual([{ id: "mem-2", visibility: "private" }]);
  });

  it("a grant on a DIFFERENT owner does not count — only a grant on THIS memory's own agentId backfills to shared", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-3", agentId: "agent-unrelated" }],
      [{ ownerId: "agent-someone-else", scope: "read" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.backfilledPrivate).toBe(1);
    expect(capturedUpdates).toEqual([{ id: "mem-3", visibility: "private" }]);
  });

  it("a WRITE-scoped grant does not count (only read/search do) — backfilled to 'private'", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-4", agentId: "agent-owner" }],
      [{ ownerId: "agent-owner", scope: "write" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.backfilledPrivate).toBe(1);
    expect(capturedUpdates).toEqual([{ id: "mem-4", visibility: "private" }]);
  });

  it("a memory that ALREADY has a visibility value (explicit 'shared', 'private', or a prior backfill) is left untouched — idempotent", async () => {
    const { capturedUpdates, updateCallCount } = installMock(
      [
        { id: "already-shared", agentId: "agent-owner", visibility: "shared" },
        { id: "already-private", agentId: "agent-owner", visibility: "private" },
      ],
      [{ ownerId: "agent-owner", scope: "read" }], // present but irrelevant — these rows are already decided
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.scanned).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.backfilledShared).toBe(0);
    expect(r.backfilledPrivate).toBe(0);
    expect(capturedUpdates).toEqual([]);
    expect(updateCallCount()).toBe(0);
  });

  it("re-running the migration against its own prior output is a pure no-op (idempotent end-to-end)", async () => {
    // Simulates a second run AFTER a first backfill already stamped visibility.
    const { capturedUpdates, updateCallCount } = installMock(
      [
        { id: "mem-1", agentId: "agent-owner", visibility: "shared" }, // was backfilled shared last run
        { id: "mem-2", agentId: "agent-lonely", visibility: "private" }, // was backfilled private last run
      ],
      [{ ownerId: "agent-owner", scope: "read" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.skipped).toBe(2);
    expect(capturedUpdates).toEqual([]);
    expect(updateCallCount()).toBe(0);
  });

  it("dry-run reports the same counts but writes NOTHING", async () => {
    const { capturedUpdates, updateCallCount } = installMock(
      [
        { id: "mem-1", agentId: "agent-owner" }, // → would be shared
        { id: "mem-2", agentId: "agent-lonely" }, // → would be private
      ],
      [{ ownerId: "agent-owner", scope: "read" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925", dryRun: true });

    expect(r.error).toBeUndefined();
    expect(r.dryRun).toBe(true);
    expect(r.backfilledShared).toBe(1);
    expect(r.backfilledPrivate).toBe(1);
    // The whole point of --dry-run: the counts are computed, but not one
    // `update` call is ever issued.
    expect(capturedUpdates).toEqual([]);
    expect(updateCallCount()).toBe(0);
  });

  it("an explicit null visibility is treated the same as a missing key (both are backfill candidates)", async () => {
    const { capturedUpdates } = installMock(
      [{ id: "mem-null", agentId: "agent-owner", visibility: null }],
      [{ ownerId: "agent-owner", scope: "read" }],
    );
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });

    expect(r.backfilledShared).toBe(1);
    expect(capturedUpdates).toEqual([{ id: "mem-null", visibility: "shared" }]);
  });

  it("the MemoryGrant table not existing yet (search fails) degrades to treating every no-visibility row as 'private' — fail-closed, never fail-open", async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.operation === "search_by_conditions" && body.table === "Memory") {
        return res(true, 200, [{ id: "mem-1", agentId: "agent-owner" }]);
      }
      if (body?.operation === "search_by_conditions" && body.table === "MemoryGrant") {
        return res(false, 404, { error: "table does not exist" });
      }
      throw new Error(`Unexpected fetch call in fail-closed test: ${JSON.stringify(body)}`);
    }) as any;
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925", dryRun: true });

    expect(r.error).toBeUndefined();
    expect(r.backfilledShared).toBe(0);
    expect(r.backfilledPrivate).toBe(1);
  });

  it("requires an admin password — errors cleanly instead of attempting an unauthenticated ops call", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("fetch should never be called without an admin password");
    }) as any;
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const r = await runVisibilityBackfillOnce({});
    expect(r.error).toBeInstanceOf(Error);
    expect(r.error!.message).toContain("Admin password required");
  });
});

// ─── Migration-equivalence — the key safety test ───────────────────────────
//
// Proves the conservative posture end-to-end: run the backfill, THEN apply
// the REAL within-org-read-open resolveReadScope()/isAllowed() predicate
// (resources/memory-read-scope.ts) to the resulting visibility. A reader
// other than the owner must see EXACTLY what the OLD grant-gated model would
// have shown them — nothing effectively-private is newly exposed by the
// (backfill THEN open-read) sequence, and the one intended broadening
// (a previously-granted record becoming org-open) is exactly what happens.
describe("migration-equivalence — (backfill THEN open-read) preserves the conservative posture", () => {
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("proves: no-grant memory stays owner-only, granted memory becomes org-open, explicit-private stays owner-only, owner's own memories all stay visible", async () => {
    // ── Fixture: five pre-existing (pre-backfill) memories, two DISTINCT
    // owners so the grant only ever covers ONE of them ─────────────────────
    const memNoGrant = { id: "mem-no-grant", agentId: "agent-owner-nogrant" }; // no visibility field, nobody held a grant on this owner
    const memGranted = { id: "mem-granted", agentId: "agent-owner-granted" }; // no visibility field, agent-reader held a read grant on THIS owner
    const memExplicitPrivate = { id: "mem-explicit-private", agentId: "agent-owner-granted", visibility: "private" };
    const memOwnPrivate = { id: "mem-own-private", agentId: "agent-reader", visibility: "private" }; // the READER's own
    const memOwnShared = { id: "mem-own-shared", agentId: "agent-reader" }; // the READER's own, no visibility field

    const memoryRows = [memNoGrant, memGranted, memExplicitPrivate, memOwnPrivate, memOwnShared];
    const grantRows = [{ ownerId: "agent-owner-granted", granteeId: "agent-reader", scope: "read" }];

    const { capturedUpdates } = installMock(memoryRows, grantRows);
    const { runVisibilityBackfillOnce } = await import("../../src/cli");
    const backfillResult = await runVisibilityBackfillOnce({ adminPass: "test-admin-pass", opsPort: "9925" });
    expect(backfillResult.error).toBeUndefined();

    // Apply the backfill's writes onto the in-memory fixtures, exactly as
    // the real ops API "update" operation would (merge by id).
    const backfilledById = new Map(capturedUpdates.map((u: any) => [u.id, u.visibility]));
    const afterBackfill = memoryRows.map((m) => ({ ...m, visibility: backfilledById.get(m.id) ?? m.visibility }));

    expect(afterBackfill.find((m) => m.id === "mem-no-grant")!.visibility).toBe("private");
    expect(afterBackfill.find((m) => m.id === "mem-granted")!.visibility).toBe("shared");
    expect(afterBackfill.find((m) => m.id === "mem-explicit-private")!.visibility).toBe("private"); // untouched
    expect(afterBackfill.find((m) => m.id === "mem-own-private")!.visibility).toBe("private"); // untouched

    // ── NOW apply the real open-read predicate on top of the backfilled data ──
    // resources/memory-read-scope.ts imports "@harperfast/harper" statically
    // (for resolveAllowedOwners, no longer called by resolveReadScope itself)
    // — mock it minimally so the module can be imported; it's a plain-
    // function module explicitly designed to be safe to import here under
    // its OWN fresh mock (see that module's doc comment).
    mock.module("@harperfast/harper", () => ({
      databases: { flair: { MemoryGrant: { search: () => (async function* () {})() } } },
      Resource: class {},
    }));
    const { resolveReadScope } = await import("../../resources/memory-read-scope.ts");
    const scope = await resolveReadScope("agent-reader");

    const byId = (id: string) => afterBackfill.find((m) => m.id === id)!;

    // 1. Previously no-grant memory: still owner-only (unchanged) — a
    //    non-owner reader must NOT see it, exactly as before the open-read
    //    change (when it was effectively-private, ungranted).
    expect(scope.isAllowed(byId("mem-no-grant"))).toBe(false);

    // 2. Previously granted memory: becomes org-open — the intended,
    //    documented broadening (agent-reader could already read it via the
    //    grant under the OLD model; now every agent can, but agent-reader
    //    specifically is unaffected either way).
    expect(scope.isAllowed(byId("mem-granted"))).toBe(true);

    // 3. Explicitly-private memory: stays owner-only.
    expect(scope.isAllowed(byId("mem-explicit-private"))).toBe(false);

    // 4. The reader's OWN memories (including its own private one) all stay
    //    visible to the reader itself.
    expect(scope.isAllowed(byId("mem-own-private"))).toBe(true);
    expect(scope.isAllowed(byId("mem-own-shared"))).toBe(true);

    // ── The critical cross-check: a completely UNRELATED third agent (never
    // held a grant on ANYTHING) sees under the new open-read model EXACTLY
    // what a grant-holder saw under the OLD model for the no-grant case, and
    // is newly exposed ONLY to the previously-granted record (never to the
    // no-grant or explicit-private ones) — proving nothing effectively-
    // private leaks past the backfill.
    const strangerScope = await resolveReadScope("agent-total-stranger");
    expect(strangerScope.isAllowed(byId("mem-no-grant"))).toBe(false); // was owner-only, stays owner-only
    expect(strangerScope.isAllowed(byId("mem-granted"))).toBe(true); // the one intended broadening
    expect(strangerScope.isAllowed(byId("mem-explicit-private"))).toBe(false);
    expect(strangerScope.isAllowed(byId("mem-own-private"))).toBe(false); // not the stranger's own
  });
});
