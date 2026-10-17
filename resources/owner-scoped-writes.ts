/**
 * Installs the owner-scoped write guard (resources/owner-scoped-write-policy.ts)
 * on every table class named in resources/record-owner-guard.ts's OWNER_FIELDS
 * when the component loads. For a non-admin HTTP request to a resource class
 * that extends one of those tables: an addressed write (POST/PUT/PATCH/DELETE
 * to `/<Table>/<id>`) checks a string or number body `id` on POST/PUT/PATCH before the
 * stored owner, if reached; middleware can return the owner refusal first.
 * For collection PUT/PATCH/DELETE, if reached, the table guard returns the
 * collection refusal; existing DELETE middleware may refuse earlier. A POST to a collection is delegated
 * to each resource's own POST handling. An incomplete installation (a missing or empty
 * registry, or an owner-scoped table that could not be guarded) is logged as an
 * error at load.
 *
 * The stored record is read with its own empty context, so the read runs in a
 * fresh transaction as a trusted internal read of committed state, the same
 * read resources/auth-middleware.ts's single-record owner check makes.
 * `readBody` reads `data` from the entry call's context.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 *
 * ─── No static auth import; agent-auth.js loads on the first guarded write ──
 * Harper links a component's resource modules concurrently while it starts.
 * This module's static imports are `harper` and two modules with no
 * authentication-module dependency (record-owner-guard.ts, which also supplies
 * the `owner_check_unavailable` refusal, and owner-scoped-write-policy.ts), so
 * loading it adds no link of the authentication module graph to that startup
 * phase; a static import of agent-auth.js from here stopped Harper from
 * starting under Bun (test/integration/init-persisted-admin-harper5.test.ts).
 *
 * agent-auth.js is imported once, when the first guarded write needs its
 * caller resolved, by which time the component has finished loading. The guard
 * itself is installed synchronously here either way. If that import fails, the
 * guard refuses the write as a caller that could not be verified (its named
 * 500 refusal), and the cached import is cleared so the next write retries.
 */
import { databases } from "harper";
import { OWNER_FIELDS, ownerCheckUnavailable } from "./record-owner-guard.js";
import { isReservedEventRecord, reservedEventProposedRefusal, reservedEventRefusal, reservedEventStoredRefusal } from "./org-event-reserved.js";
import { guardOwnerScopedWrites, ownerScopedWriteGuardGaps } from "./owner-scoped-write-policy.js";

type AgentAuthModule = typeof import("./agent-auth.js");

let agentAuthModule: Promise<AgentAuthModule> | undefined;

function agentAuth(): Promise<AgentAuthModule> {
  agentAuthModule ??= import("./agent-auth.js").catch((err) => {
    agentAuthModule = undefined;
    throw err;
  });
  return agentAuthModule;
}

const registry = (databases as any).flair;
const guarded = guardOwnerScopedWrites(registry, OWNER_FIELDS, {
  resolveAuth: async (context) => (await agentAuth()).resolveAgentAuth(context),
  readStored: (table, id) => registry[table].get(id, {}),
  unreadable: ownerCheckUnavailable,
  readBody: (context: any) => context?.data,
  refuseReservedWrite: async (table, method, target, context) => {
    if (table !== "OrgEvent") return null;
    const readStored = (id: string | string[]) => registry.OrgEvent.get(id, {});
    if (method === "delete") return reservedEventStoredRefusal(target?.id, readStored);
    let body: unknown;
    try {
      body = await Promise.resolve((context as any)?.data);
    } catch {
      return null; // the guard's own readBody refusal owns an unreadable body
    }
    const proposed = reservedEventProposedRefusal(body);
    if (proposed) return proposed;
    // A stored read that FAILS is left to this guard's owner check and the
    // resource's own checks, which refuse with their named errors. This
    // pre-check only adds the reserved refusal when the row is readable.
    try {
      const records = Array.isArray(body) ? body : [body];
      for (const record of records) {
        const id = record && typeof record === "object" && !Array.isArray(record) ? (record as any).id : undefined;
        if (typeof id === "string" && id !== "" && isReservedEventRecord(await readStored(id))) return reservedEventRefusal();
      }
      if (target && target.id != null && isReservedEventRecord(await readStored(target.id as any))) return reservedEventRefusal();
    } catch {
      return null;
    }
    return null;
  },
});
const gaps = ownerScopedWriteGuardGaps(registry, OWNER_FIELDS, guarded);
if (gaps.length > 0) {
  console.error(`[flair] the owner-scoped write guard is incomplete: ${gaps.join("; ")}`);
}
