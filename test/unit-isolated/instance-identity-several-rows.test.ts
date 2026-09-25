/**
 * instance-identity-several-rows.test.ts — resources/instance-identity.ts's
 * localInstanceId() when the `Instance` table holds more than one row
 * (flair#1896, the localInstanceId half).
 *
 * localInstanceId() stamps `originatorInstanceId` on every local write
 * (Memory/Soul/Agent/Relationship post()/put(), and Message's resolveOrg). It
 * used to take the FIRST row of an unordered `Instance.search()` and cache it,
 * so on an instance whose table holds several rows every local record was
 * stamped with an arbitrary identity — one a peer may never have pinned.
 *
 * The decision (issue #1896 comment): decide through the shared rule
 * (`decideInstanceAnswer`, src/lib/instance-identity-row.ts).
 *   - one row          → cache and return it, as today
 *   - no row / bad read → null, uncached, as today
 *   - several rows     → null (stamp NOTHING, the defined local-origin state);
 *                        never throw, never pick a row; log ONE error naming the
 *                        row count and the prune remedy; cache the refusal for at
 *                        most a minute so a write does not read the table every
 *                        call and a prune takes effect without a restart.
 *
 * The read goes through the SAME strict reader the GET uses
 * (`readAllInstanceRows`), so a table serving an entry with no usable id is an
 * UNREADABLE read — null, uncached — never "the rows I could name".
 *
 * Own process (test/unit-isolated) so the harper mock never races another
 * file's, exactly like federation-instance-identity-read.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

let rowsToServe: any[] = [];
let throwOnSearch = false;
let searchCallCount = 0;

const databasesMock = {
  flair: {
    Instance: {
      search: () => {
        searchCallCount++;
        async function* gen() {
          if (throwOnSearch) throw new Error("rocksdb: IO error while opening the Instance table");
          for (const row of rowsToServe) yield row;
        }
        return gen();
      },
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { getUser: async () => null, operation: async () => null },
}));

const { localInstanceId, _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

const REAL_NOW = Date.now;
let nowValue: number;
let nowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  rowsToServe = [];
  throwOnSearch = false;
  searchCallCount = 0;
  _resetLocalInstanceIdCacheForTests();
  nowValue = REAL_NOW();
  nowSpy = spyOn(Date, "now").mockImplementation(() => nowValue);
});

afterEach(() => {
  nowSpy?.mockRestore();
});

describe("localInstanceId() — one row (unchanged)", () => {
  it("resolves and caches the single row's id", async () => {
    rowsToServe = [{ id: "flair_solo" }];
    expect(await localInstanceId()).toBe("flair_solo");
    const calls = searchCallCount;
    expect(await localInstanceId()).toBe("flair_solo");
    expect(searchCallCount).toBe(calls); // cached — no second read
  });

  it("no row: null, uncached — a later row resolves", async () => {
    rowsToServe = [];
    expect(await localInstanceId()).toBeNull();
    rowsToServe = [{ id: "flair_later" }];
    expect(await localInstanceId()).toBe("flair_later");
  });
});

describe("localInstanceId() — several rows stamp nothing (flair#1896)", () => {
  it("two rows, in EITHER order: null, never one of the row ids", async () => {
    const errSpy = spyOn(console, "error"); // expected refusal line(s)
    const rowA = { id: "flair_row_a" };
    const rowB = { id: "flair_row_b" };

    for (const order of [[rowA, rowB], [rowB, rowA]]) {
      _resetLocalInstanceIdCacheForTests();
      rowsToServe = order;

      const id = await localInstanceId();

      expect(id).toBeNull();
      expect(id).not.toBe("flair_row_a");
      expect(id).not.toBe("flair_row_b");
    }

    errSpy.mockRestore();
  });

  it("logs ONE error naming the row count and the prune remedy; a second call inside the window logs nothing new and does not re-read", async () => {
    const errSpy = spyOn(console, "error");
    rowsToServe = [{ id: "flair_row_a" }, { id: "flair_row_b" }];

    expect(await localInstanceId()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg).toContain("2 Instance rows");
    expect(msg).toContain("flair federation instance prune");
    expect(msg).toContain("--apply");

    const readsAfterRefusal = searchCallCount;
    expect(await localInstanceId()).toBeNull();
    // Inside the window: no new log line, and no second table read.
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(searchCallCount).toBe(readsAfterRefusal);

    errSpy.mockRestore();
  });

  it("logs once per window even across BOTH row orders (reset = fresh window/process-equivalent slate)", async () => {
    const errSpy = spyOn(console, "error");
    const rowA = { id: "flair_row_a" };
    const rowB = { id: "flair_row_b" };

    for (const order of [[rowA, rowB], [rowB, rowA]]) {
      _resetLocalInstanceIdCacheForTests();
      errSpy.mockClear();
      rowsToServe = order;

      expect(await localInstanceId()).toBeNull();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).toContain("flair federation instance prune");
    }

    errSpy.mockRestore();
  });

  it("after the refusal window expires, a second refusal logs again exactly once (once per window)", async () => {
    const errSpy = spyOn(console, "error");
    rowsToServe = [{ id: "flair_row_a" }, { id: "flair_row_b" }];

    // First refusal: arms the window and logs once.
    expect(await localInstanceId()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);

    // Still several rows, but inside the window: silent, no second read.
    expect(await localInstanceId()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);

    // Past the window the table is re-read; it is STILL several rows, so the
    // refusal logs again — exactly once for the new window.
    nowValue += 61_000;
    expect(await localInstanceId()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(2);

    // And silent again inside the new window.
    expect(await localInstanceId()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  it("after the refusal window, a pruned table (one row) resolves the kept id — no restart", async () => {
    const errSpy = spyOn(console, "error"); // the one refusal line
    rowsToServe = [{ id: "flair_row_a" }, { id: "flair_row_b" }];
    expect(await localInstanceId()).toBeNull(); // arms the refusal window

    // A prune leaves one row. Inside the window the refusal is still cached.
    rowsToServe = [{ id: "flair_row_b" }];
    const readsDuringWindow = searchCallCount;
    expect(await localInstanceId()).toBeNull();
    expect(searchCallCount).toBe(readsDuringWindow);

    // Past the window, the next resolution re-reads and returns the kept row.
    nowValue += 61_000;
    expect(await localInstanceId()).toBe("flair_row_b");
    errSpy.mockRestore();
  });
});

describe("localInstanceId() — a read that established nothing (flair#1896)", () => {
  it("a FAILED read: null, uncached", async () => {
    throwOnSearch = true;
    expect(await localInstanceId()).toBeNull();

    throwOnSearch = false;
    rowsToServe = [{ id: "flair_after_failure" }];
    expect(await localInstanceId()).toBe("flair_after_failure");
  });

  it("an entry with no usable id is an UNREADABLE read: null, uncached — never a smaller list", async () => {
    // The strict reader (readAllInstanceRows) throws on a row it cannot name;
    // dropping it would read the table as "the rows I could name" — here, the
    // good row — and stamp it.
    rowsToServe = [{}, { id: "flair_good" }];
    expect(await localInstanceId()).toBeNull();

    rowsToServe = [{ id: "flair_good" }];
    expect(await localInstanceId()).toBe("flair_good");
  });

  it("an entry with no usable id, GOOD row FIRST, is UNREADABLE too: the refusal does not depend on order", async () => {
    // The bad entry may sit anywhere. A reader that stopped at the first usable
    // id would stamp `flair_good` here and only reject the bad-first order, so
    // the refusal must hold with the good row first as well.
    rowsToServe = [{ id: "flair_good" }, {}];
    expect(await localInstanceId()).toBeNull();

    rowsToServe = [{ id: "flair_good" }];
    expect(await localInstanceId()).toBe("flair_good");
  });
});
