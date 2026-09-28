/**
 * caller-selection.ts — flair#1940 slice 1 (round 15, Flint's design ruling).
 *
 * The caller's selection on a non-admin `Memory.get` / `Memory.search` shapes
 * only the OUTPUT. The pointer decision reads the STORED row (Flint's earlier
 * ruling for this PR): a read that carries a `select` is answered by reading
 * the FULL row — the same id, or the same conditions/operator/limit/offset/
 * sort, under the same read scope — projecting it through the gated pointer
 * join (`projectRowsThroughPointers`), and THEN applying the caller's
 * selection. So the caller cannot move the pointer decision by choosing which
 * fields it asks for: an archived row, or a row whose selection omitted
 * `archived`, renders no pointer either way.
 *
 * NARROWED CONTRACT (round 15). Instead of matching every Harper selection
 * shape, a non-admin Memory read accepts a selection ONLY as an ARRAY of plain
 * Memory schema attribute names — the shape both ADK clients send,
 * `select(id,agentId,content,metadata,subject,tags,createdAt)`. Every other
 * shape is refused with 400 BEFORE any read, INCLUDING the auth middleware's
 * pre-read: a scalar `select`, a `property`, an empty selection, the wildcard
 * `*`, a virtual `$...` or nested name, a name not in the Memory schema, a
 * trailing or doubled comma, a `select` object, or options attached to an
 * iterable (array) selection.
 *
 * For an ACCEPTED array the output is each unselected, pointer-projected row
 * reduced to exactly those keys, with Harper's forceNulls semantics (a missing
 * OR undefined value becomes null), in the requested key order. Admin and
 * internal reads are unchanged.
 */
import { DECLARED_MEMORY_ATTRIBUTES } from "./memory-declared-attributes.js";

/** A parsed non-admin selection: none, or an accepted array of Memory schema
 *  attribute names (the only supported shape). */
export type CallerSelection =
  | { shape: "none" }
  | { shape: "keys"; keys: readonly string[] };

const DECLARED = new Set<string>(DECLARED_MEMORY_ATTRIBUTES as readonly string[]);

/** The ONLY accepted selection name: a plain, DECLARED Memory schema attribute.
 *  Not the wildcard `*`, not a virtual `$...` resolver, not nested. */
function isAcceptedName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && DECLARED.has(name);
}

/** The named 400 for a selection that is not an array of plain Memory schema
 *  attribute names. The message names the narrowed contract. */
