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
});
