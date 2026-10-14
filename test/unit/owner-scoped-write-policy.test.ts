/**
 * owner-scoped-write-policy.test.ts — the owner-scoped write guard
 * (resources/owner-scoped-write-policy.ts): a non-admin agent's addressed
 * writes and collection PUT/PATCH/DELETE; collection POST is left to each
 * resource.
 *
 * The integration test (test/integration/owner-scoped-writes.test.ts) checks the
 * rule on every owner-scoped table of a real Harper. These cases pin what a real
 * Harper does not exercise on demand: a caller that cannot be resolved, a stored
 * record that cannot be read, a stored record with no owner value, calls from
 * server code (which must reach the table unchanged and synchronously),
 * inheritance by a resource class, and idempotent installation.
 */
import { describe, it, expect } from "bun:test";
import {
  addressesNoSingleRecord,
  bodyNamesDifferentRecord,
  guardOwnerScopedWrites,
  isRequestEntryTarget,
  OWNER_SCOPED_WRITE_GUARD,
  ownerScopedWriteGuardGaps,
  type OwnerScopedWriteDeps,
  type WriteCaller,
} from "../../resources/owner-scoped-write-policy";

/** A stand-in for a Harper table class: static getResource records each call and returns a marker. */
function makeTable() {
  const calls: Array<{ target: unknown; context: unknown; options: unknown }> = [];
  class Table {
    static getResource(target: unknown, context: unknown, options: unknown) {
      calls.push({ target, context, options });
      return { resource: true, target };
    }
  }
  return { Table, calls };
}

const AGENT = { verdict: { kind: "agent", agentId: "caller", isAdmin: false } as WriteCaller };
const ADMIN = { verdict: { kind: "agent", agentId: "root", isAdmin: true } as WriteCaller };
const ANON = { verdict: { kind: "anonymous" } as WriteCaller };
const INTERNAL = { verdict: { kind: "internal" } as WriteCaller };

function deps(stored: Record<string, Record<string, unknown> | null> = {}, extra: Partial<OwnerScopedWriteDeps> = {}): OwnerScopedWriteDeps & { reads: unknown[] } {
  const reads: unknown[] = [];
  return {
    reads,
    resolveAuth: async (ctx: any) => ctx?.verdict ?? { kind: "internal" },
    readStored: async (_table: string, id: unknown) => { reads.push(id); return stored[String(id)] ?? null; },
    unreadable: () => new Response(JSON.stringify({ error: "owner_check_unavailable" }), { status: 503 }),
    readBody: (ctx: any) => ctx?.data,
    ...extra,
  };
}

/** An HTTP entry target: Harper sets checkPermission to the caller's permission set. */
const entry = (id: unknown, isCollection = false) => ({ id, isCollection, checkPermission: {} });
/** An entry context carrying a verdict and (optionally) a parsed request body. */
const ctxWith = (verdict: { verdict: WriteCaller }, data?: unknown) => ({ ...verdict, data });

async function outcome(p: unknown): Promise<{ ok: unknown } | { refused: any }> {
  try { return { ok: await p }; } catch (err) { return { refused: err }; }
}

async function refusalBody(p: unknown): Promise<{ status: number; body: any }> {
  const o = await outcome(p);
  if (!("refused" in o)) throw new Error("expected a refusal");
  const r = o.refused;
  if (r instanceof Response) return { status: r.status, body: await r.json() };
  return { status: r.statusCode, body: { error: r.message } };
}

