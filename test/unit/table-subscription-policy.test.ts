/**
 * table-subscription-policy.test.ts — the guard that limits table subscriptions
 * and publishes to administrators and trusted internal calls
 * (resources/table-subscription-policy.ts).
 *
 * The integration tests check the rule on a real Harper: on the collection and
 * by-id routes of every table over SSE and WebSocket
 * (test/integration/table-subscription-default-deny.test.ts), and on every
 * table's MQTT topics: SUBSCRIBE to each table's collection and by-id topics,
 * and PUBLISH, retained PUBLISH and retained delete to each table topic (but
 * the two paths another resource serves), with a marker row committed to every
 * table
 * (test/integration/table-subscription-mqtt.test.ts). These cases pin the parts
 * a real Harper does not exercise on demand: the statics it replaces
 * (`connect()`, `subscribe()`, `publish()`, and `put()`/`delete()` for an MQTT
 * session's call), inheritance by resource subclasses, how the caller's context
 * is resolved for each, the rule for a call a protocol layer made, the
 * in-process entry, a caller that cannot be resolved, and the length limit on
 * the refusal text.
 */
import { describe, it, expect } from "bun:test";
import {
  GUARDED_TABLE_STATICS,
  RETAINED_PUBLISH_STATICS,
  retainedPublishContexts,
  guardTableSubscriptions,
  isProtocolEntry,
  subscribeInProcess,
  subscriptionCaller,
  harperCallContexts,
  tableSubscriptionRefusal,
  unverifiedSubscriberRefusal,
  MAX_REFUSAL_REASON_BYTES,
  TABLE_SUBSCRIPTION_GUARD,
  type CallContextSource,
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

/**
 * A stand-in for a Harper table class with all three statics the guard
 * replaces; each records its calls and returns synchronously, as Harper's
 * subscribe() may.
 */
function makeStreamTable() {
  const calls: Array<{ method: string; self: unknown; args: unknown[] }> = [];
  class Table {
    static connect(this: unknown, ...args: unknown[]) {
      calls.push({ method: "connect", self: this, args });
      return { subscription: "connect" };
    }
    static subscribe(this: unknown, ...args: unknown[]) {
      calls.push({ method: "subscribe", self: this, args });
      return { subscription: "subscribe" };
    }
    static publish(this: unknown, ...args: unknown[]) {
      calls.push({ method: "publish", self: this, args });
      return { published: true };
    }
  }
  return { Table, calls };
}

/** resolveAuth reads the verdict off the context the guard hands it. */
const byContext = async (ctx: any): Promise<SubscriptionCaller> => ctx?.verdict ?? { kind: "internal" };
// Each carries a `transaction` property, as the contexts Harper passes do (it
// calls these statics inside transaction(context, ...)). That is what makes
// Harper read a second argument of subscribe() as its context; in the other
// forms these fixtures are used in — a third argument, the (data, context)
// form, delete() — Harper reads them as the context whatever they carry. In
// the two-argument connect()/publish() form with a target first, Harper
// checks for a real DatabaseTransaction, which `{}` is not
// (resources/Resource.ts); those cases are read both ways.
const AGENT = { verdict: { kind: "agent", agentId: "b", isAdmin: false }, transaction: {} };
const ADMIN = { verdict: { kind: "agent", agentId: "root", isAdmin: true }, transaction: {} };
const ANON = { verdict: { kind: "anonymous" }, transaction: {} };

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

describe("guardTableSubscriptions — MQTT subscribe() and publish()", () => {
  it("guards the stream statics connect(), subscribe() and publish() (put() and delete() are guarded for a retained publish)", () => {
    expect(Object.keys(GUARDED_TABLE_STATICS).sort()).toEqual(["connect", "publish", "subscribe"]);
    const { Table } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    for (const m of ["connect", "subscribe", "publish"]) {
      expect(Object.prototype.hasOwnProperty.call(Table, m), m).toBe(true);
      expect((Table as any)[m].name, m).toBe(m);
    }
  });

  it("refuses a verified non-admin agent's subscribe(target, context) with 403 and never reaches the table's subscribe()", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    let thrown: any;
    try { await (Table as any).subscribe({ id: null }, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.message).toBe("table subscriptions are for administrators");
    expect(calls).toEqual([]);
  });

  it("refuses an anonymous subscribe() with 401", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    await expect((Table as any).subscribe({ id: null }, ANON)).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
  });

  it("refuses a non-admin publish(target, data, context) with 403 and an anonymous one with 401, naming publishes", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    let thrown: any;
    try { await (Table as any).publish({ id: "m1" }, { content: "x" }, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.message).toBe("table publishes are for administrators");
    thrown = undefined;
    try { await (Table as any).publish({ id: "m1" }, { content: "x" }, ANON); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(401);
    expect(thrown?.message).toBe("table publishes need an administrator credential");
    expect(calls).toEqual([]);
  });

  it("passes an administrator's subscribe() and publish() through unchanged, with the same arguments and receiver", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    const target = { id: null };
    const data = { content: "x" };
    expect(await (Table as any).subscribe(target, ADMIN)).toEqual({ subscription: "subscribe" });
    expect(await (Table as any).publish(target, data, ADMIN)).toEqual({ published: true });
    expect(calls.map((c) => c.method)).toEqual(["subscribe", "publish"]);
    expect(calls[0].self).toBe(Table);
    expect(calls[0].args).toEqual([target, ADMIN]);
    expect(calls[1].args[0]).toBe(target);
    expect(calls[1].args[1]).toBe(data);
    expect(calls[1].args[2]).toBe(ADMIN);
  });

  it("a resource class that extends a guarded table inherits the subscribe() and publish() guards", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    class MemoryResource extends Table {
      subscribe() { return "instance subscribe is not the topic entry"; }
      publish() { return "instance publish is not the topic entry"; }
    }
    await expect((MemoryResource as any).subscribe({ id: null }, AGENT)).rejects.toMatchObject({ statusCode: 403 });
    await expect((MemoryResource as any).publish({ id: "m" }, {}, AGENT)).rejects.toMatchObject({ statusCode: 403 });
    await (MemoryResource as any).subscribe({ id: null }, ADMIN);
    expect(calls.map((c) => c.self)).toEqual([MemoryResource]);
  });

  it("decides subscribe() on the context Harper would use: the second argument when Harper reads it as one, a truthy third, or the ambient one", async () => {
    const { Table, calls } = makeStreamTable();
    let ambient: unknown = AGENT;
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ambient });
    // (target, context): a second argument carrying a transaction is the context
    await expect((Table as any).subscribe({ id: null }, ANON)).rejects.toMatchObject({ statusCode: 401 });
    // (target, plain object): Harper reads it as data and uses the ambient context
    await expect((Table as any).subscribe({ id: null }, { verdict: { kind: "anonymous" } })).rejects.toMatchObject({ statusCode: 403 });
    // (target, data, context) and (target, undefined, context): the third
    await expect((Table as any).subscribe({ id: null }, ADMIN, AGENT)).rejects.toMatchObject({ statusCode: 403 });
    await expect((Table as any).subscribe({ id: null }, undefined, ANON)).rejects.toMatchObject({ statusCode: 401 });
    // (target): the ambient context
    await expect((Table as any).subscribe({ id: null })).rejects.toMatchObject({ statusCode: 403 });
    ambient = {};
    await (Table as any).subscribe({ id: null });
    expect(calls.length).toBe(1);
  });

  it("refuses when the caller of a subscribe() or publish() cannot be resolved", async () => {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { throw new Error("agent table unavailable"); },
      ambientContext: () => ({}),
    });
    await expect((Table as any).subscribe({ id: null }, AGENT)).rejects.toMatchObject({ statusCode: 500 });
    let thrown: any;
    try { await (Table as any).publish({ id: "m" }, {}, AGENT); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(500);
    expect(thrown?.message).toContain("the publisher could not be verified");
    expect(calls).toEqual([]);
  });

  it("guards a table class that has only some of the three statics", async () => {
    class OnlySubscribe { static subscribe() { return "s"; } }
    const guarded = guardTableSubscriptions({ OnlySubscribe }, { resolveAuth: byContext, ambientContext: () => ({}) });
    expect(guarded).toEqual(["OnlySubscribe"]);
    await expect((OnlySubscribe as any).subscribe({ id: null }, AGENT)).rejects.toMatchObject({ statusCode: 403 });
    expect(Object.prototype.hasOwnProperty.call(OnlySubscribe, "connect")).toBe(false);
  });
});

