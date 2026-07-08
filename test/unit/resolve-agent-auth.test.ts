import { mock, describe, it, expect } from "bun:test";

// agent-auth.ts imports `databases` from @harperfast/harper, whose module chain
// throws when loaded outside a Harper runtime. Mock it. Provide a thin
// flair.Agent so the verifyAgentRequest fallback (reached by a well-formed
// TPS-Ed25519 header with no forged user) looks up an unknown agent and returns
// null WITHOUT throwing — proving the header ROUTED into verifyAgentRequest.
// (The positive path — a VALID signature resolving to `agent` — is covered end-
// to-end against real Harper in test/integration/oauth-authorize-authz.test.ts;
// reproducing it here would depend on which sibling file's @harperfast/harper
// mock wins bun's process-global module registry, so it's deliberately left to
// the integration harness.)
mock.module("@harperfast/harper", () => ({
  databases: { flair: { Agent: { get: async () => null, search: async function* () {} } } },
  Resource: class {},
}));

const { resolveAgentAuth, hasCredentialEvidence } = await import("../../resources/agent-auth.ts");

// ─── Request-shape helpers ────────────────────────────────────────────────────

// A request whose Authorization header is exposed via the Web Headers `.get()`
// shape (GET/search). `header === undefined` = header absent.
function getShape(header?: string): any {
  return { headers: { get: (n: string) => (n === "authorization" ? header : undefined) }, url: "/x", method: "GET" };
}
// A request whose Authorization header is exposed via the `.asObject` bag
// (PUT/POST). Omitting the key = header absent.
function asObjectShape(header?: string): any {
  const asObject: Record<string, string> = {};
  if (header !== undefined) asObject.authorization = header;
  return { headers: { asObject }, url: "/x", method: "POST" };
}

const BASIC = "Basic dXNlcjpwYXNz";
const superUser = { username: "admin", role: { permission: { super_user: true } } };
const superUserNamed = (username: string) => ({ username, role: { permission: { super_user: true } } });
const perAgentUser = { username: "agent-3", role: { permission: {} } };

// ─── internal vs anonymous (unchanged core distinction) ───────────────────────

describe("resolveAgentAuth — internal vs anonymous", () => {
  it("no request context → internal (trusted in-process call)", async () => {
    expect(await resolveAgentAuth(undefined)).toEqual({ kind: "internal" });
    expect(await resolveAgentAuth(null)).toEqual({ kind: "internal" });
  });

  it("request with NO Authorization header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(getShape())).toEqual({ kind: "anonymous" });
  });

  it("request with a non-TPS scheme + no user → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(getShape(BASIC))).toEqual({ kind: "anonymous" });
  });

  it("request with a malformed TPS-Ed25519 header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(getShape("TPS-Ed25519 garbage-no-colons"))).toEqual({ kind: "anonymous" });
  });

  it("well-formed TPS-Ed25519 header for an unknown agent → anonymous, proving it ROUTED into verifyAgentRequest (not short-circuited)", async () => {
    // No forged user present; the credential-evidence gate must NOT block the
    // Ed25519 path — it has to reach verifyAgentRequest, which returns null for
    // an unknown agent → anonymous. A short-circuit would instead have hit the
    // final `internal` return (impossible here: headers ARE present).
    const ts = Date.now();
    const header = `TPS-Ed25519 unknown-agent:${ts}:nonce-abc:c2ln`;
    expect(await resolveAgentAuth(getShape(header))).toEqual({ kind: "anonymous" });
  });
});

// ─── gate annotations (unchanged) ─────────────────────────────────────────────

describe("resolveAgentAuth — gate annotations (handler phase)", () => {
  it("gate tpsAgent annotation → agent (no header re-verify needed)", async () => {
    expect(await resolveAgentAuth({ tpsAgent: "agent-1", tpsAgentIsAdmin: false }))
      .toEqual({ kind: "agent", agentId: "agent-1", isAdmin: false });
    expect(await resolveAgentAuth({ tpsAgent: "admin-1", tpsAgentIsAdmin: true }))
      .toEqual({ kind: "agent", agentId: "admin-1", isAdmin: true });
  });

  it("annotation reachable via context.request (the ctx.request ?? ctx fallback)", async () => {
    expect(await resolveAgentAuth({ request: { tpsAgent: "agent-2", tpsAgentIsAdmin: false } }))
      .toEqual({ kind: "agent", agentId: "agent-2", isAdmin: false });
  });

  it("explicit tpsAnonymous marker → anonymous (set by the non-rejecting gate)", async () => {
    expect(await resolveAgentAuth({ tpsAnonymous: true })).toEqual({ kind: "anonymous" });
  });
});

// ─── flair#610: context.user is trusted ONLY with credential evidence ─────────

