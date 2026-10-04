/**
 * proto-safe-record-2235.test.ts — the shared null-prototype copy helper
 * (flair#2235). An own `__proto__` key is defined by JSON.parse; a copy that
 * goes through [[Set]] (Object.assign, or `target[key] = value`) when the target inherits the `__proto__` setter either turns
 * it into the copy's prototype or drops it, so a comparison silently ignores
 * it. protoSafeRecord keeps it as own data.
 */
import { describe, expect, test } from "bun:test";
import { protoSafeRecord } from "../../src/lib/proto-safe-record.js";
import { comparePreservedFields } from "../../src/lib/restore-verify.js";

/** JSON.parse defines an own `__proto__` key (a plain object literal would not). */
function parsedWithProtoKey(): Record<string, unknown> {
  return JSON.parse('{"__proto__":{"polluted":true},"label":"agent-a"}');
}

describe("protoSafeRecord", () => {
  test("keeps an own __proto__ key through a JSON round trip", () => {
    const source = parsedWithProtoKey();
    expect(Object.prototype.hasOwnProperty.call(source, "__proto__")).toBe(true); // precondition

    const copy = protoSafeRecord(source);

    expect(Object.getPrototypeOf(copy)).toBe(null);
    expect(Object.keys(copy).sort()).toEqual(["__proto__", "label"]);
    expect(Object.prototype.hasOwnProperty.call(copy, "__proto__")).toBe(true);
    // The __proto__ value survived as data; the serialized form matches a spread
    // copy, which also keeps own keys, but this copy additionally has no prototype.
    expect(JSON.stringify(copy)).toBe(JSON.stringify({ ...source }));
  });

  test("the copied own __proto__ key is visible to a comparison", () => {
    // The #2233 shape: an archived row whose `meta` carries an own __proto__ key
    // must not compare equal to a restored row that lost it.
    const archived = JSON.parse('{"id":"m1","agentId":"agent-a","meta":{"__proto__":{"x":1},"k":2}}');
    const same = JSON.parse('{"id":"m1","agentId":"agent-a","meta":{"__proto__":{"x":1},"k":2}}');
    const dropped = JSON.parse('{"id":"m1","agentId":"agent-a","meta":{"k":2}}');

    expect(comparePreservedFields("Memory", archived, same)).toEqual([]);
    expect(comparePreservedFields("Memory", archived, dropped)).toEqual(["meta"]);
  });

  test("maps each value with the supplied mapper, sorted keys preserved", () => {
    const copy = protoSafeRecord({ b: 2, a: 1 }, { keys: ["a", "b"], map: (v) => (v as number) * 10 });
    expect(JSON.stringify(copy)).toBe('{"a":10,"b":20}');
  });

  test("refuses a value the validator rejects, before returning a record", () => {
    let thrown: TypeError | null = null;
    try {
      protoSafeRecord({ a: "x" }, { validate: (v) => (typeof v === "string" ? "expected a number" : undefined) });
    } catch (err) {
      thrown = err as TypeError;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown?.message).toContain('"a"');
    expect(thrown?.message).toContain("expected a number");
  });

  test("accepts values the validator allows", () => {
    const copy = protoSafeRecord({ a: 1 }, { validate: (v) => (typeof v === "number" ? undefined : "not a number") });
    expect(JSON.stringify(copy)).toBe('{"a":1}');
  });
});