export function selectionBadRequest(
  detail: string =
    "a non-admin Memory read accepts a selection only as an array of Memory " +
    "schema attribute names (for example id, agentId, content, metadata, " +
    "subject, tags, createdAt); a scalar `select`, a `property`, an empty " +
    "selection, the wildcard `*`, a virtual `$...` name, a name not in the " +
    "Memory schema, a trailing or doubled comma, a `select` object, or options " +
    "attached to the selection array are not supported",
): Response {
  return new Response(
    JSON.stringify({ error: "invalid_selection", message: detail }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** True when a by-id target or a collection query carries a selection. Mirrors
 *  record-type-kit.ts makeByIdReadGate's own shaped-target test. */
export function carriesSelection(holder: any): boolean {
  return !!holder && typeof holder === "object" && (holder.select != null || holder.property != null);
}

/**
 * Parse a caller's `select`/`property` into the accepted shape, or the 400
 * Response for any other shape. `{ shape: "none" }` means the request carried
 * neither — the read is returned whole, as before.
 *
 * ACCEPTED: `select` is an array whose every element is a plain, DECLARED
 * Memory schema attribute name, carrying no attached options (no `asArray`,
 * `forceNulls`, `operator`, ...). REFUSED (400, before any read): everything
 * else — including a scalar `select`, a `property`, an empty array, a wildcard
 * or virtual name, an unknown name, an empty segment (trailing/doubled comma),
 * a non-array `select`, or an array with attached options.
 */
export function parseCallerSelection(select: unknown, property: unknown): CallerSelection | Response {
  const hasSelect = select !== undefined && select !== null;
  const hasProperty = property !== undefined && property !== null;
  if (!hasSelect && !hasProperty) return { shape: "none" };
  if (hasProperty) {
    return selectionBadRequest("`property` is not supported on a non-admin Memory read");
  }
  if (typeof select === "string") {
    return selectionBadRequest("a scalar `select` is not supported on a non-admin Memory read");
  }
  if (!Array.isArray(select)) {
    return selectionBadRequest("a `select` object is not supported on a non-admin Memory read");
  }
  if (select.length === 0) {
    return selectionBadRequest("an empty selection is not supported on a non-admin Memory read");
  }
  // Options attached to the selection array (`asArray`, `forceNulls`, an
  // `operator`, ...) are refused: a plain array carries only its indices.
  if (Object.keys(select).length !== select.length) {
    return selectionBadRequest("options attached to the selection array are not supported");
  }
  for (const name of select) {
    if (!isAcceptedName(name)) return selectionBadRequest();
  }
  return { shape: "keys", keys: select as string[] };
}

/**
 * Apply a parsed selection to an already-projected row:
 *   - `keys` → a NEW object carrying exactly the named keys, in the caller's
 *     order, with Harper's forceNulls semantics (a missing OR undefined value
 *     becomes `null`);
 *   - `none` → the row, unchanged.
 */
export function applyCallerSelection(projected: any, selection: CallerSelection): any {
  if (selection.shape === "none") return projected;
  const out: Record<string, unknown> = {};
  for (const key of selection.keys) {
    const value = projected && typeof projected === "object" ? (projected as any)[key] : undefined;
    out[key] = value === undefined ? null : value;
  }
  return out;
}

/**
 * flair#1940 round 15 — the REST selection/path-property forms Harper parses
 * BEFORE it dispatches to the resource, read from the raw URL. The auth
 * middleware runs before the handler and sees only the URL, so it needs this to
 * refuse an unsupported selection before its Memory pre-read.
 *
 * Mirrors Harper: `resources/search.ts` `parseQuery` reads each `select(a,b,c)`
 * target (several names as an array; a single name as a string; `select((a,b))`
 * as a nested list flagged `asArray`) and re-assigns `query.select` on each, so
 * the LAST call is the effective selection; `resources/Resource.ts` `parsePath`
 * turns a `.<name>` suffix on the id (`/Memory/<id>.<name>`) into `property`.
 * Unlike Harper, this helper keeps EMPTY segments (it does not drop a trailing
 * or doubled comma), so `parseCallerSelection` refuses that shape. Returns the
 * selection in the shape `parseCallerSelection` takes, or `null` when the URL
 * carries neither form.
 */
export function restSelection(pathname: string, search: string): { select?: any; property?: any } | null {
  const out: { select?: any; property?: any } = {};
  const args = selectArgs(search);
  if (args.length > 0) {
    const inner = args[args.length - 1]; // Harper re-assigns: the LAST select(...) wins
    if (inner.startsWith("(") && inner.endsWith(")")) {
      // `select((a,b))` — the nested list form (Harper flags it `asArray`).
      const names = inner.slice(1, -1).split(",").map(decodeName);
      (names as any).asArray = true;
      out.select = names;
    } else {
      // Keep empty segments: a trailing or doubled comma is refused, not a
      // separator artifact (round-15 ruling).
      const parts = inner.split(",").map(decodeName);
      out.select = parts.length === 1 ? parts[0] : parts;
    }
  }
  const dot = pathPropertyName(pathname);
  if (dot !== null) out.property = dot;
  return out.select !== undefined || out.property !== undefined ? out : null;
}

/** The raw contents of each `select(...)` call in `search`. The matching `)`
 *  accounts for Harper's nested-list form (`select((a,b))`). */
function selectArgs(search: string): string[] {
  const out: string[] = [];
  const marker = "select(";
  let from = 0;
  for (;;) {
    const idx = search.indexOf(marker, from);
    if (idx < 0) break;
    // Reject a match inside a longer identifier (e.g. `aselect(`).
    const before = idx > 0 ? search[idx - 1] : "";
    if (before && /[A-Za-z0-9_$-]/.test(before)) {
      from = idx + marker.length;
      continue;
    }
    const open = idx + marker.length;
    let depth = 1;
    let i = open;
    for (; i < search.length; i++) {
      const ch = search[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= search.length) break; // unterminated — Harper's own parser reports the malformed query
    out.push(search.slice(open, i));
    from = i + 1;
  }
  return out;
}

/** The `.<name>` property on the last path segment (`/Memory/<id>.<name>`), or
 *  null. Mirrors Resource.ts `parsePath` (everything after the FIRST dot). */
function pathPropertyName(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  const dot = seg.indexOf(".");
  if (dot < 0 || dot === seg.length - 1) return null;
  return decodeName(seg.slice(dot + 1));
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
