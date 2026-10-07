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
 *     resource's post()/put()/patch(). The originator's own value carried in
 *     `record.data` (selected by `mergeRecord`'s LWW, or the inbound row for a
 *     new one) is therefore preserved verbatim. `_originatorInstanceId` (the
 *     underscore form) is the separate RECEIVER-side bookkeeping stamp that
 *     same path writes.
 *
 * The wire field is server-stamped on EVERY application write. The federation
 * merge is the one path that carries a peer's value, and it is not
 * "body-less": `POST /FederationSync` IS REST-reachable and parses a request
 * body, but that body is trusted only because the handler verifies a batch
 * signature against the sending PAIRED PEER's pinned public key (and each
 * record's own signature against its claimed originator's pinned key) before
 * the raw-table merge. No unauthenticated caller reaches the raw write, and the
 * merge never reads a request-body field into the stored `originatorInstanceId`
 * — it takes the value from the already-authenticated `record.data`.
 *
 * `localInstanceId()` resolves to null on an instance that has never been
 * federation-bootstrapped (no single Instance row yet) — the field is nullable
 * by design, so a create stamps null rather than inventing an id.
 */

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A stored row is a plain object; a `Response` (a refusal the caller's own
 *  get() produced) or anything else is not. */
function isStoredRow(value: unknown): value is Record<string, any> {
  return isPlainObject(value) && !(value instanceof Response);
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
 * Apply the full create/update rule: `stored` is the row this write is over
 * (null/undefined ⇒ a create). This is the one call a `put()` or `patch()` needs
 * after it has resolved the pre-existing row.
 */
export async function applyOriginatorInstanceId(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): Promise<void> {
  if (isStoredRow(stored)) {
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
 * ─── Federation bookkeeping (the underscore receiver stamps) ────────────────
 *
 * `_originatorInstanceId`, `_syncedFrom` and `_syncedAt` are the RECEIVER-side
 * bookkeeping written by resources/Federation.ts's merge (through the RAW table
 * handle) on every synced row, and rendered by resources/AdminMemory.ts's
 * admin provenance pane. They are on the Memory writer whitelist so the merge
 * can write them, but they are NOT client-settable: a write body must never
 * pass one through (a forged value would dress a local row up as a synced one
 * in the admin pane). The federation merge writes them AFTER its whitelist
 * pass, so it is unaffected by the application-side strip below.
 */
const FEDERATION_BOOKKEEPING_FIELDS = ["_originatorInstanceId", "_syncedFrom", "_syncedAt"] as const;

/** CREATE path — drop any client-supplied receiver bookkeeping. */
export function dropClientFederationBookkeeping(content: unknown): void {
  if (!isPlainObject(content)) return;
  for (const field of FEDERATION_BOOKKEEPING_FIELDS) delete content[field];
}

/** UPDATE path (full replace) — the STORED receiver stamps stand. */
export function keepStoredFederationBookkeeping(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): void {
  if (!isPlainObject(content)) return;
  for (const field of FEDERATION_BOOKKEEPING_FIELDS) {
    if (isPlainObject(stored) && stored[field] !== undefined) {
      content[field] = stored[field];
    } else {
      delete content[field];
    }
  }
}

/**
 * Apply the create/update rule for the receiver bookkeeping: `stored` ⇒ keep its
 * values (re-asserted onto a full-replace put); no stored row ⇒ a client body
 * may not set them.
 */
export function applyFederationBookkeeping(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): void {
  if (isStoredRow(stored)) {
    keepStoredFederationBookkeeping(content, stored);
  } else {
    dropClientFederationBookkeeping(content);
  }
}

/** The URL-bound target id of a resource instance: `getId()` on a real Harper
 *  resource. Only a scalar id is usable; anything else (no method, a thrown
 *  call, a non-scalar id) means "no URL target to consult". */
function urlTargetId(resource: unknown): string | number | null {
  try {
    const getId = (resource as { getId?: () => unknown } | null | undefined)?.getId;
    const id = typeof getId === "function" ? getId.call(resource) : undefined;
    if (typeof id === "string" || typeof id === "number") return id;
  } catch {
    /* getId() threw — fall back to the body id below */
  }
  return null;
}

/** A 400 for a body `id` that disagrees with the address the write was sent to:
 *  Harper writes to the URL-bound target and rewrites the row's primary key to
 *  it, so a mismatching body id names a row this write does NOT land on. */
function idTargetMismatchDenial(bodyId: unknown, targetId: unknown): Response {
  return new Response(JSON.stringify({
    error: "id_target_mismatch",
    message: `the request body id ${JSON.stringify(bodyId)} does not match the address it was sent to (${JSON.stringify(targetId)})`,
  }), { status: 400, headers: { "content-type": "application/json" } });
}

/** A 500 for a stored-row lookup that FAILED. A lookup failure is never read as
 *  "no stored row": treating it as a create would let an existing row be
 *  re-stamped when the read fails but the write succeeds. */
function storedRowLookupFailure(tableName: string, err: unknown): Response {
  // Constant format string + a structured data object: a template literal here
  // would let anything interpolated into the format position forge the log
  // (semgrep javascript.lang.security.audit.unsafe-formatstring).
  console.error(
    "originator-instance: the stored row could not be read, so the write was refused",
    { table: tableName, err },
  );
  return new Response(JSON.stringify({
    error: "stored_row_lookup_failed",
    message: "the existing record could not be read, so the write was refused",
  }), { status: 500, headers: { "content-type": "application/json" } });
}

/**
 * Resolve the stored row a `put()`/`patch()` is over, for the create/update
 * decision.
 *
 * The authoritative id is the URL-BOUND target (`resource.getId()`), NEVER the
 * request body's `id`: Harper writes to the URL target and rewrites the stored
 * primary key to it (dist/resources/Table.js `_writeUpdate`), so a body id is
 * not the row this write lands on. Reading the stored row by a body id let a
 * caller borrow another row's stored originator — or, via a nonexistent id,
 * force a "create" that re-stamped an existing row.
 *
 * Rules:
 *   - with a URL target id, a non-null body `id` that is not a string or
 *     number, or that disagrees with it, is REFUSED;
 *   - the stored row is read by the URL target id (via the raw table reader,
 *     falling back to the resource's own bound-record read when the table
 *     exposes no static reader — an in-process harness);
 *   - a read FAILURE refuses the write — it is never read as "no stored row".
 *
 * An in-process call with no URL-bound id (a direct `new Resource().put(body)`)
 * falls back to the body `id`, which IS the write key on that path.
 */
export async function resolveStoredRow(
  resource: unknown,
  tableName: string,
  content: unknown,
  getUrlBound: () => unknown,
  context?: any,
): Promise<{ row: Record<string, any> | null; denial?: Response }> {
  const targetId = urlTargetId(resource);
  const bodyId = isPlainObject(content) && content.id != null ? content.id : undefined;

  if (targetId != null && bodyId !== undefined &&
    ((typeof bodyId !== "string" && typeof bodyId !== "number") || String(bodyId) !== String(targetId))) {
    return { row: null, denial: idTargetMismatchDenial(bodyId, targetId) };
  }

  const id = targetId ?? bodyId;
  if (id == null) return { row: null };

  try {
    const table = (databases as any).flair?.[tableName];
    if (table && typeof table.get === "function") {
      const row = await table.get(id, context ?? (resource as any)?.getContext?.());
      return { row: isStoredRow(row) ? row : null };
    }
    // No static table reader (an in-process harness): read the resource's own
    // URL-bound record instead — the row this write lands on.
    const bound = await getUrlBound();
    return { row: isStoredRow(bound) ? bound : null };
  } catch (err) {
    return { row: null, denial: storedRowLookupFailure(tableName, err) };
  }
}