describe("guardOwnerScopedWrites", () => {
  for (const method of ["put", "patch", "delete"]) {
    it(`refuses a non-admin ${method} addressed to the collection with the named 403, before the table loads anything`, async () => {
      const { Table, calls } = makeTable();
      const d = deps();
      guardOwnerScopedWrites({ Relationship: Table }, { Relationship: "agentId" }, d);
      const r = await refusalBody((Table as any).getResource(entry(null, true), AGENT, { method }));
      expect(r).toEqual({ status: 403, body: { error: "forbidden: a non-admin write to Relationship must address one record by its id" } });
      expect(calls).toEqual([]);
      expect(d.reads).toEqual([]);
    });
  }

  it("treats a target with no id as addressing the collection", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps());
    const r = await refusalBody((Table as any).getResource(entry(null, false), AGENT, { method: "put" }));
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("treats a collection target that carries an id prefix as addressing the collection", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps());
    const r = await refusalBody((Table as any).getResource(entry("mine/", true), AGENT, { method: "put" }));
    expect(r.body.error).toBe("forbidden: a non-admin write to Memory must address one record by its id");
    expect(calls).toEqual([]);
  });

  it("lets a non-admin collection POST through to the resource (a create)", async () => {
    const { Table, calls } = makeTable();
    const d = deps();
    guardOwnerScopedWrites({ Presence: Table }, { Presence: "agentId" }, d);
    const target = entry(null, true);
    const o = await outcome((Table as any).getResource(target, AGENT, { method: "post" }));
    expect(o).toEqual({ ok: { resource: true, target } });
    expect(calls.length).toBe(1);
    expect(d.reads).toEqual([]);
  });

  for (const method of ["put", "patch", "delete", "post"]) {
    it(`refuses a non-admin ${method} of a record owned by another principal with the named 403`, async () => {
      const { Table, calls } = makeTable();
      const d = deps({ r1: { id: "r1", agentId: "owner", object: "secret-value" } });
      guardOwnerScopedWrites({ Relationship: Table }, { Relationship: "agentId" }, d);
      const r = await refusalBody((Table as any).getResource(entry("r1"), AGENT, { method }));
      expect(r).toEqual({ status: 403, body: { error: "forbidden: cannot modify Relationship owned by another principal" } });
      expect(JSON.stringify(r.body)).not.toContain("secret-value");
      expect(calls).toEqual([]);
      expect(d.reads).toEqual(["r1"]);
    });
  }

  it("decides on the record the target resolves to, using the table's owner field", async () => {
    const { Table, calls } = makeTable();
    const d = deps({ g1: { id: "g1", ownerId: "owner", granteeId: "caller" } });
    guardOwnerScopedWrites({ MemoryGrant: Table }, { MemoryGrant: "ownerId" }, d);
    const r = await refusalBody((Table as any).getResource(entry("g1"), AGENT, { method: "patch" }));
    expect(r.body.error).toBe("forbidden: cannot modify MemoryGrant owned by another principal");
    expect(calls).toEqual([]);
  });

  it("refuses a non-admin write to a stored record that carries no owner value", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps({ m1: { id: "m1", content: "x" } }));
    expect((await refusalBody((Table as any).getResource(entry("m1"), AGENT, { method: "patch" }))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("lets a non-admin write its own record, and create one that does not exist yet", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps({ mine: { id: "mine", agentId: "caller" } }));
    expect("ok" in await outcome((Table as any).getResource(entry("mine"), AGENT, { method: "put" }))).toBe(true);
    expect("ok" in await outcome((Table as any).getResource(entry("new-id"), AGENT, { method: "put" }))).toBe(true);
    expect(calls.length).toBe(2);
  });

  for (const [label, ctx] of [["an admin agent", ADMIN], ["a trusted internal call", INTERNAL], ["an anonymous caller (refused by the resource's own gate)", ANON]] as const) {
    it(`leaves ${label} to the resource unchanged, on the collection and on another principal's record`, async () => {
      const { Table, calls } = makeTable();
      const d = deps({ r1: { id: "r1", agentId: "owner" } });
      guardOwnerScopedWrites({ Relationship: Table }, { Relationship: "agentId" }, d);
      expect("ok" in await outcome((Table as any).getResource(entry(null, true), ctx, { method: "put" }))).toBe(true);
      expect("ok" in await outcome((Table as any).getResource(entry("r1"), ctx, { method: "delete" }))).toBe(true);
      expect(calls.length).toBe(2);
      expect(d.reads).toEqual([]);
    });
  }

  it("passes server-code calls (no entry target) and reads straight through, synchronously", () => {
    const { Table, calls } = makeTable();
    const d = deps({ r1: { id: "r1", agentId: "owner" } });
    guardOwnerScopedWrites({ Relationship: Table }, { Relationship: "agentId" }, d);
    const plain = { id: "r1" };
    const authorized = { id: "r1", checkPermission: false };
    const outcomes = [
      (Table as any).getResource(plain, AGENT, { method: "put" }),
      (Table as any).getResource(authorized, AGENT, { method: "patch" }),
      (Table as any).getResource("r1", AGENT, { method: "delete" }),
      (Table as any).getResource(entry("r1"), AGENT, { method: "get" }),
      (Table as any).getResource(entry(null, true), AGENT, { method: "search" }),
      (Table as any).getResource(entry("r1"), AGENT, undefined),
    ];
    for (const o of outcomes) {
      expect(typeof (o as any)?.then).toBe("undefined");
      expect((o as any)?.resource).toBe(true);
    }
    expect(calls.length).toBe(outcomes.length);
    expect(d.reads).toEqual([]);
  });

  it("refuses with the unreadable refusal when the stored record cannot be read", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps({}, { readStored: async () => { throw new Error("disk"); } }));
    const r = await refusalBody((Table as any).getResource(entry("m1"), AGENT, { method: "patch" }));
    expect(r).toEqual({ status: 503, body: { error: "owner_check_unavailable" } });
    expect(calls).toEqual([]);
  });

  it("refuses with a named error when the caller cannot be resolved", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps({}, { resolveAuth: async () => { throw new Error("lookup"); } }));
    const r = await refusalBody((Table as any).getResource(entry("m1"), AGENT, { method: "put" }));
    expect(r).toEqual({ status: 500, body: { error: "the caller of this Memory write could not be verified, so it was refused; retry" } });
    expect(calls).toEqual([]);
  });

  it("is inherited by a resource class that extends the table", async () => {
    const { Table, calls } = makeTable();
    guardOwnerScopedWrites({ Relationship: Table }, { Relationship: "agentId" }, deps({ r1: { id: "r1", agentId: "owner" } }));
    class RelationshipResource extends (Table as any) {}
    const r = await refusalBody((RelationshipResource as any).getResource(entry("r1"), AGENT, { method: "patch" }));
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("passes `this` through to the inherited getResource", async () => {
    let seenThis: unknown = null;
    class Table { static getResource(this: unknown) { seenThis = this; return {}; } }
    guardOwnerScopedWrites({ Memory: Table }, { Memory: "agentId" }, deps({ mine: { id: "mine", agentId: "caller" } }));
    class MemoryResource extends Table {}
    await (MemoryResource as any).getResource(entry("mine"), AGENT, { method: "patch" });
    expect(seenThis).toBe(MemoryResource);
  });

  it("guards only tables named in the owner-field map, and is idempotent", () => {
    const owned = makeTable().Table;
    const unowned = makeTable().Table;
    const original = (unowned as any).getResource;
    const d = deps();
    expect(guardOwnerScopedWrites({ Memory: owned, Peer: unowned }, { Memory: "agentId" }, d)).toEqual(["Memory"]);
    const installed = (owned as any).getResource;
    expect(guardOwnerScopedWrites({ Memory: owned, Peer: unowned }, { Memory: "agentId" }, d)).toEqual(["Memory"]);
    expect((owned as any).getResource).toBe(installed);
    expect(Object.prototype.hasOwnProperty.call(owned, OWNER_SCOPED_WRITE_GUARD)).toBe(true);
    expect((unowned as any).getResource).toBe(original);
  });
});

