/**
 * record-id-path.test.ts — the shared id-path helper (flair#1970).
 *
 * `encodeRecordId` is what every CLI site builds a record path with. The
 * contract: the id is ONE path segment, and that segment decodes back to the
 * id — for ids containing `/`, `?`, `#`, `%` and space. `.` and `..` are
 * refused, because URL normalization collapses them and no request could
 * address the record.
 */
import { describe, expect, test } from "bun:test";
import { encodeRecordId, recordIdPath } from "../../src/lib/record-id-path.js";

// Every reserved URL character in one id.
const RAW_ID = "rec#1?x/y%z w";

describe("flair#1970: encodeRecordId keeps an id ONE path segment", () => {
  test("an id with every reserved character becomes one segment that decodes back to it", () => {
    const path = recordIdPath("Memory", RAW_ID);
    const segments = path.split("/");
    expect(segments).toHaveLength(3); // "", collection, id
    expect(segments[1]).toBe("Memory");
    expect(segments[2]).not.toContain("/");
    expect(decodeURIComponent(segments[2])).toBe(RAW_ID);
  });

  for (const ch of ["/", "?", "#", "%", " "]) {
    test(`keeps ${JSON.stringify(ch)} inside the single id segment`, () => {
      const id = `a${ch}b`;
      const segment = encodeRecordId(id);
      // The raw id is not the segment (it was encoded) and the segment is one piece.
      expect(segment).not.toBe(id);
      expect(segment.split("/")).toHaveLength(1);
      expect(decodeURIComponent(segment)).toBe(id);
      expect(`/Memory/${segment}`.split("/")).toHaveLength(3);
    });
  }

  test("refuses a dot-segment id rather than sending a normalized path", () => {
    for (const id of [".", ".."]) {
      expect(() => encodeRecordId(id)).toThrow(/dot-segment/);
    }
  });
});
