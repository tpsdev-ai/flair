/**
 * presence-post-read-failure-2578.test.ts — flair#2578 slice 1: POST /Presence
 * distinguishes a confirmed miss from a read error.
 *
 * A stored-row read that FAILS must not be read as "first heartbeat": treating
 * it as a create would let an existing row be re-stamped (and re-authored) while
 * the read is broken. The write is refused by name and nothing is stored.
 *
 * Unit-isolated (mock harper) because resources/Presence.ts extends
 * `databases.flair.Presence` at class-definition time, which needs a Harper
 * runtime. The real-Harper heartbeat path lives in
 * test/integration/presence-api.test.ts and
 * test/integration/federation-presence-receive-2578.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

let presenceStore: Map<string, any>;
let presenceReadError = false;

class BasePresence {
  static async get(id: string) {
    if (presenceReadError) throw new Error("presence read failed");
    return presenceStore.get(id) ?? null;
  }
  static async put(content: any) { presenceStore.set(content.agentId, { ...content }); return content; }
  getId() { return (this as any)._targetId; }
  async get(target?: any) {
    const id = typeof target === "string" ? target : (target?.id ?? (this as any)._targetId);
    return presenceStore.get(id) ?? null;
  }
  async put(content: any) { presenceStore.set(content.agentId, { ...content }); return content; }
  async patch(content: any, _query?: any) { presenceStore.set(content.agentId, { ...(presenceStore.get(content.agentId) ?? {}), ...content }); return content; }
  async delete(_id?: any) { return true; }
}

class BaseAgent {
  static async get(id: string) { return agentRowFor(id); }
}

const AGENT = "pf-2578-agent";

function agentRowFor(id: string): any {
  if (id !== AGENT) return null;
  // A NULL home: this instance is treated as the home, so the home guard allows
  // the write. The failure under test is the Presence read, not the home.
  return { id, name: id, role: "agent", publicKey: "k", createdAt: "2026-01-01T00:00:00.000Z", originatorInstanceId: null };
}

const databasesMock = {
  flair: {
    Presence: BasePresence,
    Agent: BaseAgent,
    Instance: {
      // No Instance row: localInstanceId() resolves to null (harmless here — the
      // agent's home is null, so the home refusal returns null either way).
      search: () => {
        async function* gen() {}
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  server: { http: () => {}, getUser: async () => null },
  Resource: class {},
}));

const { Presence } = await import("../../resources/Presence.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function makePresence(): any {
  const p: any = new (Presence as any)();
  p.getContext = () => ({ request: { tpsAgent: AGENT, url: "/Presence" } });
  return p;
}

beforeEach(() => {
  presenceStore = new Map();
  presenceReadError = false;
  _resetLocalInstanceIdCacheForTests();
});

describe("flair#2578 — POST /Presence refuses a FAILED stored-row read", () => {
  it("a failing read followed by an otherwise valid write is refused by name and stores nothing", async () => {
    presenceReadError = true;
    const res: any = await makePresence().post({ activity: "coding" });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("presence_read_failed");
    expect(presenceStore.size).toBe(0);
  });

  it("a CONFIRMED miss (a successful read that finds no row) still writes — the guard is not over-broad", async () => {
    presenceReadError = false;
    const res: any = await makePresence().post({ activity: "coding" });
    expect(res instanceof Response).toBe(false);
    expect(presenceStore.get(AGENT)).toBeDefined();
  });
});
