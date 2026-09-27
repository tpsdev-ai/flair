/**
 * caller-selection.ts — flair#1940 slice 1 (A1' / round 12).
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
 * Two selection shapes are supported on a non-admin read:
 *   - a single field name — a string `select`, or `property` — yields that
 *     field's value from the projected row;
 *   - an array of field names (`select: [...]`) yields an object with only
 *     those keys (absent attributes are omitted, exactly as Harper's own
 *     projection omits them).
 * Any other shape is refused with 400 BEFORE any read, and the message names
 * the two supported shapes.
 */

/** A parsed non-admin selection: none, one field (scalar), or a list of keys. */
export type CallerSelection =
  | { shape: "none" }
  | { shape: "field"; field: string }
  | { shape: "keys"; keys: readonly string[] };

/** The named 400 for an unsupported non-admin selection shape. */
export function selectionBadRequest(): Response {
  return new Response(
    JSON.stringify({
      error: "invalid_selection",
      message:
        "a non-admin Memory read supports two selection shapes: a single field name " +
        "(a string `select`, or `property`) or an array of field names (`select: [name, ...]`)",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** True when a by-id target or a collection query carries a selection. Mirrors
 *  record-type-kit.ts makeByIdReadGate's own shaped-target test. */
export function carriesSelection(holder: any): boolean {
  return !!holder && typeof holder === "object" && (holder.select != null || holder.property != null);
}

/**
 * Parse a caller's `select`/`property` into one of the two supported shapes, or
 * the 400 Response for any other shape. `{ shape: "none" }` means the request
 * carried neither — the read is returned whole, as before.
 *
 * Precedence: an explicit `property` (Harper's "request a specific property")
 * wins over `select`; a string `select` is the same single-field shape.
 */
export function parseCallerSelection(select: unknown, property: unknown): CallerSelection | Response {
  const hasSelect = select !== undefined && select !== null;
  const hasProperty = property !== undefined && property !== null;
  if (!hasSelect && !hasProperty) return { shape: "none" };
  if (hasProperty) {
    return typeof property === "string" && property.length > 0
      ? { shape: "field", field: property }
      : selectionBadRequest();
  }
  if (typeof select === "string" && select.length > 0) return { shape: "field", field: select };
  if (
    Array.isArray(select) &&
    select.length > 0 &&
    select.every((name) => typeof name === "string" && name.length > 0)
  ) {
    return { shape: "keys", keys: select as string[] };
  }
  return selectionBadRequest();
}

/**
 * Apply a parsed selection to an already-projected row.
 *   - `field` → that field's value (undefined when absent — the same no-value
 *     shape an unselected read of a missing field gives, never a 404);
 *   - `keys`  → a NEW object with only the present keys, in the caller's order
 *     (absent attributes are omitted, matching Harper's projection);
 *   - `none`  → the row, unchanged.
 */
export function applyCallerSelection(projected: any, selection: CallerSelection): any {
  if (selection.shape === "none") return projected;
  if (selection.shape === "field") {
    return projected && typeof projected === "object" ? projected[selection.field] : undefined;
  }
  const out: Record<string, unknown> = {};
  if (projected && typeof projected === "object") {
    for (const key of selection.keys) if (key in (projected as object)) out[key] = (projected as any)[key];
  }
  return out;
}
