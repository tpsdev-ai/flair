/**
 * proto-safe-record.ts — the one helper for copying an untrusted object's own
 * keys into a null-prototype record, entry by entry (flair#2235).
 *
 * Why this exists. A copy built with `Object.assign(target, source)` or an
 * explicit `target[key] = value` loop goes through [[Set]]. For the key
 * `__proto__` on a plain object that runs the inherited `Object.prototype`
 * accessor instead of creating a key, so an own `__proto__` key is either
 * turned into the copy's prototype (object value) or dropped (primitive
 * value). A comparison or checkpoint that reads the copy then silently
 * ignores a value the source carried (flair#2225, #2233).
 *
 * The copy here is built on `Object.create(null)` and each entry is defined as
 * an OWN property with `Object.defineProperty`, so every own enumerable string
 * key it copies survives, `__proto__` included, and the copy can never inherit
 * a prototype it did not ask for.
 *
 * Sites that copy an untrusted record into a plain object use this helper; the
 * source scanner in test/unit/proto-safe-copy-guard.test.ts fails the build on
 * a new un-allowlisted copy.
 */

/** A per-key value transform, e.g. a recursive normalizer. */
export type ProtoSafeValueMap = (value: unknown, key: string) => unknown;

/**
 * A per-key validator: return an error message to refuse the value, or
 * `undefined` to accept it.
 */
export type ProtoSafeValueValidator = (value: unknown, key: string) => string | undefined;

export interface ProtoSafeRecordOptions {
  /**
   * Own keys to copy, in this order. Defaults to `Object.keys(source)`.
   * Pass only own keys: reading `source[key]` for a key the source does not own
   * (e.g. a bare `__proto__`) returns an inherited value.
   */
  readonly keys?: readonly string[];
  /** Transform each value before it is stored — pass your own mapper to recurse. */
  readonly map?: ProtoSafeValueMap;
  /** Refuse a value: the copy throws before it returns a partial record. */
  readonly validate?: ProtoSafeValueValidator;
}

/**
 * Build a null-prototype record from `source`, own key by own key. Each key is
 * defined as an own enumerable property, so `__proto__` is a data key and never
 * the record's prototype. With `validate`, the first refused value throws a
 * `TypeError` naming the key, with no record returned.
 */
export function protoSafeRecord(source: object, options: ProtoSafeRecordOptions = {}): Record<string, unknown> {
  const src = source as Record<string, unknown>;
  const keys = options.keys ?? Object.keys(src);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const raw = src[key];
    const refused = options.validate?.(raw, key);
    if (refused !== undefined) {
      throw new TypeError(`protoSafeRecord: refused value for "${key}": ${refused}`);
    }
    Object.defineProperty(out, key, {
      value: options.map ? options.map(raw, key) : raw,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
