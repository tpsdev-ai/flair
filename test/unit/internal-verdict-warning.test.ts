// internal-verdict-warning.test.ts — flair#936.
//
// A resource invoked with no caller context resolves to flair's trusted
// `internal` verdict: reads unfiltered across every agent, writes unattributed,
// and the admin-only gate refuses it (flair#2837). That is correct for flair's own maintenance
// work and, in an embedding application, a mistake that can keep unfiltered
// access on agent-facing paths — both spell it `new Memory()`, and neither
// produces an error. The resolver warns once per process.
//
// The verdict is deliberately UNCHANGED here; ~40 assertions across the suite
// pin it, and altering it is a breaking change to every internal call site.
// What changes is that it is no longer silent: a call that MEANS to take that
// authority carries the marker internalContext() sets, and an internal verdict
// reached without the marker warns at most once per process.
//
// ── Why this pins the PREDICATE and not the console output ──────────────────
// The warning is latched once per process. bun shares one module registry
// across the whole run, so whichever test file resolves a context-less call
// first consumes that latch — and every later assertion on "did it warn?" then
// passes for the wrong reason. An earlier draft of this file did exactly that:
// green on its own, red in the full suite. A test whose result depends on file
// ordering is not pinning anything, so the decision is exported and asserted
// directly.
import { mock, describe, it, expect } from "bun:test";

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: { flair: { Agent: { get: async () => null, search: async function* () {} } } },
  Resource: class {},
}));

const { resolveAgentAuth, isDeliberateInternalCall, INTERNAL_BY_OMISSION_WARNING } =
  await import("../../resources/agent-auth.ts");
import { internalContext, agentContext, adminContext } from "../../resources/in-process.ts";

describe("flair#936 — a deliberate elevated call is distinguishable from a forgotten one", () => {
  it("internalContext() is recognised as deliberate", () => {
    expect(isDeliberateInternalCall(internalContext())).toBe(true);
  });

  it("every way of ARRIVING at internal by accident is recognised as NOT deliberate", () => {
    // These are exactly the shapes that reach the `internal` verdict without
    // anyone having asked for it: no context at all, and a context carrying no
    // annotations, no user and no headers.
    for (const ctx of [undefined, null, {}, { request: {} }, { request: { tpsAgent: undefined } }]) {
      expect(isDeliberateInternalCall(ctx), `treated ${JSON.stringify(ctx) ?? String(ctx)} as deliberate`).toBe(false);
    }
  });

  it("the marker cannot be faked by a truthy value — only the exact boolean counts", () => {
    for (const v of ["true", 1, {}, [], "yes"] as any[]) {
      expect(isDeliberateInternalCall({ request: {}, __flairInternal: v })).toBe(false);
    }
  });

  it("scoped and admin contexts are not treated as deliberate-internal", () => {
    // They never reach the internal verdict at all, so they must not carry the
    // marker either — otherwise a future refactor could silence a real warning.
    expect(isDeliberateInternalCall(agentContext("planner"))).toBe(false);
    expect(isDeliberateInternalCall(adminContext("root"))).toBe(false);
  });

  it("the advisory names the hazard AND the remedy", () => {
    // An error must enable a response: say what happened and what to do next.
    expect(INTERNAL_BY_OMISSION_WARNING).toContain("[flair-auth]");
    expect(INTERNAL_BY_OMISSION_WARNING).toContain("UNFILTERED");
    expect(INTERNAL_BY_OMISSION_WARNING).toContain("the admin-only gate (allowAdmin) refuses it");
    expect(INTERNAL_BY_OMISSION_WARNING).toContain("agentContext");
    expect(INTERNAL_BY_OMISSION_WARNING).toContain("internalContext");
  });
});

describe("flair#936 — the verdict itself is unchanged", () => {
  it("a context-less call still resolves to internal", async () => {
    expect(await resolveAgentAuth(undefined)).toEqual({ kind: "internal" });
    expect(await resolveAgentAuth(null)).toEqual({ kind: "internal" });
  });

  it("an annotation-free context object still resolves to internal", async () => {
    expect(await resolveAgentAuth({})).toEqual({ kind: "internal" });
    expect(await resolveAgentAuth({ request: {} })).toEqual({ kind: "internal" });
  });

  it("a deliberate internalContext() resolves to internal, same as before", async () => {
    expect(await resolveAgentAuth(internalContext())).toEqual({ kind: "internal" });
  });

  it("a scoped context is unaffected", async () => {
    expect(await resolveAgentAuth(agentContext("planner")))
      .toEqual({ kind: "agent", agentId: "planner", isAdmin: false });
  });
});
