/**
 * Subscriptions and publishes on flair's tables are served to administrators
 * and trusted internal callers only, on every transport. Harper's native MCP
 * subscription route refuses every caller, administrators included, until a
 * verified bridge from Harper's MCP session to a flair caller exists (see
 * "Which caller is decided on").
 *
 * An exported table has a subscription route: SSE (`Accept:
 * text/event-stream`, which Harper dispatches as CONNECT) and WebSocket on
 * `/<Table>/` and `/<Table>/<id>`. When Harper's MQTT broker is on, the same
 * table is also an MQTT topic (`<Table>/#`, `<Table>/<id>`, ...): a SUBSCRIBE
 * streams it, a PUBLISH writes a message to it, and a retained PUBLISH writes
 * (or, with an empty payload, deletes) the row itself. A table subscription
 * streams the table's stored rows, while flair's per-record read rules are
 * applied by each resource's get()/search(). So every table subscription and
 * every MQTT publish to a table, retained or not, refuses a caller that is not
 * an administrator or a trusted internal call: a verified non-admin agent gets
 * 403, a caller without a valid credential 401. Resources that are not tables,
 * such as the feed resources, decide their own subscribers and are not
 * affected.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Harper enters a table through statics of the class registered for its path,
 * each handed the caller's context:
 *   - `connect()` — the SSE and WebSocket subscription routes (the context is
 *     the HTTP request);
 *   - `subscribe()` — an MQTT SUBSCRIBE (DurableSubscriptionsSession's
 *     addSubscription), and Harper's native MCP `resources/subscribe` when
 *     that component is configured;
 *   - `publish()` — an MQTT PUBLISH (publishMessage);
 *   - `put()` / `delete()` — a retained MQTT PUBLISH and a retained last-will
 *     (publishMessage). Harper passes the session's own context for a session's
 *     publish and for the will it publishes when a session disconnects, and the
 *     stored will record itself for a will it replays when its first worker
 *     starts (every will still stored: a session that never disconnected, or
 *     one whose will was not published as it dropped). These two statics are
 *     also the entry of ordinary put and delete calls (a REST PUT or DELETE,
 *     flair's own writes), so their guard decides only a call whose explicit
 *     context argument is one of those two, recognised from that argument's own
 *     data properties (isDirectMqttSessionContext and isLastWillReplayContext
 *     in resources/protocol-context.ts). A replayed will carries no verified
 *     principal, so it is decided as a caller without a valid credential:
 *     refused for every table, an administrator's will included. Every other
 *     put()/delete() call goes to the inherited static with the same arguments
 *     and receiver, synchronously: the guard invokes no getter and no
 *     `getContext()` of its arguments and resolves no caller, so the write
 *     keeps flair's write rules and Harper reads its context as it would
 *     without the guard. Harper's `post()` and `patch()` statics are separate
 *     and not wrapped (an MQTT PUBLISH reaches neither).
 * `guardTableSubscriptions` replaces these statics on every table class in the
 * flair database's table registry, read at load
 * (resources/table-subscriptions.ts), not from a list someone maintains. For
 * every call it decides — each connect(), subscribe() and publish(), and each
 * put()/delete() made with an MQTT session's context or a replayed will record
 * — the replacement resolves the caller from the context Harper would use for
 * that call (a replayed will is a caller without a valid credential) and asks
 * ONE decision function, `tableSubscriptionRefusal`, so the entries
 * cannot drift apart:
 *   - a table added to the schema is in that registry, so its class gets the
 *     guard without anyone naming it, and its routes and topics use the guard
 *     once the table is exported;
 *   - a flair resource class that extends a table inherits the guarded
 *     statics, and an INSTANCE method it overrides runs only after them,
 *     because the static runs first. A class that defines one of these STATICS
 *     itself replaces the guarded one; none does today, and one that does must
 *     apply the same check itself;
 *   - flair's own in-process readers (the feed resources, which apply their
 *     own subscriber rules, and the BM25 index) read a table's changes through
 *     `subscribeInProcess()`, which calls the table's subscribe() as Harper
 *     defines it. A call that reaches the static `subscribe()` instead is
 *     decided by the guard like any other.
 *
 * ── Which caller is decided on ──────────────────────────────────────────────
 * resolveAgentAuth (resources/agent-auth.ts) resolves the context: over SSE,
 * WebSocket and MQTT over WebSocket the context carries the HTTP request whose
 * Authorization header identifies the caller. A context a protocol layer built
 * without an HTTP request — an MQTT session on Harper's TCP or TLS listener —
 * resolves as anonymous, and so does any other context with no HTTP request
 * that Harper marks for authorization; a call with neither is the trusted
 * `internal` verdict of in-process code. The guard never decides a
 * protocol-layer call as `internal` (subscriptionCaller): when the resolver
 * answers `internal` for a call whose target carries Harper's protocol-layer
 * marker (a non-null, non-false `checkPermission`) or whose context a
 * protocol layer built, the call is decided as a caller without a valid
 * credential (401). Every other verdict is decided as resolved.
 *
 * A last-will message is decided when Harper publishes it, not when a session
 * registers it at CONNECT: Harper stores the will inside its session setup
 * before it attaches the session's HTTP request, and its CONNECT hook
 * (`server.mqtt.authorizeClient(packet, user)`) is synchronous and receives
 * neither that request nor the transport, so the caller flair resolves is not
 * known there. When a session disconnects without DISCONNECT, Harper publishes
 * its will on the session's own context, decided like the session's own
 * publish. When Harper's first worker starts (an instance start or a worker
 * restart), it replays every will still stored — a session that never
 * disconnected, or one whose will was not published as it dropped — on the
 * stored record itself, which carries no verified principal: a retained will
 * is decided as a caller without a valid credential (retainedPublishCaller),
 * and a will that is not retained resolves as anonymous like any context
 * still carrying `authorize: true`. So a replayed will on a table topic is
 * refused, an administrator's included.
 *
 * Harper's native MCP component calls subscribe() with
 * `{ user, authorize: true, request: <RequestTarget> }`. The Harper user it
 * authenticated is not a credential flair verifies, and that context carries no
 * HTTP request, so the call resolves as anonymous: the route refuses every
 * table subscription, administrators included. Admitting an administrator
 * there needs a verified bridge from Harper's MCP session to a flair caller,
 * which does not exist yet; test/integration/table-subscription-mcp.test.ts
 * drives that route and holds it to the refusal.
 *
 * test/integration/table-subscription-default-deny.test.ts reads every table in
 * the database at runtime and fails if a non-admin subscriber is admitted to a
 * table's collection route (`/<Table>/`) or by-id route (`/<Table>/<id>`), over
 * SSE or WebSocket. test/integration/table-subscription-mqtt.test.ts checks
 * MQTT subscribe, publish and retained publish on a Harper with MQTT turned on,
 * and test/integration/table-subscription-mcp.test.ts checks Harper's native
 * MCP `resources/subscribe` on a Harper with that component configured.
 *
 * This module imports only resources/protocol-context.ts, which has no
 * imports, so it is unit-tested directly
 * (test/unit/table-subscription-policy.test.ts); the dependencies it needs are
 * passed in by resources/table-subscriptions.ts.
 */
