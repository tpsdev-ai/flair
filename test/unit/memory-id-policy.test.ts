/**
 * memory-id-policy.test.ts — flair#2199.
 *
 */
import { describe, expect, test } from "bun:test";
import {
  MEMORY_CONTENT_SELECTOR_SUFFIX,
  endsWithContentSelectorSuffix,
  idSegmentHasEncodedSlash,
} from "../../src/lib/memory-id-policy.js";

describe("flair#2199: Memory ids ending in the `.content` suffix", () => {
  test("the suffix constant is the property suffix Harper reads", () => {
    expect(MEMORY_CONTENT_SELECTOR_SUFFIX).toBe(".content");
  });

  test("an id ending in `.content` is refused", () => {
    for (const id of ["x.content", ".content", "a/b.content", "a.b.content", "content.content"]) {
      expect(endsWithContentSelectorSuffix(id), id).toBe(true);
    }
  });

  test("an id that does not end in `.content` passes", () => {
    for (const id of ["content", "x", "x.contentx", "x.Content", "x.content ", "x.agentId", "a/b"]) {
      expect(endsWithContentSelectorSuffix(id), id).toBe(false);
    }
  });

  test("a non-string id never carries the suffix", () => {
    for (const id of [undefined, null, 42, {}, [], true]) {
      expect(endsWithContentSelectorSuffix(id)).toBe(false);
    }
  });

  test("the encoded-slash predicate matches `%2F` in any case", () => {
    for (const seg of ["a%2Fb", "a%2fb", "a%2Fb.content", "a%2Fb%2Econtent"]) {
      expect(idSegmentHasEncodedSlash(seg), seg).toBe(true);
    }
    for (const seg of ["a/b", "a%20b", "ab", "a%25Fb"]) {
      expect(idSegmentHasEncodedSlash(seg), seg).toBe(false);
    }
  });
});
