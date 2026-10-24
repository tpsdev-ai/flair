// flair#2478 part 3a — the lock token (resources/memory-write-lock.ts) and the
// locked transaction scope (resources/memory-write-transaction.ts), with a lock
// double and the unit lane's mock transaction. The checked Memory writes that
// use them are covered in memory-checked-write-2478.test.ts and, through real
// Harper, in test/integration/memory-archive-lock-2478.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  MemoryWriteCapabilityError,
  assertMemoryWriteLockToken,
  memoryLockKey,
  memoryWriteLockTokenIds,
  withMemoryWriteLock,
  withMemoryWriteLockOnce,
  type MemoryWriteLockToken,
} from "../../resources/memory-write-lock.ts";
import {
  LockedScopeRefusedError,
  admitLockedMemoryWrite,
  withLockedMemoryTransaction,
  type LockedMemoryTransaction,
  type MemoryWriteReceipt,
} from "../../resources/memory-write-transaction.ts";
import { mockTransaction } from "../helpers/memory-search-harness";

/** A store with Harper's non-blocking per-key tryLock / unlock; `onUnlock` runs before each release. */
function fakeStore(onUnlock?: () => void) {
  const held = new Set<string>();
  const events: string[] = [];
  return {
    held,
    events,
    tryLock(key: unknown) {
      const k = JSON.stringify(key);
      if (held.has(k)) return false;
      held.add(k);
      events.push(`lock:${k}`);
      return true;
    },
    unlock(key: unknown) {
      onUnlock?.();
      const k = JSON.stringify(key);
      events.push(`unlock:${k}`);
      held.delete(k);
    },
    resetReadTxn() {},
  };
}

const KEY_A = JSON.stringify(memoryLockKey("a"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The capability refusal reason `fn` throws, or "none". */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    if (err instanceof MemoryWriteCapabilityError) return err.reason;
    throw err;
  }
}
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (err) {
    if (err instanceof MemoryWriteCapabilityError) return err.reason;
    throw err;
  }
}

/** Admit one write into `tx` that stages (or returns `refused`) after `ms`,
 *  logging its settlement and, after a commit, its post-commit tail. */
function stagedWrite(held: unknown, tx: unknown, store: unknown, log: string[], ms = 30, refused?: Response): Promise<MemoryWriteReceipt> {
  const admission = admitLockedMemoryWrite(held, tx, store, ["a"]);
  return admission.track("a", async (stage) => {
    await sleep(ms);
    log.push("write-settled");
    if (refused) return refused;
    if (!(await stage())) return undefined;
    log.push("tail");
    return { answered: true };
  });
}

let savedTransaction: unknown;
beforeAll(() => {
  savedTransaction = (globalThis as any).transaction;
  (globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
    const result = mockTransaction(ctx, cb);
    const txn = ctx.transaction;
    const log: string[] | undefined = ctx.log;
    // Record when the mock transaction committed or aborted.
    return Promise.resolve(result).then(
      (value) => { log?.push(txn.aborted ? "aborted" : "committed"); return value; },
      (error) => { log?.push("aborted"); throw error; },
    );
  };
});
afterAll(() => {
  (globalThis as any).transaction = savedTransaction;
});

