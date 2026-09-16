// Fails-first coverage for flair#1263.
//
// On main, POST /ReflectMemories execute calls models.generate() while
// Harper's Resource dispatcher still holds the request transaction open.
// A cold generative backend (model load > storage.maxTransactionOpenTime,
// default 30s) makes that txn write-bearing and overdue → HTTP 422
// (transactionOpenTooLongError), not the documented 502/503.
//
// This file injects a cold-backend delay against a simulated Harper
// ceiling. The MAIN interleaving (generate while the request txn is still
// open) reproduces 422. runExecuteDistillation (release → generate → write)
// does not. MemoryReflect.ts must call that helper — a source tripwire
// so the resource cannot silently revert to the main interleaving.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HARPER_MAX_TRANSACTION_OPEN_TIME_MS,
  TRANSACTION_OPEN_TOO_LONG_STATUS,
  evaluateTxnCeiling,
  releaseRequestTransaction,
  runExecuteDistillation,
} from "../../resources/memory-reflect-lib.ts";

const MEMORY_REFLECT_SRC = readFileSync(
  join(import.meta.dir, "..", "..", "resources", "MemoryReflect.ts"),
  "utf8",
);

const COLD_DELAY_MS = 80;
const SHORT_CEILING_MS = 30;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulated Harper request transaction + long-transaction monitor.
 * A write staged into an open txn that stays past `ceilingMs` poisons
 * the txn; the next write/commit is HTTP 422 — the same shape as
 * DatabaseTransaction.transactionOpenTooLongError.
 */
class SimulatedRequestTxn {
  open = true;
  timedOut = false;
  writes = 0;
  private openedAt = 0;
  constructor(
    private readonly now: () => number,
    private readonly ceilingMs: number,
  ) {}

  start(): void {
    this.openedAt = this.now();
    this.open = true;
    this.timedOut = false;
    this.writes = 0;
  }

  /** models.generate() / table.put() joining the request txn. */
  addWrite(): void {
    this.tick();
    if (this.timedOut) {
      const err = new Error(
        "Transaction was aborted after exceeding the maximum open-transaction time; split long-running work into smaller transactions",
      );
      (err as any).status = TRANSACTION_OPEN_TOO_LONG_STATUS;
      throw err;
    }
    if (this.open) this.writes++;
  }

  tick(): void {
    if (!this.open || this.timedOut) return;
    if (this.writes > 0 && this.now() - this.openedAt > this.ceilingMs) {
      this.timedOut = true;
      this.open = false;
    }
  }

  commit(): void {
    this.tick();
    if (this.timedOut) {
      const err = new Error("transaction open too long");
      (err as any).status = TRANSACTION_OPEN_TOO_LONG_STATUS;
      throw err;
    }
    this.open = false;
  }
}

describe("evaluateTxnCeiling (Harper 422 shape)", () => {
  test("cold generate inside an open request txn reproduces 422, not 502/503", () => {
    const result = evaluateTxnCeiling({
      generateStartedWhileTxnOpen: true,
      generateDurationMs: COLD_DELAY_MS,
      ceilingMs: SHORT_CEILING_MS,
    });
    expect(result).toEqual({ status: TRANSACTION_OPEN_TOO_LONG_STATUS });
    expect(TRANSACTION_OPEN_TOO_LONG_STATUS).toBe(422);
    expect(HARPER_MAX_TRANSACTION_OPEN_TIME_MS).toBe(30_000);
  });

  test("the same delay after the request txn is released is not 422", () => {
    expect(
      evaluateTxnCeiling({
        generateStartedWhileTxnOpen: false,
        generateDurationMs: COLD_DELAY_MS,
        ceilingMs: SHORT_CEILING_MS,
      }),
    ).toEqual({ ok: true });
  });
});

