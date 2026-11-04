import { beforeEach, describe, expect, mock, test } from "bun:test";

let reads = 0;
let authCalls = 0;
let verdict: any;

mock.module("harper", () => ({
  Resource: class {},
  databases: new Proxy({}, {
    get() {
      reads++;
      throw new Error("unexpected table access");
    },
  }),
}));
mock.module("../../resources/agent-auth.js", () => ({
  resolveAgentAuth: async () => {
    authCalls++;
    return verdict;
  },
}));

const { AgentKeyRegister } = await import("../../resources/AgentKeyRegister.ts");

beforeEach(() => {
  reads = 0;
  authCalls = 0;
  verdict = { kind: "agent", agentId: "admin", isAdmin: true };
});

async function post(authorization: string, shape: "get" | "asObject", anonymous: boolean) {
  const route = new AgentKeyRegister();
  (route as any).getContext = () => ({
    request: {
      headers: shape === "get"
        ? new Headers({ authorization })
        : { asObject: { authorization } },
      user: { username: "admin", role: { permission: { super_user: true } } },
      tpsAnonymous: anonymous,
      tpsAgent: "admin",
      tpsAgentIsAdmin: true,
    },
  });
  let bodyReads = 0;
  const body = new Proxy({}, {
    get() {
      bodyReads++;
      return undefined;
    },
  });
  const response = await route.post(body);
  return { response, bodyReads };
}

describe("AgentKeyRegister Authorization schemes", () => {
  for (const authorization of ["Bearer token", "Flair-Enroll token", "Digest token", "BasicExtra token", "TPS-Ed25519Extra token", ""]) {
    for (const shape of ["get", "asObject"] as const) {
      for (const anonymous of [false, true]) {
        test(`${authorization || "absent"}: 401 before auth resolution, body validation and table reads (${shape}, anonymous=${anonymous})`, async () => {
          const { response, bodyReads } = await post(authorization, shape, anonymous);
          expect(response.status).toBe(401);
          expect((await response.json()).error).toBe("authentication required");
          expect(authCalls).toBe(0);
          expect(bodyReads).toBe(0);
          expect(reads).toBe(0);
        });
      }
    }
  }

  for (const authorization of ["Basic credentials", "TPS-Ed25519 signature", "basic credentials", "tps-ed25519 signature"]) {
    test(`${authorization}: resolves admin auth before body validation`, async () => {
      const { response, bodyReads } = await post(authorization, "get", false);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("registration_request_invalid");
      expect(authCalls).toBe(1);
      expect(bodyReads).toBeGreaterThan(0);
      expect(reads).toBe(0);
    });

    test(`${authorization}: requires admin auth`, async () => {
      verdict = { kind: "agent", agentId: "member", isAdmin: false };
      const { response, bodyReads } = await post(authorization, "get", false);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("forbidden");
      expect(authCalls).toBe(1);
      expect(bodyReads).toBe(0);
      expect(reads).toBe(0);
    });
  }
});
