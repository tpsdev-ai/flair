/**
 * OrgEventCatchup watermark — flair#931 acceptance.
 *
 * Owns OrgEventCatchup + AgentReadPosition + the storage primitive (one
 * process, own harper mock). Cross-agent isolation stays in
 * test/unit/cross-agent-isolation.test.ts.
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";

type ReadPositionTable = {
  get: (id: string) => Promise<any>;
  put: (row: any) => Promise<unknown>;
};

let orgEventRecords: any[] = [];
const positionStore = new Map<string, any>();

class BaseOrgEvent {
  static search(query?: any) {
    const cond = query?.conditions?.find((c: any) => c.attribute === "createdAt");
    async function* gen() {
      for (const r of orgEventRecords) {
        if (cond?.comparator === "greater_than_equal" && r.createdAt < cond.value) continue;
        yield r;
      }
    }
    return gen();
  }
}

class BaseAgentReadPosition {
  static async get(id: string) {
    return positionStore.get(id) ?? null;
  }
  static async put(row: any) {
    positionStore.set(row.id, { ...row });
    return row;
  }
}

class MockResourceBase {
  getContext() { return {}; }
  getId() { return undefined; }
}

class GenericTable {
  static async get() { return null; }
  static async put(rec: any) { return rec; }
  static async delete() { return true; }
  static async *search() {}
}

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      OrgEvent: BaseOrgEvent,
      AgentReadPosition: BaseAgentReadPosition,
      Agent: GenericTable,
      WorkspaceState: GenericTable,
    },
  },
  Resource: MockResourceBase,
}));

const { recordPosition } = await import("../../resources/agent-read-position-lib.ts");
const {
  advanceReadPosition,
  ensureReadPosition,
  getReadPosition,
} = await import("../../resources/agent-read-position.ts");
const { OrgEventCatchup } = await import("../../resources/OrgEventCatchup.ts");
const { AgentReadPosition } = await import("../../resources/AgentReadPosition.ts");

function makeInstance<T>(Cls: any, ctxRequest: any | undefined): T {
  const r: any = new Cls();
  r.getContext = () => (ctxRequest === undefined ? undefined : { request: ctxRequest });
  return r as T;
}

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

function ev(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, authorId: "writer", kind: "a2a.message", summary: id, createdAt, targetIds: ["krais"], ...extra };
}

function pathFor(participantId: string, extra: Record<string, string> = {}) {
  return {
    id: participantId,
    conditions: Object.entries(extra).map(([attribute, value]) => ({
      attribute, value, comparator: "equals",
    })),
  };
}

const T0 = "2026-09-01T00:00:00.000Z";
const HOURS = (h: number) => new Date(Date.parse(T0) + h * 3600_000).toISOString();

beforeEach(() => {
  orgEventRecords = [];
  positionStore.clear();
});

describe("AgentReadPosition primitive — monotonic + concurrent", () => {
  const table: ReadPositionTable = BaseAgentReadPosition;

  it("ensure creates once; a second ensure does not regress", async () => {
    const a = await ensureReadPosition(table, "krais", "org-event", "pos-a");
    const b = await ensureReadPosition(table, "krais", "org-event", "pos-b");
    expect(a).toBe("pos-a");
    expect(b).toBe("pos-a");
    expect(await getReadPosition(table, "krais", "org-event")).toBe("pos-a");
  });

  it("advance is monotonic — a lower ack is a no-op", async () => {
    await advanceReadPosition(table, "krais", "org-event", "m");
    const low = await advanceReadPosition(table, "krais", "org-event", "a");
    expect(low.advanced).toBe(false);
    expect(low.position).toBe("m");
    const high = await advanceReadPosition(table, "krais", "org-event", "z");
    expect(high.advanced).toBe(true);
    expect(high.position).toBe("z");
  });

  it("concurrent advances by the same agent do not corrupt the watermark", async () => {
    const positions = ["p-2", "p-9", "p-1", "p-5", "p-8"];
    await Promise.all(positions.map((p) => advanceReadPosition(table, "krais", "org-event", p)));
    expect(await getReadPosition(table, "krais", "org-event")).toBe("p-9");
  });

  it("watermarks are per-agent (owner-private store)", async () => {
    await advanceReadPosition(table, "krais", "org-event", "k");
    await advanceReadPosition(table, "rivet", "org-event", "r");
    expect(await getReadPosition(table, "krais", "org-event")).toBe("k");
    expect(await getReadPosition(table, "rivet", "org-event")).toBe("r");
  });
});

describe("OrgEventCatchup — flair#931 acceptance", () => {
  it(">10 events since last catch-up → ALL returned (paged), none dropped", async () => {
    orgEventRecords = Array.from({ length: 15 }, (_, i) => ev(`e${String(i).padStart(2, "0")}`, HOURS(i + 1)));
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    let hasMore = true;
    while (hasMore) {
      const extra: Record<string, string> = { limit: "7" };
      if (after) extra.after = after;
      else extra.since = T0;
      const res = await oe.get(pathFor("krais", extra));
      expect(res).not.toBeInstanceOf(Response);
      expect(res.events.length).toBeLessThanOrEqual(7);
      seen.push(...res.events.map((e: any) => e.id));
      hasMore = res.hasMore;
      after = res.nextAfter;
      pages++;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual(orgEventRecords.map((e) => e.id));
    expect(pages).toBe(3);
  });

  it("event older than the old 24h window but newer than watermark is returned", async () => {
    const watermarkAt = HOURS(1);
    positionStore.set("krais:org-event", {
      id: "krais:org-event", agentId: "krais", stream: "org-event",
      position: recordPosition({ createdAt: watermarkAt, id: "wm" }),
      updatedAt: watermarkAt,
    });
    const stale = ev("stale-handoff", HOURS(12)); // 12h after watermark, 36h before "now" if now=HOURS(48)
    orgEventRecords = [stale];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const res = await oe.get(pathFor("krais"));
    expect(res.events.map((e: any) => e.id)).toEqual(["stale-handoff"]);
    expect(res.hasMore).toBe(false);
  });

  it("after ack, re-catch-up returns nothing", async () => {
    orgEventRecords = [ev("one", HOURS(2)), ev("two", HOURS(3))];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const first = await oe.get(pathFor("krais", { since: T0 }));
    expect(first.events.map((e: any) => e.id)).toEqual(["one", "two"]);
    const ack = await oe.post({ position: first.nextAfter }, pathFor("krais"));
    expect(ack.advanced).toBe(true);
    const second = await oe.get(pathFor("krais"));
    expect(second.events).toEqual([]);
    expect(second.hasMore).toBe(false);
    expect(second.watermark).toBe(first.nextAfter);
  });

  it("crash between deliver and ack → re-delivery (at-least-once)", async () => {
    orgEventRecords = [ev("handoff", HOURS(2))];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const first = await oe.get(pathFor("krais", { since: T0 }));
    expect(first.events).toHaveLength(1);
    // no ack — crash
    const second = await oe.get(pathFor("krais", { since: T0 }));
    expect(second.events.map((e: any) => e.id)).toEqual(["handoff"]);
  });

  it("GET does not advance the watermark (advance-on-ack, not on-read)", async () => {
    orgEventRecords = [ev("x", HOURS(2))];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    await oe.get(pathFor("krais", { since: T0 }));
    expect(positionStore.size).toBe(0);
    const again = await oe.get(pathFor("krais", { since: T0 }));
    expect(again.events).toHaveLength(1);
  });

  it("since is optional when a watermark exists", async () => {
    positionStore.set("krais:org-event", {
      id: "krais:org-event", agentId: "krais", stream: "org-event",
      position: recordPosition({ createdAt: HOURS(1), id: "wm" }),
      updatedAt: HOURS(1),
    });
    orgEventRecords = [ev("after", HOURS(3))];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const res = await oe.get(pathFor("krais")); // no since
    expect(res).not.toBeInstanceOf(Response);
    expect(res.events.map((e: any) => e.id)).toEqual(["after"]);
  });

  it("legacy since still works without a watermark", async () => {
    orgEventRecords = [ev("old", "2020-01-01T00:00:00.000Z"), ev("in-window", HOURS(2))];
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("krais"));
    const res = await oe.get(pathFor("krais", { since: T0 }));
    expect(res.events.map((e: any) => e.id)).toEqual(["in-window"]);
  });
});

describe("OrgEventCatchup / AgentReadPosition — owner-scoped", () => {
  it("agent cannot ack another agent's watermark", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, agentCtx("rivet"));
    const res = await oe.post({ position: "p" }, pathFor("krais"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("agent cannot read another agent's AgentReadPosition", async () => {
    const rp = makeInstance<any>(AgentReadPosition, agentCtx("rivet"));
    const res = await rp.get(pathFor("krais", { stream: "org-event" }));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("anonymous is denied on GET and POST", async () => {
    const oe = makeInstance<any>(OrgEventCatchup, anonCtx());
    expect((await oe.get(pathFor("krais", { since: T0 }))).status).toBe(403);
    expect((await oe.post({ position: "p" }, pathFor("krais"))).status).toBe(403);
  });
});
