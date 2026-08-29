import { describe, expect, test } from "bun:test";
import {
  buildRecordUsageBody,
  citationIds,
  CITE_USAGE_NUDGE,
  RECORD_USAGE_ID_MERGE_CONTRACT,
  withCiteNudge,
} from "../src/usage.ts";

/**
 * flair#1147 — stdio MCP clients can reach POST /RecordUsage.
 *
 * Pins the body construction the `record_usage` tool uses (identity from the
 * signature, never the body), the citation-on-write passthrough, and the
 * one-line cite nudge on recalled ids. Mirrors the isolation style of
 * mcp.test.ts's coordination-write tests.
 */

describe("record_usage body (flair#1147)", () => {
  test("singular memoryId becomes memoryIds — the RecordUsage contract", () => {
    expect(buildRecordUsageBody({ memoryId: "mem-a" })).toEqual({ memoryIds: ["mem-a"] });
  });

  test("memoryIds array is forwarded as-is (deduped)", () => {
    expect(buildRecordUsageBody({ memoryIds: ["mem-a", "mem-b", "mem-a"] })).toEqual({
      memoryIds: ["mem-a", "mem-b"],
    });
  });

  test("when BOTH memoryId and memoryIds are supplied, MERGE (flair#1410 — same contract as native /mcp)", () => {
    expect(buildRecordUsageBody({ memoryId: "mem-b", memoryIds: ["mem-a"] })).toEqual({
      memoryIds: ["mem-a", "mem-b"],
    });
    expect(buildRecordUsageBody({ memoryId: "mem-solo", memoryIds: ["mem-a", "mem-b"] })).toEqual({
      memoryIds: ["mem-a", "mem-b", "mem-solo"],
    });
  });

  test("schema states the merge contract (flair#1410)", () => {
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toContain("merged");
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toContain("union");
    expect(RECORD_USAGE_ID_MERGE_CONTRACT).toMatch(/memoryId.*memoryIds/);
  });

  test("optional attribution is forwarded only when non-empty", () => {
    expect(buildRecordUsageBody({ memoryId: "mem-a", attribution: "grounded the spec" })).toEqual({
      memoryIds: ["mem-a"],
      attribution: "grounded the spec",
    });
    expect(buildRecordUsageBody({ memoryId: "mem-a", attribution: "" })).toEqual({
      memoryIds: ["mem-a"],
    });
  });

  test("empty / missing ids return null — the tool fails locally, never POSTs an empty list", () => {
    expect(buildRecordUsageBody({})).toBeNull();
    expect(buildRecordUsageBody({ memoryIds: [] })).toBeNull();
    expect(buildRecordUsageBody({ memoryId: "" })).toBeNull();
  });

  test("body never carries agentId (no forging — attribute from signature)", () => {
    const body = buildRecordUsageBody({ memoryId: "mem-a", attribution: "used it" });
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("agentId");
    expect(Object.keys(body!)).toEqual(["memoryIds", "attribution"]);
  });
});

describe("citation-on-write passthrough (flair#1147)", () => {
  test("forwards a non-empty list of ids", () => {
    expect(citationIds(["mem-a", "mem-b"])).toEqual(["mem-a", "mem-b"]);
  });

  test("omitted / empty is undefined so the write body stays byte-identical", () => {
    expect(citationIds(undefined)).toBeUndefined();
    expect(citationIds([])).toBeUndefined();
  });

  test("rejects a list that is not all non-empty strings", () => {
    expect(citationIds(["mem-a", ""])).toBeUndefined();
  });
});

describe("cite-what-you-use nudge (flair#1147)", () => {
  test("appends the one-line instruction after recalled content", () => {
    const text = withCiteNudge("1. a recalled memory (id:mem-a)");
    expect(text).toContain("id:mem-a");
    expect(text).toContain(CITE_USAGE_NUDGE);
    expect(text).toContain("record_usage");
    expect(text).toContain("usedMemoryIds");
  });

  test("empty text is left empty — no nudge on an empty payload", () => {
    expect(withCiteNudge("")).toBe("");
  });
});