import { isDirectMqttSessionContext, isLastWillReplayContext, isProtocolLayerContext } from "./protocol-context.js";

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

/** Marks a table class whose subscription and publish statics have been guarded. */
export const TABLE_SUBSCRIPTION_GUARD: unique symbol = Symbol.for("flair.tableSubscriptionGuard");

/**
 * Holds a guarded table's subscribe() as Harper defines it, for
 * subscribeInProcess(). Not exported: in-process readers go through
 * subscribeInProcess().
 */
const IN_PROCESS_SUBSCRIBE: unique symbol = Symbol.for("flair.tableSubscriptionInProcessSubscribe");

/**
 * The table statics the guard replaces, and what each one does: connect() and
 * subscribe() open a subscription, publish() writes a message to the table.
 */
export const GUARDED_TABLE_STATICS = Object.freeze({
  connect: "subscribe",
  subscribe: "subscribe",
  publish: "publish",
} as const);

/** What a guarded call does, as the refusal names it. */
export type TableStreamAction = (typeof GUARDED_TABLE_STATICS)[keyof typeof GUARDED_TABLE_STATICS];

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

function unwrapContext(value: unknown): unknown {
  return (value as any)?.getContext?.() || value;
}

/**
 * The context a static `connect(target, data, context)` or
 * `publish(target, data, context)` call runs under, resolved the way Harper
 * resolves it: the explicit context argument (the request, for SSE and
 * WebSocket; the MQTT session's context, for a publish), else a context passed
 * in the data position (the two-argument in-process form), else the ambient
 * context.
 */
export function subscriptionCallerContext(
  data: unknown,
  context: unknown,
  ambientContext: () => unknown,
): unknown {
  if (context) return unwrapContext(context);
  if (looksLikeContext(data)) return unwrapContext(data);
  return ambientContext();
}

/**
 * The context a static `subscribe(target, context)` call runs under. subscribe()
 * takes no body, so Harper reads its second argument as the context — or, when
 * a third is passed, the third. Without either, the ambient context.
 */
