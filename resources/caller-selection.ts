/**
 * caller-selection.ts — flair#1940 slice 1 (A1' / round 12-13).
 *
 * The caller's selection on a non-admin `Memory.get` / `Memory.search` shapes
 * only the OUTPUT. The pointer decision reads the STORED row (Flint's design
 * ruling for this PR): a read that carries a `select` or `property` is answered
 * by reading the FULL row — the same id, or the same conditions/operator/limit/
 * offset/sort, under the same read scope — projecting it through the gated
 * pointer join (`projectRowsThroughPointers`), and THEN applying the caller's
 * selection. So the caller cannot move the pointer decision by choosing which
 * fields it asks for: an archived row, or a row whose selection omitted
 * `archived`, renders no pointer either way.
 *
 * SUPPORTED SELECTION SHAPES (a non-admin read). An accepted name is any
 * plain, non-empty attribute name — the set is NOT restricted to a fixed list
 * of fields; only the wildcard `*` and the virtual `$...` resolvers are
 * excluded, because those resolve server-side against the index/entry Harper
 * holds and a plain projected row cannot reproduce them:
 *   - a single field name — a string `select`, or `property` on a by-id read —
 *     yields that field's value from the projected row;
 *   - an array of field names (`select: [...]`) yields an object with every
 *     named key present (Harper's in-process array projection retains selected
 *     missing keys with `undefined` values, or with `null` when the array is
 *     flagged `forceNulls` — Table.ts: `value === undefined && forceNulls →
 *     null` — so this does too), in the caller's order — UNLESS the array is
 *     flagged `asArray`, in which case it yields an array of the values in
 *     select order, exactly as Harper does (`asArray` ignores `forceNulls`, as
 *     Harper's own projection does).
 * The wildcard `*` and virtual resolver names (`$id`, `$record`, `$distance`,
 * `$updatedTime`, ...) are NOT supported: they are resolved server-side against
 * the index/entry Harper holds, which a plain projected row cannot reproduce,
 * so they are refused with 400 BEFORE any read rather than answered wrongly.
 * `property` is supported on a by-id read only — Harper search does not honour
 * `property`, so a collection `property` is refused with 400 before a read.
 * Any other shape is likewise refused with 400 BEFORE any read, and the message
 * names the supported field set.
 */

/** A parsed non-admin selection: none, one field (scalar), a keyed object, or
 *  an `asArray` value list. */
export type CallerSelection =
  | { shape: "none" }
  | { shape: "field"; field: string }
  | { shape: "keys"; keys: readonly string[]; forceNulls: boolean }
  | { shape: "array"; keys: readonly string[] };

/** Which read surface a selection is being validated for. `property` is a
 *  by-id-only shape (Harper search ignores `property`). */
export type SelectionSurface = "byId" | "collection";

const WILDCARD = "*";

/** A name this helper can project from a plain row: a non-empty plain attribute.
 *  The wildcard `*` and virtual `$...` resolvers are Harper-side only. */
function isSupportedFieldName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== WILDCARD && !name.startsWith("$");
}

