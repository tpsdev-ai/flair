// with-detached-txn-1897.test.ts — the awaited-detach contract (flair#1897).
//
// `withDetachedTxn` restores ctx.transaction when fn RETURNS (for an async fn:
// when the promise is created); `withDetachedTxnAsync` holds it until the
// promise settles. A reader that selects its transaction AFTER an async pause
// therefore reads STALE under the sync wrapper and FRESH under the awaited one —
// the read path in Federation.ts uses the awaited variant for the same reason as
// the write (flair#1897 round 3).

import { describe, it, expect } from "bun:test";
import { withDetachedTxn, withDetachedTxnAsync } from "../../resources/table-helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

/** A reader that picks its transaction AFTER an async pause. */
async function readAfterPause(ctx: { transaction: unknown }): Promise<"detached" | "joined"> {
  await tick();
  return ctx.transaction === undefined ? "detached" : "joined";
}

describe("withDetachedTxnAsync holds the detach through settlement (flair#1897)", () => {
  it("the AWAITED wrapper keeps the transaction detached across an async read", async () => {
    const ctx = { transaction: { requestTxn: true } as unknown };
    expect(await withDetachedTxnAsync(ctx, () => readAfterPause(ctx))).toBe("detached");
    expect((ctx as any).transaction).toEqual({ requestTxn: true }); // restored after
  });

  it("the SYNC wrapper restores early — an async reader reads the JOINED request transaction", async () => {
    const ctx = { transaction: { requestTxn: true } as unknown };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await Promise.resolve((withDetachedTxn as any)(ctx, () => readAfterPause(ctx)));
    expect(out).toBe("joined");
  });
});
