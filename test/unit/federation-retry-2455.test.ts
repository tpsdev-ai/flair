// flair#2455 slice 1 — the retry vocabulary: the closed SkipReason union, the
// exhaustive retryable classification, the FederationRetry tuple key and the
// table's declared fields.
//
// A SkipReason missing from SKIP_REASON_CLASS is a tsc error (the map
// `satisfies Record<SkipReason, …>`); that is the primary check. SKIP_REASONS
// is derived from the map itself, so comparing the two here proves nothing
// about a missing reason. This lane instead reads the SOURCE as an independent
// oracle: the members of the `SkipReason` union in federation-classify.ts and
// every literal refusal reason in Federation.ts must each have a
// class. The same approach checks RETRY_ROW_FIELDS against the schema file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SKIP_REASON_CLASS,
  SKIP_REASONS,
  RETRYABLE_SKIP_REASONS,
  isSkipReason,
} from "../../resources/federation-classify.js";
import {
  retryEntryKey,
  parseRetryEntryKey,
  isRetryResolution,
  isRetryBound,
  pickRetryRowFields,
  retryRowProblem,
  RETRY_RESOLUTIONS,
  RETRY_ROW_FIELDS,
  LOCAL_RETRY_REASONS,
} from "../../resources/federation-retry-lib.js";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The string members of `export type SkipReason = … ;`, read from the source text. */
function skipReasonUnionFromSource(): string[] {
  const src = read("resources/federation-classify.ts");
  const start = src.indexOf("export type SkipReason =");
  expect(start, "the SkipReason union is in federation-classify.ts").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n;", start);
  expect(end, "the SkipReason union ends with a line holding only `;`").toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/^\s*\|\s*"([a-z_]+)"/gm)].map((m) => m[1]);
}

function literalRefusalReasons(): string[] {
  const src = read("resources/Federation.ts");
  return [...new Set([...src.matchAll(/\{\s*reason:\s*"([a-z_]+)"\s*\}/g)].map((m) => m[1]))];
}