describe("MAIN interleaving vs runExecuteDistillation (injected cold delay)", () => {
  test("fails-first: generate while the request txn is still open + cold delay → 422", async () => {
    expect(COLD_DELAY_MS).toBeGreaterThan(SHORT_CEILING_MS);
    const txn = new SimulatedRequestTxn(() => performance.now(), SHORT_CEILING_MS);
    txn.start();

    let status = 200;
    try {
      // MAIN: the generative call joins the still-open request txn (accounting
      // write) and then blocks on a cold backend past the ceiling.
      txn.addWrite();
      await delay(COLD_DELAY_MS);
      txn.addWrite();
      txn.commit();
    } catch (err: any) {
      status = err?.status ?? 500;
    }

    expect(status).toBe(422);
    expect(evaluateTxnCeiling({
      generateStartedWhileTxnOpen: true,
      generateDurationMs: COLD_DELAY_MS,
      ceilingMs: SHORT_CEILING_MS,
    })).toEqual({ status: 422 });
  });

  test("release → generate → write survives the same injected cold delay", async () => {
    const txn = new SimulatedRequestTxn(() => performance.now(), SHORT_CEILING_MS);
    txn.start();
    const events: string[] = [];

    const staged = await runExecuteDistillation({
      releaseRequestTxn: async () => {
        events.push("release");
        await releaseRequestTransaction({
          transaction: {
            commit: ({ doneWriting } = {}) => {
              expect(doneWriting).toBe(true);
              txn.commit();
            },
          },
        });
        expect(txn.open).toBe(false);
        expect(txn.timedOut).toBe(false);
      },
      generate: async () => {
        events.push("generate");
        expect(txn.open).toBe(false);
        await delay(COLD_DELAY_MS);
        // Generate-side accounting writes must not rejoin the released txn.
        txn.addWrite();
        return { candidates: [{ claim: "ok" }] };
      },
      write: async (generated) => {
        events.push("write");
        txn.addWrite();
        return generated;
      },
    });

    expect(events).toEqual(["release", "generate", "write"]);
    expect(staged).toEqual({ candidates: [{ claim: "ok" }] });
    expect(txn.timedOut).toBe(false);
    expect(evaluateTxnCeiling({
      generateStartedWhileTxnOpen: false,
      generateDurationMs: COLD_DELAY_MS,
      ceilingMs: SHORT_CEILING_MS,
    })).toEqual({ ok: true });
  });

  test("releaseRequestTransaction commits doneWriting and detaches ctx.transaction", async () => {
    const commits: unknown[] = [];
    const ctx: { transaction?: { commit: (opts?: { doneWriting?: boolean }) => void } } = {
      transaction: {
        commit: (opts) => {
          commits.push(opts);
        },
      },
    };
    await releaseRequestTransaction(ctx);
    expect(commits).toEqual([{ doneWriting: true }]);
    expect(ctx.transaction).toBeUndefined();
  });

  test("releaseRequestTransaction is a no-op without a context transaction", async () => {
    await releaseRequestTransaction(undefined);
    await releaseRequestTransaction({});
    await releaseRequestTransaction({ transaction: {} });
  });

  test("optional warm runs after release and before generate", async () => {
    const events: string[] = [];
    await runExecuteDistillation({
      releaseRequestTxn: () => {
        events.push("release");
      },
      warm: () => {
        events.push("warm");
      },
      generate: async () => {
        events.push("generate");
        return "g";
      },
      write: async (g) => {
        events.push("write");
        return g;
      },
    });
    expect(events).toEqual(["release", "warm", "generate", "write"]);
  });
});

describe("MemoryReflect.ts must use the #1263 helper (fails on main)", () => {
  test("the resource does not call models.generate() directly", () => {
    expect(MEMORY_REFLECT_SRC).not.toMatch(/models\.generate\s*\(/);
    expect(MEMORY_REFLECT_SRC).toContain("reflectModelsGenerate");
  });

  test("execute-mode generateCandidates is only invoked from runExecuteDistillation", () => {
    expect(MEMORY_REFLECT_SRC).toContain("runExecuteDistillation");
    expect(MEMORY_REFLECT_SRC).toContain("releaseRequestTransaction");

    const executeIdx = MEMORY_REFLECT_SRC.indexOf("execute mode (spec §3A)");
    expect(executeIdx).toBeGreaterThan(0);
    const generateIdx = MEMORY_REFLECT_SRC.indexOf("generateCandidates({", executeIdx);
    const helperIdx = MEMORY_REFLECT_SRC.indexOf("runExecuteDistillation({", executeIdx);
    expect(helperIdx).toBeGreaterThan(0);
    expect(generateIdx).toBeGreaterThan(helperIdx);

    const releaseIdx = MEMORY_REFLECT_SRC.indexOf("releaseRequestTransaction(ctx)", executeIdx);
    expect(releaseIdx).toBeGreaterThan(0);
    expect(releaseIdx).toBeLessThan(generateIdx);

    const binderIdx = MEMORY_REFLECT_SRC.indexOf("generate: reflectModelsGenerate", executeIdx);
    expect(binderIdx).toBeGreaterThan(helperIdx);
  });
});
