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
  // Real Harper binds the resource to the URL target (`getId()`); a PUT writes
  // to THAT id and rewrites the record's primary key to it. `_targetId` models
  // the URL-bound target on the instance (unset for a direct in-process call,
  // where the body id IS the write key). See resources/originator-instance.ts.
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

// ─── flair#1965 round 2 — URL-target resolution + PATCH-create stamping ──────
// Blocker 2: the stored-row lookup must use the URL-BOUND target id, never a
// body `id` (Harper writes to the URL target and rewrites the row's primary key
// to it), and a mismatch or a failed read must REFUSE the write — never fall
// back to "create". Blocker 3: Harper's patch path has no existing-row
// requirement, so a PATCH that creates a row must stamp the local id.
describe("flair#1965 r2 — Agent PUT resolves the URL-bound target; PATCH creates are stamped", () => {
  it("REFUSES a PUT whose body id differs from the URL target id (a body id is not the row this write lands on)", async () => {
    instanceRow = { id: "flair_local_test" };
    agentStore.set("agent-real", { id: "agent-real", name: "Real", originatorInstanceId: "instance-B" });
    const a: any = makeAgent(agentCtx("agent-admin", true));
    a._targetId = "agent-real";
    const res: any = await a.put({ id: "agent-decoy", name: "Decoy", originatorInstanceId: "instance-attacker" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(400);
    expect(agentStore.get("agent-decoy")).toBeUndefined(); // nothing landed on the body id
    expect(agentStore.get("agent-real").originatorInstanceId).toBe("instance-B"); // the target row is untouched
  });

  it("a PUT whose body OMITS `id` updates the URL-bound target row, keeping its stored value (never keyed on a body id)", async () => {
    instanceRow = { id: "flair_local_test" };
    agentStore.set("agent-target", { id: "agent-target", name: "Target", originatorInstanceId: "instance-B" });
    const a: any = makeAgent(agentCtx("agent-admin", true));
    a._targetId = "agent-target";
    const res: any = await a.put({ name: "Target Updated" });
    expect(res instanceof Response).toBe(false);
    expect(agentStore.get("agent-target").name).toBe("Target Updated");
    expect(agentStore.get("agent-target").originatorInstanceId).toBe("instance-B");
  });

  it("PATCH that CREATES a row (URL target has no stored row) stamps the local instance id", async () => {
    instanceRow = { id: "flair_local_test" };
    const a: any = makeAgent(agentCtx("agent-admin", true));
    a._targetId = "agent-patch-new";
    await a.patch({ displayName: "Brand New via PATCH" });
    expect(agentStore.get("agent-patch-new").originatorInstanceId).toBe("flair_local_test");
  });

  it("a stored-row read FAILURE refuses the write (never read as 'create')", async () => {
    instanceRow = { id: "flair_local_test" };
    const original = (BaseAgent as any).get;
    try {
      (BaseAgent as any).get = async () => { throw new Error("reader down"); };
      const a: any = makeAgent(agentCtx("agent-admin", true));
      const res: any = await a.put({ id: "agent-readfail", name: "X" });
      expect(res instanceof Response).toBe(true);
      expect(res.status).toBe(500);
      expect(agentStore.get("agent-readfail")).toBeUndefined(); // nothing written
    } finally {
      (BaseAgent as any).get = original;
    }
  });
});
