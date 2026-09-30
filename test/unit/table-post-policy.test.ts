// resources/table-post-policy.ts: a table whose resource defines no post() of
// its own admits a collection POST only from an administrator or a trusted
// internal call. The live route is covered by
// test/integration/collection-post-attribution.test.ts.
import { describe, expect, test } from "bun:test";
import {
  guardInheritedPosts,
  inheritedPostRefusal,
  resourceDefinesPost,
  TABLE_POST_GUARD,
  unverifiedPostCallerRefusal,
  type PostCaller,
} from "../../resources/table-post-policy";

/** A stand-in for Harper's Resource base: post() records the call. */
function makeTables() {
  const calls: unknown[][] = [];
  class Base {
    context: unknown;
    constructor(context?: unknown) { this.context = context; }
    getContext() { return this.context; }
    async post(...args: unknown[]) { calls.push(args); return { created: args[0] }; }
  }
  class Plain extends Base {}
  class Other extends Base {}
  const tables: { Plain: typeof Plain; Other: typeof Other; [name: string]: any } = { Plain, Other, notATable: { post() {} }, nothing: null };
  return { calls, Base, tables };
}

const ADMIN: PostCaller = { kind: "agent", agentId: "root", isAdmin: true };
const AGENT: PostCaller = { kind: "agent", agentId: "a", isAdmin: false };
const ANON: PostCaller = { kind: "anonymous" };
const INTERNAL: PostCaller = { kind: "internal" };

describe("resourceDefinesPost", () => {
  test("an instance of the table class itself defines none", () => {
    const { tables } = makeTables();
    expect(resourceDefinesPost(new tables.Plain(), tables.Plain.prototype)).toBe(false);
  });

  test("a resource class below the table with its own post() defines one", () => {
    const { tables } = makeTables();
    class Resource extends tables.Plain { async post(...a: unknown[]) { return super.post(...a); } }
    class Deeper extends Resource {}
    expect(resourceDefinesPost(new Resource(), tables.Plain.prototype)).toBe(true);
    expect(resourceDefinesPost(new Deeper(), tables.Plain.prototype)).toBe(true);
  });

  test("a resource class below the table without a post() defines none", () => {
    const { tables } = makeTables();
    class Resource extends tables.Plain { async put() { return null; } }
    expect(resourceDefinesPost(new Resource(), tables.Plain.prototype)).toBe(false);
  });

  test("a missing instance defines none", () => {
    const { tables } = makeTables();
    expect(resourceDefinesPost(null, tables.Plain.prototype)).toBe(false);
    expect(resourceDefinesPost(undefined, tables.Plain.prototype)).toBe(false);
  });
});

describe("inheritedPostRefusal", () => {
  test("an administrator and a trusted internal call are admitted", () => {
    expect(inheritedPostRefusal("T", ADMIN)).toBeNull();
    expect(inheritedPostRefusal("T", INTERNAL)).toBeNull();
  });

  test("a verified non-admin agent gets 403, naming the table and the PUT route", () => {
    const refusal = inheritedPostRefusal("Thing", AGENT);
    expect(refusal?.statusCode).toBe(403);
    expect(refusal?.message).toContain("Thing");
    expect(refusal?.message).toContain("PUT /Thing/<id>");
  });

  test("a caller without a valid credential gets 401", () => {
    expect(inheritedPostRefusal("Thing", ANON)?.statusCode).toBe(401);
  });

  test("an agent verdict without isAdmin === true is not an administrator", () => {
    expect(inheritedPostRefusal("T", { kind: "agent", agentId: "a", isAdmin: "true" as any })?.statusCode).toBe(403);
  });

  test("a caller that cannot be resolved gets 500", () => {
    const refusal = unverifiedPostCallerRefusal("Thing");
    expect(refusal.statusCode).toBe(500);
    expect(refusal.message).toContain("Thing");
  });
});

describe("guardInheritedPosts", () => {
  function install(caller: PostCaller | Error) {
    const t = makeTables();
    const seen: unknown[] = [];
    const guarded = guardInheritedPosts(t.tables, {
      resolveAuth: async (context) => {
        seen.push(context);
        if (caller instanceof Error) throw caller;
        return caller;
      },
    });
    return { ...t, guarded, seen };
  }

  test("guards every table class in the registry, and only table classes", () => {
    const { guarded, tables } = install(ADMIN);
    expect(guarded.sort()).toEqual(["Other", "Plain"]);
    expect(Object.prototype.hasOwnProperty.call(tables.Plain.prototype, "post")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(tables.Plain, TABLE_POST_GUARD)).toBe(true);
  });

  test("a non-admin agent is refused with 403 and the inherited post() does not run", async () => {
    const { tables, calls, seen } = install(AGENT);
    const ctx = { request: "r" };
    await expect(new tables.Plain(ctx).post({ id: "x" })).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual([]);
    expect(seen).toEqual([ctx]);
  });

  test("a caller without a valid credential is refused with 401", async () => {
    const { tables, calls } = install(ANON);
    await expect(new tables.Plain({}).post({ id: "x" })).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
  });

  test("a caller whose verdict cannot be read is refused with 500", async () => {
    const { tables, calls } = install(new Error("lookup failed"));
    await expect(new tables.Plain({}).post({ id: "x" })).rejects.toMatchObject({ statusCode: 500 });
    expect(calls).toEqual([]);
  });

  test("an administrator and a trusted internal call reach the inherited post() with the same arguments", async () => {
    for (const caller of [ADMIN, INTERNAL]) {
      const { tables, calls } = install(caller);
      const result = await new tables.Plain({}).post({ id: "x" }, { q: 1 });
      expect(result).toEqual({ created: { id: "x" } });
      expect(calls).toEqual([[{ id: "x" }, { q: 1 }]]);
    }
  });

  test("a resource class with its own post() keeps it; its super.post() is not refused", async () => {
    const { tables, calls, seen } = install(AGENT);
    class Resource extends tables.Plain {
      async post(content: any, query?: any) { content.stamped = true; return super.post(content, query); }
    }
    const result = await new Resource({}).post({ id: "x" });
    expect(result).toEqual({ created: { id: "x", stamped: true } });
    expect(calls.length).toBe(1);
    expect(seen).toEqual([]);
  });

  test("a resource class without its own post() is refused like the table itself", async () => {
    const { tables, calls } = install(AGENT);
    class Resource extends tables.Plain { async put() { return null; } }
    await expect(new Resource({}).post({ id: "x" })).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual([]);
  });

  test("each table is guarded under its own name", async () => {
    const { tables } = install(AGENT);
    await expect(new tables.Other({}).post({})).rejects.toThrow(/Other/);
    await expect(new tables.Plain({}).post({})).rejects.toThrow(/Plain/);
  });

  test("installing twice guards once", async () => {
    const t = makeTables();
    let resolved = 0;
    const deps = { resolveAuth: async () => { resolved++; return ADMIN; } };
    guardInheritedPosts(t.tables, deps);
    const guardedPost = t.tables.Plain.prototype.post;
    expect(guardInheritedPosts(t.tables, deps).sort()).toEqual(["Other", "Plain"]);
    expect(t.tables.Plain.prototype.post).toBe(guardedPost);
    await new t.tables.Plain({}).post({ id: "x" });
    expect(resolved).toBe(1);
    expect(t.calls.length).toBe(1);
  });

  test("a missing registry guards nothing", () => {
    expect(guardInheritedPosts(undefined, { resolveAuth: async () => ADMIN })).toEqual([]);
    expect(guardInheritedPosts(null, { resolveAuth: async () => ADMIN })).toEqual([]);
  });
});
