/**
 * Subscriptions to flair's tables are served to administrators and trusted
 * internal callers only.
 *
 * Every table in the flair database has a subscription route of its own: SSE
 * (`Accept: text/event-stream`, which Harper dispatches as CONNECT) and
 * WebSocket on `/<Table>/` and `/<Table>/<id>`. A table subscription streams
 * the table's stored rows, while flair's per-record read rules are applied by
 * each resource's get()/search(). So the table route refuses every caller that
 * is not an administrator or a trusted internal call: a verified non-admin
 * agent gets 403, a caller without a valid credential 401. Agents subscribe
 * through FeedMemories and FeedSouls, which are not tables and decide their own
 * subscribers.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Harper enters every table subscription route — SSE and WebSocket alike —
 * through the static `connect()` of the class registered for that route, and
 * hands it the request as its context. `guardTableSubscriptions` replaces that
 * static `connect()` on every table class in the flair database, read from the
 * database's own table registry at load (resources/table-subscriptions.ts), not
 * from a list someone maintains:
 *   - a table added to the schema is in that registry, so it is guarded without
 *     anyone naming it;
 *   - a flair resource class that extends a table inherits the guarded static,
 *     and overriding an INSTANCE `connect()`/`subscribe()` does not bypass it,
 *     because the static runs first;
 *   - in-process callers (the feed resources, the BM25 index) subscribe
 *     through the table's `subscribe()`, not `connect()`, so they are
 *     unaffected.
 * test/integration/table-subscription-default-deny.test.ts enumerates every
 * table in the database at runtime and fails if any served route admits a
 * non-admin subscriber.
 *
 * This module has no imports, so it is unit-tested directly
 * (test/unit/table-subscription-policy.test.ts); the dependencies it needs are
 * passed in by resources/table-subscriptions.ts.
 */

/** The caller verdict the guard decides on (resources/agent-auth.ts's AgentAuthVerdict). */
export type SubscriptionCaller =
  | { kind: "internal" }
  | { kind: "agent"; agentId: string; isAdmin: boolean }
  | { kind: "anonymous" };

export interface TableSubscriptionGuardDeps {
  /** Resolves a request/context to a caller verdict (resolveAgentAuth). */
  resolveAuth: (context: unknown) => Promise<SubscriptionCaller>;
  /** The ambient context Harper uses when a call passes none (harper's getContext). */
  ambientContext: () => unknown;
}

/** Marks a table class whose static `connect()` has been guarded. */
export const TABLE_SUBSCRIPTION_GUARD: unique symbol = Symbol.for("flair.tableSubscriptionGuard");

/** The resources that serve agents a subscription; they are not tables. */
const AGENT_SUBSCRIPTION_RESOURCES = ["FeedMemories", "FeedSouls"] as const;

function looksLikeContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.getContext === "function" ||
    "request" in v ||
    "user" in v ||
    "transaction" in v ||
    "headers" in v ||
    "tpsAgent" in v ||
    "tpsAnonymous" in v
  );
}

/**
 * The context a static `connect(target, data, context)` call runs under,
 * resolved the way Harper resolves it: the explicit context argument (the
 * request, for SSE and WebSocket), else a context passed in the data position
 * (the two-argument in-process form), else the ambient context.
 */
export function subscriptionCallerContext(
  data: unknown,
  context: unknown,
  ambientContext: () => unknown,
): unknown {
  if (context) return (context as any).getContext?.() || context;
  if (looksLikeContext(data)) return (data as any).getContext?.() || data;
  return ambientContext();
}

/**
 * The longest error text Harper can return for a refused subscription. Harper
 * sends the error as the WebSocket close reason (`Error: <message>`), and a
 * close reason is limited to 123 bytes; a longer one fails to close the socket.
 * The messages below therefore do not include the table name.
 */
export const MAX_REFUSAL_REASON_BYTES = 123;

/**
 * Why `caller` may not subscribe to a table route, as the error the route
 * returns; null for an administrator or a trusted internal call.
 */
export function tableSubscriptionRefusal(caller: SubscriptionCaller): (Error & { statusCode: number }) | null {
  if (caller.kind === "internal") return null;
  if (caller.kind === "agent" && caller.isAdmin === true) return null;
  const feeds = AGENT_SUBSCRIPTION_RESOURCES.join(" or ");
  if (caller.kind === "agent") {
    return Object.assign(
      new Error(`table subscriptions are for administrators; agents subscribe through ${feeds}`),
      { statusCode: 403 },
    );
  }
  return Object.assign(
    new Error(`table subscriptions need an administrator credential; agents subscribe through ${feeds}`),
    { statusCode: 401 },
  );
}

/** The error for a subscription whose caller could not be resolved. */
export function unverifiedSubscriberRefusal(): Error & { statusCode: number } {
  return Object.assign(
    new Error("the subscriber could not be verified, so the table subscription was refused; retry"),
    { statusCode: 500 },
  );
}

/**
 * Replace the static `connect()` of every table class in `tables` with one that
 * admits only administrators and trusted internal calls, then delegates to the
 * inherited `connect()` unchanged. Idempotent. A failure to resolve the caller
 * refuses the subscription. Returns the names of the guarded tables.
 */
export function guardTableSubscriptions(
  tables: Record<string, unknown> | null | undefined,
  deps: TableSubscriptionGuardDeps,
): string[] {
  const guarded: string[] = [];
  for (const name of Object.keys(tables ?? {})) {
    const table = (tables as Record<string, any>)[name];
    if (typeof table !== "function") continue;
    if (Object.prototype.hasOwnProperty.call(table, TABLE_SUBSCRIPTION_GUARD)) {
      guarded.push(name);
      continue;
    }
    const inherited = table.connect;
    if (typeof inherited !== "function") continue; // no subscription entry point to guard
    Object.defineProperty(table, "connect", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: async function connect(this: unknown, target: unknown, data?: unknown, context?: unknown) {
        let caller: SubscriptionCaller;
        try {
          caller = await deps.resolveAuth(subscriptionCallerContext(data, context, deps.ambientContext));
        } catch {
          throw unverifiedSubscriberRefusal();
        }
        const refusal = tableSubscriptionRefusal(caller);
        if (refusal) throw refusal;
        return inherited.call(this, target, data, context);
      },
    });
    Object.defineProperty(table, TABLE_SUBSCRIPTION_GUARD, { value: true });
    guarded.push(name);
  }
  return guarded;
}
