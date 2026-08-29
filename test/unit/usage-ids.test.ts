/**
 * usage-ids.test.ts — flair#1410 merge contract for record_usage / RecordUsage.
 *
 * Pure: no Harper. Pins union (not prefer) and the HTTP-endpoint validation
 * that still 400s invalid/empty/over-cap batches.
 */
import { describe, expect, test } from "bun:test";
import {
  RECORD_USAGE_ID_MERGE_CONTRACT,
  resolveRecordUsageIds,
  unionUsageMemoryIds,
} from "../../resources/usage-ids.ts";

const MAX = 20;

describe("unionUsageMemoryIds (native /mcp flatten)", () => {
  test("singular only", () => {
    expect(unionUsageMemoryIds("mem-a")).toEqual(["mem-a"]);
  });

  test("plural only, deduped", () => {
    expect(unionUsageMemoryIds(undefined, ["mem-a", "mem-b", "mem-a"])).toEqual(["mem-a", "mem-b"]);
  });

  test("both fields MERGE — singular not in the array is kept", () => {
    expect(unionUsageMemoryIds("mem-solo", ["mem-a", "mem-b"])).toEqual(["mem-a", "mem-b", "mem-solo"]);
  });

  test("overlapping fields dedupe", () => {
    expect(unionUsageMemoryIds("mem-a", ["mem-a", "mem-b"])).toEqual(["mem-a", "mem-b"]);
  });

  test("empty plural + singular still credits the singular", () => {
    expect(unionUsageMemoryIds("mem-solo", [])).toEqual(["mem-solo"]);
  });

  test("empty / missing yields []", () => {
    expect(unionUsageMemoryIds()).toEqual([]);
    expect(unionUsageMemoryIds("", [])).toEqual([]);
  });
});

describe("resolveRecordUsageIds (POST /RecordUsage)", () => {
  test("unions both fields — singular not in the array is credited", () => {
    const result = resolveRecordUsageIds({ memoryId: "mem-solo", memoryIds: ["mem-a", "mem-b"] }, MAX);
    expect(result).toEqual({ ok: true, ids: ["mem-a", "mem-b", "mem-solo"] });
  });

  test("empty memoryIds + singular succeeds (no longer 400s by prefer)", () => {
    const result = resolveRecordUsageIds({ memoryId: "mem-solo", memoryIds: [] }, MAX);
    expect(result).toEqual({ ok: true, ids: ["mem-solo"] });
  });

  test("singular only", () => {
    expect(resolveRecordUsageIds({ memoryId: "mem-a" }, MAX)).toEqual({ ok: true, ids: ["mem-a"] });
  });

  test("plural only", () => {
    expect(resolveRecordUsageIds({ memoryIds: ["mem-a", "mem-b"] }, MAX)).toEqual({ ok: true, ids: ["mem-a", "mem-b"] });
  });

  test("missing / empty is empty (endpoint 400s)", () => {
    expect(resolveRecordUsageIds({}, MAX)).toEqual({ ok: false, error: "empty" });
    expect(resolveRecordUsageIds({ memoryIds: [] }, MAX)).toEqual({ ok: false, error: "empty" });
  });

  test("invalid plural entry is invalid (endpoint 400s — not filtered)", () => {
    expect(resolveRecordUsageIds({ memoryIds: ["mem-a", ""] }, MAX)).toEqual({ ok: false, error: "invalid" });
    expect(resolveRecordUsageIds({ memoryIds: "mem-a" }, MAX)).toEqual({ ok: false, error: "invalid" });
  });

  test("per-call cap is on the raw concatenated list (anti-gaming bound unchanged)", () => {
    const ids = Array.from({ length: MAX }, (_, i) => `m${i}`);
    expect(resolveRecordUsageIds({ memoryIds: ids }, MAX).ok).toBe(true);
    expect(resolveRecordUsageIds({ memoryId: "extra", memoryIds: ids }, MAX)).toEqual({ ok: false, error: "cap" });
  });
});

describe("schema contract string", () => {
  test("names the merge so a caller can predict it without reading source", () => {
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toContain("merged");
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toContain("union");
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toMatch(/memoryId.*memoryIds/);
  });
});