describe("resolveAgentAuth — context.user credential-evidence gate (flair#610)", () => {
  it("super_user context.user WITH a Basic Authorization header (.get shape) → admin agent", async () => {
    const v = await resolveAgentAuth({ user: superUser, ...getShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "admin", isAdmin: true });
  });

  it("super_user context.user WITH a Basic Authorization header (.asObject shape) → admin agent", async () => {
    const v = await resolveAgentAuth({ user: superUser, ...asObjectShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "admin", isAdmin: true });
  });

  it("super_user reachable via context.request wrapper (with header) → admin agent", async () => {
    const v = await resolveAgentAuth({ request: { user: superUserNamed("nathan"), ...getShape(BASIC) } });
    expect(v).toEqual({ kind: "agent", agentId: "nathan", isAdmin: true });
  });

  it("FORGED super_user context.user with NO Authorization header (.get shape) → anonymous — the authorizeLocal forgery is rejected", async () => {
    const v = await resolveAgentAuth({ user: superUser, ...getShape(/* absent */) });
    expect(v).toEqual({ kind: "anonymous" });
  });

  it("FORGED super_user context.user with NO Authorization header (.asObject shape) → anonymous", async () => {
    const v = await resolveAgentAuth({ user: superUser, ...asObjectShape(/* absent */) });
    expect(v).toEqual({ kind: "anonymous" });
  });

  it("per-agent (de-elevated) username WITH a Basic Authorization header → non-admin agent", async () => {
    const v = await resolveAgentAuth({ user: perAgentUser, ...getShape(BASIC) });
    expect(v).toEqual({ kind: "agent", agentId: "agent-3", isAdmin: false });
  });

  it("FORGED per-agent username with NO Authorization header → anonymous (identity claim without a credential is not trusted)", async () => {
    const v = await resolveAgentAuth({ user: perAgentUser, ...getShape(/* absent */) });
    expect(v).toEqual({ kind: "anonymous" });
  });

  it("shared flair-agent user with no other signal → internal (not mistaken for an agent)", async () => {
    expect(await resolveAgentAuth({ user: { username: "flair-agent", role: { permission: {} } } }))
      .toEqual({ kind: "internal" });
  });

  it("a bare context.user with NO request/headers object at all → internal (an in-process shape, never a loopback HTTP forgery, which always carries a headers object)", async () => {
    // Documents the fall-through: a genuinely request-less call that merely
    // carries a user object is a trusted in-process caller. A forged loopback
    // request is distinguishable because it ALWAYS has a headers object (tested
    // above → anonymous), so this internal path is unreachable by an attacker.
    expect(await resolveAgentAuth({ user: superUser })).toEqual({ kind: "internal" });
  });
});

// ─── hasCredentialEvidence — direct coverage of every shape ───────────────────

describe("hasCredentialEvidence — recognizes every credential-bearing header shape", () => {
  it("Basic on the .get() shape → true", () => {
    expect(hasCredentialEvidence(getShape("Basic abc"))).toBe(true);
  });
  it("Bearer on the .get() shape → true", () => {
    expect(hasCredentialEvidence(getShape("Bearer tok"))).toBe(true);
  });
  it("TPS-Ed25519 on the .get() shape → true (custom scheme still rides Authorization)", () => {
    expect(hasCredentialEvidence(getShape("TPS-Ed25519 a:1:b:c"))).toBe(true);
  });
  it("TPS-Ed25519 on the .asObject shape → true", () => {
    expect(hasCredentialEvidence(asObjectShape("TPS-Ed25519 a:1:b:c"))).toBe(true);
  });
  it("Basic on the .asObject shape → true", () => {
    expect(hasCredentialEvidence(asObjectShape("Basic abc"))).toBe(true);
  });
  it("absent Authorization (.get returns undefined) → false", () => {
    expect(hasCredentialEvidence(getShape())).toBe(false);
  });
  it("empty-string Authorization → false", () => {
    expect(hasCredentialEvidence(getShape(""))).toBe(false);
  });
  it("absent Authorization (.asObject has no key) → false", () => {
    expect(hasCredentialEvidence(asObjectShape())).toBe(false);
  });
  it("no headers object at all → false", () => {
    expect(hasCredentialEvidence({ user: superUser })).toBe(false);
    expect(hasCredentialEvidence(undefined)).toBe(false);
    expect(hasCredentialEvidence(null)).toBe(false);
  });
  it("header carried on context.request (GET/search context shape) → true", () => {
    expect(hasCredentialEvidence({ request: getShape("Basic abc") })).toBe(true);
  });
  it("header carried on the context object itself (PUT/POST context shape) → true", () => {
    expect(hasCredentialEvidence(asObjectShape("Basic abc"))).toBe(true);
  });
});