describe("guardTableSubscriptions — retained MQTT publish (put() / delete())", () => {
  /** A table class whose static put()/delete() record their calls and answer synchronously. */
  function makeWriteTable() {
    const calls: Array<{ method: string; self: unknown; args: unknown[] }> = [];
    class Table {
      static put(this: unknown, ...args: unknown[]) { calls.push({ method: "put", self: this, args }); return "put-result"; }
      static delete(this: unknown, ...args: unknown[]) { calls.push({ method: "delete", self: this, args }); return "delete-result"; }
    }
    return { Table, calls };
  }
  /** An MQTT session's context carrying the verdict byContext reads. */
  const mqtt = (verdict: unknown) => ({ session: { addSubscription: () => undefined }, socket: {}, authorize: true, verdict });

  it("guards put() and delete()", () => {
    expect([...RETAINED_PUBLISH_STATICS].sort()).toEqual(["delete", "put"]);
    const { Table } = makeWriteTable();
    expect(guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) })).toEqual(["Memory"]);
    expect((Table as any).put.name).toBe("put");
    expect((Table as any).delete.name).toBe("delete");
  });

  it("refuses an MQTT session's retained put/delete for a non-admin (403) and an anonymous caller (401), naming publishes", async () => {
    const { Table, calls } = makeWriteTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    let thrown: any;
    try { await (Table as any).put({ id: "m" }, { content: "x" }, mqtt(AGENT.verdict)); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.message).toBe("table publishes are for administrators");
    await expect((Table as any).delete({ id: "m" }, mqtt(ANON.verdict))).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
  });

  it("an MQTT session's context that resolves as internal is a caller without a credential (Harper's TCP listener)", async () => {
    const { Table, calls } = makeWriteTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: async () => ({ kind: "internal" }), ambientContext: () => ({}) });
    await expect((Table as any).put({ id: "m" }, { content: "x" }, mqtt(undefined))).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
  });

  it("passes an administrator's retained put/delete through with the same arguments and receiver", async () => {
    const { Table, calls } = makeWriteTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ({}) });
    const ctx = mqtt(ADMIN.verdict);
    expect(await (Table as any).put({ id: "m" }, { content: "x" }, ctx)).toBe("put-result");
    expect(await (Table as any).delete({ id: "m" }, ctx)).toBe("delete-result");
    expect(calls.map((c) => [c.method, c.self, c.args.length])).toEqual([["put", Table, 3], ["delete", Table, 2]]);
  });

  it("every other write goes to the inherited static synchronously, without resolving a caller", () => {
    const { Table, calls } = makeWriteTable();
    let resolved = 0;
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { resolved++; return { kind: "anonymous" }; },
      ambientContext: () => mqtt(ANON.verdict), // the ambient context is not consulted
    });
    // A REST request, an in-process call with no context, the two-argument form, a protocol marker on the target only.
    expect((Table as any).put({ id: "m" }, { content: "x" }, { headers: {}, authorize: true })).toBe("put-result");
    expect((Table as any).put({ id: "m", content: "x" })).toBe("put-result");
    expect((Table as any).put({ id: "m", content: "x" }, { transaction: {} })).toBe("put-result");
    expect((Table as any).delete({ id: "m", checkPermission: {} }, { request: { headers: {} } })).toBe("delete-result");
    expect(resolved).toBe(0);
    expect(calls.length).toBe(4);
  });

  it("refuses an MQTT session's retained put/delete when the caller cannot be resolved", async () => {
    const { Table, calls } = makeWriteTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: async () => { throw new Error("down"); }, ambientContext: () => ({}) });
    await expect((Table as any).put({ id: "m" }, {}, mqtt(undefined))).rejects.toMatchObject({ statusCode: 500 });
    expect(calls).toEqual([]);
  });

  it("retainedPublishContexts returns the MQTT session context Harper passes, at the position Harper reads it", () => {
    const ctx = mqtt(ADMIN.verdict);
    expect(retainedPublishContexts("put", [{}, { data: 1 }, ctx])).toEqual([ctx]); // put(target, data, context)
    expect(retainedPublishContexts("delete", [{}, ctx])).toEqual([ctx]); // delete(target, context)
    expect(retainedPublishContexts("put", [{}, { data: 1 }, { ...ctx, user: {} }])).toHaveLength(1); // a session's will copies the context
  });

  it("retainedPublishContexts classifies the arguments Harper may take as the context, as Harper reads put() and delete()", () => {
    const ctx = mqtt(ADMIN.verdict);
    const target = new URLSearchParams("id=m"); // Harper's RequestTarget
    const released = Object.freeze({ open: 0, addWrite() {}, setContext() {} });
    const replayShaped = { id: "m", topic: "Memory/m", retain: true, authorize: true };
    const withTxn = { ...ctx, transaction: { commit() { return {}; } } };
    expect(retainedPublishContexts("put", [{ id: "m" }, ctx])).toEqual([ctx]); // (data, context)
    expect(retainedPublishContexts("put", [target, replayShaped])).toEqual([]); // Harper reads it as data
    expect(retainedPublishContexts("put", [target, withTxn])).toEqual([withTxn]); // a second argument carrying a transaction
    expect(retainedPublishContexts("put", [target, { data: 1 }, released])).toEqual([]); // released counts as absent
    expect(retainedPublishContexts("put", [{ id: "m" }, ctx, released])).toEqual([ctx]);
    expect(retainedPublishContexts("delete", [target, ctx, released])).toEqual([ctx]);
    expect(retainedPublishContexts("delete", [target, undefined, ctx])).toEqual([ctx]);
    expect(retainedPublishContexts("put", [target, { data: 1 }, ctx])).toEqual([ctx]);
  });

  it("a will Harper replays is decided as a caller without a credential, an administrator's included", async () => {
    const { Table, calls } = makeWriteTable();
    let resolved = 0;
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { resolved++; return ADMIN.verdict as SubscriptionCaller; },
      ambientContext: () => ({}),
    });
    // The stored will record, as Harper's will replay passes it (its user looked up by name).
    const replayed = (data: unknown) => ({ id: "c1", topic: "Memory/m", data, qos: 1, retain: true, user: { username: "admin", role: { permission: { super_user: true } } }, authorize: true });
    let thrown: any;
    try { await (Table as any).put({ id: "m" }, { content: "x" }, replayed({ content: "x" })); } catch (err) { thrown = err; }
    expect(thrown?.statusCode).toBe(401);
    expect(thrown?.message).toBe("table publishes need an administrator credential");
    await expect((Table as any).delete({ id: "m" }, replayed(undefined))).rejects.toMatchObject({ statusCode: 401 });
    expect(resolved).toBe(0);
    expect(calls).toEqual([]);
    expect(retainedPublishContexts("put", [{}, { content: "x" }, replayed({ content: "x" })])).toHaveLength(1);
  });

  it("retainedPublishContexts is empty for a context of neither shape, and invokes no getter or getContext()", () => {
    let accessorReads = 0;
    let getContextCalls = 0;
    const session = { addSubscription: () => undefined };
    const viaAccessor = { socket: {}, get session() { accessorReads++; return session; } };
    const viaGetContext = { getContext() { getContextCalls++; return mqtt(ADMIN.verdict); } };
    expect(retainedPublishContexts("put", [{}, { data: 1 }, { user: 1 }])).toEqual([]);
    expect(retainedPublishContexts("put", [{}, { data: 1 }, { headers: {}, authorize: true }])).toEqual([]);
    expect(retainedPublishContexts("put", [{ id: "x" }])).toEqual([]);
    expect(retainedPublishContexts("delete", ["id"])).toEqual([]);
    expect(retainedPublishContexts("put", [{}, { data: 1 }, viaAccessor])).toEqual([]);
    expect(retainedPublishContexts("delete", [{}, viaGetContext])).toEqual([]);
    expect(retainedPublishContexts("put", [{}, { data: 1 }, Object.create(mqtt(ADMIN.verdict))])).toEqual([]); // inherited, not own
    expect(accessorReads).toBe(0);
    expect(getContextCalls).toBe(0);
  });

  it("an ordinary put()/delete() classifies its context from own property descriptors only (pinned trap by trap with a recording Proxy), then passes the call through", () => {
    /** A context Proxy that records every trap it receives (key-taking traps with their key). */
    function recordingContext(target: Record<string, unknown>) {
      const traps: string[] = [];
      const handler: ProxyHandler<Record<string, unknown>> = {};
      const keyed = new Set(["get", "set", "has", "deleteProperty", "getOwnPropertyDescriptor", "defineProperty"]);
      for (const trap of ["get", "set", "has", "deleteProperty", "ownKeys", "getOwnPropertyDescriptor", "defineProperty",
        "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions"] as const) {
        (handler as any)[trap] = (...a: any[]) => {
          traps.push(keyed.has(trap) ? `${trap} ${String(a[1])}` : trap);
          return (Reflect as any)[trap](...a);
        };
      }
      return { context: new Proxy(target, handler), traps };
    }
    // makeWriteTable's statics do not touch their arguments, so every trap below is the guard's.
    const { Table, calls } = makeWriteTable();
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { throw new Error("an ordinary write resolves no caller"); },
      ambientContext: () => { throw new Error("an ordinary write reads no ambient context"); },
    });

    const plain = recordingContext({ transaction: {} });
    expect((Table as any).put({ id: "m" }, { content: "x" }, plain.context)).toBe("put-result");
    expect(plain.traps).toEqual(["getOwnPropertyDescriptor addWrite", "getOwnPropertyDescriptor socket", "getOwnPropertyDescriptor authorize"]);

    const twoArgument = recordingContext({ transaction: {} });
    expect((Table as any).delete({ id: "m" }, twoArgument.context)).toBe("delete-result");
    expect(twoArgument.traps).toEqual(["getOwnPropertyDescriptor addWrite", "getOwnPropertyDescriptor socket", "getOwnPropertyDescriptor authorize"]);

    // A request Harper marked for authorization adds the read of `topic`, and no more.
    const marked = recordingContext({ headers: {}, authorize: true });
    expect((Table as any).put({ id: "m" }, { content: "x" }, marked.context)).toBe("put-result");
    expect(marked.traps).toEqual(["getOwnPropertyDescriptor addWrite", "getOwnPropertyDescriptor socket", "getOwnPropertyDescriptor authorize", "getOwnPropertyDescriptor topic"]);
    expect(calls.length).toBe(3);

    // A descriptor read that throws propagates before the inherited static runs.
    const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("descriptor read refused"); } });
    expect(() => (Table as any).put({ id: "m" }, { content: "x" }, throwing)).toThrow("descriptor read refused");
    expect(calls.length).toBe(3);
  });

  it("an ordinary put()/delete() calls getContext() and gets properties of its context exactly as often as without the guard", () => {
    /**
     * A table whose static put()/delete() read an explicit context the way
     * Harper's transactional() does (resources/Resource.ts: the context is
     * replaced by `context.getContext?.() || context`).
     */
    function makeHarperLikeWriteTable() {
      const read = (args: unknown[]) => { const explicit: any = args[2] ? args[2] : args[1]; return explicit?.getContext?.() || explicit; };
      class Table {
        static put(...args: unknown[]) { read(args); return "put-result"; }
        static delete(...args: unknown[]) { read(args); return "delete-result"; }
      }
      return Table;
    }
    /** A context that counts its getContext() calls and every property read. */
    function countingContext() {
      const counts = { getContext: 0, reads: 0 };
      const target: Record<string, unknown> = { transaction: {} };
      target.getContext = () => { counts.getContext++; return target; };
      const context = new Proxy(target, { get(t, key, receiver) { counts.reads++; return Reflect.get(t, key, receiver); } });
      return { context, counts };
    }
    const writes: Array<[string, (table: any, context: unknown) => unknown]> = [
      ["put(target, data, context)", (t, c) => t.put({ id: "m" }, { content: "x" }, c)],
      ["put(record, context)", (t, c) => t.put({ id: "m", content: "x" }, c)],
      ["delete(target, context)", (t, c) => t.delete({ id: "m" }, c)],
      ["delete(target, data, context)", (t, c) => t.delete({ id: "m" }, { reason: "x" }, c)],
    ];
    for (const [form, write] of writes) {
      const unguarded = countingContext();
      const unguardedResult = write(makeHarperLikeWriteTable(), unguarded.context);
      const Guarded = makeHarperLikeWriteTable();
      guardTableSubscriptions({ Memory: Guarded }, {
        resolveAuth: async () => { throw new Error("an ordinary write resolves no caller"); },
        ambientContext: () => { throw new Error("an ordinary write reads no ambient context"); },
      });
      const guarded = countingContext();
      expect([form, write(Guarded, guarded.context)]).toEqual([form, unguardedResult]);
      expect([form, guarded.counts]).toEqual([form, unguarded.counts]);
      expect([form, unguarded.counts.getContext]).toEqual([form, 1]);
    }
  });
});

