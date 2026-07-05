/**
 * instance-identity.test.ts — resources/instance-identity.ts's localInstanceId()
 * accessor (federation-edge-hardening slice 1).
 *
 * The write-time originatorInstanceId stamp (Memory.ts/Soul.ts/Agent.ts/
 * Relationship.ts) needs this instance's own federation identity WITHOUT
 * paying a DB lookup on every write — this file proves the module-level
 * cache actually caches (a spy counts calls to the mocked
 * databases.flair.Instance.search()), and that an unresolved (null) result
 * is NOT permanently cached (a never-federated instance that later pairs
 * must pick up its new identity on the next write, not stay null forever).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

let instanceRow: any = null;
let searchCallCount = 0;
let throwOnSearch = false;

const databasesMock = {
  flair: {
    Instance: {
      search: () => {
        searchCallCount++;
        if (throwOnSearch) throw new Error("Instance table not present");
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
    },
  },
};

mock.module("@harperfast/harper", () => ({ databases: databasesMock, Resource: class {} }));

const { localInstanceId, _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

beforeEach(() => {
  instanceRow = null;
  searchCallCount = 0;
  throwOnSearch = false;
  _resetLocalInstanceIdCacheForTests();
});

describe("localInstanceId() — resolution", () => {
  it("resolves the instance id from the Instance table's single row", async () => {
    instanceRow = { id: "flair_abc123" };
    expect(await localInstanceId()).toBe("flair_abc123");
  });

  it("resolves to null when no Instance row exists yet (never federation-bootstrapped)", async () => {
    instanceRow = null;
    expect(await localInstanceId()).toBeNull();
  });

  it("resolves to null (never throws) when the Instance table isn't present at all", async () => {
    throwOnSearch = true;
    expect(await localInstanceId()).toBeNull();
  });
});

describe("localInstanceId() — caching (a write must not pay a DB lookup every call)", () => {
  it("a successful resolution is cached — a second call does NOT hit the DB again", async () => {
    instanceRow = { id: "flair_abc123" };
    const first = await localInstanceId();
    const callsAfterFirst = searchCallCount;
    expect(first).toBe("flair_abc123");
    expect(callsAfterFirst).toBe(1);

    const second = await localInstanceId();
    expect(second).toBe("flair_abc123");
    expect(searchCallCount).toBe(callsAfterFirst); // no new DB call
  });

  it("caching survives even if the underlying row later changes — the cached value wins (by design: resolved once)", async () => {
    instanceRow = { id: "flair_first" };
    await localInstanceId();
    instanceRow = { id: "flair_second" }; // simulate the row somehow changing
    const stillCached = await localInstanceId();
    expect(stillCached).toBe("flair_first");
    expect(searchCallCount).toBe(1); // proves no re-fetch happened
  });

  it("an UNRESOLVED (null) result is NOT cached — the next call retries against the DB", async () => {
    instanceRow = null;
    const first = await localInstanceId();
    expect(first).toBeNull();
    expect(searchCallCount).toBe(1);

    // Instance becomes available (e.g. this process's first-ever federation
    // pairing just completed) — the very next write must pick it up, not
    // stay permanently null from the earlier miss.
    instanceRow = { id: "flair_newly_paired" };
    const second = await localInstanceId();
    expect(second).toBe("flair_newly_paired");
    expect(searchCallCount).toBe(2); // retried — proves null wasn't cached
  });

  it("_resetLocalInstanceIdCacheForTests() forces re-resolution on the next call", async () => {
    instanceRow = { id: "flair_before_reset" };
    await localInstanceId();
    expect(searchCallCount).toBe(1);

    _resetLocalInstanceIdCacheForTests();
    instanceRow = { id: "flair_after_reset" };
    const afterReset = await localInstanceId();
    expect(afterReset).toBe("flair_after_reset");
    expect(searchCallCount).toBe(2);
  });
});
