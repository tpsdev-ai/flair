/**
 * agent-id-rule-resource-2359.test.ts — flair#2359.
 *
 * The Agent resource's REST write paths (POST, PUT, PATCH) must apply the ONE
 * shared agent-ID rule before anything is stored, exactly as AgentSeed does.
 * Before this fix none of the three checked the id: a collection POST, a PUT to
 * a new id and a PATCH to a new id each stored whatever id the caller sent.
 *
 * Same mocking technique as test/unit/agent-originator-instance.test.ts: mock
 * harper so resources/Agent.ts loads outside a real Harper runtime. Isolated so
 * it owns its `harper` mock with no collision with the unit lane's process.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

let agentStore: Map<string, any>;
let instanceRow: any = null;

class BaseAgent {
  async post(content: any) {
    const id = content.id ?? `agent-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    const rec = { ...content };
    agentStore.set(id, rec);
    return rec;
  }
  getId() { return (this as any)._targetId; }
  async put(content: any) {
    const id = this.getId() ?? content.id;
    const rec = { ...content, id };
    agentStore.set(id, rec);
    return rec;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return agentStore.get(id) ?? null;
  }
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(agentStore.get(id) ?? {}), ...content };
    agentStore.set(id, merged);
    return { ...merged };
  }
  static async get(id: any) {
    return agentStore.get(id) ?? null;
  }
}

const databasesMock = {
  flair: {
    Agent: BaseAgent,
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: databasesMock, Resource: class {} }));

const { Agent } = await import("../../resources/Agent.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makeAgent(ctxRequest: any) {
  const a: any = new (Agent as any)();
  a.getContext = () => ({ request: ctxRequest });
  return a;
}
const adminCtx = { tpsAgent: "agent-admin", tpsAgentIsAdmin: true };

/** The agent-ID rule the fix enforces. */
const OUT_OF_RULE = "bad.id"; // a dot is not in [A-Za-z0-9_-]

beforeEach(() => {
  agentStore = new Map();
  instanceRow = { id: "flair_local_test" };
  _resetLocalInstanceIdCacheForTests();
});

describe("flair#2359 — Agent collection POST refuses an id outside the shared rule, storing nothing", () => {
  it("POST with an out-of-rule body id: 400 with the named error and no row written", async () => {
    const a = makeAgent(adminCtx);
    const res: any = await a.post({ id: OUT_OF_RULE, name: "Bad" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_agent_id");
    expect(agentStore.size).toBe(0);
  });

  it("POST with an over-long id (65 chars) is refused too", async () => {
    const a = makeAgent(adminCtx);
    const res: any = await a.post({ id: "a".repeat(65), name: "TooLong" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect(agentStore.size).toBe(0);
  });

  it("POST with a conforming id still creates the row (the guard is not over-broad)", async () => {
    const a = makeAgent(adminCtx);
    const res: any = await a.post({ id: "good_id-1", name: "Good" });
    expect(res instanceof Response).toBe(false);
    expect(agentStore.get("good_id-1")).toBeDefined();
  });
});

describe("flair#2359 — Agent PUT refuses an id outside the shared rule, storing nothing", () => {
  it("PUT to a NEW id outside the rule: 400 named error, no row", async () => {
    const a: any = makeAgent(adminCtx);
    a._targetId = OUT_OF_RULE;
    const res: any = await a.put({ name: "Bad" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_agent_id");
    expect(agentStore.size).toBe(0);
  });

  it("PUT with only a body id outside the rule (in-process): 400, no row", async () => {
    const a: any = makeAgent(adminCtx);
    const res: any = await a.put({ id: OUT_OF_RULE, name: "Bad" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect(agentStore.size).toBe(0);
  });
});

describe("flair#2359 — Agent PATCH refuses an id outside the shared rule, storing nothing", () => {
  it("PATCH whose URL target has no stored row and is out of rule: 400 named error, no row", async () => {
    const a: any = makeAgent(adminCtx);
    a._targetId = OUT_OF_RULE;
    const res: any = await a.patch({ displayName: "Bad" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_agent_id");
    expect(agentStore.size).toBe(0);
  });
});