/** The named 400 for an unsupported non-admin selection shape. */
export function selectionBadRequest(
  detail: string =
    "a non-admin Memory read supports a single field name (a string `select`, or " +
    "`property` on a by-id read) or an array of field names; names must be plain " +
    "non-empty attributes — the wildcard `*` and virtual `$...` resolvers are not supported",
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
 * Parse a caller's `select`/`property` into one of the supported shapes, or the
 * 400 Response for any other shape. `{ shape: "none" }` means the request
 * carried neither — the read is returned whole, as before.
 *
 * Precedence: an explicit `property` (Harper's "request a specific property")
 * wins over `select`; a string `select` is the same single-field shape. On a
 * collection surface `property` is refused (Harper search does not honour it).
 */
export function parseCallerSelection(
  select: unknown,
  property: unknown,
  opts?: { surface?: SelectionSurface },
): CallerSelection | Response {
  const surface: SelectionSurface = opts?.surface ?? "byId";
  const hasSelect = select !== undefined && select !== null;
  const hasProperty = property !== undefined && property !== null;
  if (!hasSelect && !hasProperty) return { shape: "none" };
  if (hasProperty) {
    if (surface === "collection") {
      return selectionBadRequest(
        "`property` is supported on a by-id Memory read only; a collection read " +
          "supports a single field name (a string `select`) or an array of field names",
      );
    }
    return isSupportedFieldName(property) ? { shape: "field", field: property } : selectionBadRequest();
  }
  if (isSupportedFieldName(select)) return { shape: "field", field: select };
  if (Array.isArray(select) && select.length > 0 && select.every(isSupportedFieldName)) {
    const keys = select as string[];
    // `forceNulls` is Harper's array-projection flag (Table.ts: a selected key
    // the record lacks becomes `null`, not `undefined`); `asArray` is a values
    // list and ignores it, exactly as Harper does.
    const forceNulls = (select as any).forceNulls === true;
    return (select as any).asArray ? { shape: "array", keys } : { shape: "keys", keys, forceNulls };
  }
  return selectionBadRequest();
}

/**
 * Apply a parsed selection to an already-projected row.
 *   - `field` → that field's value (undefined when absent — the same no-value
 *     shape an unselected read of a missing field gives, never a 404);
 *   - `keys`  → a NEW object carrying EVERY named key, in the caller's order; a
 *     selected key the row does not carry is retained with an `undefined`
 *     value, matching Harper's in-process array projection;
 *   - `array` → a NEW array of the named values, in select order (`asArray`);
 *   - `none`  → the row, unchanged.
 */
export function applyCallerSelection(projected: any, selection: CallerSelection): any {
  if (selection.shape === "none") return projected;
  if (selection.shape === "field") {
    return projected && typeof projected === "object" ? projected[selection.field] : undefined;
  }
  if (selection.shape === "array") {
    return selection.keys.map((key) => (projected && typeof projected === "object" ? (projected as any)[key] : undefined));
  }
  const out: Record<string, unknown> = {};
  for (const key of selection.keys) {
    out[key] = selectionValue(projected, key, selection.forceNulls);
  }
  return out;
}

/** The value a named key contributes to a projected object: the row's own value
 *  when it carries the key, else `null` for a `forceNulls` selection and
 *  `undefined` otherwise (Harper's Table.ts projection). */
function selectionValue(projected: any, key: string, forceNulls: boolean): unknown {
  if (projected && typeof projected === "object" && key in projected) {
    return (projected as any)[key];
  }
  return forceNulls ? null : undefined;
}

/**
 * flair#1940 round 14 — the REST selection/path-property forms Harper parses
 * BEFORE it dispatches to the resource, read from the raw URL. The auth
 * middleware runs before the handler and sees only the URL, so it needs this to
 * refuse an unsupported selection before its Memory pre-read.
 *
 * Mirrors Harper: `resources/search.ts` `parseQuery` turns `select(a,b,c)` into
 * `target.select` (a single name as a string, several as an array) and
 * `select((a,b,c))` into an array flagged `asArray`; `resources/Resource.ts`
 * `parsePath` turns a `.<name>` suffix on the id (`/Memory/<id>.<name>`) into
 * `target.property`. Returns the selection in the shape `parseCallerSelection`
 * accepts, or `null` when the URL carries neither form.
 */
export function restSelection(pathname: string, search: string): { select?: any; property?: any } | null {
  const out: { select?: any; property?: any } = {};
  const selectArg = selectorArg(search, "select");
  if (selectArg !== null) {
    let inner = selectArg;
    let asArray = false;
    if (inner.startsWith("(") && inner.endsWith(")")) {
      asArray = true;
      inner = inner.slice(1, -1);
    }
    const names = inner.length ? inner.split(",").map(decodeName) : [];
    if (asArray) (names as any).asArray = true;
    out.select = names.length === 1 && !asArray ? names[0] : names;
  }
  const dot = pathPropertyName(pathname);
  if (dot !== null) out.property = dot;
  return out.select !== undefined || out.property !== undefined ? out : null;
}

/** The raw contents of the `keyword(...)` call in `search`, or null. The
 *  matching `)` accounts for Harper's nested-list form (`select((a,b))`). */
function selectorArg(search: string, keyword: string): string | null {
  const marker = `${keyword}(`;
  const idx = search.indexOf(marker);
  if (idx < 0) return null;
  // Reject a match inside a longer identifier (e.g. `aselect(`).
  const before = idx > 0 ? search[idx - 1] : "";
  if (before && /[A-Za-z0-9_$-]/.test(before)) return null;
  const open = idx + marker.length;
  let depth = 1;
  for (let i = open; i < search.length; i++) {
    const ch = search[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return search.slice(open, i);
    }
  }
  return null; // unterminated — Harper's own parser reports the malformed query
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
