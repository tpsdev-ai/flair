/**
 * memory-id-guard-decode-2307.test.ts — flair#2307 item 2.
 *
 * The resource-layer `.content`-suffix guard decodes a URL-bound id segment the
 * SAME way the auth middleware does: a segment that is not valid
 * percent-encoding decodes to its raw form (never throwing), so the guard
 * returns its named 400 for such a segment instead of a 500.
 */
import { describe, expect, test } from "bun:test";
import { refuseContentSuffixId } from "../../resources/memory-id-guard.js";

describe("refuseContentSuffixId — a URL-bound id segment is decoded, never crashes", () => {
  test("a malformed percent-encoded segment that ends in `.content` yields the named 400", async () => {
    const res = refuseContentSuffixId([], { pathname: "/Memory/x%ZZ.content" });
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toBe("memory_id_content_suffix");
  });

  test("a malformed percent-encoded segment with no suffix is not refused, and does not throw", () => {
    expect(refuseContentSuffixId([], { pathname: "/Memory/x%ZZ" })).toBeNull();
  });

  test("an absent or non-string pathname is handled without a throw", () => {
    expect(refuseContentSuffixId([], {})).toBeNull();
    expect(refuseContentSuffixId([], undefined)).toBeNull();
  });
});
