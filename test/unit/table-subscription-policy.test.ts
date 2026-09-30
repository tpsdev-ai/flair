/**
 * table-subscription-policy.test.ts — the guard that limits table subscription
 * routes to administrators and trusted internal calls
 * (resources/table-subscription-policy.ts).
 *
 * The integration test (test/integration/table-subscription-default-deny.test.ts)
 * proves the rule on every table of a real Harper. These cases pin the parts a
 * real Harper does not exercise on demand: the static `connect()` it replaces,
 * inheritance by resource subclasses, how the caller's context is resolved, a
 * caller that cannot be resolved, and the length limit on the refusal text.
 */
import { describe, it, expect } from "bun:test";
import {
  guardTableSubscriptions,
  subscriptionCallerContext,
  tableSubscriptionRefusal,
  unverifiedSubscriberRefusal,
  MAX_REFUSAL_REASON_BYTES,
  TABLE_SUBSCRIPTION_GUARD,
  type SubscriptionCaller,
} from "../../resources/table-subscription-policy";

/** A stand-in for a Harper table class: the static connect() records its calls. */
function makeTable() {
  const calls: Array<{ self: unknown; args: unknown[] }> = [];
  class Table {
    static connect(this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return Promise.resolve({ subscription: true });
    }
  }
  return { Table, calls };
}

/** resolveAuth reads the verdict off the context the guard hands it. */
const byContext = async (ctx: any): Promise<SubscriptionCaller> => ctx?.verdict ?? { kind: "internal" };
const AGENT = { verdict: { kind: "agent", agentId: "b", isAdmin: false } };
const ADMIN = { verdict: { kind: "agent", agentId: "root", isAdmin: true } };
const ANON = { verdict: { kind: "anonymous" } };

describe("guardTableSubscriptions", () => {
  it("refuses a verified non-admin agent with 403 and never reaches the table's connect()", async () => {
    const { Table, calls } = makeTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    let thrown: any;
    try { await (Table as any).connect({ id: null }, null, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.message).toContain("table subscriptions are for administrators");
    expect(calls).toEqual([]);
  });

  it("refuses a caller without a valid credential with 401", async () => {
    const { Table, calls } = makeTable();
    guardTableSubscriptions({ Message: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    let thrown: any;
    try { await (Table as any).connect({ id: null }, null, ANON); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("passes an administrator and a trusted internal call through unchanged, with the same arguments and receiver", async () => {
    const { Table, calls } = makeTable();
    guardTableSubscriptions({ MemoryUsage: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    const target = { id: null };
    const queue = { messages: true };
    expect(await (Table as any).connect(target, queue, ADMIN)).toEqual({ subscription: true });
    expect(await (Table as any).connect(target)).toEqual({ subscription: true }); // no context: internal
    expect(calls.length).toBe(2);
    expect(calls[0].self).toBe(Table);
    expect(calls[0].args[0]).toBe(target);
    expect(calls[0].args[1]).toBe(queue);
    expect(calls[0].args[2]).toBe(ADMIN);
  });

  it("a resource class that extends a guarded table inherits the guard, even when it overrides instance connect()", async () => {
    const { Table, calls } = makeTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    class MemoryResource extends Table {
      connect() { return "instance connect is not the route entry"; }
    }
    let thrown: any;
    try { await (MemoryResource as any).connect({ id: null }, null, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(403);
    await (MemoryResource as any).connect({ id: null }, null, ADMIN);
    expect(calls.map((c) => c.self)).toEqual([MemoryResource]);
  });

  it("guards every table it is given, skips values that are not classes, and is idempotent", async () => {
    const a = makeTable();
    const b = makeTable();
    let resolved = 0;
    const deps = { resolveAuth: async (ctx: any) => { resolved++; return byContext(ctx); }, ambientContext: () => ({}) };
    const tables = { Memory: a.Table, Message: b.Table, notATable: { connect: () => null }, alsoNot: 42 } as any;
    expect(guardTableSubscriptions(tables, deps)).toEqual(["Memory", "Message"]);
    expect(guardTableSubscriptions(tables, deps)).toEqual(["Memory", "Message"]);
    expect(Object.prototype.hasOwnProperty.call(a.Table, TABLE_SUBSCRIPTION_GUARD)).toBe(true);
    await (a.Table as any).connect({ id: null }, null, ADMIN);
    expect(resolved).toBe(1); // installed once, not wrapped twice
    expect(guardTableSubscriptions(undefined, deps)).toEqual([]);
  });

  it("refuses when the caller cannot be resolved", async () => {
    const { Table, calls } = makeTable();
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { throw new Error("agent table unavailable"); },
      ambientContext: () => ({}),
    });
    let thrown: any;
    try { await (Table as any).connect({ id: null }, null, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(500);
    expect(thrown?.message).toContain("could not be verified");
    expect(calls).toEqual([]);
  });

  it("decides on the context Harper would use: explicit, in the data position, or ambient", async () => {
    const { Table, calls } = makeTable();
    let ambient: unknown = AGENT;
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ambient });
    // two-argument in-process form: (target, context)
    await expect((Table as any).connect({ id: null }, { ...AGENT, request: {} })).rejects.toMatchObject({ statusCode: 403 });
    // no context at all: the ambient one decides
    await expect((Table as any).connect({ id: null })).rejects.toMatchObject({ statusCode: 403 });
    ambient = {};
    await (Table as any).connect({ id: null });
    expect(calls.length).toBe(1);
  });
});

describe("subscriptionCallerContext", () => {
  const ambient = () => "ambient";
  it("prefers the explicit context, unwrapping getContext()", () => {
    const inner = { user: 1 };
    expect(subscriptionCallerContext(null, { getContext: () => inner }, ambient)).toBe(inner);
    const request = { headers: {} };
    expect(subscriptionCallerContext({ queue: true }, request, ambient)).toBe(request);
  });
  it("uses a context passed in the data position", () => {
    const ctx = { request: {} };
    expect(subscriptionCallerContext(ctx, undefined, ambient)).toBe(ctx);
  });
  it("falls back to the ambient context", () => {
    expect(subscriptionCallerContext(undefined, undefined, ambient)).toBe("ambient");
    expect(subscriptionCallerContext({ messages: [] }, undefined, ambient)).toBe("ambient");
  });
});

describe("refusal text", () => {
  it("fits a WebSocket close reason (Harper sends `Error: <message>`)", () => {
    const refusals = [
      tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false })!,
      tableSubscriptionRefusal({ kind: "anonymous" })!,
      unverifiedSubscriberRefusal(),
    ];
    for (const err of refusals) {
      expect(Buffer.byteLength(`Error: ${err.message}`)).toBeLessThanOrEqual(MAX_REFUSAL_REASON_BYTES);
    }
  });
  it("names the resources agents subscribe through", () => {
    expect(tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false })!.message).toContain("FeedMemories or FeedSouls");
  });
  it("admits only administrators and internal calls", () => {
    expect(tableSubscriptionRefusal({ kind: "internal" })).toBeNull();
    expect(tableSubscriptionRefusal({ kind: "agent", agentId: "root", isAdmin: true })).toBeNull();
  });
});
