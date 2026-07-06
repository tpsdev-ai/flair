/**
 * a2a-auth.test.ts — covers the P0 fix (unauthenticated POST /a2a): A2AAdapter
 * POST /a2a was unauthenticated, allowing any caller to forge OrgEvents
 * impersonating any agent and read all Beads issues.
 *
 * The fix has two parts and both are unit-tested here:
 *
 * 1. `auth-middleware` allow-list narrowed to GET-only for /a2a and
 *    /A2AAdapter. POST falls through to TPS-Ed25519 / admin Basic
 *    enforcement. Verified by simulating the predicate.
 *
 * 2. `A2AAdapter.post()` defense-in-depth check: if request.tpsAgent is
 *    unset (no upstream auth) and not admin, reject with JSON-RPC -32001.
 *    For message/send, sender must match params.agentId unless admin.
 *
 * Note: these tests use the "simulator" pattern (a known P1 backlog item
 * to convert to real-module tests). They exercise the decision logic of
 * the two guards but do NOT exercise Harper's full request/auth pipeline.
 */
import { describe, expect, test } from "bun:test";

// ─── Allow-list narrowing (auth-middleware predicate) ─────────────────────

/**
 * Predicate copied from auth-middleware.ts line 121-150. Returns true
 * when the request bypasses auth and is forwarded to the handler.
 */
function shouldBypassAuth(method: string, pathname: string): boolean {
  const isA2APath = pathname === "/a2a" || pathname === "/A2AAdapter" || pathname.startsWith("/A2AAdapter/");
  return (
    pathname === "/health" ||
    pathname === "/Health" ||
    (method === "GET" && isA2APath) ||
    pathname === "/AgentCard" ||
    pathname.startsWith("/AgentCard/") ||
    pathname === "/FederationSync" ||
    pathname === "/FederationPair" ||
    pathname === "/OAuthRegister" ||
    pathname === "/OAuthAuthorize" ||
    pathname === "/OAuthToken" ||
    pathname === "/OAuthRevoke" ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/OAuthMetadata" ||
    pathname === "/ObservationCenter"
  );
}

describe("auth-middleware allow-list: A2A narrowed to GET-only", () => {
  test("GET /a2a bypasses (public agent card per A2A spec)", () => {
    expect(shouldBypassAuth("GET", "/a2a")).toBe(true);
  });
  test("GET /A2AAdapter bypasses", () => {
    expect(shouldBypassAuth("GET", "/A2AAdapter")).toBe(true);
  });
  test("GET /A2AAdapter/agent-x bypasses", () => {
    expect(shouldBypassAuth("GET", "/A2AAdapter/agent-x")).toBe(true);
  });
  test("POST /a2a does NOT bypass — requires auth", () => {
    expect(shouldBypassAuth("POST", "/a2a")).toBe(false);
  });
  test("POST /A2AAdapter does NOT bypass", () => {
    expect(shouldBypassAuth("POST", "/A2AAdapter")).toBe(false);
  });
  test("PUT /a2a does NOT bypass", () => {
    expect(shouldBypassAuth("PUT", "/a2a")).toBe(false);
  });
  test("DELETE /a2a does NOT bypass", () => {
    expect(shouldBypassAuth("DELETE", "/a2a")).toBe(false);
  });
  test("GET /AgentCard still bypasses (still public per A2A spec)", () => {
    expect(shouldBypassAuth("GET", "/AgentCard")).toBe(true);
  });
  test("GET /AgentCard/flint still bypasses (path prefix)", () => {
    expect(shouldBypassAuth("GET", "/AgentCard/flint")).toBe(true);
  });
});

// ─── A2AAdapter.post() guard logic ────────────────────────────────────────

/**
 * Reproduces the auth-decision logic at the top of A2AAdapter.post(),
 * plus the message/send sender-match check. Returns either:
 *   { rejected: true, code, detail }  — rejection
 *   { rejected: false, callerAgent, callerIsAdmin } — accepted
 */
type AuthCtx = { tpsAgent?: string; tpsAgentIsAdmin?: boolean };

function postAuthDecision(
  ctx: AuthCtx,
): { rejected: true; code: number; detail: string } | { rejected: false; callerAgent: string | undefined; callerIsAdmin: boolean } {
  const callerAgent: string | undefined = ctx?.tpsAgent;
  const callerIsAdmin: boolean = ctx?.tpsAgentIsAdmin === true;
  if (!callerAgent && !callerIsAdmin) {
    return { rejected: true, code: -32001, detail: "POST /a2a requires TPS-Ed25519 or admin Basic auth" };
  }
  return { rejected: false, callerAgent, callerIsAdmin };
}