/** The field names declared in the FederationRetry type of schemas/federation.graphql. */
function retryFieldsFromSchema(): string[] {
  const src = read("schemas/federation.graphql");
  const start = src.indexOf("type FederationRetry ");
  expect(start, "the FederationRetry type is in schemas/federation.graphql").toBeGreaterThanOrEqual(0);
  const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("}", start));
  return [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

describe("flair#2455 — closed SkipReason union and retry classification", () => {
  test("the classification map has exactly the members of the SkipReason union, read from the source", () => {
    const union = skipReasonUnionFromSource();
    expect(union.length, "the oracle found the union's members").toBeGreaterThanOrEqual(18);
    const mapKeys: string[] = Object.keys(SKIP_REASON_CLASS).sort();
    const reasons: string[] = [...SKIP_REASONS].sort();
    expect(mapKeys).toEqual([...union].sort());
    expect(reasons).toEqual([...union].sort());
  });

  test("every literal reason FederationSync.post records is classified", () => {
    const emitted = literalRefusalReasons();
    expect(emitted, "the oracle found literal refusal reasons").toContain("merge_error");
    for (const reason of emitted) {
      expect(Object.keys(SKIP_REASON_CLASS), `refusal reason "${reason}" has no class`).toContain(reason);
    }
  });

  test("the five reasons the slice types are members of the union", () => {
    for (const reason of [
      "merge_error",
      "invalid_agent_id",
      "skill_not_federated",
      "seed_id_not_federated",
      "content_suffix_id_not_federated",
    ]) {
      expect(isSkipReason(reason)).toBe(true);
    }
  });

  test("the retryable subset is exactly the reasons the design names", () => {
    const actual: string[] = [...RETRYABLE_SKIP_REASONS].sort();
    expect(actual).toEqual(
      ["future_timestamp", "merge_error", "merge_target_changed", "unknown_originator_key", "presence_agent_not_replicated"].sort(),
    );
    // Each retryable reason is marked retryable in the map, and nothing else is.
    for (const reason of [...SKIP_REASONS]) {
      const expected = RETRYABLE_SKIP_REASONS.has(reason as any) ? "retryable" : "non_retryable";
      expect(SKIP_REASON_CLASS[reason]).toBe(expected);
    }
  });

  test("isSkipReason accepts the closed union and rejects anything else", () => {
    expect(isSkipReason("no_op_same_hash")).toBe(true);
    expect(isSkipReason("merge_ok")).toBe(false);
    expect(isSkipReason(7)).toBe(false);
    expect(isSkipReason(undefined)).toBe(false);
  });
});

describe("flair#2455 — FederationRetry tuple key and outcome vocabulary", () => {
  test("distinct tuples never collide, including the a/bc vs ab/c case", () => {
    expect(retryEntryKey("a", "bc", "x")).not.toBe(retryEntryKey("ab", "c", "x"));
    expect(retryEntryKey("p", "Memory", "m.content")).not.toBe(retryEntryKey("p", "Memory", "m"));
  });

  test("round-trips every component exactly, including `.content`-suffixed ids", () => {
    const key = retryEntryKey("peer-1", "Memory", "row-1.content");
    expect(parseRetryEntryKey(key)).toEqual({ peerId: "peer-1", table: "Memory", recordId: "row-1.content" });
  });

  test("a missing component throws rather than minting a malformed key", () => {
    expect(() => retryEntryKey("", "Memory", "x")).toThrow();
    expect(() => retryEntryKey("p", "Memory", "")).toThrow();
    expect(() => retryEntryKey("p", "Memory", undefined as unknown as string)).toThrow();
  });

  test("parse rejects ids that are not a three-string tuple", () => {
    expect(parseRetryEntryKey("not-json")).toBeNull();
    expect(parseRetryEntryKey('["a","b"]')).toBeNull();
    expect(parseRetryEntryKey('["a","b",3]')).toBeNull();
    expect(parseRetryEntryKey('["a","b",""]')).toBeNull();
  });

  test("resolutions and bounds are the closed design sets; the renamed one is gone", () => {
    expect(isRetryResolution("merged")).toBe(true);
    expect(isRetryResolution("refused_terminal")).toBe(true);
    expect(isRetryResolution("retry_exhausted")).toBe(true);
    expect(isRetryResolution("no_retry_required")).toBe(false);
    expect(isRetryBound("attempts")).toBe(true);
    expect(isRetryBound("both")).toBe(true);
    expect(isRetryBound("sometimes")).toBe(false);
    expect([...RETRY_RESOLUTIONS].length).toBe(6);
    const actual: string[] = [...LOCAL_RETRY_REASONS].sort();
    expect(actual).toEqual(["invalid_response", "retry_unknown", "transport_failure"].sort());
  });
});

describe("flair#2455 — FederationRetry declared fields", () => {
  test("RETRY_ROW_FIELDS is exactly the schema's declared fields, in schema order", () => {
    const fields: string[] = [...RETRY_ROW_FIELDS];
    expect(fields).toEqual(retryFieldsFromSchema());
  });

  test("the table is @sealed in the schema", () => {
    const src = read("schemas/federation.graphql");
    expect(src).toMatch(/type FederationRetry @table\([^)]*\)[^{]*@sealed[^{]*\{/);
  });

  test("pickRetryRowFields keeps declared fields with a value and drops everything else", () => {
    const row = {
      id: "k", peerId: "p", table: "Memory", recordId: "r", state: "pending",
      firstRefusedAt: "t", attempts: 1, createdAt: "t", bound: null, episodeId: undefined,
      content: "a record's content", data: { content: "x" },
    };
    expect(pickRetryRowFields(row)).toEqual({
      id: "k", peerId: "p", table: "Memory", recordId: "r", state: "pending",
      firstRefusedAt: "t", attempts: 1, createdAt: "t", bound: null,
    });
  });
});

describe("flair#2455 — retryRowProblem names a row that breaks a sender convention", () => {
  const key = retryEntryKey("peer-1", "Memory", "row-1");
  const pending = { id: key, peerId: "peer-1", table: "Memory", recordId: "row-1", state: "pending", lastReason: "merge_error" };
  const terminal = { ...pending, state: "terminal", resolution: "retry_exhausted", bound: "attempts" };

  test("a well-formed pending or terminal row has no problem", () => {
    expect(retryRowProblem(pending)).toBeNull();
    expect(retryRowProblem({ ...pending, lastReason: "transport_failure" })).toBeNull();
    expect(retryRowProblem({ ...pending, lastReason: undefined })).toBeNull();
    expect(retryRowProblem(terminal)).toBeNull();
    expect(retryRowProblem({ ...terminal, resolution: "merged", bound: null })).toBeNull();
  });

  test("id_mismatch: the id is not the key of the stored tuple", () => {
    expect(retryRowProblem({ ...pending, recordId: "row-2" })).toBe("id_mismatch");
    expect(retryRowProblem({ ...pending, peerId: "peer-2" })).toBe("id_mismatch");
    expect(retryRowProblem({ ...pending, id: "peer-1/Memory/row-1" })).toBe("id_mismatch");
    expect(retryRowProblem({ ...pending, recordId: "" })).toBe("id_mismatch");
  });

  test("unknown_state: a state other than pending or terminal", () => {
    expect(retryRowProblem({ ...pending, state: "paused" })).toBe("unknown_state");
    expect(retryRowProblem({ ...pending, state: undefined })).toBe("unknown_state");
  });

  test("unknown_reason: a lastReason that is neither a SkipReason nor a local reason", () => {
    expect(retryRowProblem({ ...pending, lastReason: "free text" })).toBe("unknown_reason");
  });

  test("outcome_mismatch: an outcome on a pending row, or a terminal row's unknown resolution or wrong bound", () => {
    expect(retryRowProblem({ ...pending, resolution: "merged" })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...pending, bound: "age" })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...terminal, resolution: "done" })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...terminal, resolution: undefined })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...terminal, bound: null })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...terminal, bound: "sometimes" })).toBe("outcome_mismatch");
    expect(retryRowProblem({ ...terminal, resolution: "merged", bound: "attempts" })).toBe("outcome_mismatch");
  });
});
