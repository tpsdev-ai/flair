/**
 * a2a-org-event-failure-3005.test.ts — flair#3005 unit coverage for the A2A
 * intake helpers: `containsBigInt` (the message/send refusal trigger) and
 * `orgEventWriteFailure` (the server-error code), which reports a missing
 * OrgEvent validator apart from an invalid row.
 */
import { describe, expect, test } from "bun:test";
import { containsBigInt, orgEventWriteFailure } from "../../resources/a2a-stream.ts";

describe("flair#3005 — containsBigInt sees a BigInt at any depth", () => {
  test("true for a top-level, nested-object and array BigInt", () => {
    expect(containsBigInt(9007199254740993n)).toBe(true);
    expect(containsBigInt({ parts: [{ text: "hi" }], metadata: { sequence: 9007199254740993n } })).toBe(true);
    expect(containsBigInt({ parts: [{ text: "hi" }], targets: ["a", 9007199254740993n] })).toBe(true);
  });

  test("false for the same shapes without a BigInt, including the decimal as a string", () => {
    expect(containsBigInt({ parts: [{ text: "hi" }], metadata: { sequence: "9007199254740993" } })).toBe(false);
    expect(containsBigInt({ parts: [{ text: "hi" }], targets: ["a", 9007199254740992] })).toBe(false);
    expect(containsBigInt(null)).toBe(false);
  });
});

describe("flair#3005 — a missing validator is reported apart from an invalid row", () => {
  test("the two OrgEvent write failures answer distinct error codes", () => {
    expect(orgEventWriteFailure(1, "row_invalid")).toEqual({
      jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", data: { error: "org_event_row_invalid" } },
    });
    expect(orgEventWriteFailure(1, "validator_missing")).toEqual({
      jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", data: { error: "org_event_validator_missing" } },
    });
  });
});
