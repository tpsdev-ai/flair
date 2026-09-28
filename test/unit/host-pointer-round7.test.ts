/**
 * host-pointer-round7.test.ts — flair#1940 slice 1, round 7 (A1-iv items 4/5/6).
 *   item 4 — cleanup is hygiene: a maintenance run with a cleanup error is a
 *            FAILURE response naming the counts; a missing pointer table is
 *            reported, never silently skipped.
 *   item 5 — the transaction helper throws when Harper's transaction function
 *            is absent, and does not join a CLOSED (detached) transaction.
 *   item 6 — a failing pointer-table adapter is driven from TEST code (the
 *            shared Harper mock's next-write failure flag); no FLAIR_TEST_FAIL_*
 *            env switch and no production seam exist.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  harnessState,
  resetHarnessState,
  installMemoryHarperMock,
  databasesMock,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");
const { withSharedWriteTransaction, isJoinableTransaction } = await import("../../resources/request-transaction.ts");

const memoryStore = harnessState.memoryStore;
const pointerStore = harnessState.pointerStore;
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

function seedMemory(overrides: Record<string, any> = {}) {
  const row = {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    content: "a short note",
    visibility: "shared",
    instanceToken: overrides.instanceToken ?? "tok-x",
    ...overrides,
  };
  memoryStore.set(row.id, row);
  return row;
}
const maint = () => {
  const m: any = new (MemoryMaintenance as any)();
  m.getContext = () => ({ request: { tpsAgent: "agent-a" } });
  return m;
};

beforeEach(() => {
  resetHarnessState();
  _resetLocalInstanceIdCacheForTests();
});

// ─── item 4: cleanup is hygiene ──────────────────────────────────────────────

describe("A1-iv item 4 — cleanup failures are reported, never a success", () => {
  it("(h1) a maintenance run with a cleanup error returns a failure naming counts", async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    seedMemory({ id: "mem-h1", agentId: "agent-a", durability: "ephemeral", expiresAt: old });
    pointerStore.set("mem-h1", { memoryId: "mem-h1", hostSource: JSON.stringify(POINTER), authorId: "agent-a" });
    harnessState.failNextPointerDelete = true; // the pointer delete fails

    const out: any = await maint().post({});

    expect(out instanceof Response).toBe(true); // assertion: NOT a normal "complete" object
    expect((out as Response).status).toBe(500); // assertion: a failure response
    const body = await (out as Response).json();
    expect(body.error).toBe("maintenance_incomplete"); // assertion
    expect(body.errors).toBe(1); // assertion: the counts are named
  });

  it("(h2) a missing pointer table is reported, never silently skipped", async () => {
    const saved = (databasesMockFlair() as any).MemoryHostSource;
    (databasesMockFlair() as any).MemoryHostSource = undefined;
    try {
      const out: any = await maint().post({});
      expect(out instanceof Response).toBe(true); // assertion: reported
      expect((out as Response).status).toBe(500); // assertion
      const body = await (out as Response).json();
      expect(String(body.error)).toContain("MemoryHostSource table unavailable"); // assertion
    } finally {
      (databasesMockFlair() as any).MemoryHostSource = saved;
    }
  });
});

function databasesMockFlair(): any {
  return (databasesMock as any).flair;
}

// ─── item 5: the transaction helper ──────────────────────────────────────────

describe("A1-iv item 5 — the transaction helper has no unwrapped fallback", () => {
  it("(tx1) it THROWS when Harper's transaction function is absent", async () => {
    const saved = (globalThis as any).transaction;
    (globalThis as any).transaction = undefined;
    try {
      await expect(
        withSharedWriteTransaction({}, async () => "ok"),
      ).rejects.toThrow(/transaction\(\) is unavailable/); // assertion: throws, does not run unwrapped
    } finally {
      (globalThis as any).transaction = saved;
    }
  });

  it("(tx2) it does not join a CLOSED (detached) transaction", () => {
    expect(isJoinableTransaction({ transaction: { open: 0 } })).toBe(false); // assertion: CLOSED is not joinable
    expect(isJoinableTransaction({ transaction: { open: 1, saveCommits: true } })).toBe(false); // assertion: self-committing is not joinable
    expect(isJoinableTransaction({ transaction: { open: 1 } })).toBe(true); // assertion: OPEN is joinable
  });
});

// ─── item 6: a failing pointer write is driven from TEST code ────────────────

describe("A1-iv item 6 — a failing pointer-table write driven from test code", () => {
  it("(seam) a failing pointer write makes the write fail and leaves no Memory row", async () => {
    // No production seam: the shared Harper mock's pointer-table `put` throws
    // once when this flag is set — a TEST-side failure injection only.
    harnessState.failNextPointerPut = true;
    const r: any = new (Memory as any)();
    r.getContext = () => ({}); // no request context
    const res: any = await r.post({ id: "mem-seam", content: "x", hostSource: POINTER, hostSourceScope: "record" });
    expect((res as Response)?.status).toBe(500); // assertion: the write fails
    expect(memoryStore.has("mem-seam")).toBe(false); // assertion: no Memory row
  });
});
