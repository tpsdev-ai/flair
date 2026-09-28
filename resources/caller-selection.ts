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
 * SUPPORTED SELECTION SHAPES (a non-admin read). The accepted field set is
 * exactly the Memory row's own plain attributes:
 *   - a single field name — a string `select`, or `property` on a by-id read —
 *     yields that field's value from the projected row;
 *   - an array of field names (`select: [...]`) yields an object with every
 *     named key present (Harper's in-process array projection retains selected
 *     missing keys with `undefined` values, so this does too), in the caller's
 *     order — UNLESS the array is flagged `asArray`, in which case it yields an
 *     array of the values in select order, exactly as Harper does.
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
  | { shape: "keys"; keys: readonly string[] }
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
    return (select as any).asArray ? { shape: "array", keys } : { shape: "keys", keys };
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
    out[key] = projected && typeof projected === "object" ? (projected as any)[key] : undefined;
  }
  return out;
}
