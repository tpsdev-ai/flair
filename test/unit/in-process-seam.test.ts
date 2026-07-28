// resources/in-process.ts — the in-process call seam.
//
// The module under test has ZERO imports (deliberately — see its header), so
// this file needs no `mock.module("harper", …)` and is safe in test/unit/.
//
// Two things are pinned here:
//
//   1. The SAFETY SHAPE. A missing or empty agent id resolves, inside Flair, to
//      the trusted `internal` verdict — unfiltered reads and writes across every
//      agent. So the constructors refuse it rather than defaulting, and the
//      privileged contexts are separate named exports that cannot be reached by
//      leaving an argument off. These are runtime guards on purpose: an
//      embedding app may be plain JavaScript, where the type annotations buy
//      nothing at all.
//   2. The COLLECTION BINDING. `collectionResource()` must produce an instance a
//      real Harper `Resource` subclass accepts a `post()` on. Harper decides
//      that from a PRIVATE field (`#isCollection`) only its own `getResource()`
//      can set; the public `isCollection` is a getter with no setter.
//      `HarperShaped` below reproduces both facts exactly, so the assertions
//      fail for the same reason a real Harper would.
//
// The end-to-end proof against a real, two-component Harper — including the
// escalation this API shape prevents — is
// test/integration/in-process-agents.test.ts.
import { describe, it, expect } from "bun:test";
import {
  agentContext,
  adminContext,
  internalContext,
  collectionResource,
  InProcessContextError,
} from "../../resources/in-process.ts";

/**
 * A stand-in for Harper's `Resource`, matching it on the only two points the
 * seam depends on: a getter-only `isCollection` backed by a private field, and
 * a `static getResource(target, context, options)` that is the sole way to set
 * it. Verified against harper 5.1.22's resources/Resource.ts (`get
 * isCollection()` at the prototype, `resource.#isCollection = true` inside
 * `getResource`, and `post()` calling `missingMethod` when the flag is false).
 */