describe("a call a protocol layer made is never the trusted internal caller", () => {
  const INTERNAL: SubscriptionCaller = { kind: "internal" };

  it("isProtocolEntry reads Harper's markers: a non-null, non-false checkPermission, or authorize: true", () => {
    expect(isProtocolEntry({ checkPermission: {} }, undefined)).toBe(true);
    expect(isProtocolEntry({ checkPermission: { super_user: true } }, undefined)).toBe(true);
    expect(isProtocolEntry({ id: null }, { authorize: true })).toBe(true);
    expect(isProtocolEntry({ checkPermission: false }, undefined)).toBe(false);
    expect(isProtocolEntry({ checkPermission: null }, { authorize: false })).toBe(false);
    expect(isProtocolEntry({ id: null }, {})).toBe(false);
    expect(isProtocolEntry(undefined, undefined)).toBe(false);
    expect(isProtocolEntry("an id", "not a context")).toBe(false);
  });

  it("subscriptionCaller turns an internal verdict on a protocol-layer call into a caller without a credential", () => {
    expect(subscriptionCaller(INTERNAL, { checkPermission: {} }, {})).toEqual({ kind: "anonymous" });
    expect(subscriptionCaller(INTERNAL, { id: null }, { authorize: true })).toEqual({ kind: "anonymous" });
    expect(subscriptionCaller(INTERNAL, { id: null }, {})).toEqual(INTERNAL);
    const admin: SubscriptionCaller = { kind: "agent", agentId: "root", isAdmin: true };
    expect(subscriptionCaller(admin, { checkPermission: {} }, { authorize: true })).toBe(admin);
  });

  it("an MQTT session context without an HTTP request (Harper's TCP listener) is refused with 401 on subscribe() and publish()", async () => {
    const { Table, calls } = makeStreamTable();
    // A resolver that answers `internal` for these requestless contexts, so the
    // guard's own rule decides (resolveAgentAuth answers anonymous for them,
    // since they carry authorize: true).
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: async () => INTERNAL, ambientContext: () => ({}) });
    const mqttContext = { session: {}, socket: {}, user: { role: { permission: { super_user: true } } }, authorize: true };
    await expect((Table as any).subscribe({ id: null, checkPermission: {} }, mqttContext)).rejects.toMatchObject({ statusCode: 401 });
    await expect((Table as any).publish({ id: "m", checkPermission: {} }, { content: "x" }, mqttContext)).rejects.toMatchObject({ statusCode: 401 });
    // The same verdict without the markers is a trusted internal call.
    await (Table as any).subscribe({ id: null });
    expect(calls.map((c) => c.method)).toEqual(["subscribe"]);
  });
});

