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

function fromStore(): AsyncIterable<any> {
  async function* gen() {
    for (const r of memoryStore.values()) yield r;
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      search: () => fromStore(),
      delete: async (id: string) => {
        memoryStore.delete(id);
        return { ok: true };
      },
      update: async (id: string, data: any) => {
        memoryStore.set(id, { ...memoryStore.get(id), ...data });
        return data;
      },
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
});

describe("MemoryMaintenance expiry — ephemeral-only (flair#1265)", () => {
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
    const deleteBlock = src.match(/Delete expired[\s\S]*?continue;/);
    expect(deleteBlock).not.toBeNull();
    expect(deleteBlock![0]).toContain('durability === "ephemeral"');
    expect(deleteBlock![0]).toContain("expiresAt");
    // The pre-fix predicate (`expiresAt && new Date(expiresAt) < now` with
    // no durability conjunct) must not reappear as the sole condition.
    expect(deleteBlock![0]).not.toMatch(
      /if\s*\(\s*record\.expiresAt\s*&&\s*new Date\(record\.expiresAt\)\s*<\s*now\s*\)/,
    );
  });
});
