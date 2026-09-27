import { describe, expect, test } from "bun:test";
import { encodeRecordId, memoryPutPath } from "../src/record-id-path.ts";

/**
 * flair#1970 — the captured-journal path construction (the continuity capture
 * hook's `/Memory/<id>` PUT, built by `memoryPutPath` in ./record-id-path.ts)
 * ENCODES the id as ONE path segment, and REFUSES a `.`/`..` id before any
 * request.
 *
 * The hook's own rows carry a journal id that is URL-safe by construction, so
 * driving the whole hook cannot exercise the encoder (flair#1970 item 3: a
 * test that interpolates a safe id passes with raw interpolation). These pin
 * the extracted builder directly with a reserved-character id instead.
 */
describe("capture PUT path: Memory id encoding (#1970)", () => {
  test("a reserved-character id is one encoded path segment that decodes back", () => {
    const id = "sess#1?x/y%z w";
    const path = memoryPutPath(id);

    // Exactly one segment after /Memory/ — a naive `#` would start a fragment,
    // `?` a query, `/` split the segment, and `%`/space would be malformed.
    expect(path.startsWith("/Memory/")).toBe(true);
    const segment = path.slice("/Memory/".length);
    expect(segment).toBe(encodeURIComponent(id)); // assertion: the id is percent-encoded
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("?");
    expect(segment).not.toContain("#");
    expect(decodeURIComponent(segment)).toBe(id);
  });

  test("a '.'/'..' id is refused (nothing to send)", () => {
    for (const bad of [".", ".."]) {
      expect(() => memoryPutPath(bad)).toThrow(/dot-segment/); // assertion: the rule is named
      expect(() => memoryPutPath(bad)).toThrow(new RegExp(JSON.stringify(bad).slice(1, -1)));
    }
  });
});
