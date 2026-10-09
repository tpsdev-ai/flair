/**
 * memory-maintenance-expiry.test.ts — flair#1265.
 *
 * MemoryMaintenance's docstring has always scoped expiry deletes to
 * ephemeral rows. The shipped predicate was `expiresAt < now` with no
 * durability check, so a persistent (or any other non-ephemeral) row that
 * ever acquired an expiresAt was silently reaped on the nightly pass.
 *
 * These tests run MemoryMaintenance.post() against an in-memory Memory
 * table. No live Harper. Lives in unit-isolated/ so its harper mock owns
 * the process (CI runs each file here in its own `bun test` invocation).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAST = new Date(Date.now() - 3600_000).toISOString();
const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const AGENT = "agent-1";

let memoryStore: Map<string, any>;
let pointerStore: Map<string, any>;
// This mock applies writes immediately; it does not model transaction rollback.
let deletionStore: Map<string, any>;
let failNextMemoryRead: boolean;

function fromStore(): AsyncIterable<any> {
  async function* gen() {
    for (const r of memoryStore.values()) yield r;
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => {
        if (failNextMemoryRead) {
          failNextMemoryRead = false;
          throw new Error("injected first orphan read failure");
        }
        return memoryStore.get(id) ?? null;
      },
      search: () => fromStore(),
      delete: async (id: string) => {
        memoryStore.delete(id);
        return true;
      },
      update: async (id: string, data: any) => {
        memoryStore.set(id, { ...memoryStore.get(id), ...data });
        return data;
      },
    },
    MemoryHostSource: {
      search: () => (async function* () { yield* pointerStore.values(); })(),
      get: async (id: string) => pointerStore.get(id) ?? null,
      put: async (row: any) => row,
      delete: async (id: string) => { pointerStore.delete(id); return { ok: true }; },
    },
    MemoryDeletionHistory: {
      put: async (row: any) => { deletionStore.set(row.id, { ...row }); return { ...row }; },
    },
    Agent: { get: async () => null, search: async () => [] },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
}));

const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");

function seed(id: string, overrides: Record<string, any> = {}) {
  const row = { id, agentId: AGENT, content: id, ...overrides };
  memoryStore.set(id, row);
  return row;
}

function makeMaintenance(ctxRequest: any) {
  const r: any = new (MemoryMaintenance as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}

const adminCtx = () => ({ tpsAgent: "admin", tpsAgentIsAdmin: true });

beforeEach(() => {
  memoryStore = new Map();
  pointerStore = new Map();
  deletionStore = new Map();
  failNextMemoryRead = false;
});

// flair#1940: Harper assigns `transaction` onto the global at load, and the
// Memory write path creates one when a caller has no request context, refusing
// to run a write unwrapped. Provide it in this isolated mock.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = { open: 1, saveCommits: false, abort() { this.open = 0; }, commit() { this.open = 0; } };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  let r: any;
  try { r = cb(txn); } catch (e) { txn.abort(); throw e; }
  if (r && typeof r.then === "function") {
    return r.then((v: any) => { txn.commit(); return v; }, (e: any) => { txn.abort(); throw e; });
  }
  txn.commit();
  return r;
};

describe("MemoryMaintenance expiry — ephemeral-only (flair#1265)", () => {
  it("(r23-orphan-read) counts an initial Memory read failure and cleans later orphan rows", async () => {
    pointerStore.set("unreadable", { memoryId: "unreadable" });
    pointerStore.set("later-orphan", { memoryId: "later-orphan" });
    failNextMemoryRead = true;

    const response = await makeMaintenance(adminCtx()).post({});
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(500);
    const out = await response.json();
    expect(failNextMemoryRead).toBe(false); // control: the first read actually failed
    expect(pointerStore.has("later-orphan")).toBe(false); // continuation is the regression
    expect(pointerStore.has("unreadable")).toBe(true);
    expect(out.error).toBe("maintenance_incomplete");
    expect(out.errors).toBe(1);
    expect(out.stats.errors).toBe(1);
    expect(out.orphans).toBe(1);
  });

  it("deletes an ephemeral row whose expiresAt is in the past", async () => {
    seed("eph-expired", { durability: "ephemeral", expiresAt: PAST });

    const result = await makeMaintenance(adminCtx()).post({});
    expect(result.expired).toBe(1);
    expect(memoryStore.has("eph-expired")).toBe(false);
  });

  it("leaves an ephemeral row whose expiresAt is still in the future", async () => {
    seed("eph-live", { durability: "ephemeral", expiresAt: FUTURE });

    const result = await makeMaintenance(adminCtx()).post({});
    expect(result.expired).toBe(0);
    expect(memoryStore.has("eph-live")).toBe(true);
  });

  it("positive control: a persistent row with past expiresAt SURVIVES", async () => {
    // This is the row the pre-#1265 predicate would have deleted. If the
    // durability filter is removed, this test goes red — that is the
    // mutation-check.
    seed("persist-expired", { durability: "persistent", expiresAt: PAST });
    seed("eph-expired", { durability: "ephemeral", expiresAt: PAST });

    const result = await makeMaintenance(adminCtx()).post({});

    expect(memoryStore.has("persist-expired")).toBe(true);
    expect(memoryStore.has("eph-expired")).toBe(false);
    expect(result.expired).toBe(1);
  });

  it("does not reap other non-ephemeral (or missing / unexpected) durability", async () => {
    seed("permanent-expired", { durability: "permanent", expiresAt: PAST });
    seed("standard-expired", { durability: "standard", expiresAt: PAST });
    seed("absent-durability", { expiresAt: PAST });
    seed("garbage-durability", { durability: "durable", expiresAt: PAST });
    seed("eph-expired", { durability: "ephemeral", expiresAt: PAST });

    const result = await makeMaintenance(adminCtx()).post({});

    expect(memoryStore.has("permanent-expired")).toBe(true);
    expect(memoryStore.has("standard-expired")).toBe(true);
    expect(memoryStore.has("absent-durability")).toBe(true);
    expect(memoryStore.has("garbage-durability")).toBe(true);
    expect(memoryStore.has("eph-expired")).toBe(false);
    expect(result.expired).toBe(1);
  });
});

describe("flair#1265 mutation-check — durability filter stays in the delete predicate", () => {
  it("the expiry delete block requires durability === 'ephemeral'", () => {
    // Behavioural tests above fail if the filter is removed (persistent
    // row would be deleted). This scan fails on deletion of the conjunct
    // even if a later rewrite stopped exercising the store.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "resources", "MemoryMaintenance.ts"),
      "utf8",
    );
    // Pin the three conjuncts in one predicate. A looser "Delete expired"
    // scan hits the file header first and is not a mutation-check.
    expect(src).toMatch(
      /record\.durability === "ephemeral"\s*&&\s*record\.expiresAt\s*&&\s*new Date\(record\.expiresAt\) < now/,
    );
    // The pre-#1265 predicate (`expiresAt && date < now` with no durability
    // conjunct) must not reappear as the sole condition.
    expect(src).not.toMatch(
      /if\s*\(\s*record\.expiresAt\s*&&\s*new Date\(record\.expiresAt\)\s*<\s*now\s*\)/,
    );
  });
});
