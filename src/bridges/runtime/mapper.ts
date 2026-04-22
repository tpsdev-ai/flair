/**
 * JSONPath-subset expression evaluator.
 *
 * The YAML descriptor's `map` object binds BridgeMemory fields to source-side
 * expressions. Slice 2 supports:
 *
 *   "$.field"           — root-level field of the source record
 *   "$.nested.field"    — dotted path
 *   "$.array[*]"        — the full array (caller decides what to do with it)
 *   "$.array[0]"        — specific index
 *   "literal string"    — string literal (no $ prefix) — used as a constant
 *
 * Slice 3 will extend with expressions (`foreignId ?? id`, ternaries, boolean
 * predicates for `when:`). For now, `when` is ignored unless it starts with
 * `$.` — a conservative default so stored descriptors don't error out.
 *
 * All functions are pure and synchronous. No file or network I/O.
 */

/**
 * Evaluate a mapping expression against a record. Returns `undefined` if the
 * lookup misses — callers decide whether that's a skip or a hard error.
 */
export function evaluate(expression: string, record: unknown): unknown {
  if (typeof expression !== "string") return undefined;

  // Literal (no $ prefix) → constant string
  if (!expression.startsWith("$")) return expression;

  // $ alone → the whole record
  if (expression === "$") return record;

  // Must start with $. for a path
  if (!expression.startsWith("$.")) return undefined;

  const path = expression.slice(2);
  const tokens = tokenize(path);
  if (tokens === null) return undefined; // malformed — refuse to guess
  return walk(tokens, record);
}

function walk(tokens: PathToken[], value: unknown): unknown {
  let cursor: unknown = value;
  for (const tok of tokens) {
    if (cursor == null) return undefined;
    if (tok.kind === "field") {
      if (typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[tok.name];
    } else if (tok.kind === "index") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[tok.index];
    } else if (tok.kind === "splat") {
      if (!Array.isArray(cursor)) return undefined;
      // '[*]' returns the whole array; subsequent tokens don't apply
      return cursor;
    }
  }
  return cursor;
}

type PathToken =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "splat" };

function tokenize(path: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === ".") { i++; continue; }
    if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) return null; // malformed — unterminated bracket
      const inner = path.slice(i + 1, end);
      if (inner === "*") tokens.push({ kind: "splat" });
      else {
        const n = Number.parseInt(inner, 10);
        if (!Number.isFinite(n)) return null; // malformed — non-numeric, non-splat bracket content
        tokens.push({ kind: "index", index: n });
      }
      i = end + 1;
      continue;
    }
    // Field name: run until next . or [
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    const name = path.slice(i, j);
    if (name) tokens.push({ kind: "field", name });
    i = j;
  }
  return tokens;
}

/**
 * Apply an entire `map: { field: expression, ... }` block to a source record,
 * producing a BridgeMemory-shaped partial. Empty-string and undefined results
 * are dropped. Arrays are preserved (tags may be an array splat).
 */
export function applyMap(
  mapping: Record<string, string>,
  record: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(mapping)) {
    const value = evaluate(expr, record);
    if (value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    out[field] = value;
  }
  return out;
}