describe("subscribeInProcess", () => {
  it("calls the table's own subscribe() synchronously, with the same argument and receiver, without consulting the guard", () => {
    const { Table, calls } = makeStreamTable();
    let resolved = 0;
    guardTableSubscriptions({ Memory: Table }, {
      resolveAuth: async () => { resolved++; return { kind: "anonymous" }; },
      ambientContext: () => AGENT,
    });
    const request = { omitCurrent: true };
    expect(subscribeInProcess(Table, request)).toEqual({ subscription: "subscribe" }); // not a promise
    expect(resolved).toBe(0);
    expect(calls).toEqual([{ method: "subscribe", self: Table, args: [request] }]);
  });

  it("subscribes to a table the guard was not installed on directly", () => {
    const { Table, calls } = makeStreamTable();
    expect(subscribeInProcess(Table, { id: "x" })).toEqual({ subscription: "subscribe" });
    expect(calls.length).toBe(1);
  });
});

describe("harperCallContexts: the context Harper's transactional() uses for each call form", () => {
  const ctx = { user: 1 };
  const other = { user: 2 };
  const arg = (value: unknown): CallContextSource => ({ from: "argument", value });
  const AMBIENT: CallContextSource = { from: "ambient" };
  const target = new URLSearchParams("id=m"); // Harper's RequestTarget is a URLSearchParams
  const released = Object.freeze({ open: 0, addWrite() {}, setContext() {}, commit() { return { txnTime: 0 }; } });

  it("a truthy third argument is the context whatever the second, for every static", () => {
    for (const method of ["connect", "subscribe", "publish"] as const) {
      expect([method, harperCallContexts(method, [target, undefined, ctx])]).toEqual([method, [arg(ctx)]]);
      expect([method, harperCallContexts(method, [target, { data: 1 }, ctx])]).toEqual([method, [arg(ctx)]]);
      expect([method, harperCallContexts(method, [target, other, ctx])]).toEqual([method, [arg(ctx)]]);
    }
  });

  it("unwraps getContext() where Harper does, and keeps a bare third argument of subscribe() as is", () => {
    const wrapper = { getContext: () => ctx };
    expect(harperCallContexts("connect", [target, undefined, wrapper])).toEqual([arg(ctx)]);
    expect(harperCallContexts("subscribe", [target, other, wrapper])).toEqual([arg(ctx)]);
    expect(harperCallContexts("subscribe", [target, undefined, wrapper])).toEqual([arg(wrapper)]);
  });

  it("subscribe(): the second argument when it has a transaction or a getContext, otherwise the ambient context", () => {
    const withTxn = { transaction: {}, user: 3 };
    expect(harperCallContexts("subscribe", [target, withTxn])).toEqual([arg(withTxn)]);
    expect(harperCallContexts("subscribe", [target, { getContext: () => ctx }])).toEqual([arg(ctx)]);
    expect(harperCallContexts("subscribe", [target, { user: 1 }])).toEqual([AMBIENT]); // data, as Harper reads it
    expect(harperCallContexts("subscribe", [target])).toEqual([AMBIENT]);
  });

  it("connect()/publish() with no third argument: the (data, context) form, else both readings Harper may take", () => {
    for (const method of ["connect", "publish"] as const) {
      expect([method, harperCallContexts(method, [{ id: "m" }, ctx])]).toEqual([method, [arg(ctx)]]);
      // An array first argument: Harper tells the form from element 0, which flair does not read, so every reading is decided.
      expect([method, harperCallContexts(method, [[{ id: "m" }], ctx])]).toEqual([method, [arg(ctx), AMBIENT]]);
      // Harper takes the second as the context only when it is or carries a DatabaseTransaction.
      expect([method, harperCallContexts(method, [target, ctx])]).toEqual([method, [arg(ctx), AMBIENT]]);
      expect([method, harperCallContexts(method, ["m", ctx])]).toEqual([method, [arg(ctx), AMBIENT]]);
      expect([method, harperCallContexts(method, [target])]).toEqual([method, [AMBIENT]]);
    }
  });

  it("an argument shaped like Harper's released-transaction placeholder is read both as given and as absent", () => {
    expect(harperCallContexts("subscribe", [target, { transaction: {}, user: 3 }, released]))
      .toEqual([arg(released), arg({ transaction: {}, user: 3 })]);
    expect(harperCallContexts("connect", [target, released, ctx])).toEqual([arg(ctx)]);
  });
});

