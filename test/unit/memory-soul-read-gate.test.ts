/**
 * memory-soul-read-gate.test.ts — regression guard for the P0 read-gate fix
 * on resources/Soul.ts (Soul.allowRead).
 *
 * The bug: Soul.ts gated the WRITE paths (post/put via enforceWriteAuth) but
 * never defined `allowRead()`. Harper routes `GET /Soul/<id>` to get() and
 * the collection-describe `GET /Soul` outside search()/allow*, so both were
 * ungated — an anonymous caller got a 200 with full soul content.
 *
 * The fix adds ONLY `allowRead()` to Soul (no get() override / per-agent
 * scoping): souls are identity/discovery data, intentionally readable by any
 * verified agent — same posture as Agent.ts's allowRead.
 *
 * The companion Memory.ts read-gate tests (allowRead, get() ownership/grant
 * scoping, search() parity, delete() regression-guard) live in
 * test/unit/memory-integrity.test.ts instead of here — bun runs every file
 * in test/unit/ in ONE process, and that file already `mock.module`s
 * "harper" and dynamically imports "../../resources/Memory.ts".
 * A second file doing the same thing collides: Memory's `class Memory
 * extends (databases as any).flair.Memory` superclass reference is captured
 * ONCE, at whichever file's import wins the race, so a second competing
 * mock+import silently makes BOTH files' Memory instances write into only
 * ONE file's in-memory store. This file avoids that entirely by never
 * importing resources/Memory.ts — only resources/Soul.ts, which has no other
 * importer in test/unit/.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// ─── In-memory Harper Soul mock ─────────────────────────────────────────────

let soulStore: Map<string, any>;
// federation-edge-hardening slice 1: resources/instance-identity.ts's
// localInstanceId() reads this via databases.flair.Instance.search().
let instanceRow: any = null;

class BaseSoul {
  async post(content: any) {
    const id = content.id ?? `soul-${Math.random().toString(36).slice(2)}`;
    content.id = id;
    const rec = { ...content };
    soulStore.set(id, rec);
    return rec;
  }
  async put(content: any) {
    const rec = { ...content };
    soulStore.set(content.id, rec);
    return rec;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return soulStore.get(id) ?? null;
  }
  // Real Harper PATCH merges the body into the stored row; the id comes from the
  // URL, which the double models as an explicit `_targetId` on the instance.
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(soulStore.get(id) ?? {}), ...content };
    soulStore.set(id, merged);
    return { ...merged };
  }
  // Real Harper's table is statically callable (`databases.flair.Soul.get(id)`),
  // which is how resources/originator-instance.ts's resolveStoredRow reads the
  // pre-existing row for the create/update decision.
  static async get(id: any) {
    return soulStore.get(id) ?? null;
  }
  search() {
    async function* gen() {
      for (const r of soulStore.values()) yield r;
    }
    return gen();
  }
}

const databasesMock = {
  flair: {
    Soul: BaseSoul,
    MemoryCandidate: { search: () => (async function* () {})() },
    Memory: { search: () => (async function* () {})() },
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

const { Soul } = await import("../../resources/Soul.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makeSoul(ctxRequest: any) {
  const r: any = new (Soul as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  soulStore = new Map();
  instanceRow = null;
  _resetLocalInstanceIdCacheForTests();
});

// ─── Soul.allowRead — anonymous denied, any verified agent allowed (no per-agent scoping) ──
describe("Soul.allowRead — closes the anonymous GET /Soul/<id> and describe leak", () => {
  it("anonymous is denied", async () => {
    const s = makeSoul(anonCtx());
    expect(await s.allowRead()).toBe(false);
  });

  it("a verified non-admin agent is allowed — souls are identity/discovery data, no per-record scoping", async () => {
    const s = makeSoul(agentCtx("agent-1"));
    expect(await s.allowRead()).toBe(true);
  });

  it("a verified agent may read ANOTHER agent's soul (intentional — same posture as Agent.ts)", async () => {
    soulStore.set("soul-other", { id: "soul-other", agentId: "agent-other", identity: "public identity data" });
    const s = makeSoul(agentCtx("agent-1"));
    // Soul has no get() override — allowRead is the only gate, and it's
    // granted to any verified agent. Exercise the inherited get() directly.
    const res = await s.get("soul-other");
    expect(res).not.toBeNull();
    expect((res as any).identity).toBe("public identity data");
  });

  it("an admin agent is allowed", async () => {
    const s = makeSoul(agentCtx("agent-admin", true));
    expect(await s.allowRead()).toBe(true);
  });

  it("an internal call (no request context) is allowed", async () => {
    const r: any = new (Soul as any)();
    r.getContext = () => undefined;
    expect(await r.allowRead()).toBe(true);
  });
});

// ─── Soul write gates — unchanged by the allowRead addition ─────────────────
describe("Soul write gates — unaffected by the read-gate fix", () => {
  it("anonymous post is still denied (401)", async () => {
    const s = makeSoul(anonCtx());
    const res = await s.post({ agentId: "agent-1", identity: "x" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("a non-admin agent still cannot write a soul owned by another agent (403)", async () => {
    const s = makeSoul(agentCtx("agent-attacker"));
    const res = await s.post({ agentId: "agent-owner", identity: "hijacked" });
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("an agent runtime cannot write even its own soul", async () => {
    const res = await makeSoul(agentCtx("agent-1")).post({ agentId: "agent-1", value: "my identity" });
    expect(res.status).toBe(403);
  });
});

// ─── federation-edge-hardening slice 1 / flair#1965: originatorInstanceId stamp ──
// See resources/originator-instance.ts for the full contract. originatorInstanceId
// is server-stamped and NEVER client-writable: a body value on create is replaced
// by the local id; on update the stored value stands. Soul.ts stamps on post()
// (create) and put() (create or update).
describe("federation-edge-hardening slice 1 / flair#1965 — Soul originatorInstanceId is server-stamped", () => {
  const owner = () => ({ tpsAgent: "operator", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic verified" }) });

  it("CREATE (post) stamps the local instance id on a fresh local write", async () => {
    instanceRow = { id: "flair_local_test" };
    const res: any = await makeSoul(owner()).post({ agentId: "agent-1", key: "identity", value: "my soul" });
    expect(res.originatorInstanceId).toBe("flair_local_test");
  });

  it("CREATE (post) IGNORES a request-body originatorInstanceId and stamps the local id", async () => {
    instanceRow = { id: "flair_local_test" };
    const res: any = await makeSoul(owner()).post({
      agentId: "agent-1",
      key: "identity",
      value: "body claims instance B",
      originatorInstanceId: "instance-B",
    });
    expect(res.originatorInstanceId).toBe("flair_local_test");
    expect(res.originatorInstanceId).not.toBe("instance-B");
  });

  it("stamps null when this instance has no Instance row yet — never invents one", async () => {
    instanceRow = null;
    const res: any = await makeSoul(owner()).post({ agentId: "agent-1", key: "identity", value: "my soul" });
    expect(res.originatorInstanceId).toBeNull();
  });

  it("CREATE (put, no stored row) stamps the local id and ignores a body value", async () => {
    instanceRow = { id: "flair_local_test" };
    const res: any = await makeSoul(owner()).put({
      id: "soul-1", agentId: "agent-1", key: "identity", value: "fresh put", originatorInstanceId: "instance-B",
    });
    expect(res.originatorInstanceId).toBe("flair_local_test");
  });

  it("UPDATE (put) with a body value LEAVES the stored value — a client cannot change it", async () => {
    instanceRow = { id: "flair_local_test" };
    soulStore.set("soul-2", { id: "soul-2", agentId: "agent-1", key: "identity", value: "authored on B", originatorInstanceId: "instance-B" });
    const res: any = await makeSoul(owner()).put({
      id: "soul-2", agentId: "agent-1", key: "identity", value: "edit", originatorInstanceId: "instance-attacker",
    });
    expect(res.originatorInstanceId).toBe("instance-B");
    expect(res.originatorInstanceId).not.toBe("instance-attacker");
  });

  it("UPDATE (put) that OMITS the field leaves the stored value", async () => {
    instanceRow = { id: "flair_local_test" };
    soulStore.set("soul-3", { id: "soul-3", agentId: "agent-1", key: "identity", value: "authored on B", originatorInstanceId: "instance-B" });
    const res: any = await makeSoul(owner()).put({ id: "soul-3", agentId: "agent-1", key: "identity", value: "edit" });
    expect(res.originatorInstanceId).toBe("instance-B");
  });

  it("PATCH cannot set or clear originatorInstanceId — the stored value stands", async () => {
    instanceRow = { id: "flair_local_test" };
    soulStore.set("soul-patch", { id: "soul-patch", agentId: "agent-1", key: "identity", value: "authored on B", originatorInstanceId: "instance-B" });
    const s: any = makeSoul(owner());
    s._targetId = "soul-patch";
    await s.patch({ originatorInstanceId: "instance-attacker" });
    expect(soulStore.get("soul-patch").originatorInstanceId).toBe("instance-B");
  });
});
