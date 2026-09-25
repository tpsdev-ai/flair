import { describe, it, expect, mock, beforeEach, afterEach, jest } from "bun:test";
import {
  runCleanupTick,
  initFederationCleanup,
  runSweepTick,
  stopFederationCleanup,
  listUsernamesOrNull,
  BOOTSTRAP_USER_PREFIX,
  type SweepLogState,
} from "../../resources/federation-cleanup.js";

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

function createMockDb(tokens: any[], instanceRows: any[] = []) {
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
      Instance: {
        search: () => fromArray(instanceRows),
      },
    },
  };
}

/** A db whose Instance table is read fresh on every search (role can change). */
function createLiveDb(getInstanceRows: () => any[], tokens: any[] = []) {
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
      PairingToken: { search: () => fromArray(tokens) },
      Instance: { search: () => fromArray(getInstanceRows()) },
    },
  };
}

/** A serverOp stub that answers every call and records it. */
function recordingServerOp(opts?: { users?: string[]; fail?: Error }) {
  const captured: any[] = [];
  const fn = mock(async (body: any) => {
    captured.push(body);
    if (opts?.fail) throw opts.fail;
    if (body.operation === "list_users") {
      return (opts?.users ?? []).map((username) => ({ username }));
    }
    return { ok: true };
  });
  return { fn, captured };
}

function captureLog(): { lines: string[]; errors: string[]; log: Pick<Console, "log" | "error"> } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: {
      log: (...args: any[]) => lines.push(args.map(String).join(" ")),
      error: (...args: any[]) => errors.push(args.map(String).join(" ")),
    } as unknown as Pick<Console, "log" | "error">,
  };
}

/**
 * Let a faked-out interval callback finish. bun has no
 * `advanceTimersByTimeAsync`, so after `jest.advanceTimersByTime(...)` the tick's
 * promise chain is drained by yielding to the microtask queue — the sweep awaits
 * no real timer (only the db and serverOp mocks), so microtasks are all it needs.
 */
