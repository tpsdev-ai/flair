import { describe, expect, test, spyOn } from "bun:test";
import { Bm25Index, SUPPORTED_SCOPE_ATTRS, TEMPORAL_ATTRS } from "../../resources/bm25-index.ts";

const base = () => ({ id: "m", content: "quokka release checklist", agentId: "owner", tags: ["ops"],
  visibility: "shared", createdAt: "2026-01-01T00:00:00Z" });
const rank = (index: Bm25Index, conditions: any[] = [], now = Date.parse("2026-06-01")) =>
  index.rank({ q: "quokka", conditions, limit: 10, timeFilters: { now } });

describe("BM25 metadata-only updates", () => {
  test("hit tracking and repeated hook/feed delivery do not retire postings", () => {
    const index = new Bm25Index();
    index.upsert(base());
    const remove = spyOn(index, "remove");
    for (let i = 0; i < 500; i++) index.upsert({ ...base(), tags: ["ops"], retrievalCount: i, lastRetrieved: String(i) });
    expect(remove).not.toHaveBeenCalled();
    expect(rank(index)).toEqual(["m"]);
    expect(index.size).toBe(1);
    expect(index.postingCount).toBe(3);
  });

  for (const attr of [...SUPPORTED_SCOPE_ATTRS, ...TEMPORAL_ATTRS]) {
    test(`${attr} changes and deletions still replace the indexed projection`, () => {
      const index = new Bm25Index();
      const row: any = { ...base(), [attr]: "before" };
      index.upsert(row);
      const remove = spyOn(index, "remove");
      index.upsert({ ...row, [attr]: "after" });
      expect(remove).toHaveBeenCalledTimes(1);
      delete row[attr];
      index.upsert(row);
      expect(remove).toHaveBeenCalledTimes(2);
    });
  }

  test("retains exact content, not a hash, and reindexes edits even with a stale contentHash", () => {
    const index = new Bm25Index();
    index.upsert({ ...base(), contentHash: "unchanged" });
    index.upsert({ ...base(), content: "wombat release checklist", contentHash: "unchanged" });
    expect(rank(index)).toEqual([]);
    expect(index.rank({ q: "wombat", conditions: [], limit: 10 })).toEqual(["m"]);
  });

  test("array snapshots survive callers mutating and reusing a row", () => {
    const index = new Bm25Index();
    const row = base();
    index.upsert(row);
    row.tags[0] = "private-project";
    index.upsert(row);
    expect(rank(index, [{ attribute: "tags", comparator: "equals", value: "ops" }])).toEqual([]);
    expect(rank(index, [{ attribute: "tags", comparator: "equals", value: "private-project" }])).toEqual(["m"]);
  });

  test("visibility, archive and temporal transitions remain effective after repeated metadata writes", () => {
    const index = new Bm25Index();
    const row = base();
    index.upsert(row);
    index.upsert({ ...row, retrievalCount: 5 });
    index.upsert({ ...row, visibility: "private" });
    expect(rank(index, [{ attribute: "visibility", comparator: "not_equal", value: "private" }])).toEqual([]);
    index.upsert({ ...row, archived: true });
    expect(rank(index, [{ attribute: "archived", comparator: "not_equal", value: true }])).toEqual([]);
    for (const field of ["expiresAt", "validTo"]) {
      index.upsert({ ...row, [field]: "2026-05-01T00:00:00Z" });
      expect(rank(index)).toEqual([]);
      index.upsert({ ...row, [field]: "2026-07-01T00:00:00Z" });
      expect(rank(index)).toEqual(["m"]);
    }
    index.remove(row.id);
    index.upsert(row);
    expect(rank(index)).toEqual(["m"]);
  });
});


test("body-cache eviction and oversized records preserve correctness", () => {
  const index = new Bm25Index();
  index.upsert(base());
  for (let i = 0; i < 1100; i++) index.upsert({ id: `cold-${i}`, content: "wombat" });
  const remove = spyOn(index, "remove");
  index.upsert(base());
  expect(remove).toHaveBeenCalledTimes(1); // evicted: conservative rebuild
  index.upsert({ ...base(), retrievalCount: 1 });
  expect(remove).toHaveBeenCalledTimes(1); // warm: skip replacement
  const huge = { ...base(), content: "quokka ".repeat(80000) };
  index.upsert(huge);
  index.upsert({ ...huge, retrievalCount: 2 });
  expect(remove).toHaveBeenCalledTimes(3); // too large to retain
  expect(rank(index)).toEqual(["m"]);
  index.clear();
  index.upsert({ ...base(), content: "wombat" });
  expect(rank(index)).toEqual([]);
});

test("body cache is bounded by characters as well as entry count", () => {
  const index = new Bm25Index();
  const large = { ...base(), content: "quokka ".repeat(50000) };
  index.upsert(large);
  index.upsert({ id: "other", content: "wombat ".repeat(50000) });
  const remove = spyOn(index, "remove");
  index.upsert(large);
  expect(remove).toHaveBeenCalledTimes(1);
  index.upsert({ ...large, retrievalCount: 3 });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(rank(index)).toEqual(["m"]);
});
