import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";
import { memoryLockDouble } from "../helpers/memory-lock-double";

let row: Record<string, any>;
let changeAt: string | undefined;
let updates: number;
const changedHash = "a".repeat(64);
const txn = installFakeHarperTransaction((_id, value) => { row = value; });
afterAll(() => txn.restore());

mock.module("harper", () => ({ databases: { flair: { Memory: {
  primaryStore: memoryLockDouble(),
  get: async () => ({ ...row }),
  update: async (id: string, patch: Record<string, unknown>) => {
    updates++;
    if (!txn.stage(id, { ...row, ...patch })) throw new Error("update outside transaction");
  },
} } } }));
mock.module("../../resources/bm25-index-service.ts", () => ({ noteMemoryUpsert: () => {} }));
mock.module("../../resources/txn-pause-point.ts", () => ({
  TEST_FAULT_INJECTION_ENV: "FLAIR_ENABLE_TEST_FAULT_INJECTION",
  txnPausePoint: (point: string) => {
    if (point === changeAt) {
      row = { ...row, promotionContentHash: changedHash };
      changeAt = undefined;
    }
  },
}));

const { stampMemoryPromotion } = await import("../../resources/promotion-stamp.ts");
const { promotionContentHash } = await import("../../resources/promotion-binding.ts");
const { WriteBackConflictError } = await import("../../resources/write-back.ts");

beforeEach(() => {
  row = { id: "binding-test", agentId: "owner", content: "reviewed content", instanceToken: "incarnation", createdAt: "2026-10-17T00:00:00.000Z" };
  updates = 0;
  changeAt = undefined;
});

function stamp(): Promise<void> {
  return stampMemoryPromotion(row.id, "reviewer", "decision-time", undefined, undefined, { ...row } as any);
}

it("an unchanged binding receives the automatic verdict", async () => {
  await stamp();
  expect(row.promotionStatus).toBe("approved");
  expect(row.promotionContentHash).toBe(promotionContentHash(row.content));
  expect(updates).toBe(1);
});

it("a binding-only change before the transaction prevents the automatic stamp", async () => {
  changeAt = "promotion-stamp-pre";
  await expect(stamp()).rejects.toBeInstanceOf(WriteBackConflictError);
  expect(row.promotionStatus).toBeUndefined();
  expect(row.promotionContentHash).toBe(changedHash);
  expect(updates).toBe(0);
});

it("a binding-only change after the transaction read aborts its staged stamp", async () => {
  changeAt = "promotion-stamp";
  await expect(stamp()).rejects.toBeInstanceOf(WriteBackConflictError);
  expect(row.promotionStatus).toBeUndefined();
  expect(row.promotionContentHash).toBe(changedHash);
  expect(updates).toBe(1);
});
