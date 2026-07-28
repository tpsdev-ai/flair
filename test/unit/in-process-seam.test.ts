// resources/in-process.ts — the in-process call seam.
//
// The module under test has ZERO imports (deliberately — see its header), so
// this file needs no `mock.module("harper", …)` and is safe in test/unit/.
//
// What matters here is that `collectionResource()` produces an instance a REAL
// Harper `Resource` subclass would accept a `post()` on. Harper decides that
// from a PRIVATE field (`#isCollection`) that only its own `getResource()` can
// set; the public `isCollection` is a getter with no setter. `HarperShaped`
// below reproduces both facts exactly, so the assertions here fail for the same
// reason a real Harper would.
//
// The end-to-end proof against a real, two-component Harper is
// test/integration/in-process-agents.test.ts — this file pins the mechanism.
import { describe, it, expect } from "bun:test";
import { agentContext, collectionResource } from "../../resources/in-process.ts";

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

describe("agentContext", () => {
  it("carries the agent id the resolver reads, non-admin by default", () => {
    expect(agentContext("planner")).toEqual({ request: { tpsAgent: "planner", tpsAgentIsAdmin: false } });
  });

  it("isAdmin is opt-in and strictly boolean (a truthy non-true never elevates)", () => {
    expect(agentContext("p", { isAdmin: true }).request.tpsAgentIsAdmin).toBe(true);
    expect(agentContext("p", { isAdmin: false }).request.tpsAgentIsAdmin).toBe(false);
    expect(agentContext("p", {}).request.tpsAgentIsAdmin).toBe(false);
    expect(agentContext("p", { isAdmin: 1 as any }).request.tpsAgentIsAdmin).toBe(false);
    expect(agentContext("p", { isAdmin: "true" as any }).request.tpsAgentIsAdmin).toBe(false);
  });

  it("returns a fresh object per call (one agent's context can never be mutated into another's)", () => {
    const a = agentContext("a");
    const b = agentContext("b");
    a.request.tpsAgent = "mutated";
    expect(b.request.tpsAgent).toBe("b");
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

  it("with no context still binds the collection (flair's own maintenance paths)", async () => {
    const h = await collectionResource<HarperShaped>(HarperShaped);
    expect(h.isCollection).toBe(true);
    expect(h.context).toEqual({});
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
