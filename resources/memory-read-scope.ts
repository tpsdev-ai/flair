import { databases } from "@harperfast/harper";
import { PRIVATE_VISIBILITY, isPrivateVisibility } from "./memory-visibility.js";

/**
 * ─── Centralized Memory read-scoping (the original grant-gated read model → within-org-read-open) ─
 *
 * The SINGLE source every cross-agent Memory read path resolves its scope
 * through: Memory.search()/Memory.get() (resources/Memory.ts), SemanticSearch
 * (resources/SemanticSearch.ts), MemoryBootstrap (resources/MemoryBootstrap.ts),
 * and the by-id GET guard in resources/auth-middleware.ts. Before this module
 * existed, SemanticSearch had its OWN inline grant-resolution + a
 * `visibility === "office"` global OR-clause that leaked ANY authenticated
 * agent's read of ANY other agent's memories once that memory happened to
 * carry `visibility: "office"` (the office-visibility read leak). Scattering the scoping rule per
 * path is exactly how that leak happened — this module exists so it can't
 * happen again: one rule, one place, every path imports it.
 *
 * ── The model (open-within-org read) ─────────────────────────────────────────
 * Knowledge-refinement, not access-control (per the MEMORY-MODEL-REFRAME):
 * an org/instance is one shared knowledge base. `Memory.visibility` is writer
 * intent: "private" is the ONLY owner-only exception; anything else (`shared`,
 * null/absent) is org-open — readable by ANY verified agent on this instance,
 * not just owners who happen to hold a per-owner MemoryGrant. A reader's full
 * read-scope is:
 *   - ALL of the reader's own records, any visibility, unrestricted.
 *   - EVERY other agent's non-private record on this instance.
 * The federation edge (resources/Federation.ts's push filter / src/cli.ts's
 * runFederationSyncOnce) is the only remaining hard access boundary — it
 * already excludes `private` rows from ever leaving this instance. Within an
 * instance, there is no per-owner grant gate on READS anymore: MemoryGrant is
 * no longer consulted by this module at all (see resolveAllowedOwners's doc
 * below for why the function itself still exists).
 *
 * ── The no-visibility-field invariant (non-negotiable) ───────────────────────
 * Existing memories (written before the `visibility` field existed) have NO
 * `visibility` field. A record with no `visibility` field is NOT private — it
 * reads exactly like an explicit `shared` record (org-open). This is why the
 * exclusion condition is `visibility != 'private'` (`not_equal`, which
 * INCLUDES records missing the field entirely), never `visibility == 'shared'`
 * (`equals`, which would EXCLUDE them and silently retroactively privatize
 * every legacy row) — nothing is retroactively made private, nothing is
 * excluded from the broadening that wasn't already excluded before it. There
 * is no migration/backfill step: pure-open means every pre-existing record
 * reads as non-private automatically, the moment this code is deployed —
 * gating that on an operator-run step would itself be a knob the
 * emergent-trust reframe rejects (zero knobs).
 */

/**
 * Owner ids a non-admin agent holds an explicit "read" or "search" scoped
 * MemoryGrant from (plus itself). NO LONGER used by resolveReadScope() below
 * — reads are open-within-org now, so a per-read grant lookup is dead weight
 * on every read path. Kept exported and unchanged in shape/behavior because
 * it is still the right tool for "who has this agent explicitly granted
 * itself to" listings / admin tooling (grants remain a real, inspectable
 * relationship — they just no longer gate reads). Do NOT delete this
 * function, and do NOT reintroduce a call to it from resolveReadScope().
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
  /**
   * VESTIGIAL for read-scoping — no consumer of resolveReadScope() reads this
   * field to bound what it can see (only `.condition`/`.isAllowed` are read-
   * path-consumed; see this module's doc above). Always `[authAgentId]` now:
   * reads are open-within-org, so there is no "granted owner set" to report
   * here anymore. Kept on the interface only for shape/call-site stability —
   * do NOT repopulate it from resolveAllowedOwners(); a caller that actually
   * needs the grant-holder set should call resolveAllowedOwners() directly.
   */
  allowedOwners: string[];
  /**
   * The Harper condition object encoding the FULL read-scope:
   *   (agentId == reader) OR (visibility != 'private')
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

/**
 * Resolve the full read-scope (condition + in-process predicate) for a
 * reader. This is the ONE function every cross-agent Memory read path must
 * call — see the module doc above. No longer async-dependent on a DB lookup
 * (MemoryGrant is not consulted for reads), but stays declared `async` /
 * Promise-returning for call-site stability — every existing caller already
 * `await`s it.
 */
export async function resolveReadScope(authAgentId: string): Promise<ReadScope> {
  // Open-within-org read: own records (any visibility) OR any non-private
  // record on the instance. No grant lookup — see module doc.
  const condition = {
    operator: "or",
    conditions: [
      { attribute: "agentId", comparator: "equals", value: authAgentId },
      // not_equal (NOT equals 'private') — see module doc: a record with NO
      // visibility field must still read as non-private (the migration-
      // equivalence invariant), enforced in the condition itself so every
      // path that uses it gets it for free.
      { attribute: "visibility", comparator: "not_equal", value: PRIVATE_VISIBILITY },
    ],
  };

  const isAllowed = (record: ScopableRecord | null | undefined): boolean => {
    if (!record) return false;
    return record.agentId === authAgentId || !isPrivateVisibility(record.visibility);
  };

  return { allowedOwners: [authAgentId], condition, isAllowed };
}