describe("the lock token (flair#2478 part 3a)", () => {
  test("the genuine token passes; a fabricated, copied or derived object is not a token", async () => {
    const store = fakeStore();
    await withMemoryWriteLock(store, ["a"], async (held) => {
      expect(refusal(() => assertMemoryWriteLockToken(held, { store, ids: ["a"] }))).toBe("none");
      expect(Object.isFrozen(held)).toBe(true);
      expect(Reflect.ownKeys(held)).toEqual([]);
      for (const forged of [{}, { ...held }, Object.create(held), null, undefined, "a"]) {
        expect(refusal(() => assertMemoryWriteLockToken(forged, { store, ids: ["a"] }))).toBe("not_a_token");
      }
    });
  });

  test("a partial acquisition mints no token and runs no callback", async () => {
    const store = fakeStore();
    store.tryLock(memoryLockKey("b"));
    let minted: MemoryWriteLockToken | undefined;
    expect(await withMemoryWriteLockOnce(store, ["a", "b"], async (held) => { minted = held; })).toEqual({ kind: "busy" });
    expect(minted).toBeUndefined();
    expect(store.held.has(KEY_A)).toBe(false);
  });

  test("a token is revoked when its acquisition settles, and before its keys are released", async () => {
    let held: MemoryWriteLockToken | undefined;
    const atUnlock: string[] = [];
    const store = fakeStore(() => atUnlock.push(refusal(() => assertMemoryWriteLockToken(held))));
    await withMemoryWriteLock(store, ["a"], async (token) => { held = token; });
    expect(atUnlock).toEqual(["revoked"]);
    expect(refusal(() => assertMemoryWriteLockToken(held))).toBe("revoked");
    // A throwing callback revokes too.
    await withMemoryWriteLock(store, ["a"], async (token) => { held = token; throw new Error("boom"); }).catch(() => {});
    expect(refusal(() => assertMemoryWriteLockToken(held))).toBe("revoked");
  });

  test("a token covers the store and ids it was acquired for, and no other", async () => {
    const store = fakeStore();
    const other = fakeStore();
    await withMemoryWriteLock(store, ["b", "a"], async (held) => {
      expect(memoryWriteLockTokenIds(held)).toEqual(["a", "b"]);
      expect(refusal(() => assertMemoryWriteLockToken(held, { store, ids: ["a", "b"] }))).toBe("none");
      expect(refusal(() => assertMemoryWriteLockToken(held, { store: other, ids: ["a"] }))).toBe("wrong_store");
      expect(refusal(() => assertMemoryWriteLockToken(held, { store, ids: ["c"] }))).toBe("id_not_covered");
      expect(refusal(() => assertMemoryWriteLockToken(held, { store, ids: ["a", "c"] }))).toBe("id_not_covered");
    });
  });

  test("existing callers that ignore the callback argument keep working", async () => {
    const store = fakeStore();
    expect(await withMemoryWriteLock(store, ["a"], async () => "value")).toEqual({ kind: "done", value: "value" });
    expect(await withMemoryWriteLockOnce(store, ["a"], async () => "once")).toEqual({ kind: "done", value: "once" });
    expect(store.held.size).toBe(0);
  });
});

