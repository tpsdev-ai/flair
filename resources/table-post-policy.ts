/**
 * A non-admin HTTP collection POST is served only by a resource's own `post()`,
 * which applies that resource's own write rules. On a table whose resource
 * defines no `post()` of its own, a collection POST is refused unless the
 * caller is an administrator or a trusted internal call. Harper runs the
 * resource's `allowCreate()` check before `post()`, and that check can refuse
 * the POST first; a POST that reaches the guard is answered 403 for a verified
 * non-admin agent and 401 for a caller without a valid credential, and is
 * refused when the caller cannot be resolved.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * `guardInheritedPosts` gives every table class in the flair database's table
 * registry that has a `post()` its own instance `post()`, read from that
 * registry at load
 * (resources/table-posts.ts), not from a list someone maintains:
 *   - a table added to the schema is in that registry, so its class gets the
 *     guard without anyone naming it;
 *   - a resource class that defines `post()` keeps it: Harper calls the most
 *     derived `post()`, and when that override ends in `super.post()` the guard
 *     sees that the resource defines one and lets the call through;
 *   - on a resource class without a `post()` of its own, a POST that passes the
 *     resource's `allowCreate()` check reaches the guard, which refuses a
 *     non-admin caller before Harper's `create()` runs;
 *   - resources/table-posts.ts logs an error at load when the registry is
 *     missing or empty, or an entry could not be guarded (`tablePostGuardGaps`).
 * test/integration/collection-post-attribution.test.ts reads every table in the
 * database at runtime, sends a collection POST built from the table's declared
 * attributes (plus a value a table's own validation requires) as a verified
 * non-admin agent, and checks each candidate stored row of that POST (a new or
 * changed row, or a row under the body id or a key the response names, found
 * under the table's primary key): the table's registered owner field, if it
 * has one, must be the caller. The body carries an `originatorInstanceId` and a
 * `provenance` only where the table declares them, and only those declared
 * fields are checked: `originatorInstanceId` must be this instance's id on a
 * new row and the previous value on an existing one, and `provenance` must
 * not contain the body's sentinel timestamp. The guard's non-admin refusals
 * are unit-tested (test/unit/table-post-policy.test.ts,
 * test/unit/table-posts.test.ts); the integration test covers an
 * administrator's POST through the guard (Peer).
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
 * Give every table class in `tables` that has a `post()` its own instance
 * `post()`. When the resource defines no `post()` of its own, that `post()`
 * refuses a caller who is not an administrator or a trusted internal call; an
 * admitted caller, and every call on a resource with its own `post()`, is
 * delegated to the inherited `post()` unchanged. Idempotent. Returns the names
 * of the guarded tables.
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

/**
 * What an installation left unguarded, given the registry and the names
 * `guardInheritedPosts` returned: a missing or empty registry, or each entry
 * that is not a table class with a `post()` to guard. Empty when every entry
 * is guarded.
 */
export function tablePostGuardGaps(
  tables: Record<string, unknown> | null | undefined,
  guarded: readonly string[],
): string[] {
  const names = Object.keys(tables ?? {});
  if (names.length === 0) return ["the flair table registry is missing or empty"];
  const done = new Set(guarded);
  return names.filter((name) => !done.has(name)).map((name) => `${name} is not a table class with a post() to guard`);
}
