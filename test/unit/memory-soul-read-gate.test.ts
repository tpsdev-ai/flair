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
 * "@harperfast/harper" and dynamically imports "../../resources/Memory.ts".
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
    const id = typeof target === "string" ? target : target?.id;
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
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock }));

const { Soul } = await import("../../resources/Soul.ts");

function makeSoul(ctxRequest: any) {
  const r: any = new (Soul as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

beforeEach(() => {
  soulStore = new Map();
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

  it("an owner can still write its own soul", async () => {
    const s = makeSoul(agentCtx("agent-1"));
    const res: any = await s.post({ agentId: "agent-1", identity: "my identity" });
    expect(res.identity).toBe("my identity");
  });
});
