/**
 * Runtime check of a native /mcp `tools/call` arguments object against the
 * declared argument types and required properties of the tool's inputSchema,
 * before the tool runs. JSON-RPC arguments are
 * untyped at runtime; the tool implementations are written for the declared
 * types, so a value of another type is refused here instead of reaching them.
 *
 * Checked at the top level of the schema (the native tools declare only
 * top-level primitive, array and object properties):
 *   - the arguments are a plain object (or absent, meaning {});
 *   - every `required` property is present (not undefined or null);
 *   - every present, non-null property matches its declared `type` (string,
 *     number, integer, boolean, array, object; a type list allows any of them),
 *     and an array's items match `items.type` when it declares one;
 *   - when the schema declares an `id` argument, it is a non-empty string (ids
 *     address one record).
 * Properties the schema does not declare, and enum values, are left to the
 * tool, as before. withoutNullArguments() then drops null-valued properties so
 * a tool never forwards a null where its schema declares a type.
 */

type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

function matches(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null": return value === null;
    default: return true; // an undeclared or unknown type constrains nothing
  }
}

function matchesAny(value: unknown, declared: unknown): boolean {
  if (declared === undefined) return true;
  const types = (Array.isArray(declared) ? declared : [declared]) as JsonType[];
  return types.some((t) => matches(value, t));
}

/** Returns a message naming the first non-conforming argument, or null. */
export function checkToolArguments(schema: any, args: unknown): string | null {
  const value = args === undefined ? {} : args;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "arguments must be a JSON object";
  }
  const obj = value as Record<string, unknown>;
  const props: Record<string, any> = schema?.properties ?? {};
  for (const name of (schema?.required ?? []) as string[]) {
    if (obj[name] === undefined || obj[name] === null) return `missing required argument "${name}"`;
  }
  for (const [name, prop] of Object.entries(props)) {
    const v = obj[name];
    if (v === undefined || v === null) continue;
    if (!matchesAny(v, prop?.type)) {
      const t = Array.isArray(prop.type) ? prop.type.join(" or ") : prop.type;
      return `argument "${name}" must be of type ${t}`;
    }
    if (Array.isArray(v) && prop?.items?.type !== undefined) {
      const bad = v.findIndex((item) => !matchesAny(item, prop.items.type));
      if (bad >= 0) return `argument "${name}" item ${bad} must be of type ${prop.items.type}`;
    }
  }
  if ("id" in props && obj.id !== undefined && obj.id !== null
      && (typeof obj.id !== "string" || obj.id.length === 0)) {
    return `argument "id" must be a non-empty string`;
  }
  return null;
}

/** The arguments without null- or undefined-valued properties: an optional
 *  argument given as null is treated as absent (required ones were already
 *  checked to be present). Returns {} for absent arguments. */
export function withoutNullArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}
