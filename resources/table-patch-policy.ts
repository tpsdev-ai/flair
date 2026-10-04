/**
 * PATCH updates an existing row. For a caller that is not an administrator or a
 * trusted internal call, a PATCH never creates one; where a resource permits
 * creation, rows are created with POST or PUT under the resource's own create
 * rules.
 *
 * Harper's PATCH writes to the row its URL names and, when that row does not
 * exist, would create it from the request body alone. So each guarded table's
 * own `patch()` refuses a PATCH whose target row does not exist unless the
 * caller is an administrator or a trusted internal call: the caller gets 404.
 * A resource or authorization check that refuses the request before the
 * table's `patch()` runs answers with its own status instead. A PATCH to an
 * existing row is unchanged — the resources' own rules (ownership, the
 * immutable owner field, validation) still decide it.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * `guardTablePatches` gives every table class in the flair database's table
 * registry its own instance `patch()`, read from that registry at load
 * (resources/table-patches.ts), not from a list someone maintains:
 *   - a table added to the schema is in that registry, so its class gets the
 *     guard without anyone naming it;
 *   - Harper has already resolved the target id and loaded the row when the
 *     instance `patch()` runs, so the guard decides on the row Harper will
 *     write (`doesExist()`), never on a re-parse of the URL;
 *   - a resource class without a `patch()` override inherits the guarded
 *     method, and an override reaches it only through `super.patch()`. Every
 *     flair override today either ends in `super.patch()` for the callers it
 *     admits or refuses the request itself: MemoryHostSource refuses every REST
 *     write, and MemoryUsage refuses a non-admin PATCH. A future override must
 *     do one or the other; an override that writes the row another way would
 *     not be covered by this guard.
 * test/integration/patch-updates-existing-rows.test.ts enumerates every table in
 * the database at runtime and fails if a non-admin PATCH creates a row in any.
 *
 * This module has no imports, so it is unit-tested directly
 * (test/unit/table-patch-policy.test.ts); the dependencies it needs are passed
 * in by resources/table-patches.ts.
 */

/** The caller verdict the guard decides on (resources/agent-auth.ts's AgentAuthVerdict). */
export type PatchCaller =
  | { kind: "internal" }
  | { kind: "agent"; agentId: string; isAdmin: boolean }
  | { kind: "anonymous" };

export interface TablePatchGuardDeps {
  /** Resolves a resource context to a caller verdict (resolveAgentAuth). */
  resolveAuth: (context: unknown) => Promise<PatchCaller>;
}

/** Marks a table class whose `patch()` has been guarded. */
export const TABLE_PATCH_GUARD: unique symbol = Symbol.for("flair.tablePatchGuard");

/**
 * Whether the row a resource instance addresses exists: true or false as the
 * instance reports it, or undefined when the instance cannot say (the guard
 * then treats the PATCH as a create).
 */
export function rowExists(resource: unknown): boolean | undefined {
  const doesExist = (resource as any)?.doesExist;
  if (typeof doesExist !== "function") return undefined;
  const answer = doesExist.call(resource);
  return typeof answer === "boolean" ? answer : undefined;
}

/** The refusal for a PATCH whose target row does not exist; null for an administrator or a trusted internal call. */
export function patchCreateRefusal(table: string, caller: PatchCaller): (Error & { statusCode: number }) | null {
  if (caller.kind === "internal") return null;
  if (caller.kind === "agent" && caller.isAdmin === true) return null;
  return Object.assign(
    new Error(`not found: PATCH updates an existing ${table} row and does not create one; where ${table} permits creation, use POST or PUT`),
    { statusCode: 404 },
  );
}

/** The refusal when the caller of a PATCH that would create a row cannot be resolved. */
export function unverifiedPatchCallerRefusal(table: string): Error & { statusCode: number } {
  return Object.assign(
    new Error(`the caller of this ${table} PATCH could not be verified, so it was refused; retry`),
    { statusCode: 500 },
  );
}

/**
 * Give every table class in `tables` its own instance `patch()` that refuses to
 * create a row for a caller who is not an administrator or a trusted internal
 * call, then delegates to the inherited `patch()` unchanged. A PATCH to an
 * existing row goes straight through. Idempotent. Returns the names of the
 * guarded tables.
 */
export function guardTablePatches(
  tables: Record<string, unknown> | null | undefined,
  deps: TablePatchGuardDeps,
): string[] {
  const guarded: string[] = [];
  for (const name of Object.keys(tables ?? {})) {
    const table = (tables as Record<string, any>)[name];
    if (typeof table !== "function" || table.prototype == null) continue;
    if (Object.prototype.hasOwnProperty.call(table, TABLE_PATCH_GUARD)) {
      guarded.push(name);
      continue;
    }
    const inherited = table.prototype.patch;
    if (typeof inherited !== "function") continue; // no PATCH to guard
    Object.defineProperty(table.prototype, "patch", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: async function patch(this: any, ...args: unknown[]) {
        if (rowExists(this) !== true) {
          let caller: PatchCaller;
          try {
            caller = await deps.resolveAuth(this.getContext?.());
          } catch {
            throw unverifiedPatchCallerRefusal(name);
          }
          const refusal = patchCreateRefusal(name, caller);
          if (refusal) throw refusal;
        }
        return inherited.apply(this, args);
      },
    });
    Object.defineProperty(table, TABLE_PATCH_GUARD, { value: true });
    guarded.push(name);
  }
  return guarded;
}