function messageSendSenderCheck(
  callerAgent: string | undefined,
  callerIsAdmin: boolean,
  paramsAgentId: string,
): { rejected: true; code: number } | { rejected: false } {
  if (!callerIsAdmin && callerAgent !== paramsAgentId) {
    return { rejected: true, code: -32001 };
  }
  return { rejected: false };
}

describe("A2AAdapter.post() — auth decision", () => {
  test("anonymous request (no tpsAgent, not admin) rejected with -32001", () => {
    const decision = postAuthDecision({});
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.code).toBe(-32001);
      expect(decision.detail).toContain("TPS-Ed25519 or admin Basic");
    }
  });

  test("tpsAgent set: accepted as callerAgent", () => {
    const decision = postAuthDecision({ tpsAgent: "flint" });
    expect(decision.rejected).toBe(false);
    if (!decision.rejected) {
      expect(decision.callerAgent).toBe("flint");
      expect(decision.callerIsAdmin).toBe(false);
    }
  });

  test("admin Basic accepted even without tpsAgent", () => {
    const decision = postAuthDecision({ tpsAgentIsAdmin: true });
    expect(decision.rejected).toBe(false);
    if (!decision.rejected) {
      expect(decision.callerIsAdmin).toBe(true);
    }
  });

  test("tpsAgent + admin: accepted, both flags set", () => {
    const decision = postAuthDecision({ tpsAgent: "flint", tpsAgentIsAdmin: true });
    expect(decision.rejected).toBe(false);
    if (!decision.rejected) {
      expect(decision.callerAgent).toBe("flint");
      expect(decision.callerIsAdmin).toBe(true);
    }
  });
});

describe("A2AAdapter.post() — message/send sender-match", () => {
  test("caller flint cannot send AS pulse (no admin)", () => {
    const r = messageSendSenderCheck("flint", false, "pulse");
    expect(r.rejected).toBe(true);
    if (r.rejected) expect(r.code).toBe(-32001);
  });

  test("caller flint can send AS flint", () => {
    const r = messageSendSenderCheck("flint", false, "flint");
    expect(r.rejected).toBe(false);
  });

  test("admin can send AS any agent (operational override)", () => {
    const r = messageSendSenderCheck(undefined, true, "pulse");
    expect(r.rejected).toBe(false);
  });

  test("admin who also has tpsAgent can still send AS others", () => {
    const r = messageSendSenderCheck("admin-agent", true, "pulse");
    expect(r.rejected).toBe(false);
  });

  test("anon (no callerAgent, not admin) — would have been blocked by postAuthDecision; redundant check also blocks", () => {
    // This branch shouldn't be reachable in production (postAuthDecision
    // would have already rejected), but the sender-match is defensive.
    const r = messageSendSenderCheck(undefined, false, "flint");
    expect(r.rejected).toBe(true);
  });
});

// ─── message/send DIRECTED handoff routing (Rivet × krais collision fix) ──

/**
 * Reproduces the message/send routing decision from A2AAdapter.post()
 * (the "simulator" pattern this file already uses). Verifies the OrgEvent
 * that would be published: who it is attributed to (scope/authorId = sender)
 * and who receives it (targetIds = recipient). This is the core of the
 * directed-handoff fix found in the Rivet × krais collision dogfood: before
 * the fix, targetIds was [sender], so a message rivet→krais published an
 * event targeting rivet and krais never received it.
 *
 * `knownAgents` simulates Agent.get(): membership = exists.
 */
type RoutingResult =
  | { rejected: true; code: number; reason: string }
  | { rejected: false; orgEvent: { authorId: string; scope: string; targetIds: string[] } };

