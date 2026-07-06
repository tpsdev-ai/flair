/**
 * federation-nonce-store.test.ts — unit tests for the persistent NonceStore
 * backing (federation-edge-hardening slice 4).
 *
 * Covers:
 *   - the restart scenario: a nonce written by one store instance is seen
 *     as a replay by a FRESH store instance after hydrate() (simulating a
 *     process restart — the whole point of persisting the store)
 *   - the NonceStore interface contract still holds when composed with
 *     verifyBodySignatureFresh (existing sync call pattern, unmodified)
 *   - the eviction sweep (runNonceCleanupTick) deletes rows older than the
 *     retention window and keeps recent ones
 *   - additive-migration sanity: the Nonce table is new, no @export, and
 *     existing federation tables are untouched
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import {
  createPersistentNonceStore,
  runNonceCleanupTick,
  DEFAULT_RETENTION_MS,
} from "../../resources/federation-nonce-store.js";
import { signBodyFresh, verifyBodySignatureFresh } from "../../resources/federation-crypto.js";

// ─── Fake Harper `Nonce` table ────────────────────────────────────────────────
// Shared across store instances in a test to simulate real persistence
// surviving a "restart" (a fresh store object, same backing table).

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

function createFakeNonceTable() {
  const rows = new Map<string, { id: string; seenAt: number }>();
  return {
    rows,
    table: {
      async put(record: { id: string; seenAt: number }) {
        rows.set(record.id, { ...record });
      },
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      async delete(id: string) {
        rows.delete(id);
      },
      search() {
        return fromArray([...rows.values()]);
      },
    },
  };
}

function createFakeDb(nonceTable: ReturnType<typeof createFakeNonceTable>["table"]) {
  return { flair: { Nonce: nonceTable } };
}

// Persistence in createPersistentNonceStore's `set()` is fire-and-forget
// (not awaited by the caller). Give the microtask queue a turn so the
// background `db.flair.Nonce.put()` call resolves before assertions run.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createPersistentNonceStore — restart-replay (the whole point)", () => {
  it("a nonce written to the persistent store is seen as replay by a FRESH store instance", async () => {
    const { table } = createFakeNonceTable();
    const db = createFakeDb(table);

    // Process #1: records a nonce, then (conceptually) restarts.
    const storeBeforeRestart = createPersistentNonceStore({ db });
    const now = Date.now();
    storeBeforeRestart.set("nonce-abc-123", now);
    await flushMicrotasks(); // let the fire-and-forget put() land

    // Sanity: same-process store already sees it (unchanged in-memory behavior).
    expect(storeBeforeRestart.has("nonce-abc-123")).toBe(true);

    // Process #2: a completely FRESH store instance — new in-memory Map,
    // nothing set yet. This is what a restart looks like: the old in-memory
    // Map is gone, only the table survives.
    const storeAfterRestart = createPersistentNonceStore({ db });
    expect(storeAfterRestart.has("nonce-abc-123")).toBe(false); // not hydrated yet

    await storeAfterRestart.hydrate({ now: now + 1000 });

    // The nonce persisted by the PRE-restart process is now visible.
    expect(storeAfterRestart.has("nonce-abc-123")).toBe(true);
  });

  it("hydrate() skips rows older than the retention window (already-expired nonces aren't resurrected)", async () => {
    const { table } = createFakeNonceTable();
    const db = createFakeDb(table);
    const now = Date.now();

    await table.put({ id: "ancient-nonce", seenAt: now - 500_000 });
    await table.put({ id: "recent-nonce", seenAt: now - 1_000 });

    const store = createPersistentNonceStore({ db });
    await store.hydrate({ now, retentionMs: DEFAULT_RETENTION_MS });

    expect(store.has("ancient-nonce")).toBe(false);
    expect(store.has("recent-nonce")).toBe(true);
  });

  it("hydrate() on an empty table is a safe no-op", async () => {
    const { table } = createFakeNonceTable();
    const db = createFakeDb(table);

    const store = createPersistentNonceStore({ db });
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.has("anything")).toBe(false);
  });

  it("hydrate() swallows table errors (starts with an empty guard rather than throwing)", async () => {
    const failingDb = {
      flair: {
        Nonce: {
          search: () => {
            throw new Error("table does not exist");
          },
        },
      },
    };
    const store = createPersistentNonceStore({ db: failingDb });
    await expect(store.hydrate()).resolves.toBeUndefined();
  });
});

describe("createPersistentNonceStore — NonceStore interface contract", () => {
  it("has/set/evict behave exactly like the in-memory store within one process", () => {
    const store = createPersistentNonceStore({ db: createFakeDb(createFakeNonceTable().table) });
    expect(store.has("k")).toBe(false);
    store.set("k", 1000);
    expect(store.has("k")).toBe(true);
    store.evict(2000); // olderThan=2000, entry at ts=1000 → evicted
    expect(store.has("k")).toBe(false);
  });

  it("evict() only trims the in-memory cache — does not touch the table (table cleanup is the separate sweep)", async () => {
    const { table, rows } = createFakeNonceTable();
    const db = createFakeDb(table);
    const store = createPersistentNonceStore({ db });

    store.set("k", 1000);
    await flushMicrotasks();
    expect(rows.has("k")).toBe(true);

    store.evict(2000); // evicts in-memory
    expect(store.has("k")).toBe(false);
    // Table row is untouched by evict() — deletion is the periodic sweep's job.
    expect(rows.has("k")).toBe(true);
  });

  it("composes with verifyBodySignatureFresh exactly like createNonceStore — sync call site, no await needed", () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    const store = createPersistentNonceStore({ db: createFakeDb(createFakeNonceTable().table) });

    const signed = signBodyFresh({ instanceId: "spoke-1" }, secretKey);

    const first = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: store,
    });
    expect(first.ok).toBe(true);

    const second = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: store,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("replay");
  });

  it("a replay detected via verifyBodySignatureFresh survives a simulated restart against a fresh store", async () => {
    const kp = nacl.sign.keyPair();
    const secretKey = kp.secretKey;
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");
    const { table } = createFakeNonceTable();
    const db = createFakeDb(table);

    const storeBeforeRestart = createPersistentNonceStore({ db });
    const signed = signBodyFresh({ instanceId: "spoke-1" }, secretKey);

    const result = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: storeBeforeRestart,
    });
    expect(result.ok).toBe(true);
    await flushMicrotasks(); // let the background persist land

    // Restart: fresh store, hydrate from the surviving table.
    const storeAfterRestart = createPersistentNonceStore({ db });
    await storeAfterRestart.hydrate();

    // The SAME signed body, replayed against the post-restart instance, is
    // now rejected — this is the ±30s window the persistence closes.
    const replay = verifyBodySignatureFresh(signed, publicKeyB64url, {
      windowMs: 30_000,
      nonceStore: storeAfterRestart,
    });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("replay");
  });
});

describe("runNonceCleanupTick — eviction sweep", () => {
  it("deletes rows older than the retention window, keeps recent ones", async () => {
    const { table, rows } = createFakeNonceTable();
    const db = createFakeDb(table);
    const now = Date.now();

    await table.put({ id: "old-1", seenAt: now - 120_000 });
    await table.put({ id: "old-2", seenAt: now - 61_000 });
    await table.put({ id: "recent-1", seenAt: now - 5_000 });
    await table.put({ id: "recent-2", seenAt: now });

    const result = await runNonceCleanupTick({ db, now, retentionMs: DEFAULT_RETENTION_MS });

    expect(result.deleted).toBe(2);
    expect(rows.has("old-1")).toBe(false);
    expect(rows.has("old-2")).toBe(false);
    expect(rows.has("recent-1")).toBe(true);
    expect(rows.has("recent-2")).toBe(true);
  });

  it("handles an empty table gracefully", async () => {
    const { table } = createFakeNonceTable();
    const db = createFakeDb(table);
    const result = await runNonceCleanupTick({ db });
    expect(result).toEqual({ deleted: 0, scanned: 0 });
  });

  it("handles search failure gracefully (returns without throwing)", async () => {
    const failingDb = {
      flair: {
        Nonce: {
          search: () => {
            throw new Error("table does not exist");
          },
        },
      },
    };
    await expect(runNonceCleanupTick({ db: failingDb })).resolves.toEqual({ deleted: 0, scanned: 0 });
  });

  it("a delete failure for one row does not prevent deleting the others", async () => {
    const { rows } = createFakeNonceTable();
    const now = Date.now();
    rows.set("bad-row", { id: "bad-row", seenAt: now - 120_000 });
    rows.set("good-row", { id: "good-row", seenAt: now - 120_000 });

    const db = createFakeDb({
      search: () => fromArray([...rows.values()]),
      async delete(id: string) {
        if (id === "bad-row") throw new Error("db error on delete");
        rows.delete(id);
      },
    } as any);

    const result = await runNonceCleanupTick({ db, now, retentionMs: DEFAULT_RETENTION_MS });
    expect(result.deleted).toBe(1);
    expect(rows.has("bad-row")).toBe(true);
    expect(rows.has("good-row")).toBe(false);
  });
});

describe("Nonce table — additive migration sanity", () => {
  it("federation.graphql declares Nonce without @export, and leaves existing tables intact", () => {
    const schema = readFileSync(
      new URL("../../schemas/federation.graphql", import.meta.url),
      "utf8",
    );

    const nonceMatch = schema.match(/type Nonce\s+@table\(database:\s*"flair"\)([^{]*)\{/);
    expect(nonceMatch).not.toBeNull();
    // No @export directly on the Nonce type declaration — keeps it off the
    // served/replication surface.
    expect(nonceMatch![1]).not.toContain("@export");
    expect(schema).toContain("id: ID @primaryKey");
    expect(schema).toMatch(/seenAt:\s*Int!\s*@indexed/);

    // Pre-existing tables are untouched (additive-only migration).
    for (const existing of ["Instance", "PairingToken", "Peer", "SyncLog"]) {
      expect(schema).toContain(`type ${existing} @table(database: "flair")`);
    }
  });
});
