/**
 * agent-originator-instance.test.ts — federation-edge-hardening slice 1:
 * write-time originatorInstanceId stamp on resources/Agent.ts.
 *
 * See resources/Memory.ts's stampOriginatorInstanceId doc for the full
 * contract (write-time, cached local instance id via resources/instance-
 * identity.ts's localInstanceId(), anti-clobber for federation-synced
 * records). Agent.ts stamps in both post() and put().
 *
 * Same mocking technique as memory-integrity.test.ts / relationship-read-
 * gate.test.ts: mock harper so the resource class loads outside
 * a real Harper runtime. No other test/unit/ file imports resources/Agent.ts,
 * so this file owns that mock+import with no collision risk (bun runs
 * test/unit/ in one process and dynamic imports are cached by resolved path).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

let agentStore: Map<string, any>;
// resources/instance-identity.ts's localInstanceId() reads this via
// databases.flair.Instance.search().
let instanceRow: any = null;

class BaseAgent {
  async post(content: any) {
    const id = content.id ?? `agent-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    const rec = { ...content };
    agentStore.set(id, rec);
    return rec;
  }
  async put(content: any) {
    const rec = { ...content };
    agentStore.set(content.id, rec);
    return rec;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return agentStore.get(id) ?? null;
  }
  // Real Harper PATCH merges the body into the stored row; the id comes from the
  // URL, which the double models as an explicit `_targetId` on the instance.
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(agentStore.get(id) ?? {}), ...content };
    agentStore.set(id, merged);
    return { ...merged };
  }
  // Real Harper's table is statically callable (`databases.flair.Agent.get(id)`),
  // which is how resources/originator-instance.ts's resolveStoredRow reads the
  // pre-existing row for the create/update decision.
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
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

beforeEach(() => {
  agentStore = new Map();
  instanceRow = null;
  _resetLocalInstanceIdCacheForTests();
});

describe("federation-edge-hardening slice 1 / flair#1965 — Agent.post() stamps a server-set originatorInstanceId", () => {
  it("stamps the local instance id on a fresh local write", async () => {
    instanceRow = { id: "flair_local_test" };
    const a = makeAgent(agentCtx("agent-admin", true));
    const res: any = await a.post({ name: "New Principal" }, undefined);
    expect(res.originatorInstanceId).toBe("flair_local_test");
  });

  it("IGNORES a request-body originatorInstanceId and stamps the local id — a client can never set it on create", async () => {
    instanceRow = { id: "flair_local_test" };
    const a = makeAgent(agentCtx("agent-admin", true));
    const res: any = await a.post({ name: "Synced Principal", originatorInstanceId: "instance-B" }, undefined);
    expect(res.originatorInstanceId).toBe("flair_local_test");
    expect(res.originatorInstanceId).not.toBe("instance-B");
  });

  it("stamps null when this instance has no Instance row yet — never invents one", async () => {
    instanceRow = null;
    const a = makeAgent(agentCtx("agent-admin", true));
    const res: any = await a.post({ name: "New Principal" }, undefined);
    expect(res.originatorInstanceId).toBeNull();
  });
});

describe("federation-edge-hardening slice 1 / flair#1965 — Agent.put() create vs update", () => {
  it("CREATE (put, no stored row) stamps the local id and ignores a body value", async () => {
    instanceRow = { id: "flair_local_test" };
    const a = makeAgent(agentCtx("agent-1"));
    const res: any = await a.put({ id: "agent-new", name: "Fresh Principal", originatorInstanceId: "instance-B" });
    expect(res.originatorInstanceId).toBe("flair_local_test");
    expect(res.originatorInstanceId).not.toBe("instance-B");
  });

  it("UPDATE (put) with a body value LEAVES the stored value — a client cannot change it", async () => {
    instanceRow = { id: "flair_local_test" };
    agentStore.set("agent-1", { id: "agent-1", name: "Agent One", originatorInstanceId: "instance-B" });
    const a = makeAgent(agentCtx("agent-1"));
    const res: any = await a.put({ id: "agent-1", name: "Agent One Updated", originatorInstanceId: "instance-attacker" });
    expect(res.originatorInstanceId).toBe("instance-B");
    expect(res.originatorInstanceId).not.toBe("instance-attacker");
  });

  it("UPDATE (put) that OMITS the field leaves the stored value", async () => {
    instanceRow = { id: "flair_local_test" };
    agentStore.set("agent-2", { id: "agent-2", name: "Agent Two", originatorInstanceId: "instance-B" });
    const a = makeAgent(agentCtx("agent-2"));
    const res: any = await a.put({ id: "agent-2", name: "Agent Two Updated" });
    expect(res.originatorInstanceId).toBe("instance-B");
  });

  it("PATCH cannot set or clear originatorInstanceId — the stored value stands", async () => {
    instanceRow = { id: "flair_local_test" };
    agentStore.set("agent-1", { id: "agent-1", name: "Agent One", originatorInstanceId: "instance-B" });
    const a: any = makeAgent(agentCtx("agent-1"));
    a._targetId = "agent-1";
    await a.patch({ originatorInstanceId: "instance-attacker" });
    expect(agentStore.get("agent-1").originatorInstanceId).toBe("instance-B");
  });
});

describe("federation-edge-hardening slice 1 — migration-equivalence (no-originatorInstanceId-field Agent rows)", () => {
  it("an existing/old Agent row with no originatorInstanceId field reads back fine", async () => {
    agentStore.set("legacy-agent", { id: "legacy-agent", name: "Legacy Principal" });
    const a = makeAgent(agentCtx("agent-admin", true));
    const res: any = await a.get("legacy-agent");
    expect(res.name).toBe("Legacy Principal");
    expect(res.originatorInstanceId).toBeUndefined();
  });
});
