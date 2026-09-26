/**
 * The ONE pairing-token-id redactor (flair#1902).
 *
 * A pairing-token id IS the credential a spoke redeems, so only its 8-character
 * prefix may reach a log line. Three sites grew their own copy of this rule in
 * one day, so it lives here as one deep redactor every token-id-carrying line
 * uses: a string (a message, a string field at any depth, an array element, or
 * an object KEY) has each secret replaced; non-string scalars pass through; and a
 * secret shorter than MIN_SECRET_LENGTH is replaced in full, because an
 * 8-character "prefix" of an 11-character id is not a redaction.
 */

import { describe, expect, test } from "bun:test";
import {
  createTokenRedactor,
  FULLY_REDACTED,
  MIN_SECRET_LENGTH,
  redactTokenIds,
  redactTokenMessage,
} from "../../src/lib/redact-token-id.js";

// 32 characters, like a real pairing-token id — so its 8-character prefix is a
// strict prefix and "the whole id never appears" is not vacuous.
const TOKEN = "pair-token-live-abcdefghijklmnop";
const PREFIX = TOKEN.slice(0, 8);
// A DIFFERENT token id, to prove a foreign secret in the batch is cut too.
const OTHER = "foreign-token-id-0123456789abcdef";
const OTHER_PREFIX = OTHER.slice(0, 8);
// Shorter than MIN_SECRET_LENGTH: must be replaced in full.
const SHORT = "short_id";

describe("redactTokenIds — deep token-id redaction (flair#1902)", () => {
  test("redacts a message string", () => {
    expect(redactTokenMessage(`before ${TOKEN} after`, [TOKEN])).toBe(`before ${PREFIX}… after`);
  });

  test("redacts a string field at the top level", () => {
    expect(redactTokenIds({ tid: TOKEN, ok: true }, [TOKEN])).toEqual({ tid: `${PREFIX}…`, ok: true });
  });

  test("redacts a nested value at any depth", () => {
    expect(redactTokenIds({ a: { b: { c: `carries ${TOKEN}` } } }, [TOKEN])).toEqual({
      a: { b: { c: `carries ${PREFIX}…` } },
    });
  });

  test("redacts an array element", () => {
    expect(redactTokenIds([TOKEN, "plain", 7], [TOKEN])).toEqual([`${PREFIX}…`, "plain", 7]);
  });

  test("redacts an object KEY as well as its value", () => {
    expect(redactTokenIds({ [TOKEN]: TOKEN }, [TOKEN])).toEqual({ [`${PREFIX}…`]: `${PREFIX}…` });
  });

  test("leaves numbers, booleans and null untouched", () => {
    const value = { n: 7, b: true, z: null, list: [1, false, null] };
    expect(redactTokenIds(value, [TOKEN])).toEqual(value);
  });

  test("replaces a secret shorter than the minimum in FULL", () => {
    expect(SHORT.length).toBeLessThan(MIN_SECRET_LENGTH);
    expect(redactTokenMessage(`a ${SHORT} b`, [SHORT])).toBe(`a ${FULLY_REDACTED} b`);
    expect(redactTokenIds({ [SHORT]: SHORT }, [SHORT])).toEqual({ [FULLY_REDACTED]: FULLY_REDACTED });
  });

  test("the boundary: an 11-character secret is replaced in full, a 12-character secret keeps its 8-character prefix", () => {
    const eleven = "abcdefghijk"; // 11 characters — one below the bound
    const twelve = "abcdefghijkl"; // 12 characters — at the bound
    expect(eleven).toHaveLength(MIN_SECRET_LENGTH - 1);
    expect(twelve).toHaveLength(MIN_SECRET_LENGTH);
    expect(redactTokenMessage(`a ${eleven} b`, [eleven])).toBe(`a ${FULLY_REDACTED} b`);
    expect(redactTokenMessage(`a ${twelve} b`, [twelve])).toBe(`a ${twelve.slice(0, 8)}… b`);
  });

  test("ignores empty secrets — no replacement spliced between characters", () => {
    expect(redactTokenMessage("abc", [""])).toBe("abc");
    expect(redactTokenIds({ a: "b" }, ["", ""])).toEqual({ a: "b" });
  });

  test("redacts several secrets, including one from another token", () => {
    expect(redactTokenMessage(`a ${TOKEN} b ${OTHER} c`, [TOKEN, OTHER])).toBe(
      `a ${PREFIX}… b ${OTHER_PREFIX}… c`,
    );
  });

  test("returns the value unchanged when there are no secrets", () => {
    const value = { a: "b" };
    expect(redactTokenIds(value, [])).toBe(value);
  });

  test("with an overlapping short secret, the LONGER id is redacted and its suffix does not survive", () => {
    const long = "abcdefghijklmnopqrstuvwx"; // 24 chars
    const short = long.slice(0, 8); // an 8-char prefix of `long`, under the minimum
    const out = redactTokenMessage(`id ${long}`, [short, long]);
    expect(out).toContain(long.slice(0, 8));
    expect(out).not.toContain(long);
    // The characters after the prefix must not survive: a shorter secret that
    // matched first would have left them exposed.
    expect(out).not.toContain(long.slice(8));
  });

  test("a compiled redactor can be reused across values and messages", () => {
    const redactor = createTokenRedactor([TOKEN]);
    expect(redactor.redactMessage(`a ${TOKEN}`)).toBe(`a ${PREFIX}…`);
    expect(redactor.redactMessage(`b ${TOKEN}`)).toBe(`b ${PREFIX}…`);
    expect(redactor.redactValue({ k: TOKEN, list: [TOKEN] })).toEqual({
      k: `${PREFIX}…`,
      list: [`${PREFIX}…`],
    });
  });
});

describe("redactTokenIds — walk robustness (flair#1902)", () => {
  test("a cyclic value does not throw", () => {
    const cyclic: any = { name: "loop" };
    cyclic.self = cyclic;
    let out: any;
    expect(() => {
      out = redactTokenIds(cyclic, [TOKEN]);
    }).not.toThrow();
    // The container already on the path is returned as-is, not recursed into.
    expect(out.self).toBe(cyclic);
  });

  test("a non-plain object keeps its identity and its message", () => {
    const err = new Error(`boom ${TOKEN}`);
    const out = redactTokenIds({ e: err }, [TOKEN]) as any;
    // The Error passes through unchanged: rebuilding it through Object.entries
    // would drop its message, and String(err) is what a caller logs.
    expect(out.e).toBe(err);
    expect(out.e.message).toBe(`boom ${TOKEN}`);
  });

  test("a Date passes through unchanged", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect((redactTokenIds({ d }, [TOKEN]) as any).d).toBe(d);
  });
});