class HarperShaped {
  #isCollection = false;
  id: any;
  context: any;
  constructor(id: any, context: any) { this.id = id; this.context = context; }
  get isCollection() { return this.#isCollection; }
  static getResource(target: any, request: any, options?: any) {
    const r = new (this as any)(target?.id, request ?? {}) as HarperShaped;
    if (options?.isCollection) r.#isCollection = true;
    return r;
  }
  /** Mirrors Harper's base Resource.post: refuses unless collection-bound. */
  post(record: any) {
    if (!this.#isCollection) throw new Error("The HarperShaped does not have a post method implemented");
    return { id: record?.id ?? "generated", written: true };
  }
}

// Everything a JS caller could plausibly pass by accident where an id belongs.
// Each one resolves, inside Flair, to the unfiltered `internal` verdict (or to a
// nonsense agent id, in the blank-string case) — so each one must be refused.
const BAD_IDS: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["blank string", "   "],
  ["a number", 0],
  ["a truthy number", 42],
  ["an object", {}],
  ["an array", []],
  ["a boolean", false],
];

describe("agentContext", () => {
  it("carries the agent id the resolver reads, and is never admin", () => {
    expect(agentContext("planner")).toEqual({ request: { tpsAgent: "planner", tpsAgentIsAdmin: false } });
  });

  it("has no options parameter, so no spread object can escalate it", () => {
    // The escalation shape this API removes: `agentContext(id, opts)` where
    // `opts` came from somewhere a caller could influence. There is no second
    // parameter to spread into, and extra arguments are inert.
    expect(agentContext.length).toBe(1);
    const attacker = { isAdmin: true, tpsAgentIsAdmin: true };
    expect((agentContext as any)("planner", attacker).request.tpsAgentIsAdmin).toBe(false);
  });

  it("returns a fresh object per call (one agent's context can never be mutated into another's)", () => {
    const a = agentContext("a");
    const b = agentContext("b");
    a.request.tpsAgent = "mutated";
    expect(b.request.tpsAgent).toBe("b");
  });

  describe("refuses anything that would resolve to the unfiltered `internal` verdict", () => {
    for (const [label, value] of BAD_IDS) {
      it(`throws InProcessContextError for ${label}`, () => {
        expect(() => (agentContext as any)(value)).toThrow(InProcessContextError);
      });
    }

    it("names the HAZARD, not just the argument", () => {
      // Whoever hits this should understand what they narrowly avoided, so the
      // message has to say what would otherwise have happened.
      let message = "";
      try { (agentContext as any)(undefined); } catch (e: any) { message = e.message; }
      expect(message).toContain("non-empty agent id");
      expect(message).toContain("internal");
      expect(message).toContain("UNFILTERED");
      expect(message).toContain("never from request data");
    });

    it("reports what it actually received, so the bug is findable", () => {
      const seen = (v: unknown) => { try { (agentContext as any)(v); return ""; } catch (e: any) { return e.message; } };
      expect(seen(undefined)).toContain("undefined");
      expect(seen(null)).toContain("null");
      expect(seen("")).toContain("an empty string");
      expect(seen("   ")).toContain("a blank string");
      expect(seen(42)).toContain("a number");
    });
  });
});

describe("adminContext", () => {
  it("is the only way to ask for admin, and says so by name", () => {
    expect(adminContext("provisioner")).toEqual({
      request: { tpsAgent: "provisioner", tpsAgentIsAdmin: true },
    });
  });

  it("applies the same id guard — admin by accident is still accident", () => {
    for (const [, value] of BAD_IDS) {
      expect(() => (adminContext as any)(value)).toThrow(InProcessContextError);
    }
  });
});

describe("internalContext", () => {
  it("carries NO identity annotation — that absence IS the internal verdict", () => {
    const ctx = internalContext();
    expect(ctx.request).toEqual({});
    expect("tpsAgent" in ctx.request).toBe(false);
  });

  it("is a distinct, greppable name rather than an omitted argument", () => {
    // The whole point: reaching the unfiltered verdict requires typing
    // something that looks like what it is.
    expect(typeof internalContext).toBe("function");
    expect(internalContext.length).toBe(0);
  });
});

describe("collectionResource", () => {
  it("returns an instance Harper accepts a create on", async () => {
    const h = await collectionResource<HarperShaped>(HarperShaped, agentContext("planner"));
    expect(h.isCollection).toBe(true);
    expect(h.post({ content: "x" })).toEqual({ id: "generated", written: true });
  });

  it("threads the caller's context through to the instance", async () => {
    const ctx = agentContext("researcher");
    const h = await collectionResource<HarperShaped>(HarperShaped, ctx);
    expect(h.context).toBe(ctx);
  });

  it("works with the explicitly-privileged contexts too", async () => {
    for (const ctx of [adminContext("provisioner"), internalContext()]) {
      const h = await collectionResource<HarperShaped>(HarperShaped, ctx);
      expect(h.isCollection).toBe(true);
    }
  });

  describe("refuses to grant `internal` by omission", () => {
    const OMITTED: [string, unknown][] = [["nothing", undefined], ["null", null], ["a string", "planner"]];
    for (const [label, value] of OMITTED) {
      it(`throws when the context is ${label}`, async () => {
        await expect(collectionResource(HarperShaped, value as any)).rejects.toThrow(InProcessContextError);
      });
    }

    it("explains that omitting it would have been the privileged path", async () => {
      let message = "";
      try { await collectionResource(HarperShaped, undefined as any); } catch (e: any) { message = e.message; }
      expect(message).toContain("explicit context");
      expect(message).toContain("internal");
      expect(message).toContain("agentContext(id)");
    });
  });

  // ── The anti-pattern this module exists to replace ────────────────────────
  //
  // Before the seam, flair's MCP tool paths did `new Cls(undefined, ctx)` then
  // `(h as any).isCollection = true`. Both halves of why that is wrong are
  // pinned here, so reintroducing either fails a test instead of only failing
  // in production:

  it("MUTATION CHECK: assigning isCollection throws — it is a getter with no setter", () => {
    const h = new HarperShaped(undefined, agentContext("planner"));
    expect(() => { (h as any).isCollection = true; }).toThrow(TypeError);
  });

  it("MUTATION CHECK: a plain `new Cls(...)` instance refuses post()", () => {
    const h = new HarperShaped(undefined, agentContext("planner"));
    expect(h.isCollection).toBe(false);
    expect(() => h.post({ content: "x" })).toThrow(/does not have a post method implemented/);
  });

  it("MUTATION CHECK: defineProperty on the instance does NOT satisfy Harper (private field)", () => {
    const h = new HarperShaped(undefined, agentContext("planner"));
    Object.defineProperty(h, "isCollection", { value: true, configurable: true });
    expect(() => h.post({ content: "x" })).toThrow(/does not have a post method implemented/);
  });
});