describe("the guard decides on the context Harper takes from the arguments (conflicting ambient and explicit callers)", () => {
  /** A table whose statics record that they ran. */
  function guarded(ambient: unknown) {
    const { Table, calls } = makeStreamTable();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ambient });
    return { Table: Table as any, calls };
  }
  const target = new URLSearchParams("id=m");

  it("ambient administrator, explicit non-admin or anonymous: refused wherever Harper uses the explicit context", async () => {
    for (const explicit of [AGENT, ANON]) {
      const status = explicit === AGENT ? 403 : 401;
      const forms: Array<[string, (t: any) => unknown]> = [
        ["subscribe(target, context)", (t) => t.subscribe(target, explicit)],
        ["subscribe(target, undefined, context)", (t) => t.subscribe(target, undefined, explicit)],
        ["subscribe(target, data, context)", (t) => t.subscribe(target, { data: 1 }, explicit)],
        ["connect(target, data, context)", (t) => t.connect(target, { data: 1 }, explicit)],
        ["connect(target, undefined, context)", (t) => t.connect(target, undefined, explicit)],
        ["connect(record, context)", (t) => t.connect({ id: "m" }, explicit)],
        ["connect(target, context)", (t) => t.connect(target, explicit)],
        ["publish(target, data, context)", (t) => t.publish(target, { data: 1 }, explicit)],
        ["publish(target, undefined, context)", (t) => t.publish(target, undefined, explicit)],
        ["publish(record, context)", (t) => t.publish({ id: "m" }, explicit)],
        ["publish(target, context)", (t) => t.publish(target, explicit)],
      ];
      for (const [form, call] of forms) {
        const { Table, calls } = guarded(ADMIN);
        let thrown: any;
        try { await call(Table); } catch (err) { thrown = err; }
        expect([form, thrown?.statusCode, calls.length]).toEqual([form, status, 0]);
      }
    }
  });

  it("ambient administrator: admitted where Harper uses the ambient context", async () => {
    for (const [form, call] of [
      ["subscribe(target)", (t: any) => t.subscribe(target)],
      ["subscribe(target, data)", (t: any) => t.subscribe(target, { data: 1 })],
      ["connect(target)", (t: any) => t.connect(target)],
      ["publish(target, data)", (t: any) => t.publish(target, { data: 1 })], // data resolves as internal; the ambient admin is admitted
    ] as const) {
      const { Table, calls } = guarded(ADMIN);
      await call(Table);
      expect([form, calls.length]).toEqual([form, 1]);
    }
  });

  it("ambient non-admin, explicit administrator: admitted only where Harper acts as the administrator", async () => {
    for (const [form, call, admitted] of [
      ["subscribe(target, undefined, admin)", (t: any) => t.subscribe(target, undefined, ADMIN), true],
      ["subscribe(target, { verdict })", (t: any) => t.subscribe(target, { verdict: ADMIN.verdict }), false], // Harper reads a plain second argument as data
      ["connect(target, data, admin)", (t: any) => t.connect(target, { data: 1 }, ADMIN), true],
      ["connect(record, admin)", (t: any) => t.connect({ id: "m" }, ADMIN), true],
      // Harper uses the second only if it carries one of its transactions; flair cannot tell, so both readings must be admitted.
      ["connect(target, admin)", (t: any) => t.connect(target, ADMIN), false],
      ["publish(target, undefined, admin)", (t: any) => t.publish(target, undefined, ADMIN), true],
      ["subscribe(target)", (t: any) => t.subscribe(target), false],
    ] as const) {
      const { Table, calls } = guarded(AGENT);
      let thrown: any;
      try { await call(Table); } catch (err) { thrown = err; }
      expect([form, calls.length, admitted ? undefined : thrown?.statusCode]).toEqual([form, admitted ? 1 : 0, admitted ? undefined : 403]);
    }
  });
});