export function subscribeCallerContext(
  second: unknown,
  third: unknown,
  ambientContext: () => unknown,
): unknown {
  if (second && third) return unwrapContext(third);
  if (second) return unwrapContext(second);
  return ambientContext();
}

/**
 * Whether Harper marked this call as made by a protocol layer: REST, MQTT and
 * MCP set a non-null, non-false `checkPermission` on the target; MQTT and MCP
 * set `authorize: true` on the context, and an MQTT session's context carries
 * the session (resources/protocol-context.ts).
 */
export function isProtocolEntry(target: unknown, context: unknown): boolean {
  const permission = target != null && typeof target === "object"
    ? (target as { checkPermission?: unknown }).checkPermission
    : undefined;
  if (permission != null && permission !== false) return true;
  return isProtocolLayerContext(context);
}

/**
 * The caller a guarded call is decided on: the resolved verdict, except that a
 * call a protocol layer made is never the trusted internal caller. Such a call
 * whose context carries no HTTP request with a credential is a caller without
 * a valid credential.
 */
export function subscriptionCaller(
  verdict: SubscriptionCaller,
  target: unknown,
  context: unknown,
): SubscriptionCaller {
  if (verdict.kind === "internal" && isProtocolEntry(target, context)) return { kind: "anonymous" };
  return verdict;
}

/**
 * The longest error text Harper can return for a refused subscription. Harper
 * sends the error as the WebSocket close reason (`Error: <message>`), and a
 * close reason is limited to 123 bytes; a longer one fails to close the socket.
 * The messages below therefore do not include the table name.
 */
export const MAX_REFUSAL_REASON_BYTES = 123;

/**
 * The decision: why `caller` may not subscribe to (or publish to) a table, as
 * the error the route or topic returns; null for an administrator or a trusted
 * internal call. Every guarded entry asks this function, so subscription and
 * publish decide a resolved caller the same way.
 */
export function tableSubscriptionRefusal(
  caller: SubscriptionCaller,
  action: TableStreamAction = "subscribe",
): (Error & { statusCode: number }) | null {
  if (caller.kind === "internal") return null;
  if (caller.kind === "agent" && caller.isAdmin === true) return null;
  const what = action === "publish" ? "table publishes" : "table subscriptions";
  if (caller.kind === "agent") {
    return Object.assign(new Error(`${what} are for administrators`), { statusCode: 403 });
  }
  return Object.assign(new Error(`${what} need an administrator credential`), { statusCode: 401 });
}

/** The error for a subscription or publish whose caller could not be resolved. */
export function unverifiedSubscriberRefusal(action: TableStreamAction = "subscribe"): Error & { statusCode: number } {
  const message = action === "publish"
    ? "the publisher could not be verified, so the table publish was refused; retry"
    : "the subscriber could not be verified, so the table subscription was refused; retry";
  return Object.assign(new Error(message), { statusCode: 500 });
}

/**
 * Read a flair table's changes from flair's own in-process code: the table's
 * subscribe() as Harper defines it, called synchronously with the same
 * argument, without the guard. Clients cannot invoke this helper directly: an
 * authorized feed request reaches it through FeedMemories.connect() or
 * FeedSouls.connect(), after those resources apply their own subscriber
 * rules, and the BM25 index calls it for its own feed. A table the guard was
 * not installed on is subscribed to directly.
 */
export function subscribeInProcess(table: any, request?: unknown): any {
  const subscribe = table?.[IN_PROCESS_SUBSCRIBE];
  return typeof subscribe === "function" ? subscribe.call(table, request) : table.subscribe(request);
}

/**
 * The table statics a retained MQTT PUBLISH reaches: Harper's publishMessage
 * calls `put(target, data, context)` for a retained message with a payload and
 * `delete(target, context)` for one without. Their guard decides only a call
 * made with an MQTT session's context; every other put()/delete() call passes
 * through without resolving a caller.
 */
export const RETAINED_PUBLISH_STATICS: readonly string[] = Object.freeze(["put", "delete"]);

/**
 * The context of a retained MQTT publish, or undefined for any other
 * put()/delete() call. Harper's publishMessage passes the context explicitly,
 * `put(target, data, context)` / `delete(target, context)`: a session's own
 * context (isDirectMqttSessionContext) when the session publishes, or when
 * Harper publishes its will as it disconnects; the stored will record
 * (isLastWillReplayContext) when Harper replays a stored will as its first
 * worker starts. So this takes the argument at
 * the position Harper reads an explicit context (the third when one is given,
 * otherwise the second) and returns it only when it is one of those. Only own
 * data properties of the argument are read: no getter and no `getContext()` of
 * it is invoked, so an ordinary write's context is read by Harper alone, as
 * without the guard. The ambient context is not consulted.
 */
