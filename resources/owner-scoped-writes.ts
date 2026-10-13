/**
 * Installs the owner-scoped write guard (resources/owner-scoped-write-policy.ts)
 * on every table class named in resources/record-owner-guard.ts's OWNER_FIELDS
 * when the component loads. For a non-admin HTTP request: an addressed write
 * (POST/PUT/PATCH/DELETE to `/<Table>/<id>`) is owner-checked on the record its
 * URL addresses, and its body may name only that record; a collection
 * PUT/PATCH/DELETE is refused. An incomplete installation (a missing or empty
 * registry, or an owner-scoped table that could not be guarded) is logged as an
 * error at load.
 *
 * The stored record is read with its own empty context, so the read runs in a
 * fresh transaction as a trusted internal read of committed state, the same
 * read resources/auth-middleware.ts's single-record owner check makes. The body
 * is `request.data`, the body Harper itself writes from, read from the entry
 * call's context.
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
  readBody: (context: any) => context?.data,
});
const gaps = ownerScopedWriteGuardGaps(registry, OWNER_FIELDS, guarded);
if (gaps.length > 0) {
  console.error(`[flair] the owner-scoped write guard is incomplete: ${gaps.join("; ")}`);
}
