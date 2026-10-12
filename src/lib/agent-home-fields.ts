/**
 * agent-home-fields.ts — the home-instance field predicates and the stamp
 * control field, shared by the CLI (src/lib/agent-home.ts) and the Agent
 * resource (resources/Agent.ts, flair#2472).
 *
 * Kept in its OWN module, with no imports: a static resource import must reach a
 * dependency-free compiled helper (test/unit/resource-src-purity-1775.test.ts).
 * agent-home.ts itself pulls in the ops-API readers, so the resource imports
 * this file, never that one.
 */

/** The `originatorInstanceId` value the Agent resource's create and the CLI's
 *  seed stamp as a new row's home. */
export const AGENT_HOME_FIELD = "originatorInstanceId";

/**
 * The request-body control field the remedy sends to the Agent resource
 * (flair#2472): a guarded home stamp. The resource reads it, applies the stamp
 * inside a FRESH OWNED transaction — the request's own transaction is detached
 * for that scope (resources/request-transaction.ts's withOwnedTransaction) — and
 * drops the field before the write. It is a control field, not a stored column.
 */
export const AGENT_HOME_STAMP_FIELD = "flairStampHome";

/**
 * The named pause point the home-stamp test arms (flair#2472), inside the
 * stamp's OWNED transaction, after the resource's first read of the row and
 * before its confirmation read. Inert unless the fault-injection env opt-in is
 * set and armed (resources/txn-pause-point.ts).
 *
 * The resource names this point as a DIRECT string literal at its call site
 * (`txnPausePoint("agent-home-stamp")` in resources/Agent.ts), not through this
 * constant: flair#2382's checker scans resources/ and src/ and resolves only
 * direct literals or `spec.point`. This export is the single source the
 * integration test arms (test/integration/agent-home-2433.test.ts), and it must
 * stay equal to the literal.
 */
export const AGENT_HOME_STAMP_PAUSE_POINT = "agent-home-stamp";

/**
 * The request-body control field `flair principal add`'s write-back sends to the
 * Agent resource (flair#2473). The write-back runs when the command's create-only
 * `insert` is SKIPPED because the row already exists: the resource then writes
 * back only the allow-listed fields (never the home) in a fresh owned
 * transaction, refusing `originator_instance_immutable` when its owned read or
 * its confirmation read sees the row's home as a peer's, and
 * `agent_principal_write_back_no_row` when either read finds the row absent. The
 * resource reads the field and drops it before the write — it is a control
 * field, not a stored column.
 */
export const AGENT_PRINCIPAL_WRITE_BACK_FIELD = "flairPrincipalWriteBack";

/**
 * The named refusal the Agent resource answers for a guarded principal write-back
 * (flair#2473) whose row is ABSENT at the owned read before the staging or at the
 * confirmation read (HTTP 404). Harper's `table.update` would re-create a missing
 * row, so a deletion either read sees leaves the row deleted rather than bringing
 * it back home-less. A deletion committed after the confirmation read and before
 * the commit is not seen (the residual window, flair#2478).
 */
export const AGENT_PRINCIPAL_WRITE_BACK_NO_ROW_ERROR = "agent_principal_write_back_no_row";

/**
 * The fields `flair principal add`'s write-back may set on an EXISTING Agent row
 * (flair#2473). An EXPLICIT allow-list, not a deny-list: a field a future caller
 * adds to the request body is NOT carried by this path until it is named here.
 *
 * `originatorInstanceId` is deliberately ABSENT — this path never takes a home
 * from the request body (a create stamps it; an update keeps the stored value).
 * `publicKey` and `createdAt` are absent too: the Agent resource treats both as
 * immutable after create (a key changes through key rotation, not this write).
 * The receiver-side federation stamps (`_syncedFrom`, `_originatorInstanceId`,
 * `_syncedAt`) are absent as well — the Agent resource's write paths do not take
 * them from a request body.
 */
export const AGENT_PRINCIPAL_WRITE_BACK_FIELDS = [
  "name",
  "displayName",
  "kind",
  "type",
  "status",
  "defaultTrustTier",
  "role",
  "admin",
  "runtime",
  "updatedAt",
] as const;

/**
 * The allow-listed subset of a write-back body: exactly the fields
 * {@link AGENT_PRINCIPAL_WRITE_BACK_FIELDS} names, copied as-is. Never a home
 * and never a federation stamp, because neither is on the list. PURE; a
 * non-object body yields an empty object.
 */
export function pickPrincipalWriteBackFields(content: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (content == null || typeof content !== "object") return out;
  const src = content as Record<string, unknown>;
  for (const field of AGENT_PRINCIPAL_WRITE_BACK_FIELDS) {
    if (field in src) out[field] = src[field];
  }
  return out;
}

/**
 * The named pause point the write-back test arms (flair#2473), inside the
 * write-back's OWNED transaction, between the staged update and its confirmation
 * read. Named as a DIRECT string literal at the call site in resources/Agent.ts
 * (flair#2382's checker resolves only literals or `spec.point`); this export is
 * the single source the integration test arms, and it must stay equal.
 */
export const AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT = "agent-principal-write-back";

/**
 * Whether a stored row's home is FOREIGN to `localId`: a non-empty
 * `originatorInstanceId` that is not this instance's own. A home-less row (null,
 * absent or empty) is not foreign, and neither is a row stamped with this
 * instance's id. Used by `flair principal add`'s guarded write-back (flair#2473):
 * a row whose home became a peer's must not be changed.
 */
export function isForeignAgentHome(row: Record<string, unknown> | null | undefined, localId: string | null): boolean {
  if (!row || typeof row !== "object") return false;
  const home = row[AGENT_HOME_FIELD];
  return typeof home === "string" && home.length > 0 && home !== localId;
}

/** A row is home-less when `originatorInstanceId` is null, absent or empty. */
export function isHomeLessAgentRow(row: Record<string, unknown>): boolean {
  const home = row[AGENT_HOME_FIELD];
  return home === null || home === undefined || home === "";
}

/**
 * Whether an inbound federation merge wrote this row (`_syncedFrom`,
 * `_originatorInstanceId` — resources/Federation.ts's receiver-side stamps).
 * Such a row did NOT originate on this instance, so nothing here may stamp a
 * home on it: that would attribute a peer's row to this instance.
 */
export function isSyncOriginatedAgentRow(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  return (
    (typeof row._syncedFrom === "string" && row._syncedFrom.length > 0) ||
    (typeof row._originatorInstanceId === "string" && row._originatorInstanceId.length > 0)
  );
}
