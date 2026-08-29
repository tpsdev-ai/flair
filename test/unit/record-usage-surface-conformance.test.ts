/**
 * record-usage-surface-conformance.test.ts — flair#1410.
 *
 * Durable pin: the SAME input (both memoryId and memoryIds populated)
 * produces the SAME credited set on native `/mcp` and stdio `flair-mcp`.
 * A length-only check is not enough — the sets must match.
 *
 * Powered: a case where memoryId is not in memoryIds must include the
 * singular id on BOTH surfaces. If native still preferred `memoryIds`
 * and dropped `memoryId`, this file would stay red.
 */
import { describe, expect, test } from "bun:test";
import { buildRecordUsageBody } from "../../packages/flair-mcp/src/usage.ts";
import {
  RECORD_USAGE_ID_MERGE_CONTRACT as NATIVE_CONTRACT,
  resolveRecordUsageIds,
  unionUsageMemoryIds,
} from "../../resources/usage-ids.ts";
import { RECORD_USAGE_ID_MERGE_CONTRACT as STDIO_CONTRACT } from "../../packages/flair-mcp/src/usage.ts";

const MAX = 20;

/** Native /mcp credited set: what recordUsage() forwards to RecordUsage.post. */
function nativeCredited(input: { memoryId?: string; memoryIds?: string[] }): Set<string> {
  return new Set(unionUsageMemoryIds(input.memoryId, input.memoryIds));
}

/** Stdio flair-mcp credited set: the memoryIds array POSTed to /RecordUsage. */
function stdioCredited(input: { memoryId?: string; memoryIds?: string[] }): Set<string> {
  const body = buildRecordUsageBody(input);
  return new Set(body?.memoryIds ?? []);
}

/** HTTP endpoint credited set: what POST /RecordUsage actually iterates. */
function endpointCredited(input: { memoryId?: string; memoryIds?: string[] }): Set<string> {
  const resolved = resolveRecordUsageIds(input, MAX);
  return new Set(resolved.ok ? resolved.ids : []);
}

const CASES: Array<{ name: string; input: { memoryId?: string; memoryIds?: string[] }; expected: string[] }> = [
  {
    name: "disjoint — memoryId is NOT in memoryIds (the native drop)",
    input: { memoryId: "mem-solo", memoryIds: ["mem-a", "mem-b"] },
    expected: ["mem-a", "mem-b", "mem-solo"],
  },
  {
    name: "overlapping — memoryId already in memoryIds",
    input: { memoryId: "mem-a", memoryIds: ["mem-a", "mem-b"] },
    expected: ["mem-a", "mem-b"],
  },
  {
    name: "empty plural + singular",
    input: { memoryId: "mem-solo", memoryIds: [] },
    expected: ["mem-solo"],
  },
  {
    name: "singular only",
    input: { memoryId: "mem-solo" },
    expected: ["mem-solo"],
  },
  {
    name: "plural only",
    input: { memoryIds: ["mem-a", "mem-b"] },
    expected: ["mem-a", "mem-b"],
  },
];

describe("record_usage surface conformance (flair#1410)", () => {
  test.each(CASES)("$name: native /mcp and stdio flair-mcp credit the same set", ({ input, expected }) => {
    const native = nativeCredited(input);
    const stdio = stdioCredited(input);
    const want = new Set(expected);
    expect(native, "native credited set").toEqual(want);
    expect(stdio, "stdio credited set").toEqual(want);
    expect(native, "native and stdio must match (not merely same length)").toEqual(stdio);
  });

  test("powered: memoryId not in memoryIds is credited on BOTH surfaces", () => {
    const input = { memoryId: "mem-solo", memoryIds: ["mem-a", "mem-b"] };
    const native = nativeCredited(input);
    const stdio = stdioCredited(input);
    // If native still dropped memoryId, native would be {mem-a, mem-b} and
    // this assertion (and the set-equality above) would fail. Length-only
    // would not catch a swap; membership of the singular id does.
    expect(native.has("mem-solo")).toBe(true);
    expect(stdio.has("mem-solo")).toBe(true);
    expect(native).toEqual(stdio);
    expect(native).toEqual(new Set(["mem-a", "mem-b", "mem-solo"]));
  });

  test("POST /RecordUsage unions the same way — guarantee does not depend on the client flattening first", () => {
    const input = { memoryId: "mem-solo", memoryIds: ["mem-a", "mem-b"] };
    const endpoint = endpointCredited(input);
    expect(endpoint.has("mem-solo")).toBe(true);
    expect(endpoint).toEqual(nativeCredited(input));
    expect(endpoint).toEqual(stdioCredited(input));
  });

  test("both MCP schemas state the same merge contract", () => {
    expect(NATIVE_CONTRACT).toBe(STDIO_CONTRACT);
    expect(NATIVE_CONTRACT).toContain("merged");
    expect(NATIVE_CONTRACT).toContain("union");
  });
});
