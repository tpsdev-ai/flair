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
    `\`memory_search\` covers any agent you hold a search grant from.`
  );
}
