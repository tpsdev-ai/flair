import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { runCleanupTick, initFederationCleanup } from "../../resources/federation-cleanup.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeToken(id: string, opts: {
  consumedBy?: string;
  consumesAt?: string;
  expiresAt?: string;
} = {}) {
  return {
    id,
    consumedBy: opts.consumedBy ?? null,
    consumedAt: opts.consumesAt ?? null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
  };
}

function tokenId(id: string) {
  return id.slice(0, 8);
}

// ─── Mock factories ──────────────────────────────────────────────────────────

interface CapturedOp {
  body: Record<string, unknown>;
  ctx: Record<string, unknown>;
  authorize: boolean;
}

function createMockServerOp(
  responses: Array<{ ok: true; data?: any } | { ok: false; error: Error }>,
) {
  let idx = 0;
  const captured: CapturedOp[] = [];
  const fn = mock(async (body: Record<string, unknown>, ctx: Record<string, unknown>, authorize: boolean) => {
    captured.push({ body, ctx, authorize });
    const resp = responses[idx++];
    if (!resp) throw new Error(`Unexpected serverOp call #${idx}`);
    if (!resp.ok) throw resp.error;
    return resp.data ?? { message: "ok" };
  });
  return { fn, captured };
}

function createMockDb(tokens: any[]) {
  // async iterable from an array
  function fromArray<T>(items: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < items.length) return { value: items[i++], done: false };
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }

  return {
    flair: {
      PairingToken: {
        search: () => fromArray(tokens),
      },
    },
  };
}

// ─── Tests: runCleanupTick ───────────────────────────────────────────────────

