/**
 * Installs the owner-scoped write guard (resources/owner-scoped-write-policy.ts)
 * on every table class named in resources/record-owner-guard.ts's OWNER_FIELDS
 * when the component loads: every non-admin HTTP write to such a table is
 * owner-checked for each record it writes, and one that addresses no single
 * record is refused on PUT, PATCH and DELETE. An incomplete installation (a
 * missing or empty registry, or an owner-scoped table that could not be
 * guarded) is logged as an error at load.
 *
 * The stored record is read with its own empty context, so the read runs in a
 * fresh transaction as a trusted internal read of committed state, the same
 * read resources/auth-middleware.ts's single-record owner check makes.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { ownerCheckUnavailable } from "./owner-field-guard.js";
import { OWNER_FIELDS } from "./record-owner-guard.js";
import { guardOwnerScopedWrites, ownerScopedWriteGuardGaps } from "./owner-scoped-write-policy.js";

const registry = (databases as any).flair;
const guarded = guardOwnerScopedWrites(registry, OWNER_FIELDS, {
  resolveAuth: resolveAgentAuth,
  readStored: (table, id) => registry[table].get(id, {}),
  unreadable: ownerCheckUnavailable,
});
const gaps = ownerScopedWriteGuardGaps(registry, OWNER_FIELDS, guarded);
if (gaps.length > 0) {
  console.error(`[flair] the owner-scoped write guard is incomplete: ${gaps.join("; ")}`);
}