export function retainedPublishContext(args: readonly unknown[]): unknown {
  const explicit = args[2] ? args[2] : args[1];
  return isDirectMqttSessionContext(explicit) || isLastWillReplayContext(explicit) ? explicit : undefined;
}

/**
 * The caller a retained publish is decided on. A will Harper replays as its
 * first worker starts carries no verified principal, so it is decided as a
 * caller without a valid credential, without resolving the record; a
 * session's context is resolved like any other guarded call.
 */
async function retainedPublishCaller(
  context: unknown,
  target: unknown,
  deps: TableSubscriptionGuardDeps,
): Promise<SubscriptionCaller> {
  if (isLastWillReplayContext(context)) return { kind: "anonymous" };
  return subscriptionCaller(await deps.resolveAuth(context), target, context);
}

/** Harper reads `reliesOnPrototype` off its static entry functions; the replacement keeps it. */
function carryStaticMarkers<T extends Function>(replacement: T, inherited: Function): T {
  const marker = (inherited as { reliesOnPrototype?: unknown }).reliesOnPrototype;
  if (marker !== undefined) Object.defineProperty(replacement, "reliesOnPrototype", { value: marker });
  return replacement;
}

function guardedRetainedWrite(
  method: string,
  inherited: (...args: unknown[]) => unknown,
  deps: TableSubscriptionGuardDeps,
) {
  const guarded = {
    [method](this: unknown, ...args: unknown[]) {
      const context = retainedPublishContext(args);
      // Every write that is not an MQTT session's goes to the inherited static
      // as it was called: same arguments, same receiver, same synchronous call,
      // with nothing read from its context.
      if (context === undefined) return inherited.apply(this, args);
      return (async () => {
        let caller: SubscriptionCaller;
        try {
          caller = await retainedPublishCaller(context, args[0], deps);
        } catch {
          throw unverifiedSubscriberRefusal("publish");
        }
        const refusal = tableSubscriptionRefusal(caller, "publish");
        if (refusal) throw refusal;
        return inherited.apply(this, args);
      })();
    },
  }[method];
  return guarded;
}

function guardedStatic(
  method: keyof typeof GUARDED_TABLE_STATICS,
  inherited: (...args: unknown[]) => unknown,
  deps: TableSubscriptionGuardDeps,
) {
  const action = GUARDED_TABLE_STATICS[method];
  const contextOf = method === "subscribe" ? subscribeCallerContext : subscriptionCallerContext;
  // A named function expression, so the replaced static keeps its name.
  const guarded = {
    async [method](this: unknown, ...args: unknown[]) {
      const context = contextOf(args[1], args[2], deps.ambientContext);
      let caller: SubscriptionCaller;
      try {
        caller = subscriptionCaller(await deps.resolveAuth(context), args[0], context);
      } catch {
        throw unverifiedSubscriberRefusal(action);
      }
      const refusal = tableSubscriptionRefusal(caller, action);
      if (refusal) throw refusal;
      return inherited.apply(this, args);
    },
  }[method];
  return guarded;
}

/**
 * Replace the static `connect()`, `subscribe()` and `publish()` of every table
 * class in `tables` with ones that admit only administrators and trusted
 * internal calls, then delegate to the inherited static unchanged; and its
 * static `put()` and `delete()` with ones that decide the same way a call
 * whose explicit context argument is an MQTT session's context or a will
 * record Harper replays (a retained MQTT PUBLISH or last-will) and
 * pass every other put()/delete() call through without reading its context or
 * resolving a caller. Idempotent. A failure to resolve the caller refuses the
 * call.
 * Returns the names of the guarded tables.
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
    let replaced = 0;
    for (const method of Object.keys(GUARDED_TABLE_STATICS) as Array<keyof typeof GUARDED_TABLE_STATICS>) {
      const inherited = table[method];
      if (typeof inherited !== "function") continue; // no such entry point to guard
      if (method === "subscribe") {
        Object.defineProperty(table, IN_PROCESS_SUBSCRIBE, { value: inherited });
      }
      Object.defineProperty(table, method, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: carryStaticMarkers(guardedStatic(method, inherited, deps), inherited),
      });
      replaced++;
    }
    for (const method of RETAINED_PUBLISH_STATICS) {
      const inherited = table[method];
      if (typeof inherited !== "function") continue;
      Object.defineProperty(table, method, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: carryStaticMarkers(guardedRetainedWrite(method, inherited, deps), inherited),
      });
      replaced++;
    }
    if (replaced === 0) continue;
    Object.defineProperty(table, TABLE_SUBSCRIPTION_GUARD, { value: true });
    guarded.push(name);
  }
  return guarded;
}