function messageSendRouting(
  callerAgent: string | undefined,
  callerIsAdmin: boolean,
  agentId: string, // SENDER
  toAgentId: string | undefined, // RECIPIENT (optional)
  knownAgents: Set<string>,
): RoutingResult {
  // 1. No-spoof guard (unchanged): you can only send AS yourself.
  if (!callerIsAdmin && callerAgent !== agentId) {
    return { rejected: true, code: -32001, reason: "Forbidden" };
  }
  // 2. Sender must exist.
  if (!knownAgents.has(agentId)) {
    return { rejected: true, code: -32004, reason: "Agent not found" };
  }
  // 3. Directed routing: recipient (if given) must exist and becomes the target.
  const recipient = (toAgentId ?? "").trim();
  let targetIds: string[];
  if (recipient) {
    if (!knownAgents.has(recipient)) {
      return { rejected: true, code: -32004, reason: "Recipient agent not found" };
    }
    targetIds = [recipient];
  } else {
    targetIds = [agentId]; // back-compat: legacy self-scoped broadcast
  }
  return { rejected: false, orgEvent: { authorId: agentId, scope: agentId, targetIds } };
}

/**
 * OrgEventCatchup.ts line 83 filter (copied): an event reaches `participant`
 * when targetIds is empty/null OR includes the participant. This is what
 * makes targetIds = [recipient] the correct routing for a directed handoff.
 */
function catchupReceives(participant: string, targetIds: string[] | null | undefined): boolean {
  return !targetIds || targetIds.length === 0 || targetIds.includes(participant);
}

describe("message/send — directed handoff routing (Rivet × krais collision fix)", () => {
  const agents = new Set(["rivet", "krais", "flint"]);

  test("(a) sender=rivet, toAgentId=krais → event scope=rivet, targetIds=[krais]; krais's catchup receives it", () => {
    const r = messageSendRouting("rivet", false, "rivet", "krais", agents);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.orgEvent.scope).toBe("rivet");
      expect(r.orgEvent.authorId).toBe("rivet");
      expect(r.orgEvent.targetIds).toEqual(["krais"]);
      // krais's OrgEventCatchup would return it; rivet's would NOT (the bug).
      expect(catchupReceives("krais", r.orgEvent.targetIds)).toBe(true);
      expect(catchupReceives("rivet", r.orgEvent.targetIds)).toBe(false);
    }
  });

  test("(b) no-spoof: caller rivet cannot send AS krais → Forbidden (-32001)", () => {
    const r = messageSendRouting("rivet", false, "krais", "flint", agents);
    expect(r.rejected).toBe(true);
    if (r.rejected) {
      expect(r.code).toBe(-32001);
      expect(r.reason).toBe("Forbidden");
    }
  });

  test("(c) unknown recipient → -32004 Recipient agent not found", () => {
    const r = messageSendRouting("rivet", false, "rivet", "nobody", agents);
    expect(r.rejected).toBe(true);
    if (r.rejected) {
      expect(r.code).toBe(-32004);
      expect(r.reason).toBe("Recipient agent not found");
    }
  });

  test("back-compat: toAgentId omitted → legacy self-scoped targetIds=[sender]", () => {
    const r = messageSendRouting("rivet", false, "rivet", undefined, agents);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.orgEvent.targetIds).toEqual(["rivet"]);
      expect(catchupReceives("rivet", r.orgEvent.targetIds)).toBe(true);
    }
  });

  test("back-compat: empty-string toAgentId is treated as omitted (self-scoped)", () => {
    const r = messageSendRouting("rivet", false, "rivet", "", agents);
    expect(r.rejected).toBe(false);
    if (!r.rejected) expect(r.orgEvent.targetIds).toEqual(["rivet"]);
  });

  test("admin may send AS another agent and direct to a recipient", () => {
    const r = messageSendRouting("admin-agent", true, "rivet", "krais", agents);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.orgEvent.scope).toBe("rivet");
      expect(r.orgEvent.targetIds).toEqual(["krais"]);
    }
  });

  test("unknown SENDER → -32004 Agent not found (sender existence still checked)", () => {
    const r = messageSendRouting("ghost", true, "ghost", "krais", agents);
    expect(r.rejected).toBe(true);
    if (r.rejected) {
      expect(r.code).toBe(-32004);
      expect(r.reason).toBe("Agent not found");
    }
  });
});

describe("OrgEventCatchup filter — directed routing reaches the recipient", () => {
  test("empty/null targetIds is a broadcast — everyone receives", () => {
    expect(catchupReceives("anyone", [])).toBe(true);
    expect(catchupReceives("anyone", null)).toBe(true);
    expect(catchupReceives("anyone", undefined)).toBe(true);
  });
  test("targetIds=[krais] reaches krais only", () => {
    expect(catchupReceives("krais", ["krais"])).toBe(true);
    expect(catchupReceives("rivet", ["krais"])).toBe(false);
  });
});