describe("ownerScopedWriteGuardGaps", () => {
  it("is empty when every owner-scoped table in the registry is guarded", () => {
    const { Table } = makeTable();
    const tables = { Memory: Table };
    expect(ownerScopedWriteGuardGaps(tables, { Memory: "agentId" }, guardOwnerScopedWrites(tables, { Memory: "agentId" }, deps()))).toEqual([]);
  });

  it("names an owner-scoped table that has no table class in the registry", () => {
    expect(ownerScopedWriteGuardGaps({ Memory: makeTable().Table }, { Memory: "agentId", Soul: "agentId" }, ["Memory"]))
      .toEqual(["Soul is not a table class with a getResource() to guard"]);
  });

  it("reports a missing or empty registry", () => {
    expect(ownerScopedWriteGuardGaps(undefined, { Memory: "agentId" }, [])).toEqual(["the flair table registry is missing or empty"]);
    expect(ownerScopedWriteGuardGaps({}, { Memory: "agentId" }, [])).toEqual(["the flair table registry is missing or empty"]);
  });
});

describe("target predicates", () => {
  it("recognizes an HTTP entry target by its permission set", () => {
    expect(isRequestEntryTarget({ checkPermission: {} })).toBe(true);
    expect(isRequestEntryTarget({ checkPermission: { super_user: false } })).toBe(true);
    expect(isRequestEntryTarget({ checkPermission: false })).toBe(false);
    expect(isRequestEntryTarget({})).toBe(false);
    expect(isRequestEntryTarget("r1")).toBe(false);
    expect(isRequestEntryTarget(null)).toBe(false);
  });

  it("recognizes a target that addresses no single record", () => {
    expect(addressesNoSingleRecord({ id: null })).toBe(true);
    expect(addressesNoSingleRecord({ id: undefined })).toBe(true);
    expect(addressesNoSingleRecord({ id: "x/", isCollection: true })).toBe(true);
    expect(addressesNoSingleRecord({ id: "r1", isCollection: false })).toBe(false);
    expect(addressesNoSingleRecord({ id: "r1" })).toBe(false);
  });

  it("sees a scalar body id that names a different record than the addressed one", () => {
    expect(bodyNamesDifferentRecord("fresh", { id: "victim", v: 1 })).toBe(true);
    expect(bodyNamesDifferentRecord("r1", { id: "r1" })).toBe(false);
    expect(bodyNamesDifferentRecord(7, { id: "7" })).toBe(false);       // equal by coercion
    expect(bodyNamesDifferentRecord("r1", { v: 1 })).toBe(false);       // no body id
    expect(bodyNamesDifferentRecord("r1", { id: ["r1"] })).toBe(false); // non-scalar: left to the resource
    expect(bodyNamesDifferentRecord("r1", { id: { label: "x" } })).toBe(false);
    expect(bodyNamesDifferentRecord("r1", ["r1"])).toBe(false);         // array body
    expect(bodyNamesDifferentRecord(null, { id: "victim" })).toBe(false); // no addressed id
  });
});

