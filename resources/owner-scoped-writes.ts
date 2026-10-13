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
 *
 * ─── Static imports are pure; the auth helpers load at first use ────────────
 * Harper links a component's resource modules concurrently while it starts.
 * This module's static imports are kept to `harper` and pure modules, so
 * loading it adds no link of the authentication module graph to that startup
 * phase; a static import of agent-auth.js from here stopped Harper from
 * starting under Bun (test/integration/init-persisted-admin-harper5.test.ts).
 * resolveAgentAuth and ownerCheckUnavailable are therefore imported on the
 * first guarded write, by which time the component has finished loading. The
 * guard is installed synchronously here either way. If that import fails, the
 * write is refused: the guard turns a caller that cannot be resolved into its
 * named refusal, and the cached import is cleared so the next write retries.
 */
import { databases } from "harper";
import { OWNER_FIELDS } from "./record-owner-guard.js";
import { guardOwnerScopedWrites, ownerScopedWriteGuardGaps } from "./owner-scoped-write-policy.js";

type AgentAuthModule = typeof import("./agent-auth.js");
type OwnerFieldGuardModule = typeof import("./owner-field-guard.js");

let agentAuthModule: Promise<AgentAuthModule> | undefined;
let ownerFieldGuardModule: Promise<OwnerFieldGuardModule> | undefined;

function agentAuth(): Promise<AgentAuthModule> {
  agentAuthModule ??= import("./agent-auth.js").catch((err) => {
    agentAuthModule = undefined;
    throw err;
  });
  return agentAuthModule;
}

function ownerFieldGuard(): Promise<OwnerFieldGuardModule> {
  ownerFieldGuardModule ??= import("./owner-field-guard.js").catch((err) => {
    ownerFieldGuardModule = undefined;
    throw err;
  });
  return ownerFieldGuardModule;
}

const registry = (databases as any).flair;
const guarded = guardOwnerScopedWrites(registry, OWNER_FIELDS, {
  resolveAuth: async (context) => (await agentAuth()).resolveAgentAuth(context),
  readStored: (table, id) => registry[table].get(id, {}),
  unreadable: async (err) => (await ownerFieldGuard()).ownerCheckUnavailable(err),
  readBody: (context: any) => context?.data,
});
const gaps = ownerScopedWriteGuardGaps(registry, OWNER_FIELDS, guarded);
if (gaps.length > 0) {
  console.error(`[flair] the owner-scoped write guard is incomplete: ${gaps.join("; ")}`);
}
