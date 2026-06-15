import { mock, describe, it, expect } from "bun:test";

// agent-auth.ts imports `databases` from @harperfast/harper, whose module chain
// throws when loaded outside a Harper runtime. Mock it — resolveAgentAuth's
// internal/anonymous paths never touch databases (they return before Agent.get).
mock.module("@harperfast/harper", () => ({ databases: {} }));

const { resolveAgentAuth } = await import("../../resources/agent-auth.ts");

// The internal-vs-anonymous distinction is the security-critical part: a missing
// request = trusted in-process call; a request with no valid agent = anonymous
// HTTP caller that MUST be denied. (The "agent" verdict needs a real Agent record
// + signature, covered in the integration harness.)

function reqWithAuth(header: string) {
  return { headers: { get: (n: string) => (n === "authorization" ? header : undefined) } };
}

describe("resolveAgentAuth — internal vs anonymous", () => {
  it("no request context → internal (trusted in-process call)", async () => {
    expect(await resolveAgentAuth(undefined)).toEqual({ kind: "internal" });
    expect(await resolveAgentAuth(null)).toEqual({ kind: "internal" });
  });

  it("request with NO Authorization header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth(""))).toEqual({ kind: "anonymous" });
  });

  it("request with a non-TPS scheme → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth("Basic dXNlcjpwYXNz"))).toEqual({ kind: "anonymous" });
  });

  it("request with a malformed TPS-Ed25519 header → anonymous (deny)", async () => {
    expect(await resolveAgentAuth(reqWithAuth("TPS-Ed25519 garbage-no-colons"))).toEqual({ kind: "anonymous" });
  });
});
