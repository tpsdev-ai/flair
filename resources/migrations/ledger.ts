/**
 * ledger.ts — the migration ledger OrgEvent (invariant IV: "every migration
 * records an OrgEvent (initiator, versions, scope, outcome, duration) —
 * migrations get decision provenance. Dogfood.")
 *
 * Sherlock verdict: "Ledger discloses structural metadata only — versions,
 * counts, outcome, duration; never memory IDs or content summaries." The
 * shape below is EXACTLY the Kern-verdict field list (migration id,
 * initiator, from/to version, scope, start/end, outcome, rows
 * processed/remaining, error if halted, hash envelope) — nothing else is
 * ever written into `detail`.
 *
 * Written via an internal (no-HTTP-context) call to
 * `databases.flair.OrgEvent.put()` — resolveAgentAuth(undefined) resolves
 * to `{kind: "internal"}` (trusted; see resources/agent-auth.ts), the same
 * pattern resources/auth-middleware.ts's backfillEmbedding() and
 * resources/MemoryReindex.ts's `_reindex` path already rely on for
 * server-internal writes with no HTTP caller behind them.
 */
import { databases } from "@harperfast/harper";

export type LedgerOutcome = "success" | "halted" | "failed";
export type LedgerInitiator = "auto" | "operator";
export type LedgerScope = "full" | "canary";

export interface LedgerEvent {
  migrationId: string;
  initiator: LedgerInitiator;
  fromVersion: string;
  toVersion: string;
  scope: LedgerScope;
  startedAt: string;
  endedAt: string;
  outcome: LedgerOutcome;
  rowsProcessed: number;
  rowsRemaining: number;
  /** null when the risk class's gate doesn't compute a hash at all (derived-only). */
  hashEnvelopeMatch: boolean | null;
  error?: string;
}

export interface LedgerDeps {
  orgEventTable?: { put(content: unknown): Promise<unknown> };
}

function defaultOrgEventTable() {
  return (databases as unknown as { flair: { OrgEvent: { put(content: unknown): Promise<unknown> } } }).flair.OrgEvent;
}

/** Structural-only detail blob — see the module doc; never memory IDs/content. */
export function buildLedgerDetail(evt: LedgerEvent): string {
  return JSON.stringify({
    migrationId: evt.migrationId,
    initiator: evt.initiator,
    fromVersion: evt.fromVersion,
    toVersion: evt.toVersion,
    scope: evt.scope,
    startedAt: evt.startedAt,
    endedAt: evt.endedAt,
    outcome: evt.outcome,
    rowsProcessed: evt.rowsProcessed,
    rowsRemaining: evt.rowsRemaining,
    hashEnvelopeMatch: evt.hashEnvelopeMatch,
    ...(evt.error ? { error: evt.error } : {}),
  });
}

export async function writeLedgerEvent(evt: LedgerEvent, deps: LedgerDeps = {}): Promise<void> {
  const table = deps.orgEventTable ?? defaultOrgEventTable();
  const id = `migration-${evt.migrationId}-${evt.endedAt}`;
  const remainingNote = evt.rowsRemaining > 0 ? `, ${evt.rowsRemaining} remaining` : "";
  await table.put({
    id,
    authorId: "flair-migrations",
    kind: "migration",
    scope: evt.scope,
    summary: `migration ${evt.migrationId} ${evt.outcome} (${evt.rowsProcessed} row${evt.rowsProcessed === 1 ? "" : "s"} processed${remainingNote})`,
    detail: buildLedgerDetail(evt),
    refId: evt.migrationId,
    createdAt: evt.endedAt,
  });
}
