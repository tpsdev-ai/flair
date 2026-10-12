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
 * inside its own request transaction, and drops it before the write — it is a
 * control field, not a stored column.
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