describe("federation-cleanup sweep", () => {
  describe("runCleanupTick", () => {
    it("sweep skips tokens neither consumed nor expired", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokens = [
        makeToken("token_A_pending_ABCD", {
          expiresAt: new Date("2026-05-05T23:00:00Z").toISOString(),
        }), // not consumed, not expired → skip
      ];

      const db = createMockDb(tokens);
      const { fn: serverOp, captured } = createMockServerOp([]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(0);
    });

    it("sweep deletes user for consumed token", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tId = "token_B_consumed_ABCDEF01";
      const tokens = [
        makeToken(tId, {
          consumedBy: "instance-xyz",
          expiresAt: new Date("2026-05-05T22:30:00Z").toISOString(),
        }),
      ];

      const db = createMockDb(tokens);
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: true, data: { message: "user dropped" } },
      ]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(1);
      const call = captured[0];
      expect(call.body.operation).toBe("drop_user");
      expect(call.body.username).toBe(`pair-bootstrap-${tokenId(tId)}`);
      expect(call.authorize).toBe(false);

      // Should NOT delete the token record (audit trail)
      const deleteCalls = captured.filter((c) => c.body.operation === "delete");
      expect(deleteCalls).toHaveLength(0);
    });

    it("sweep deletes user AND record for expired unconsumed token", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tId = "token_C_expired_XYZ12345";
      const tokens = [
        makeToken(tId, {
          expiresAt: new Date("2026-05-05T21:00:00Z").toISOString(), // expired
        }),
      ];

      const db = createMockDb(tokens);
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: true, data: { message: "user dropped" } },  // drop_user
        { ok: true, data: { message: "deleted 1 record" } },  // delete token record
      ]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(2);

      // First call: drop_user
      expect(captured[0].body.operation).toBe("drop_user");
      expect(captured[0].body.username).toBe(`pair-bootstrap-${tokenId(tId)}`);

      // Second call: delete token record
      expect(captured[1].body.operation).toBe("delete");
      expect(captured[1].body.database).toBe("flair");
      expect(captured[1].body.table).toBe("PairingToken");
      expect(captured[1].body.hash_value).toBe(tId);
    });

    it("sweep keeps record (just deletes user) for consumed token", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokenId = "token_D_consumed_KEEPIT99";
      const tokens = [
        makeToken(tokenId, {
          consumedBy: "instance-other",
          expiresAt: new Date("2026-05-04T12:00:00Z").toISOString(), // also expired
        }),
      ];

      const db = createMockDb(tokens);
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: true, data: { message: "user dropped" } },
      ]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(1);
      expect(captured[0].body.operation).toBe("drop_user");

      // Even though expired, since consumed, do NOT delete the record
      const deleteCalls = captured.filter((c) => c.body.operation === "delete");
      expect(deleteCalls).toHaveLength(0);
    });

    it("drop_user 404 (user already gone) is swallowed", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokenId = "token_E_gone_GHOST404";
      const tokens = [
        makeToken(tokenId, {
          consumedBy: "instance-gone",
        }),
      ];

      const db = createMockDb(tokens);
      const fourOhFour = { statusCode: 404, message: "User 'pair-bootstrap-token_E_' does not exist" } as any;
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: false, error: fourOhFour },
      ]);

      // Should not throw
      await expect(
        runCleanupTick({ serverOp, db: db as any, now }),
      ).resolves.toBeUndefined();

      expect(captured).toHaveLength(1);
      expect(captured[0].body.operation).toBe("drop_user");
    });

    it("drop_user 404 with 'not found' message is swallowed (alternative)", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokenId = "token_F_gone2_NOTFND";
      const tokens = [
        makeToken(tokenId, {
          consumedBy: "instance-gone2",
        }),
      ];

      const db = createMockDb(tokens);
      const notFound = { statusCode: 404, message: "user not found in system" } as any;
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: false, error: notFound },
      ]);

      await expect(
        runCleanupTick({ serverOp, db: db as any, now }),
      ).resolves.toBeUndefined();

      expect(captured).toHaveLength(1);
    });

    it("drop_user other errors NOT swallowed", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokenId = "token_G_realerr_500";
      const tokens = [
        makeToken(tokenId, {
          consumedBy: "instance-realerr",
        }),
      ];

      const db = createMockDb(tokens);
      const realErr = { statusCode: 500, message: "internal server error" } as any;
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: false, error: realErr },
        // Should still try the delete for housekeeping
        { ok: true },
        { ok: true },
      ]);

      // Should NOT throw — the error is caught and logged inside runCleanupTick
      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(1);
      expect(captured[0].body.operation).toBe("drop_user");
    });

    it("handles empty PairingToken table gracefully", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const db = createMockDb([]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(0);
    });

    it("handles multiple mixed tokens in one sweep", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokens = [
        makeToken("tok_X1_consumed_AAAA", { consumedBy: "x1" }),
        makeToken("tok_X2_expired__BBBB", {
          expiresAt: new Date("2026-05-04T12:00:00Z").toISOString(),
        }),
        makeToken("tok_X3_pending__CCCC", {
          expiresAt: new Date("2026-05-05T22:30:00Z").toISOString(),
        }), // not expired, not consumed → skipped
        makeToken("tok_X4_consumed_DDDD", { consumedBy: "x4" }),
      ];

      const db = createMockDb(tokens);
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: true }, // drop tok_X1
        { ok: true }, // drop tok_X2
        { ok: true }, // delete tok_X2
        { ok: true }, // drop tok_X4
      ]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(4);

      const dropCalls = captured.filter((c) => c.body.operation === "drop_user");
      expect(dropCalls).toHaveLength(3);
      expect(dropCalls[0].body.username).toBe("pair-bootstrap-tok_X1_c");
      expect(dropCalls[1].body.username).toBe("pair-bootstrap-tok_X2_e");
      expect(dropCalls[2].body.username).toBe("pair-bootstrap-tok_X4_c");

      const deleteCalls = captured.filter((c) => c.body.operation === "delete");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].body.hash_value).toBe("tok_X2_expired__BBBB");
    });

    it("delete token record error does not prevent processing other tokens", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const tokens = [
        makeToken("tok_Y1_expired", {
          expiresAt: new Date("2026-05-04T12:00:00Z").toISOString(),
        }),
        makeToken("tok_Y2_expired", {
          expiresAt: new Date("2026-05-04T13:00:00Z").toISOString(),
        }),
      ];

      const db = createMockDb(tokens);
      const deleteErr = { statusCode: 500, message: "db error on delete" } as any;
      const { fn: serverOp, captured } = createMockServerOp([
        { ok: true },           // drop tok_Y1
        { ok: false, error: deleteErr }, // delete tok_Y1 fails
        { ok: true },           // drop tok_Y2
        { ok: true },           // delete tok_Y2 succeeds
      ]);

      await runCleanupTick({ serverOp, db: db as any, now });

      expect(captured).toHaveLength(4);
      expect(captured[2].body.operation).toBe("drop_user");
      expect(captured[3].body.operation).toBe("delete");
      expect(captured[3].body.hash_value).toBe("tok_Y2_expired");
    });

    it("handles search failure gracefully (returns without throwing)", async () => {
      const now = new Date("2026-05-05T22:00:00Z");
      const failingDb = {
        flair: {
          PairingToken: {
            search: () => {
              throw new Error("table does not exist");
            },
          },
        },
      };
      const { fn: serverOp, captured } = createMockServerOp([]);

      await expect(
        runCleanupTick({ serverOp, db: failingDb as any, now }),
      ).resolves.toBeUndefined();

      expect(captured).toHaveLength(0);
    });
  });

  // ── Hub-vs-spoke guard ─────────────────────────────────────────────────────

  describe("initFederationCleanup hub guard", () => {
    it("spoke role → cleanup is a no-op", async () => {
      const db = createMockDb([]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      // Init with explicit role="spoke" + immediateTick=false so we just
      // check the role guard path.
      initFederationCleanup({
        instanceRole: "spoke",
        serverOp,
        db: db as any,
        immediateTick: false,
      });

      // Let the async rolePromise resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(captured).toHaveLength(0);
    });

    it("hub role → cleanup starts", async () => {
      const db = createMockDb([]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      initFederationCleanup({
        instanceRole: "hub",
        serverOp,
        db: db as any,
        immediateTick: true,
      });

      // Let the async rolePromise + immediate tick run
      await new Promise((resolve) => setTimeout(resolve, 100));

      // immediateTick should have called runCleanupTick, which queries the
      // empty table → 0 ops calls, but tick completed (no rejection)
      expect(captured).toHaveLength(0);
    });

    it("no instance record → treated as no-op (role is null)", async () => {
      const db = createMockDb([]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      initFederationCleanup({
        instanceRole: null,  // no instance record / role unknown
        serverOp,
        db: db as any,
        immediateTick: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(captured).toHaveLength(0);
    });
  });
});