describe("caller-made shapes the guard decides fail closed", () => {
  const target = new URLSearchParams("id=m");

  it("a session-shaped context that is also shaped like Harper's released-transaction sentinel is decided in put() and delete()", async () => {
    const { Table, calls } = (() => {
      const calls: string[] = [];
      class Table {
        static put() { calls.push("put"); return "put-result"; }
        static delete() { calls.push("delete"); return "delete-result"; }
      }
      return { Table, calls };
    })();
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ADMIN });
    const mimic = () => ({
      session: { addSubscription: () => undefined }, socket: {}, authorize: true, verdict: AGENT.verdict,
      open: 0, addWrite() {}, setContext() {},
    });
    await expect((Table as any).put({ id: "m" }, { content: "x" }, mimic())).rejects.toMatchObject({ statusCode: 403 });
    await expect((Table as any).put(target, { content: "x" }, mimic())).rejects.toMatchObject({ statusCode: 403 });
    await expect((Table as any).delete(target, mimic())).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual([]);
  });

  it("put()/delete() with two marked candidates decides both: an administrator's first and a non-admin's second is refused", async () => {
    const calls: string[] = [];
    class Table {
      static put() { calls.push("put"); return "put-result"; }
      static delete() { calls.push("delete"); return "delete-result"; }
    }
    guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => ADMIN });
    const session = (verdict: unknown, sentinelShaped = false) => ({
      session: { addSubscription: () => undefined }, socket: {}, authorize: true, verdict,
      ...(sentinelShaped ? { open: 0, addWrite() {}, setContext() {} } : {}),
    });
    // The third argument is sentinel-shaped, so Harper may skip it and take the second: both are candidates.
    await expect((Table as any).put({ id: "m" }, session(AGENT.verdict), session(ADMIN.verdict, true))).rejects.toMatchObject({ statusCode: 403 });
    await expect((Table as any).delete(target, session(AGENT.verdict), session(ADMIN.verdict, true))).rejects.toMatchObject({ statusCode: 403 });
    expect(retainedPublishContexts("put", [{ id: "m" }, session(AGENT.verdict), session(ADMIN.verdict, true)])).toHaveLength(2);
    // Both administrators: admitted.
    expect(await (Table as any).put({ id: "m" }, session(ADMIN.verdict), session(ADMIN.verdict, true))).toBe("put-result");
    expect(calls).toEqual(["put"]);
  });

  it("an array first argument: no element is read, and the call is refused when either reading is a non-admin", async () => {
    /** An array whose element 0 alternates between a record and a string on every read, counting reads. */
    function alternating() {
      const state = { reads: 0 };
      const array: unknown[] = [];
      Object.defineProperty(array, 0, { get() { state.reads++; return state.reads % 2 ? { id: "m" } : "m"; }, enumerable: true });
      return { array, state };
    }
    for (const method of ["connect", "publish"] as const) {
      // ambient non-admin, explicit administrator: one reading (the ambient one) is a non-admin
      const { Table, calls } = makeStreamTable();
      guardTableSubscriptions({ Memory: Table }, { resolveAuth: byContext, ambientContext: () => AGENT });
      const a = alternating();
      await expect((Table as any)[method](a.array, ADMIN)).rejects.toMatchObject({ statusCode: 403 });
      // ambient administrator, explicit non-admin: the (data, context) reading is a non-admin
      const { Table: T2, calls: c2 } = makeStreamTable();
      guardTableSubscriptions({ Memory: T2 }, { resolveAuth: byContext, ambientContext: () => ADMIN });
      const b = alternating();
      await expect((T2 as any)[method](b.array, AGENT)).rejects.toMatchObject({ statusCode: 403 });
      expect([method, a.state.reads, b.state.reads, calls.length, c2.length]).toEqual([method, 0, 0, 0, 0]);
    }
    // put([...], context): the session-marked second argument is decided without reading an element
    const writes: string[] = [];
    class W { static put() { writes.push("put"); return "put-result"; } }
    guardTableSubscriptions({ Memory: W }, { resolveAuth: byContext, ambientContext: () => ADMIN });
    const c = alternating();
    const session = { session: { addSubscription: () => undefined }, socket: {}, authorize: true, verdict: AGENT.verdict };
    await expect((W as any).put(c.array, session)).rejects.toMatchObject({ statusCode: 403 });
    expect([c.state.reads, writes.length]).toEqual([0, 0]);
  });
});