describe("the locked transaction scope (flair#2478 part 3a)", () => {
  test("a write the work did not await is drained before the commit, and confirmed after it", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const result = await withMemoryWriteLock(store, ["a"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        const admission = admitLockedMemoryWrite(held, tx, store, ["a"]);
        void admission.track("a", async (stage) => {
          await sleep(30);
          ctx.log.push("write-settled");
          if (!(await stage())) return undefined;
          ctx.log.push(`confirm:${store.held.has(KEY_A) ? "locked" : "unlocked"}`);
          return { answered: true };
        });
        ctx.log.push("work-returned");
        return "work";
      }));
    expect(ctx.log).toEqual(["work-returned", "write-settled", "committed", "confirm:locked"]);
    expect(result).toEqual({ kind: "done", value: { kind: "committed", value: "work", confirmed: [{ answered: true }] } });
    expect(store.held.size).toBe(0);
  });

  test("a confirmation that fails answers its refusal, not committed success", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const refused = Response.json({ error: "stored_row_changed" }, { status: 409 });
    const result = await withMemoryWriteLock(store, ["a"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        const admission = admitLockedMemoryWrite(held, tx, store, ["a"]);
        await admission.track("a", async (stage) => ((await stage()) ? refused : undefined));
        return "work";
      }));
    expect(ctx.log).toEqual(["committed"]);
    expect(result).toEqual({ kind: "done", value: { kind: "refused", response: refused } });
  });

  test("a throwing confirmation does not stop the later staged writes from confirming", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const firstError = new Error("first confirmation failed");
    const run = withMemoryWriteLock(store, ["a", "b", "c"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        const a = admitLockedMemoryWrite(held, tx, store, ["a"]);
        const b = admitLockedMemoryWrite(held, tx, store, ["b"]);
        const c = admitLockedMemoryWrite(held, tx, store, ["c"]);
        void a.track("a", async (stage) => {
          await sleep(5);
          const committed = await stage();
          ctx.log.push(`answer-a:${committed}:${store.held.has(KEY_A) ? "locked" : "unlocked"}`);
          if (committed) throw firstError;
        });
        void b.track("b", async (stage) => {
          await sleep(10);
          const committed = await stage();
          ctx.log.push(`answer-b:${committed}:${store.held.has(KEY_A) ? "locked" : "unlocked"}`);
          return committed ? { answered: "b" } : undefined;
        });
        void c.track("c", async (stage) => {
          await sleep(15);
          const committed = await stage();
          ctx.log.push(`answer-c:${committed}:${store.held.has(KEY_A) ? "locked" : "unlocked"}`);
          return committed ? { answered: "c" } : undefined;
        });
        return "work";
      }));
    await expect(run).rejects.toThrow("first confirmation failed");
    expect(ctx.log).toEqual(["committed", "answer-a:true:locked", "answer-b:true:locked", "answer-c:true:locked"]);
    expect(store.held.size).toBe(0);
  });

  test("a refused write aborts the transaction even when the work ignores it", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const response = Response.json({ error: "forbidden" }, { status: 403 });
    const result = await withMemoryWriteLock(store, ["a"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        void stagedWrite(held, tx, store, ctx.log, 5, response);
        return "work";
      }));
    expect(ctx.log).toEqual(["write-settled", "aborted"]);
    expect(result).toEqual({ kind: "done", value: { kind: "refused", response } });
  });

  test("a Response returned by the work aborts the transaction; a staged write ends without its tail", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const response = Response.json({ error: "memory_changed" }, { status: 409 });
    const result = await withMemoryWriteLock(store, ["a"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        expect(await stagedWrite(held, tx, store, ctx.log, 1)).toEqual({ status: "staged", id: "a" });
        return response;
      }));
    await sleep(10);
    expect(ctx.log).toEqual(["write-settled", "aborted"]);
    expect(result).toEqual({ kind: "done", value: { kind: "refused", response } });
  });

  test("a checked-write admission capability refusal inside the scope aborts it, even when the work catches it", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const run = withMemoryWriteLock(store, ["a"], (held) =>
      withLockedMemoryTransaction(held, ctx, async (tx) => {
        await stagedWrite(held, tx, store, ctx.log, 1);
        expect(refusal(() => admitLockedMemoryWrite(held, tx, store, ["b"]))).toBe("id_not_covered");
        return "work";
      }));
    expect(await refusalOf(run)).toBe("id_not_covered");
    expect(ctx.log).toEqual(["write-settled", "aborted"]);
    expect(store.held.size).toBe(0);
  });

  test("the lock waits for a scope the callback did not await, and its failure propagates", async () => {
    const store = fakeStore();
    const ctx: any = { log: [] as string[] };
    const run = withMemoryWriteLock(store, ["a"], async (held) => {
      void withLockedMemoryTransaction(held, ctx, async () => {
        await sleep(30);
        ctx.log.push(`scope-failed:${store.held.has(KEY_A) ? "locked" : "unlocked"}`);
        throw new Error("scope failure");
      }).catch(() => {});
      return "callback";
    });
    await expect(run).rejects.toThrow("scope failure");
    expect(ctx.log).toEqual(["scope-failed:locked", "aborted"]);
    expect(store.held.size).toBe(0);
  });

  test("the lock rejects with a refusal of a scope it did not await, before the commit or at its confirmation", async () => {
    for (const when of ["before the commit", "at the confirmation"]) {
      const store = fakeStore();
      const ctx: any = { log: [] as string[] };
      const refused = Response.json({ error: "probe_refusal" }, { status: 409 });
      const run = withMemoryWriteLock(store, ["a"], async (held) => {
        void withLockedMemoryTransaction(held, ctx, async (tx) => {
          await sleep(20);
          if (when === "before the commit") return refused;
          const admission = admitLockedMemoryWrite(held, tx, store, ["a"]);
          void admission.track("a", async (stage) => ((await stage()) ? refused : undefined));
          return "work";
        });
        return "callback";
      });
      const err = await run.catch((error) => error);
      expect(err, when).toBeInstanceOf(LockedScopeRefusedError);
      expect(err.response, when).toBe(refused);
      expect(ctx.log, when).toEqual([when === "before the commit" ? "aborted" : "committed"]);
      expect(store.held.size).toBe(0);
    }
  });

  test("a scope needs a live token: none, forged or revoked is refused, and one scope at a time", async () => {
    const store = fakeStore();
    const work = async () => "work";
    expect(await refusalOf(withLockedMemoryTransaction(undefined as any, {}, work))).toBe("not_a_token");
    expect(await refusalOf(withLockedMemoryTransaction({} as any, {}, work))).toBe("not_a_token");
    let saved: MemoryWriteLockToken | undefined;
    await withMemoryWriteLock(store, ["a"], async (held) => {
      saved = held;
      let release!: () => void;
      const first = withLockedMemoryTransaction(held, { log: [] }, () => new Promise<string>((resolve) => { release = () => resolve("first"); }));
      expect(await refusalOf(withLockedMemoryTransaction(held, { log: [] }, work))).toBe("scope_open");
      release();
      expect((await first).kind).toBe("committed");
      // Sequential scopes on one acquisition are admitted.
      expect((await withLockedMemoryTransaction(held, { log: [] }, work)).kind).toBe("committed");
    });
    expect(await refusalOf(withLockedMemoryTransaction(saved!, {}, work))).toBe("revoked");
  });

  test("a checked write is refused without a live token for the store and ids, or with another scope's handle", async () => {
    const store = fakeStore();
    const other = fakeStore();
    const seen: Record<string, string> = {};
    // Each admission refusal inside an open scope also aborts it; the scope's rejection is expected.
    const aborting = (scope: Promise<unknown>) => scope.then(() => "committed", (err) => (err instanceof MemoryWriteCapabilityError ? `aborted:${err.reason}` : "error"));
    let savedHeld: MemoryWriteLockToken | undefined;
    let savedTx: LockedMemoryTransaction | undefined;
    await withMemoryWriteLock(store, ["a"], async (held) => {
      savedHeld = held;
      await withLockedMemoryTransaction(held, { log: [] }, async (tx) => {
        savedTx = tx;
        return "first";
      });
      // A handle of a closed scope is refused, with a live token.
      seen.closedScope = refusal(() => admitLockedMemoryWrite(held, savedTx, store, ["a"]));
      seen.noTokenScope = await aborting(withLockedMemoryTransaction(held, { log: [] }, async (tx) => {
        seen.noToken = refusal(() => admitLockedMemoryWrite(undefined, tx, store, ["a"]));
        seen.forgedToken = refusal(() => admitLockedMemoryWrite({}, tx, store, ["a"]));
        seen.notATransaction = refusal(() => admitLockedMemoryWrite(held, {}, store, ["a"]));
        return "probe";
      }));
    });
    // Another acquisition's scope: the earlier token is revoked.
    await withMemoryWriteLock(store, ["a"], async (held) => {
      await aborting(withLockedMemoryTransaction(held, { log: [] }, async (tx) => {
        seen.revokedToken = refusal(() => admitLockedMemoryWrite(savedHeld, tx, store, ["a"]));
        return "probe";
      }));
    });
    // A live token from another store, and a live token with another acquisition's handle.
    await withMemoryWriteLock(other, ["a"], async (otherHeld) => {
      await withMemoryWriteLock(store, ["a"], async (held) => {
        await aborting(withLockedMemoryTransaction(held, { log: [] }, async (tx) => {
          seen.wrongStore = refusal(() => admitLockedMemoryWrite(otherHeld, tx, store, ["a"]));
          seen.otherAcquisition = refusal(() => admitLockedMemoryWrite(otherHeld, tx, other, ["a"]));
          return "probe";
        }));
      });
    });
    expect(seen).toEqual({
      closedScope: "transaction_closed",
      noToken: "not_a_token",
      forgedToken: "not_a_token",
      notATransaction: "not_a_transaction",
      noTokenScope: "aborted:not_a_token",
      revokedToken: "revoked",
      wrongStore: "wrong_store",
      otherAcquisition: "transaction_mismatch",
    });
  });
});
