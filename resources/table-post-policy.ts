/**
 * A collection POST creates a row through the resource's own `post()`, which
 * applies that resource's create rules: the owner from the authenticated
 * caller, and server-stamped attribution. On a table whose resource defines no
 * `post()` of its own, a collection POST is refused unless the caller is an
 * administrator or a trusted internal call: a verified agent gets 403, a
 * caller without a valid credential 401.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * `guardInheritedPosts` gives every table class in the flair database's table
 * registry its own instance `post()`, read from that registry at load
 * (resources/table-posts.ts), not from a list someone maintains:
 *   - a table added to the schema is in that registry, so its class gets the
 *     guard without anyone naming it;
 *   - a resource class that defines `post()` keeps it: Harper calls the most
 *     derived `post()`, and when that override ends in `super.post()` the guard
 *     sees that the resource defines one and lets the call through;
 *   - a resource class without a `post()` of its own reaches the guard directly,
 *     and a non-admin caller is refused before Harper's `create()` runs.
 * test/integration/collection-post-attribution.test.ts reads every table in the
 * database at runtime and fails if a non-admin collection POST stores an owner,
 * `originatorInstanceId` or `provenance` taken from the request body.
 *
 * This module has no imports, so it is unit-tested directly
 * (test/unit/table-post-policy.test.ts); the dependencies it needs are passed in
 * by resources/table-posts.ts.
 */

/** The caller verdict the guard decides on (resources/agent-auth.ts's AgentAuthVerdict). */
export type PostCaller =
  | { kind: "internal" }
  | { kind: "agent"; agentId: string; isAdmin: boolean }
  | { kind: "anonymous" };

export interface TablePostGuardDeps {
  /** Resolves a resource context to a caller verdict (resolveAgentAuth). */
  resolveAuth: (context: unknown) => Promise<PostCaller>;
}

/** Marks a table class whose `post()` has been guarded. */
export const TABLE_POST_GUARD: unique symbol = Symbol.for("flair.tablePostGuard");

/**
 * Whether the resource class an instance belongs to defines its own `post()`
 * below the table class (`tablePrototype`): true when any prototype between the
 * instance's own and the table's carries a `post` of its own.
 */
export function resourceDefinesPost(instance: unknown, tablePrototype: object): boolean {
  let proto = instance == null ? null : Object.getPrototypeOf(instance);
  while (proto && proto !== tablePrototype) {
    if (Object.prototype.hasOwnProperty.call(proto, "post")) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * The refusal for a collection POST on a table whose resource defines no
 * `post()`; null for an administrator or a trusted internal call.
 */
export function inheritedPostRefusal(table: string, caller: PostCaller): (Error & { statusCode: number }) | null {
  if (caller.kind === "internal") return null;
  if (caller.kind === "agent" && caller.isAdmin === true) return null;
  if (caller.kind === "agent") {
    return Object.assign(
      new Error(`forbidden: a ${table} row is created through POST only by an administrator; where ${table} permits it, use PUT /${table}/<id>`),
      { statusCode: 403 },
    );
  }
  return Object.assign(
    new Error(`creating a ${table} row through POST needs an administrator's credential`),
    { statusCode: 401 },
  );
}

/** The refusal when the caller of such a POST cannot be resolved. */
export function unverifiedPostCallerRefusal(table: string): Error & { statusCode: number } {
  return Object.assign(
    new Error(`the caller of this ${table} POST could not be verified, so it was refused; retry`),
    { statusCode: 500 },
  );
}

/**
 * Give every table class in `tables` its own instance `post()` that, when the
 * resource defines no `post()` of its own, refuses a caller who is not an
 * administrator or a trusted internal call, then delegates to the inherited
 * `post()` unchanged. Idempotent. Returns the names of the guarded tables.
 */
export function guardInheritedPosts(
  tables: Record<string, unknown> | null | undefined,
  deps: TablePostGuardDeps,
): string[] {
  const guarded: string[] = [];
  for (const name of Object.keys(tables ?? {})) {
    const table = (tables as Record<string, any>)[name];
    if (typeof table !== "function" || table.prototype == null) continue;
    if (Object.prototype.hasOwnProperty.call(table, TABLE_POST_GUARD)) {
      guarded.push(name);
      continue;
    }
    const tablePrototype = table.prototype;
    const inherited = tablePrototype.post;
    if (typeof inherited !== "function") continue; // no POST to guard
    Object.defineProperty(tablePrototype, "post", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: async function post(this: any, ...args: unknown[]) {
        if (!resourceDefinesPost(this, tablePrototype)) {
          let caller: PostCaller;
          try {
            caller = await deps.resolveAuth(this.getContext?.());
          } catch {
            throw unverifiedPostCallerRefusal(name);
          }
          const refusal = inheritedPostRefusal(name, caller);
          if (refusal) throw refusal;
        }
        return inherited.apply(this, args);
      },
    });
    Object.defineProperty(table, TABLE_POST_GUARD, { value: true });
    guarded.push(name);
  }
  return guarded;
}
