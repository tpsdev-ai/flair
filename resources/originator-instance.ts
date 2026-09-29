import { databases } from "harper";
import { localInstanceId } from "./instance-identity.js";

/**
 * originator-instance.ts — the single resource-layer delegate that enforces the
 * server-stamped `originatorInstanceId` contract on every REST write path
 * (flair#1965).
 *
 * ─── The contract ────────────────────────────────────────────────────────────
 *
 * `originatorInstanceId` names the federation instance that AUTHORED a record
 * (schemas/memory.graphql, agent.graphql): it is stamped server-side and is
 * never client-writable. Before this module each of Memory/Soul/Agent/
 * Relationship only stamped it when the request body's value was null
 * (`content.originatorInstanceId == null`), so a caller could supply or change
 * it on create AND on update. The rule enforced now is:
 *
 *   - CREATE (`post()`, and a `put()`/`patch()` that lands on a row with no
 *     stored counterpart): the local instance id is stamped; ANY request-body
 *     value is ignored.
 *   - UPDATE (`put()`/`patch()` over an existing row): the STORED value
 *     stands. A body value neither replaces nor clears it, and omitting the
 *     field leaves it exactly as stored (a legacy row with no value is left
 *     without one — the field is additive, never invented on update).
 *   - FEDERATION MERGE: unchanged. The trusted apply path
 *     (resources/Federation.ts's `FederationSync.post()`) merges a peer's row
 *     through the RAW table handle — `(databases as any).flair.Memory.put(
 *     mergedData)`, i.e. Harper's static table-level put — never through a
 *     resource's post()/put()/patch(). It therefore never consults a request
 *     body, and the originator's own value carried in `record.data` (selected
 *     by `mergeRecord`'s LWW, or the inbound row for a new one) is preserved
 *     verbatim. `_originatorInstanceId` (the underscore form) is the separate
 *     RECEIVER-side bookkeeping stamp that same path writes.
 *
 * The distinction is the trusted merge path, never a body field: a body field
 * is exactly what a client controls, so no REST-reachable writer may honour it.
 *
 * `localInstanceId()` resolves to null on an instance that has never been
 * federation-bootstrapped (no single Instance row yet) — the field is nullable
 * by design, so a create stamps null rather than inventing an id.
 */

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * CREATE path — stamp this instance's own federation id, ignoring any value the
 * request body carried. Used by `post()` (always a create) and by a
 * `put()`/`patch()` whose target id has no stored row yet.
 */
export async function stampOriginatorOnCreate(content: unknown): Promise<void> {
  if (!isPlainObject(content)) return;
  content.originatorInstanceId = await localInstanceId();
}

/**
 * UPDATE path — the STORED value stands. A body value is dropped (neither
 * replaces nor clears it); when the stored row carries no value the field is
 * left off the write so a legacy row stays un-stamped rather than gaining a
 * fresh local id.
 *
 * `stored` is the row this write is over. For a `put()` (which REPLACES the
 * row) the stored value is re-asserted explicitly; for a merging `patch()` the
 * field is simply removed from the body so the stored value survives. Both use
 * this one function so the two verbs cannot drift.
 */
export function keepStoredOriginator(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): void {
  if (!isPlainObject(content)) return;
  if (isPlainObject(stored) && stored.originatorInstanceId !== undefined) {
    content.originatorInstanceId = stored.originatorInstanceId;
  } else {
    delete content.originatorInstanceId;
  }
}

/**
 * Apply the full create/update rule to a `put()` body: `stored` is the row the
 * put is over (null/undefined ⇒ a create). This is the one call a resource's
 * `put()` needs after it has resolved the pre-existing row.
 */
export async function applyOriginatorInstanceId(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): Promise<void> {
  if (isPlainObject(stored)) {
    keepStoredOriginator(content, stored);
  } else {
    await stampOriginatorOnCreate(content);
  }
}

/**
 * PATCH path — a patch MERGES into the stored row (Harper partial update), so a
 * body value can be dropped and the stored value stands untouched.
 */
export function dropClientOriginator(content: unknown): void {
  if (isPlainObject(content)) delete content.originatorInstanceId;
}

/**
 * Resolve the row a `put()`/`patch()` is over, for the create/update decision:
 * the stored row keyed by the body's `id` when it names one (the REST PUT path
 * always does; this is the same raw-table lookup Memory.put() already uses for
 * `preExisting`), else the URL-bound record via the caller's `super.get()`.
 * A read failure is treated as "no stored row" (a create) — the lookup can only
 * ADD a stamp, never widen what a caller may write.
 */
export async function resolveStoredRow(
  tableName: string,
  getUrlBound: () => unknown,
  content: unknown,
): Promise<Record<string, any> | null> {
  const id = isPlainObject(content) ? content.id : undefined;
  try {
    if (id !== undefined && id !== null) {
      const row = await (databases as any).flair[tableName].get(id);
      return isPlainObject(row) ? row : null;
    }
  } catch {
    return null;
  }
  try {
    const row = await Promise.resolve(getUrlBound());
    return isPlainObject(row) && !(row instanceof Response) ? row : null;
  } catch {
    return null;
  }
}
