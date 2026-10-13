// flair#2455 slice 1 — the retry vocabulary: the closed SkipReason union, the
// exhaustive retryable classification, and the FederationRetry tuple key.
//
// The type-level exhaustiveness of SKIP_REASON_CLASS (a Record<SkipReason, …>)
// is checked by tsc, not here; these cases pin the runtime view so a missing or
// mis-classified reason is caught even in the lane that strips types.
import { describe, expect, test } from "bun:test";
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
  RETRY_RESOLUTIONS,
  LOCAL_RETRY_REASONS,
} from "../../resources/federation-retry-lib.js";

describe("flair#2455 — closed SkipReason union and retry classification", () => {
  test("the classification map has exactly the SkipReason members", () => {
    expect(Object.keys(SKIP_REASON_CLASS).sort()).toEqual([...SKIP_REASONS].sort());
    expect(SKIP_REASONS.size).toBe(Object.keys(SKIP_REASON_CLASS).length);
  });

  test("the reasons the slice types are present and are their own names", () => {
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

  test("the retryable subset is exactly the four reasons the design names", () => {
    const actual: string[] = [...RETRYABLE_SKIP_REASONS].sort();
    expect(actual).toEqual(
      ["future_timestamp", "merge_error", "merge_target_changed", "unknown_originator_key"].sort(),
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
