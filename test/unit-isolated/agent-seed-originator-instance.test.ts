/**
 * agent-seed-originator-instance.test.ts — flair#1965 round 2.
 *
 * POST /AgentSeed creates Agent/Soul/Memory rows through the RAW table handles
 * (`(databases as any).flair.<Table>.put`), so the four resource classes' post()
 * stamps never run. Before this fix the seeded rows carried no
 * `originatorInstanceId` at all. This drives the REAL AgentSeed.post() against a
 * mocked harper and pins that EVERY row it creates is stamped with the local
 * instance id (or null when the instance has no Instance row).
 *
 * Isolated: owns the harper + collaborator mocks for AgentSeed.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

const LOCAL_ID = "flair_local_test";
let agentStore: Map<string, any>;
let soulStore: Map<string, any>;
let memStore: Map<string, any>;
let instanceRow: any = null;
// flair#1965 r3: simulate a FAILED existing-Agent lookup (the read throws) so a
// test can prove the seed is refused rather than overwriting the row as a
// create. Reset in beforeEach.
let agentGetThrows = false;

function gen(values: () => Iterable<any>) {
  return async function* () {
    for (const v of values()) yield v;
  }();
}

mock.module("harper", () => ({
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => {
          if (agentGetThrows) throw new Error("simulated agent read failure");
          return agentStore.get(id) ?? null;
        },
        put: async (r: any) => { agentStore.set(r.id, { ...r }); return r; },
      },
      Soul: {
        get: async (id: string) => soulStore.get(id) ?? null,
        put: async (r: any) => { soulStore.set(r.id, { ...r }); return r; },
      },
      Memory: {
        search: () => gen(() => memStore.values()),
        put: async (r: any) => {
          for (const field of ["agentId", "content", "createdAt"]) expect(typeof r[field]).toBe("string");
          memStore.set(r.id, JSON.parse(JSON.stringify(r)));
          return r;
        },
      },
      Instance: {
        search: () => gen(() => (instanceRow ? [instanceRow] : [])),
      },
    },
  },
}));

mock.module("../../resources/agent-auth.ts", () => ({
  allowAdmin: async () => true,
  invalidateAdminCache: () => {},
}));
mock.module("../../resources/soul-write-policy.ts", () => ({
  authorizeSoulWrite: async () => ({ auth: { kind: "internal" }, source: "operator", denied: null }),
  refuseSoulWriteContent: async () => null,
  soulProvenance: () => "{}",
}));
mock.module("../../resources/agent-admin.ts", () => ({ reconcileAdminFields: (r: any) => r }));
mock.module("../../resources/bm25-index-service.ts", () => ({ noteMemoryUpsert: () => {} }));
mock.module("../../resources/skill-write.ts", () => ({ rejectSkillWritePath: () => null }));

const { AgentSeed } = await import("../../resources/AgentSeed.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function seed() {
  const r: any = new (AgentSeed as any)();
  r.getContext = () => ({ request: { tpsAgent: "operator", tpsAgentIsAdmin: true } });
  return r;
}

beforeEach(() => {
  agentStore = new Map();
  soulStore = new Map();
  memStore = new Map();
  instanceRow = null;
  agentGetThrows = false;
  _resetLocalInstanceIdCacheForTests();
});

describe("flair#1965 r2 — AgentSeed stamps originatorInstanceId on every raw create", () => {
  test("the seeded Agent, Soul and starter-Memory rows all carry the local instance id", async () => {
    instanceRow = { id: LOCAL_ID };
    const result: any = await seed().post({ agentId: "newbie", displayName: "Newbie" });

    expect(result.agent.id).toBe("newbie");
    expect(agentStore.get("newbie").originatorInstanceId).toBe(LOCAL_ID);

    const souls = [...soulStore.values()];
    expect(souls.length).toBeGreaterThan(0);
    for (const s of souls) expect(s.originatorInstanceId).toBe(LOCAL_ID);

    const mems = [...memStore.values()];
    expect(mems.length).toBeGreaterThan(0);
    for (const m of mems) expect(m.originatorInstanceId).toBe(LOCAL_ID);
  });

  test("with no Instance row the seeded rows are stamped null (never an invented id)", async () => {
    instanceRow = null;
    await seed().post({ agentId: "newbie2", displayName: "Newbie Two" });
    expect(agentStore.get("newbie2").originatorInstanceId).toBeNull();
    for (const s of soulStore.values()) expect(s.originatorInstanceId).toBeNull();
    for (const m of memStore.values()) expect(m.originatorInstanceId).toBeNull();
  });
});

describe("flair#1965 r3 — AgentSeed fails closed on a failed existing-Agent lookup", () => {
  test("a FAILED existing-Agent read refuses the seed (500) and never overwrites the existing row as a create", async () => {
    instanceRow = { id: LOCAL_ID };
    // An existing Agent row that a failed read must NOT be allowed to clobber.
    agentStore.set("existing", { id: "existing", name: "Existing", role: "agent", publicKey: "stable-key", originatorInstanceId: "instance-B" });
    agentGetThrows = true;

    const res: any = await seed().post({ agentId: "existing", displayName: "Existing" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(500);
    expect((await (res as Response).json()).error).toBe("agent_lookup_failed");

    // The existing row is untouched — no re-stamp, no overwrite.
    const stored = agentStore.get("existing");
    expect(stored.publicKey).toBe("stable-key");
    expect(stored.originatorInstanceId).toBe("instance-B");
    // No Soul/Memory rows were created either (the seed refused before them).
    expect(soulStore.size).toBe(0);
    expect(memStore.size).toBe(0);
  });
});

describe("AgentSeed ephemeral expiry", () => {
  test("ignores supplied expiry and stores the configured TTL through the seed writer", async () => {
    const prior = process.env.FLAIR_EPHEMERAL_TTL_HOURS;
    process.env.FLAIR_EPHEMERAL_TTL_HOURS = "6";
    try {
      const before = Date.now();
      const result: any = await seed().post({ agentId: "expiry-seed", starterMemories: [{ content: "starter note", durability: "ephemeral", expiresAt: "not-a-date" }] });
      expect(result.memories).toHaveLength(1);
      const stored = memStore.get(result.memories[0].id);
      expect(stored.durability).toBe("ephemeral");
      expect(Date.parse(stored.expiresAt)).toBeGreaterThanOrEqual(before + 6 * 3600000);
      expect(Date.parse(stored.expiresAt)).toBeLessThanOrEqual(Date.now() + 6 * 3600000);
    } finally {
      if (prior === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
      else process.env.FLAIR_EPHEMERAL_TTL_HOURS = prior;
    }
  });
});
