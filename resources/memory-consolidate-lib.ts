// ─── Memory Consolidation — pure evaluation logic ───────────────────────────
// Pure helpers extracted from MemoryConsolidate.ts (Flair #502) so they can be
// unit-tested directly. Importing MemoryConsolidate.ts pulls in the Harper
// runtime (`databases` / `Resource`, storage init) and can't run outside a live
// Harper; this module has no Harper dependency, so
// test/unit/memory-consolidate.test.ts exercises the real shipped code.

export function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return 30 * 86400_000;
  const n = Number(m[1]);
  if (m[2] === "d") return n * 86400_000;
  if (m[2] === "h") return n * 3600_000;
  if (m[2] === "m") return n * 60_000;
  return 30 * 86400_000;
}

export type Suggestion = "promote" | "archive" | "keep";

export interface Candidate {
  memory: Record<string, unknown>;
  suggestion: Suggestion;
  reason: string;
}

/**
 * Classify a single memory record as a promote/archive/keep candidate.
 *
 * Idle age is `now - (lastRetrieved ?? createdAt)`: a memory that was just
 * written and never read has lastRetrieved=null, so without the createdAt
 * fallback its idle age would be Infinity and a minutes-old memory would read
 * as maximally stale and be archived (Flair #502). The createdAt fallback
 * measures "never retrieved" from when the memory was born.
 *
 * A grace window (olderThanMs — the maintenance olderThan) guarantees a
 * freshly-created memory is never an archive candidate regardless of retrieval
 * count: archival only considers memories that have had a fair chance to be read.
 */
export function evaluate(record: any, now: number, olderThanMs: number): Candidate {
  const ageMs = record.createdAt ? now - new Date(record.createdAt).getTime() : 0;
  const count = record.retrievalCount ?? 0;

  const lastUse = record.lastRetrieved ?? record.createdAt;
  const idleMs = lastUse ? now - new Date(lastUse).getTime() : 0;
  const daysIdle = idleMs / 86400_000;
  const everRetrieved = record.lastRetrieved != null;
  const { embedding, ...memory } = record;

  // Promote: high retrieval + persistent durability
  if (record.durability === "persistent" && count >= 5) {
    return { memory, suggestion: "promote", reason: `Retrieved ${count} times — strong promotion candidate for permanent` };
  }

  // Promote: standard → persistent if retrieved frequently
  if (record.durability === "standard" && count >= 3 && ageMs > 7 * 86400_000) {
    return { memory, suggestion: "promote", reason: `Retrieved ${count} times over ${Math.round(ageMs / 86400_000)} days — worth persisting` };
  }

  // Grace window: a freshly-created memory is never an archive candidate,
  // regardless of retrieval count (Flair #502). Archive branches below are
  // reachable only for memories older than the maintenance window.
  if (ageMs <= olderThanMs) {
    return { memory, suggestion: "keep", reason: everRetrieved
      ? `Retrieved ${count} times, ${Math.round(daysIdle)} days since last retrieval`
      : `Created ${Math.round(ageMs / 86400_000)} days ago, not yet retrieved (within grace window)` };
  }

  // Archive: old + never retrieved
  if (daysIdle > 30 && count === 0) {
    return { memory, suggestion: "archive", reason: everRetrieved
      ? `Not retrieved in ${Math.round(daysIdle)} days, ${Math.round(ageMs / 86400_000)} days old`
      : `Never retrieved, ${Math.round(ageMs / 86400_000)} days old` };
  }

  // Archive: idle > 60 days with few retrievals
  if (daysIdle > 60 && count < 2) {
    return { memory, suggestion: "archive", reason: everRetrieved
      ? `Not retrieved in ${Math.round(daysIdle)} days (only ${count} total retrievals)`
      : `Never retrieved, ${Math.round(ageMs / 86400_000)} days old (0 total retrievals)` };
  }

  return { memory, suggestion: "keep", reason: everRetrieved
    ? `Retrieved ${count} times, ${Math.round(daysIdle)} days since last retrieval`
    : `Created ${Math.round(ageMs / 86400_000)} days ago, not yet retrieved` };
}