describe("a write may name only the record it addresses (through the guard)", () => {
  for (const method of ["put", "patch", "post"]) {
    it(`refuses a non-admin ${method} whose body names a different record, with the named 403, before any stored read or write`, async () => {
      const { Table, calls } = makeTable();
      const d = deps();
      guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
      const r = await refusalBody((Table as any).getResource(entry("fresh-id"), ctxWith(AGENT, { id: "victim-id", summary: "x" }), { method }));
      expect(r).toEqual({ status: 403, body: { error: "write_id_not_addressed", message: "a write may name only the record it addresses" } });
      expect(JSON.stringify(r.body)).not.toContain("victim-id");
      expect(JSON.stringify(r.body)).not.toContain("fresh-id");
      expect(calls, "the table was never reached").toEqual([]);
      expect(d.reads, "no stored read happened before the body-id refusal").toEqual([]);
    });
  }

  it("does not apply the body-id rule to DELETE", async () => {
    const { Table, calls } = makeTable();
    const d = deps({ "fresh-id": { id: "fresh-id", authorId: "caller" } });
    guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
    const o = await outcome((Table as any).getResource(entry("fresh-id"), ctxWith(AGENT, { id: "victim-id" }), { method: "delete" }));
    expect("ok" in o).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("admits a write whose body id matches, or omits, the addressed id", async () => {
    const { Table, calls } = makeTable();
    const d = deps({ r1: { id: "r1", authorId: "caller" } });
    guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
    expect("ok" in await outcome((Table as any).getResource(entry("r1"), ctxWith(AGENT, { id: "r1", summary: "x" }), { method: "put" }))).toBe(true);
    expect("ok" in await outcome((Table as any).getResource(entry("r1"), ctxWith(AGENT, { summary: "x" }), { method: "patch" }))).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("does not apply the body-id rule to a POST to a collection (it has no addressed id)", async () => {
    const { Table, calls } = makeTable();
    const d = deps();
    guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
    const target = entry(null, true);
    const o = await outcome((Table as any).getResource(target, ctxWith(AGENT, { id: "anything" }), { method: "post" }));
    expect(o).toEqual({ ok: { resource: true, target } });
    expect(calls.length).toBe(1);
  });

  it("leaves an admin and an internal caller's differing body id unchanged", async () => {
    const { Table, calls } = makeTable();
    const d = deps({ "fresh-id": { id: "fresh-id", authorId: "owner" } });
    guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
    expect("ok" in await outcome((Table as any).getResource(entry("fresh-id"), ctxWith(ADMIN, { id: "victim-id" }), { method: "put" }))).toBe(true);
    expect("ok" in await outcome((Table as any).getResource(entry("fresh-id"), ctxWith(INTERNAL, { id: "victim-id" }), { method: "put" }))).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("admits the write when the body cannot be read (left to Harper's own request handling)", async () => {
    const { Table, calls } = makeTable();
    const d = deps({ r1: { id: "r1", authorId: "caller" } }, { readBody: async () => { throw new Error("unparsable"); } });
    guardOwnerScopedWrites({ OrgEvent: Table }, { OrgEvent: "authorId" }, d);
    expect("ok" in await outcome((Table as any).getResource(entry("r1"), ctxWith(AGENT, undefined), { method: "put" }))).toBe(true);
    expect(calls.length).toBe(1);
  });
});
