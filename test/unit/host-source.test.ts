/**
 * host-source.test.ts — flair#1940 slice 1 (A1/A2/A5). Pure-module coverage for
 * resources/host-source.ts: every A2 refusal REJECTS (never truncates), the
 * canonical form is stored, and a legacy/absent value reads back null.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_SOURCE_PAIRS,
  parseHostSource,
  validateHostSource,
} from "../../resources/host-source.ts";

const OK = { v: 1, host: "openclaw", kind: "run", id: "run-1a2b3c4d" };

describe("hostSource A2 — validation rejects, never truncates", () => {
  test("a valid pointer canonicalises to the fixed key order", () => {
    const r = validateHostSource({ ...OK, url: "https://example.test/x" });
    expect(r.ok).toBe(true); // assertion
    if (r.ok) {
      expect(r.canonical).toBe(
        '{"v":1,"host":"openclaw","kind":"run","id":"run-1a2b3c4d","url":"https://example.test/x"}',
      );
    }
  });

  test("an NFD url canonicalises to NFC", () => {
    const nfd = "https://example.test/cafe\u0301"; // e + combining acute
    const r = validateHostSource({ ...OK, url: nfd });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toBe("https://example.test/café"); // NFC
  });

  const refusals: Array<[string, unknown]> = [
    ["a bad host", { ...OK, host: "evil" }],
    ["a bad kind", { ...OK, kind: "sneak" }],
    ["a mismatched host/kind pair", { v: 1, host: "cursor", kind: "run", id: "x" }],
    ["an id with whitespace", { ...OK, id: "run 1" }],
    ["an id with a newline", { ...OK, id: "run\n1" }],
    ["an id with markdown-link", { ...OK, id: "a](b" }],
    ["a 257-character id", { ...OK, id: "a".repeat(257) }],
    ["an http url", { ...OK, url: "http://example.test/x" }],
    ["a url with userinfo", { ...OK, url: "https://user:pw@example.test/x" }],
    ["a control character", { ...OK, id: "run\u0001" }],
    ["a bidi override", { ...OK, id: "run\u202Eevil" }],
    ["an unknown key", { ...OK, extra: true }],
    ["v:2", { v: 2, host: "openclaw", kind: "run", id: "x" }],
    ["a url over 2048 chars", { ...OK, url: `https://example.test/${"a".repeat(2050)}` }],
  ];

  for (const [name, input] of refusals) {
    test(`${name} is REFUSED`, () => {
      const r = validateHostSource(input);
      expect(r.ok).toBe(false); // assertion: refused
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });
  }

  test("the 256-character boundary is ACCEPTED (not truncated)", () => {
    const id = "a".repeat(256);
    const r = validateHostSource({ ...OK, id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe(id); // never truncated
  });
});

describe("hostSource A1/A5 — stored shape and legacy nulls", () => {
  test("a legacy / absent value reads back null", () => {
    expect(parseHostSource(null)).toBeNull(); // assertion
    expect(parseHostSource(undefined)).toBeNull();
    expect(parseHostSource("")).toBeNull();
  });

  test("a stored non-canonical string that re-validates reads back as its value", () => {
    const got = parseHostSource(JSON.stringify(OK));
    expect(got?.host).toBe("openclaw");
    expect(got?.kind).toBe("run");
  });

  test("A5: the canonical hostSource carries NO provenance key", () => {
    const r = validateHostSource({ ...OK });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value)).not.toContain("provenance"); // assertion: A5
  });

  test("the closed pair set is exactly the three A2 pairs", () => {
    expect(HOST_SOURCE_PAIRS.map((p) => `${p.host}/${p.kind}`).sort()).toEqual([
      "codex/turn",
      "cursor/launch",
      "openclaw/run",
    ]);
  });

  test("A1 gate: schemas/memory.graphql declares hostSource nullable with the clean-upgrade-path idiom", () => {
    const schema = readFileSync(join(import.meta.dir, "../../schemas/memory.graphql"), "utf8");
    expect(schema).toContain("hostSource: String"); // assertion
    expect(/hostSource: String[\s\S]{0,800}clean-upgrade-path gate/.test(schema)).toBe(true);
  });
});