async function settleTicks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
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
      expect(captured[1].body.hash_values).toEqual([tId]);
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
      expect(deleteCalls[0].body.hash_values).toEqual(["tok_X2_expired__BBBB"]);
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
      expect(captured[3].body.hash_values).toEqual(["tok_Y2_expired"]);
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
    afterEach(() => {
      stopFederationCleanup();
    });

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
      // A hub tick lists the bootstrap users, then sweeps (flair#1883): with an
      // empty token table and no bootstrap users there is nothing to drop, but
      // the read happens — that read is what makes the sweep user-driven.
      const { fn: serverOp, captured } = createMockServerOp([{ ok: true, data: [] }]);

      await initFederationCleanup({
        instanceRole: "hub",
        serverOp,
        db: db as any,
        immediateTick: true,
      });

      // immediateTick should have called runSweepTick, which lists users and
      // then queries the empty token table → 0 drop/delete ops calls.
      expect(captured.map((c) => c.body.operation)).toEqual(["list_users"]);
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

  // ── flair#1883: the sweep follows the role, not the startup moment ─────────

  describe("runSweepTick — the role is re-read every tick", () => {
    it("a hub row written AFTER startup starts the sweep, with no restart", async () => {
      let instanceRows: any[] = [];
      const db = createLiveDb(
        () => instanceRows,
        [makeToken("tok_after_hub_AA", { consumedBy: "instance-x" })],
      );
      const { fn: serverOp, captured } = recordingServerOp();

      const first = await runSweepTick({ serverOp, db: db as any, state: { last: null } });
      expect(first).toBe("not-hub");
      expect(captured).toHaveLength(0);

      // The identity row appears after the process started — the seed runs after
      // the server is up, which is exactly when the old one-time read missed it.
      instanceRows = [{ id: "flair_hub_after", role: "hub", createdAt: "2026-09-25T00:00:00Z" }];

      const second = await runSweepTick({ serverOp, db: db as any, state: { last: null } });
      expect(second).toBe("hub");
      expect(captured.map((c) => c.operation)).toEqual(["list_users", "drop_user"]);
      expect(captured[1].username).toBe(`${BOOTSTRAP_USER_PREFIX}tok_afte`);
    });

    it("two Instance rows is a logged error naming the remedy, and no sweep", async () => {
      const db = createMockDb(
        [makeToken("tok_two_rows_A", { consumedBy: "instance-x" })],
        [{ id: "flair_a", role: "hub" }, { id: "flair_b", role: "spoke" }],
      );
      const { fn: serverOp, captured } = recordingServerOp();
      const { errors, log } = captureLog();

      const mode = await runSweepTick({ serverOp, db: db as any, state: { last: null }, log });

      expect(mode).toBe("multiple");
      expect(captured).toHaveLength(0);
      const text = errors.join("\n");
      expect(text).toContain("more than one Instance row");
      expect(text).toContain("flair federation instance prune --keep <id>");
    });

    it("a failed Instance read is unreadable, not a spoke — and no sweep", async () => {
      const db = {
        flair: {
          PairingToken: { search: () => [] as any },
          Instance: {
            search: () => {
              throw new Error("table does not exist");
            },
          },
        },
      };
      const { fn: serverOp, captured } = recordingServerOp();
      const { lines, log } = captureLog();

      const mode = await runSweepTick({ serverOp, db: db as any, state: { last: null }, log });

      expect(mode).toBe("unreadable");
      expect(captured).toHaveLength(0);
      expect(lines.join("\n")).toContain("could not read the Instance table");
    });

    it("a steady mode is logged once, not on every tick", async () => {
      const db = createMockDb([], [{ id: "flair_spoke_only", role: "spoke" }]);
      const { fn: serverOp } = recordingServerOp();
      const { lines, log } = captureLog();
      const state: SweepLogState = { last: null };

      await runSweepTick({ serverOp, db: db as any, state, log });
      await runSweepTick({ serverOp, db: db as any, state, log });
      await runSweepTick({ serverOp, db: db as any, state, log });

      expect(lines).toHaveLength(1);
    });

    it("lists users once and passes them to the sweep", async () => {
      const db = createMockDb([], [{ id: "flair_hub_users", role: "hub" }]);
      const { fn: serverOp, captured } = recordingServerOp({
        users: [`${BOOTSTRAP_USER_PREFIX}deadbeef`],
      });

      await runSweepTick({ serverOp, db: db as any, state: { last: null } });

      expect(captured.map((c) => c.operation)).toEqual(["list_users", "drop_user"]);
      expect(captured[1].username).toBe(`${BOOTSTRAP_USER_PREFIX}deadbeef`);
    });

    it("a failed user list does not stop the token-driven sweep", async () => {
      const db = createMockDb(
        [makeToken("tok_tokensonly_A", { consumedBy: "instance-x" })],
        [{ id: "flair_hub_z", role: "hub" }],
      );
      let calls = 0;
      const captured: any[] = [];
      const serverOp = mock(async (body: any) => {
        calls++;
        captured.push(body);
        if (body.operation === "list_users") throw new Error("list_users refused");
        return { ok: true };
      });

      await runSweepTick({ serverOp, db: db as any, state: { last: null } });

      expect(calls).toBe(2);
      expect(captured.map((c) => c.operation)).toEqual(["list_users", "drop_user"]);
      expect(captured[1].username).toBe(`${BOOTSTRAP_USER_PREFIX}tok_toke`);
    });
  });

  describe("initFederationCleanup — installed on every instance", () => {
    afterEach(() => {
      stopFederationCleanup();
      jest.useRealTimers();
    });

    it("re-reads the role on a later tick: a hub row appearing after startup begins sweeping", async () => {
      // The tick is driven by the INSTALLED interval (not by calling runSweepTick),
      // and the clock is advanced explicitly: a 20 ms cadence plus a real 120 ms
      // wait flaked under CI load, when the callback ran late (flair#1883 round 5).
      jest.useFakeTimers();
      let instanceRows: any[] = [];
      const db = createLiveDb(
        () => instanceRows,
        [makeToken("tok_timer_hub_AA", { consumedBy: "instance-y" })],
      );
      const { fn: serverOp, captured } = recordingServerOp();

      await initFederationCleanup({ serverOp, db: db as any, intervalMs: 20, immediateTick: true });
      try {
        // First tick saw no row: nothing swept.
        expect(captured).toHaveLength(0);

        instanceRows = [{ id: "flair_hub_timer", role: "hub" }];
        jest.advanceTimersByTime(120);
        await settleTicks();

        expect(captured.map((c) => c.operation)).toContain("list_users");
        expect(captured.map((c) => c.operation)).toContain("drop_user");
      } finally {
        stopFederationCleanup();
      }
    });

    it("an explicit spoke role installs the sweep but never runs it", async () => {
      // Same discipline: the interval IS installed (that is what this case
      // covers), and time passing on the faked clock must produce no call.
      jest.useFakeTimers();
      const db = createMockDb([]);
      const { fn: serverOp, captured } = recordingServerOp();

      await initFederationCleanup({ instanceRole: "spoke", serverOp, db: db as any, intervalMs: 20 });
      jest.advanceTimersByTime(80);
      await settleTicks();

      expect(captured).toHaveLength(0);
      stopFederationCleanup();
      const afterStop = captured.length;
      jest.advanceTimersByTime(60);
      await settleTicks();
      expect(captured.length).toBe(afterStop);
    });
  });

  // ── flair#1883: the sweep is user-driven too ───────────────────────────────

  describe("runCleanupTick — user-driven pass", () => {
    const now = new Date("2026-05-05T22:00:00Z");

    it("drops a pair-bootstrap user whose token record is gone", async () => {
      const db = createMockDb([]); // no tokens at all
      const { fn: serverOp, captured } = createMockServerOp([{ ok: true }]);

      await runCleanupTick({ serverOp, db: db as any, now, users: [`${BOOTSTRAP_USER_PREFIX}deadbeef`] });

      expect(captured).toHaveLength(1);
      expect(captured[0].body.operation).toBe("drop_user");
      expect(captured[0].body.username).toBe(`${BOOTSTRAP_USER_PREFIX}deadbeef`);
    });

    it("leaves a user whose token is live and unexpired", async () => {
      const db = createMockDb([
        makeToken("cafebabe_live_token", { expiresAt: new Date("2026-05-05T23:00:00Z").toISOString() }),
      ]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      await runCleanupTick({ serverOp, db: db as any, now, users: [`${BOOTSTRAP_USER_PREFIX}cafebabe`] });

      expect(captured).toHaveLength(0);
    });

    it("drops a user once when its consumed token is also a token candidate", async () => {
      const db = createMockDb([makeToken("cafebabe_consumed_token", { consumedBy: "instance-z" })]);
      const { fn: serverOp, captured } = createMockServerOp([{ ok: true }]);

      await runCleanupTick({ serverOp, db: db as any, now, users: [`${BOOTSTRAP_USER_PREFIX}cafebabe`] });

      const drops = captured.filter((c) => c.body.operation === "drop_user");
      expect(drops).toHaveLength(1);
      expect(drops[0].body.username).toBe(`${BOOTSTRAP_USER_PREFIX}cafebabe`);
    });

    it("drops a user whose token is expired, and still deletes that token", async () => {
      const db = createMockDb([
        makeToken("feedface_expired_token", { expiresAt: new Date("2026-05-05T21:00:00Z").toISOString() }),
      ]);
      const { fn: serverOp, captured } = createMockServerOp([{ ok: true }, { ok: true }]);

      await runCleanupTick({ serverOp, db: db as any, now, users: [`${BOOTSTRAP_USER_PREFIX}feedface`] });

      expect(captured.map((c) => c.body.operation)).toEqual(["drop_user", "delete"]);
      expect(captured[1].body.hash_values).toEqual(["feedface_expired_token"]);
    });

    it("never drops a non-bootstrap user, even if one is handed to it", async () => {
      const db = createMockDb([]);
      const { fn: serverOp, captured } = createMockServerOp([]);

      await runCleanupTick({ serverOp, db: db as any, now, users: ["admin", "flair-agent"] });

      expect(captured).toHaveLength(0);
    });

    it("null users (the list did not read) skips only the user pass", async () => {
      const db = createMockDb([makeToken("tok_null_users_A", { consumedBy: "instance-n" })]);
      const { fn: serverOp, captured } = createMockServerOp([{ ok: true }]);

      await runCleanupTick({ serverOp, db: db as any, now, users: null });

      expect(captured).toHaveLength(1);
      expect(captured[0].body.operation).toBe("drop_user");
    });
  });

  describe("listUsernamesOrNull", () => {
    it("keeps only the pair-bootstrap names", async () => {
      const svr = mock(async () => [
        { username: "admin" },
        { username: `${BOOTSTRAP_USER_PREFIX}aaaaaaaa` },
        { user: { username: `${BOOTSTRAP_USER_PREFIX}bbbbbbbb` } },
      ]);
      expect(await listUsernamesOrNull(svr)).toEqual([
        `${BOOTSTRAP_USER_PREFIX}aaaaaaaa`,
        `${BOOTSTRAP_USER_PREFIX}bbbbbbbb`,
      ]);
    });

    it("returns null when the list fails", async () => {
      const svr = mock(async () => {
        throw new Error("list_users refused");
      });
      const { log } = captureLog();
      expect(await listUsernamesOrNull(svr, log)).toBeNull();
    });
  });
});