describe("refusal text", () => {
  it("fits a WebSocket close reason (Harper sends `Error: <message>`)", () => {
    const refusals = [
      tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false })!,
      tableSubscriptionRefusal({ kind: "anonymous" })!,
      unverifiedSubscriberRefusal(),
      tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false }, "publish")!,
      tableSubscriptionRefusal({ kind: "anonymous" }, "publish")!,
      unverifiedSubscriberRefusal("publish"),
    ];
    for (const err of refusals) {
      expect(Buffer.byteLength(`Error: ${err.message}`)).toBeLessThanOrEqual(MAX_REFUSAL_REASON_BYTES);
    }
  });
  it("states the rule and nothing else", () => {
    expect(tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false })!.message).toBe("table subscriptions are for administrators");
    expect(tableSubscriptionRefusal({ kind: "anonymous" })!.message).toBe("table subscriptions need an administrator credential");
  });
  it("admits only administrators and internal calls, for subscriptions and publishes alike", () => {
    for (const action of ["subscribe", "publish"] as const) {
      expect(tableSubscriptionRefusal({ kind: "internal" }, action)).toBeNull();
      expect(tableSubscriptionRefusal({ kind: "agent", agentId: "root", isAdmin: true }, action)).toBeNull();
      expect(tableSubscriptionRefusal({ kind: "agent", agentId: "b", isAdmin: false }, action)?.statusCode).toBe(403);
      expect(tableSubscriptionRefusal({ kind: "anonymous" }, action)?.statusCode).toBe(401);
    }
  });
});
