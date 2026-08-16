// ─── MemoryBootstrap — pure evaluation logic ────────────────────────────────
// Pure helpers extracted from MemoryBootstrap.ts (section 1c, PR #549) so they
// can be unit-tested directly. Importing MemoryBootstrap.ts pulls in the
// Harper runtime (`databases` / `Resource`, storage init) and can't run
// outside a live Harper; this module has no Harper dependency, so
// test/unit/bootstrap-team.test.ts exercises the real shipped code.

import { wrapUntrusted } from "./content-safety.js";

/**
 * Is `record` a live teammate of `callerId` for roster purposes?
 *
 * Permissive by design: pre-1.0 Agent records may not have `kind`/`status` at
 * all (Agent.ts registration only started defaulting both — `kind ||= "agent"`,
 * `status ||= "active"` — from the 1.0 auth reshape onward). A missing field
 * means "legacy agent, active", not "unknown, exclude" — so we only exclude on
 * an explicit non-matching value, never on absence.
 */
export function isTeammate(record: { id?: string; kind?: string; status?: string }, callerId: string): boolean {
  if (record.id === callerId) return false;
  if (record.kind && record.kind !== "agent") return false;
  if (record.status && record.status !== "active") return false;
  return true;
}

/**
 * Is `event` a zero-row, no-op auto-heal migration event (flair#1200)?
 *
 * The migration ledger (resources/migrations/ledger.ts) and the graph-heal
 * observability path (resources/migrations/graph-heal.ts) both emit a
 * `kind: "migration"` OrgEvent on EVERY boot — even when the migration did
 * nothing. On a healthy store these are near-identical `verified` + `success`
 * pairs, seconds apart, twice per version bump (per node): "migration graph-heal
 * success (0 rows processed)" beside "HNSW graph-heal: recall verified healthy".
 * They carry ZERO signal an agent could act on, yet each occupies one of the
 * scarce (maxEvents-capped) bootstrap event slots AND is now token-charged
 * (flair#1199) — so they crowd out events that matter. This suppresses them at
 * RENDER (bootstrap's events section) only; the ledger still records every
 * migration on the OrgEvent table (migration invariant IV is unchanged — this
 * never touches the write path, only what bootstrap surfaces to a connector).
 *
 * A migration event is a suppressible no-op when its structured `detail`
 * (a JSON string) reports:
 *   - `rowsProcessed === 0` AND a non-failure outcome (`success`, or a ledger
 *     shape with no explicit failure) — a migration that changed nothing; OR
 *   - `migrationId === "graph-heal"` with `verified === true` — the graph-heal
 *     verification half, which `run()` returns `processed: 0` for by construction
 *     (it carries no `rowsProcessed`, so the first rule can't catch it).
 *
 * A migration that PROCESSED rows, HALTED, FAILED, or reported an
 * UNCONFIRMED graph-heal (`verified: false`) is actionable and is NOT
 * suppressed. Pure + Harper-free so bootstrap-events.test.ts can drive it
 * directly against the exact ledger/graph-heal detail shapes.
 */
export function isZeroRowNoOpEvent(event: {
  kind?: string;
  detail?: unknown;
} | null | undefined): boolean {
  if (!event || event.kind !== "migration") return false;
  let detail: any = event.detail;
  if (typeof detail === "string") {
    try {
      detail = JSON.parse(detail);
    } catch {
      return false; // unparseable detail — don't guess, keep the event
    }
  }
  if (!detail || typeof detail !== "object") return false;
  // Ledger event: a migration that processed no rows AND did not fail/halt is a
  // no-op. A failed/halted migration (even at 0 rows) is actionable — keep it.
  // (Checked FIRST: the graph-heal ledger event carries migrationId "graph-heal"
  // too but no `verified` field, so the graph-heal branch below must not swallow
  // it before its rowsProcessed:0 is seen.)
  if (detail.rowsProcessed === 0 && (detail.outcome === undefined || detail.outcome === "success")) {
    return true;
  }
  // Graph-heal VERIFICATION event: inherently zero-row (run() → processed:0),
  // carries no rowsProcessed. Suppress only the CONFIRMED-healthy ones; an
  // unconfirmed heal (verified:false) is worth surfacing.
  if (detail.migrationId === "graph-heal" && detail.verified === true) return true;
  return false;
}

/**
 * Format the "## Team" roster line for a list of teammate ids, or `null`
 * when the roster is empty (caller should omit the section entirely).
 *
 * Teammate ids are registrant-chosen strings, not something Flair controls —
 * they're untrusted the same way memory content is, so only the id list goes
 * through wrapUntrusted; the surrounding instructional text is trusted and
 * stays outside the wrap.
 */
export function formatTeamLine(teammateIds: string[]): string | null {
  if (teammateIds.length === 0) return null;
  const plural = teammateIds.length === 1 ? "agent shares" : "agents share";
  return (
    `${teammateIds.length} other ${plural} this Flair office (${wrapUntrusted(teammateIds.join(", "))}). ` +
    `Before deep-diving an unfamiliar problem, search their memories for related work — ` +
    `\`memory_search\` covers any agent's non-private memories on this instance (open-within-org read; no grant required).`
  );
}
