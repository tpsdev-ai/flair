/**
 * record-id-path.test.ts — the shared id-path helper (flair#1970).
 *
 * `encodeRecordId` is what every CLI site builds a record path with. The
 * contract: the id is ONE path segment, and that segment decodes back to the
 * id — for every RFC 3986 reserved character, plus `%` and space. `.` and `..` are
 * refused, because URL normalization collapses them and no request could
 * address the record.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeRecordId, recordIdPath } from "../../src/lib/record-id-path.js";

// RFC 3986 reserved characters, plus percent and a space.
const RESERVED = ":/?#[]@!$&'()*+,;=";
const RAW_ID = `rec${RESERVED}% w`;

describe("flair#1970: encodeRecordId keeps an id ONE path segment", () => {
  test("an id with every RFC 3986 reserved character becomes one segment that decodes back to it", () => {
    const path = recordIdPath("Memory", RAW_ID);
    const segments = path.split("/");
    expect(segments).toHaveLength(3); // "", collection, id
    expect(segments[1]).toBe("Memory");
    expect(segments[2]).not.toContain("/");
    expect(decodeURIComponent(segments[2])).toBe(RAW_ID);
  });

  for (const ch of [...RESERVED, "%", " "]) {
    test(`keeps ${JSON.stringify(ch)} inside the single id segment`, () => {
      const id = `a${ch}b`;
      const segment = encodeRecordId(id);
      // Some reserved characters are safe within a path segment and remain literal.
      // The whole id must still decode exactly and occupy one segment.
      expect(segment.split("/")).toHaveLength(1);
      expect(decodeURIComponent(segment)).toBe(id);
      const path = new URL(`/Memory/${segment}`, "http://example.test").pathname;
      expect(path.split("/")).toHaveLength(3);
      expect(decodeURIComponent(path.split("/")[2])).toBe(id);
    });
  }

  test("refuses a dot-segment id rather than sending a normalized path", () => {
    for (const id of [".", ".."]) {
      expect(() => encodeRecordId(id)).toThrow(/dot-segment/);
    }
  });
});

// Source tripwires supplement the URL behavior tests: these are the CLI record
// sites that used direct or missing encoding before this change.
const RECORD_SITES: Array<[string, string]> = [
  ["soul.ts", "const out = await api(\"PUT\", `/Soul/${encodeRecordId(id)}`"],
  ["memory.ts", "const out = await api(\"PUT\", `/Memory/${encodeRecordId(memId)}`, body, { agentId, agentIdSource: source });"],
  ["init.ts", "encodeRecordId(`${agentId}:${key}`)"],
  ["idp.ts", "`/IdpConfig/${encodeRecordId(id)}`"],
  ["import.ts", "encodeRecordId(soul.id)"],
  ["quality.ts", "encodeRecordId(memId)"],
  ["rem.ts", "encodeRecordId(candidateId)"],
  ["federation.ts", "encodeRecordId(p.id)"],
  ["workspace.ts", "encodeRecordId(id)"],
];

test("CLI record write and read sites use the shared id helper", () => {
  for (const [file, expression] of RECORD_SITES) {
    const source = readFileSync(new URL(`../../src/commands/${file}`, import.meta.url), "utf8");
    expect(source).toContain(expression);
  }
});

test("federation verify and REM restore use the shared id helper", () => {
  const federation = readFileSync(new URL("../../src/federation-verify.ts", import.meta.url), "utf8");
  const restore = readFileSync(new URL("../../src/rem/restore.ts", import.meta.url), "utf8");
  expect(federation).toContain("encodeRecordId(memId)");
  for (const id of ["m.id", "s.id", "c.id"]) expect(restore).toContain(`encodeRecordId(String(${id}))`);
});
