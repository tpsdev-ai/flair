/**
 * table-patch-policy.test.ts — the guard that keeps PATCH from creating rows
 * for callers who are not administrators (resources/table-patch-policy.ts).
 *
 * The integration test (test/integration/patch-updates-existing-rows.test.ts)
 * checks the rule on every table of a real Harper. These cases pin what a real
 * Harper does not exercise on demand: an instance that cannot say whether its
 * row exists, a caller that cannot be resolved, inheritance through a resource
 * override that ends in super.patch(), and idempotent installation.
 */
import { describe, it, expect } from "bun:test";
import {
  guardTablePatches,
  patchCreateRefusal,
  rowExists,
  TABLE_PATCH_GUARD,
  type PatchCaller,
} from "../../resources/table-patch-policy";

/** A stand-in for a Harper table class: instances know whether their row exists, patch() records calls. */
function makeTable() {
  const calls: Array<{ self: unknown; args: unknown[] }> = [];
  class Table {
    exists: boolean | undefined;
    ctx: unknown;
    constructor(exists: boolean | undefined, ctx: unknown) { this.exists = exists; this.ctx = ctx; }
    doesExist() { return this.exists as boolean; }
    getContext() { return this.ctx; }
    patch(...args: unknown[]) { calls.push({ self: this, args }); return Promise.resolve(undefined); }
  }
  return { Table, calls };
}

const byContext = async (ctx: any): Promise<PatchCaller> => ctx?.verdict ?? { kind: "internal" };
const AGENT = { verdict: { kind: "agent", agentId: "b", isAdmin: false } };
const ADMIN = { verdict: { kind: "agent", agentId: "root", isAdmin: true } };
const ANON = { verdict: { kind: "anonymous" } };

async function refusalOf(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (err) { return err; }
  return null;
}

describe("guardTablePatches", () => {
  it("refuses a non-admin agent's PATCH to a missing row with 404, and never reaches the table's patch()", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Memory: Table }, { resolveAuth: byContext });
    const err = await refusalOf(new Table(false, AGENT).patch({ content: "x" }, { id: "m1" }));
    expect(err?.statusCode).toBe(404);
    expect(err?.message).toBe("not found: PATCH updates an existing Memory row and does not create one; where Memory permits creation, use POST or PUT");
    expect(calls).toEqual([]);
  });

  it("refuses an anonymous caller's PATCH to a missing row", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Message: Table }, { resolveAuth: byContext });
    expect((await refusalOf(new Table(false, ANON).patch({}, {})))?.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("lets a PATCH to an existing row through for any caller, without resolving the caller", async () => {
    const { Table, calls } = makeTable();
    let resolved = 0;
    guardTablePatches({ Memory: Table }, { resolveAuth: async (ctx) => { resolved++; return byContext(ctx); } });
    const instance = new Table(true, AGENT);
    const body = { content: "v2" };
    const target = { id: "m1" };
    await instance.patch(body, target);
    expect(calls.length).toBe(1);
    expect(calls[0].self).toBe(instance);
    expect(calls[0].args[0]).toBe(body);
    expect(calls[0].args[1]).toBe(target);
    expect(resolved).toBe(0);
  });

  it("lets an administrator and a trusted internal call create through PATCH", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Memory: Table }, { resolveAuth: byContext });
    await new Table(false, ADMIN).patch({ content: "admin" }, {});
    await new Table(false, undefined).patch({ content: "internal" }, {});
    expect(calls.length).toBe(2);
  });

  it("treats an instance that cannot say whether its row exists as a create", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Memory: Table }, { resolveAuth: byContext });
    expect((await refusalOf(new Table(undefined, AGENT).patch({}, {})))?.statusCode).toBe(404);
    expect(rowExists({})).toBeUndefined();
    expect(rowExists({ doesExist: () => "yes" })).toBeUndefined();
    expect(rowExists({ doesExist: () => true })).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a create whose caller cannot be resolved", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Memory: Table }, { resolveAuth: async () => { throw new Error("agent table unavailable"); } });
    const err = await refusalOf(new Table(false, AGENT).patch({}, {}));
    expect(err?.statusCode).toBe(500);
    expect(err?.message).toContain("could not be verified");
    expect(calls).toEqual([]);
  });

  it("a resource override that ends in super.patch() is still guarded", async () => {
    const { Table, calls } = makeTable();
    guardTablePatches({ Memory: Table }, { resolveAuth: byContext });
    class MemoryResource extends Table {
      override async patch(content: any, query?: any) { content.stamped = true; return super.patch(content, query); }
    }
    expect((await refusalOf(new MemoryResource(false, AGENT).patch({}, {})))?.statusCode).toBe(404);
    await new MemoryResource(true, AGENT).patch({}, {});
    expect(calls.length).toBe(1);
  });

  it("guards every table it is given, skips values that are not classes, and is idempotent", async () => {
    const a = makeTable();
    const b = makeTable();
    let resolved = 0;
    const deps = { resolveAuth: async (ctx: any) => { resolved++; return byContext(ctx); } };
    const tables = { Memory: a.Table, Soul: b.Table, notATable: { prototype: { patch() {} } }, alsoNot: 7 } as any;
    expect(guardTablePatches(tables, deps)).toEqual(["Memory", "Soul"]);
    expect(guardTablePatches(tables, deps)).toEqual(["Memory", "Soul"]);
    expect(Object.prototype.hasOwnProperty.call(a.Table, TABLE_PATCH_GUARD)).toBe(true);
    await new a.Table(false, ADMIN).patch({}, {});
    expect(resolved).toBe(1); // installed once, not wrapped twice
    expect(guardTablePatches(undefined, deps)).toEqual([]);
  });
});

describe("patchCreateRefusal", () => {
  it("admits only administrators and internal calls", () => {
    expect(patchCreateRefusal("Memory", { kind: "internal" })).toBeNull();
    expect(patchCreateRefusal("Memory", { kind: "agent", agentId: "root", isAdmin: true })).toBeNull();
    expect(patchCreateRefusal("Memory", { kind: "agent", agentId: "b", isAdmin: false })?.statusCode).toBe(404);
    expect(patchCreateRefusal("Memory", { kind: "anonymous" })?.statusCode).toBe(404);
  });
});
