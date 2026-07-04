import { databases } from "@harperfast/harper";

/**
 * ─── Centralized Memory read-scoping (ops-2dm3 Layer 1) ─────────────────────
 *
 * The SINGLE source every cross-agent Memory read path resolves its scope
 * through: Memory.search()/Memory.get() (resources/Memory.ts), SemanticSearch
 * (resources/SemanticSearch.ts), MemoryBootstrap (resources/MemoryBootstrap.ts),
 * and the by-id GET guard in resources/auth-middleware.ts. Before this module
 * existed, SemanticSearch had its OWN inline grant-resolution + a
 * `visibility === "office"` global OR-clause that leaked ANY authenticated
 * agent's read of ANY other agent's memories once that memory happened to
 * carry `visibility: "office"` (ops-nzxa). Scattering the scoping rule per
 * path is exactly how that leak happened — this module exists so it can't
 * happen again: one rule, one place, every path imports it.
 *
 * This is a plain-function module (no `class X extends databases.flair.X`) —
 * deliberately, so it can be safely imported + exercised under DIFFERENT
 * `@harperfast/harper` mocks from multiple test/unit/ files in the same bun
 * process without the class-capture collision documented in
 * test/unit/memory-soul-read-gate.test.ts (that collision is specific to a
 * class whose `extends` clause evaluates `databases.flair.X` at module-eval
 * time; a plain function that reads `databases` inside its body at CALL time
 * does not have that problem).
 *
 * ── The model (private | shared) ─────────────────────────────────────────────
 * `Memory.visibility` is writer intent: "private" (owner-only) or "shared"
 * (visible to anyone holding a read/search MemoryGrant on the owner). A
 * reader's full read-scope is:
 *   - ALL of the reader's own records, any visibility, unrestricted.
 *   - A GRANTED owner's records EXCEPT that owner's `private` ones.
 *
 * ── The migration invariant (non-negotiable) ─────────────────────────────────
 * Existing memories (written before this field existed) have NO `visibility`
 * field. They must read EXACTLY as before: to whoever holds a grant today.
 * So a record with no `visibility` field is treated as "shared" — this is why
 * the exclusion condition is `visibility != 'private'` (`not_equal`, which
 * INCLUDES records missing the field entirely), never `visibility == 'shared'`
 * (`equals`, which would EXCLUDE them and silently break every existing grant
 * relationship — nothing is retroactively made private, nothing broadened).
 */

/**
 * Owner ids a non-admin agent may READ: itself, plus any owner who has
 * granted it a "read" or "search" scoped MemoryGrant. This is the pre-existing
 * owner-set resolution (unchanged in shape/behavior) — resolveReadScope()
 * below builds the full private-exclusion-aware scope on top of it.
 */
export async function resolveAllowedOwners(authAgentId: string): Promise<string[]> {
  const allowedOwners: string[] = [authAgentId];
  try {
    for await (const grant of (databases as any).flair.MemoryGrant.search({
      conditions: [{ attribute: "granteeId", comparator: "equals", value: authAgentId }],
    })) {
      if (grant.ownerId && (grant.scope === "read" || grant.scope === "search")) {
        allowedOwners.push(grant.ownerId);
      }
    }
  } catch { /* MemoryGrant table not yet populated — ignore */ }
  return allowedOwners;
}

/** A record shape narrow enough for the in-process `isAllowed` re-check —
 *  callers pass whatever partial record they have (select-projected search
 *  results, a full Memory row, etc.). */
export interface ScopableRecord {
  agentId?: string | null;
  visibility?: string | null;
}

export interface ReadScope {
  /** Owner ids the reader may see records from (self + granted). Same value
   *  resolveAllowedOwners() returns — kept for callers that only need the
   *  owner set (not the private-exclusion), e.g. a "who can I see" listing. */
  allowedOwners: string[];
  /**
   * The Harper condition object encoding the FULL read-scope, including the
   * private-exclusion:
   *   (agentId == reader) OR (agentId IN grantedOwners AND visibility != 'private')
   * Injection-safe: this is always a SINGLE condition object meant to be
   * wrapped as the OUTERMOST element a caller ANDs with the rest of its
   * query — the same discipline Memory.search() already applies to the
   * plain agentId-only condition this replaces (a user-supplied query can
   * never escape this outer scope via boolean injection).
   */
  condition: any;
  /**
   * In-process re-check of the IDENTICAL rule, for defense-in-depth on paths
   * that either can't push the condition down into a Harper query (e.g.
   * MemoryBootstrap's in-memory candidate lists) or want a second check after
   * the fact (BM25's pre-fusion filter). Always agrees with `condition`.
   */
  isAllowed: (record: ScopableRecord | null | undefined) => boolean;
}

const PRIVATE = "private";

/**
 * Resolve the full read-scope (owner set + condition + in-process predicate)
 * for a reader. This is the ONE function every cross-agent Memory read path
 * must call — see the module doc above.
 */
export async function resolveReadScope(authAgentId: string): Promise<ReadScope> {
  const allowedOwners = await resolveAllowedOwners(authAgentId);
  const grantedOwners = allowedOwners.filter((id) => id !== authAgentId);

  const selfCondition = { attribute: "agentId", comparator: "equals", value: authAgentId };

  let condition: any;
  if (grantedOwners.length === 0) {
    // No grants held — the reader's scope is just its own records. Emitting
    // the plain leaf condition here (rather than an `or` with a single
    // branch) keeps the common case's query shape identical to what
    // Memory.search() emitted before this change.
    condition = selfCondition;
  } else {
    const grantedOwnerCondition = grantedOwners.length === 1
      ? { attribute: "agentId", comparator: "equals", value: grantedOwners[0] }
      : { operator: "or", conditions: grantedOwners.map((id) => ({ attribute: "agentId", comparator: "equals", value: id })) };

    condition = {
      operator: "or",
      conditions: [
        selfCondition,
        {
          operator: "and",
          conditions: [
            grantedOwnerCondition,
            // not_equal (NOT equals 'shared') — see module doc: a record with
            // NO visibility field must still read as shared. This is the
            // migration-equivalence invariant, enforced in the condition
            // itself so every path that uses it gets it for free.
            { attribute: "visibility", comparator: "not_equal", value: PRIVATE },
          ],
        },
      ],
    };
  }

  const grantedSet = new Set(grantedOwners);
  const isAllowed = (record: ScopableRecord | null | undefined): boolean => {
    if (!record) return false;
    if (record.agentId === authAgentId) return true;
    if (!record.agentId || !grantedSet.has(record.agentId)) return false;
    return record.visibility !== PRIVATE;
  };

  return { allowedOwners, condition, isAllowed };
}
