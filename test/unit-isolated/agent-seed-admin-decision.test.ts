/**
 * AgentSeed + the admin decision: an agent seeded with role "admin" is an admin
 * once the seed's transaction commits, and not while its create is only staged.
 * resources/agent-auth.ts isAdmin() reads the Agent row at the time of the call.
 */
import { beforeEach, expect, mock, test } from "bun:test";

let agents = new Map<string, any>();
let staged = new Map<string, any>();
let souls = new Map<string, any>();
let beforeCommit: () => Promise<void>;

mock.module("harper", () => ({
  Resource: class {},
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => agents.get(id),
        put: async (row: any) => { staged.set(row.id, { ...row }); },
        search: async function* () { yield* agents.values(); },
      },
      Soul: {
        get: async (id: string) => souls.get(id),
        put: async (row: any) => { souls.set(row.id, { ...row }); },
      },
      Memory: {
        search: async function* () {},
        put: async () => {},
      },
      Instance: { search: async function* () {} },
    },
  },
}));
mock.module("../../resources/soul-write-policy.ts", () => ({
  authorizeSoulWrite: async () => ({ auth: { kind: "internal" }, source: "internal", denied: null }),
  refuseSoulWriteContent: async () => null,
  soulProvenance: () => "{}",
}));
mock.module("../../resources/bm25-index-service.ts", () => ({ noteMemoryUpsert: () => {} }));
mock.module("../../resources/skill-write.ts", () => ({
  rejectSkillWritePath: (row: any) => row.content === "refused" ? new Response("refused", { status: 400 }) : null,
}));

(globalThis as any).transaction = async (ctx: any, callback: (ctx: any) => Promise<any>) => {
  const result = await callback(ctx);
  await beforeCommit();
  for (const [id, row] of staged) agents.set(id, row);
  return result;
};

const { AgentSeed } = await import("../../resources/AgentSeed.ts");
const { isAdmin } = await import("../../resources/agent-auth.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

beforeEach(() => {
  agents = new Map();
  staged = new Map();
  souls = new Map();
  _resetLocalInstanceIdCacheForTests();
});

for (const refused of [false, true]) {
  test(`AgentSeed: a seeded admin is an admin after the commit and not before it (refused: ${refused})`, async () => {
    let release!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    beforeCommit = async () => {
      paused();
      await gate;
    };
    const resource: any = new (AgentSeed as any)();
    resource.getContext = () => ({});
    const pending = resource.post({ agentId: "seeded-admin", role: "admin", starterMemories: [{ content: refused ? "refused" : "starter" }] });
    await reached;
    try {
      expect(await isAdmin("seeded-admin")).toBe(false);
    } finally {
      release();
    }
    const result = await pending;
    if (refused) expect(result.status).toBe(400);
    else expect(result.agent.admin).toBe(true);
    expect(await isAdmin("seeded-admin")).toBe(true);
  });
}
