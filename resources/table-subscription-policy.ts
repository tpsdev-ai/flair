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
 * applied by each resource's get()/search(). So these entries refuse a caller
 * that is not an administrator or a trusted internal call — an SSE or
 * WebSocket subscription; an MQTT SUBSCRIBE, PUBLISH or retained PUBLISH to a
 * table topic; and a last-will on a table topic when Harper publishes it — a
 * verified non-admin agent with 403, a caller without a valid credential with
 * 401. An MQTT UNSUBSCRIBE is not guarded: it only ends a subscription the
 * session already holds and reaches no table. CONNECT is Harper's own
 * authentication. Resources that are not tables, such as the feed resources,
 * decide their own subscribers and are not affected.
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
 *     publish and for the will it publishes when a session disconnects, and a
 *     copy of the stored will record (with `authorize: true`) for a will it
 *     replays when its first worker starts (every will still stored: a session
 *     that never disconnected, or one whose will was not published as it
 *     dropped). These two statics are also the entry of ordinary put and delete
 *     calls (a REST PUT or DELETE, flair's own writes), so their guard decides
 *     only a call whose context, as Harper reads the arguments
 *     (retainedPublishContext), has the shape of one of those two
 *     (isDirectMqttSessionContext and isLastWillReplayContext in
 *     resources/protocol-context.ts). That is a shape test: a context of that
 *     shape is decided, wherever it came from. A replayed will carries no
 *     verified principal, so it is decided as a caller without a valid
 *     credential: refused for every table, an administrator's will included. To
 *     classify a call, the guard reads property descriptors only: of the
 *     arguments Harper may take as the context, the third and then the second
 *     (the own descriptor of `addWrite`, Harper's released-transaction shape;
 *     of `socket`, and only when it exists of `session` and then, along the
 *     session's prototype chain, of `addSubscription`; of `authorize`, and only
 *     when that is true of `topic` and `retain`), and in two-argument put()
 *     forms of the second argument's `transaction`. It invokes no getter and no
 *     `getContext()`. Every other put()/delete() call then goes to the
 *     inherited static with the same arguments and receiver, synchronously, and
 *     resolves no caller, so the write keeps flair's write rules and Harper
 *     reads its context itself. A descriptor read that throws (a Proxy's trap)
 *     propagates that error before the inherited static runs. Harper's `post()`
 *     and `patch()` statics are separate and not wrapped (an MQTT PUBLISH
 *     reaches neither).
 * `guardTableSubscriptions` replaces these statics on every table class in the
 * flair database's table registry, read at load
 * (resources/table-subscriptions.ts), not from a list someone maintains. For
 * every call it decides — each connect(), subscribe() and publish(), and each
 * put()/delete() whose context has an MQTT session's or a replayed will's
 * shape — the replacement resolves the caller from the context Harper will use
 * for that call, read from the arguments as Harper's transactional() reads
 * them (harperCallContexts; where Harper's choice turns on something flair
 * cannot test, from each possible context, and all must be admitted; a
 * replayed will is a caller without a valid credential), and asks ONE
 * decision function, `tableSubscriptionRefusal`, so the entries
 * cannot drift apart:
 *   - a table added to the schema is in that registry, so its class gets the
 *     guard without anyone naming it, and its routes and topics use the guard
 *     once the table is exported;
 *   - a flair resource class that extends a table inherits the guarded
 *     statics, and an INSTANCE method it overrides runs only after them,
 *     because the static runs first. A class that defines one of these STATICS
 *     itself replaces the guarded one and must reach the guard itself. One
 *     does: OrgEvent (resources/OrgEvent.ts) defines a static put() whose
 *     branch for an array body on its collection path runs before the table's
 *     guarded static — OrgEvent's own instance checks run there first — and
 *     then stores the array through the guarded table put() with the same
 *     context, where a call made with an MQTT session's context is decided;
 *     every other call it passes to the guarded static (super.put);
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
 * disconnected, or one whose will was not published as it dropped — on a copy
 * of the stored record, which carries no verified principal: a retained will
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
import {
  carriesTransaction,
  isDirectMqttSessionContext,
  isLastWillReplayContext,
  isProtocolLayerContext,
  isReleasedTransactionPlaceholder,
} from "./protocol-context.js";

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

/**
 * How Harper's transactional() (resources/Resource.ts) reads each guarded
 * static's arguments: connect(), publish() and put() take content, delete()
 * takes none, and subscribe() leaves it unspecified.
 */
export const STATIC_CONTENT: Readonly<Record<"connect" | "subscribe" | "publish" | "put" | "delete", boolean | undefined>> =
  Object.freeze({ connect: true, subscribe: undefined, publish: true, put: true, delete: false });

/** Where Harper takes a call's context from: one of its arguments, or the ambient context. */
export type CallContextSource = { readonly from: "argument"; readonly value: unknown } | { readonly from: "ambient" };

const AMBIENT: CallContextSource = Object.freeze({ from: "ambient" });
const fromArgument = (value: unknown): CallContextSource => ({ from: "argument", value });

/** Harper's `context.getContext?.() || context`. */
function unwrapContext(value: unknown): unknown {
  return (value as any)?.getContext?.() || value;
}

/** Harper's test for the `(data, context)` form: a first argument that is a record, not a target or id. */
function isContentObject(first: unknown): boolean {
  return typeof first === "object" && first !== null && !(first instanceof URLSearchParams)
    && (!Array.isArray(first) || typeof first[0] === "object");
}

/**
 * The context Harper's transactional() uses for one reading of a static's
 * second and third arguments, mirrored branch for branch:
 *   - a truthy third argument is the context, whatever the second (unwrapped
 *     with `getContext()` when Harper unwraps it: always for a static with
 *     content, and when a second argument is present for the others; a static
 *     without content called with no second argument keeps the third as is);
 *   - with no third argument, a static with content takes the second as the
 *     context when the first is a record (the `(data, context)` form), and
 *     otherwise only when the second is, or carries, one of Harper's
 *     DatabaseTransactions — a class flair cannot test, so both readings are
 *     returned (the second argument as given, and the ambient context);
 *   - delete() takes the second; subscribe() takes the second when it has a
 *     `transaction` or a `getContext`;
 *   - otherwise the ambient context.
 */
function harperContextReading(
  hasContent: boolean | undefined,
  first: unknown,
  second: unknown,
  third: unknown,
): CallContextSource[] {
  if (hasContent === true) {
    if (third) return [fromArgument(unwrapContext(third))];
    if (!second) return [AMBIENT];
    if (isContentObject(first)) return [fromArgument(unwrapContext(second))];
    return [fromArgument(second), AMBIENT];
  }
  if (second) {
    if (third) return [fromArgument(unwrapContext(third))];
    if (hasContent === false) return [fromArgument(unwrapContext(second))];
    const s = second as { transaction?: unknown; getContext?: unknown };
    return s.transaction || s.getContext ? [fromArgument(unwrapContext(second))] : [AMBIENT];
  }
  return third ? [fromArgument(third)] : [AMBIENT];
}

/**
 * Every context Harper may use for a guarded static called with `args`: one,
 * except where Harper's choice turns on something flair cannot test, when each
 * possibility is returned and every one of them is decided. Harper drops its
 * released-transaction placeholder in the second or third position before
 * reading the arguments; an argument of that shape
 * (isReleasedTransactionPlaceholder) is read both as given and as absent.
 */
export function harperCallContexts(
  method: keyof typeof STATIC_CONTENT,
  args: readonly unknown[],
): CallContextSource[] {
  const [first, second, third] = args;
  const seconds = isReleasedTransactionPlaceholder(second) ? [second, undefined] : [second];
  const thirds = isReleasedTransactionPlaceholder(third) ? [third, undefined] : [third];
  const sources: CallContextSource[] = [];
  for (const s of seconds) {
    for (const t of thirds) {
      for (const source of harperContextReading(STATIC_CONTENT[method], first, s, t)) {
        const seen = sources.some((x) => x.from === source.from && (x.from === "ambient" || (x as any).value === (source as any).value));
        if (!seen) sources.push(source);
      }
    }
  }
  return sources;
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
 * whose context, as Harper reads it, has the shape of an MQTT session's
 * context or of a replayed will record (retainedPublishContext); every other
 * put()/delete() call passes through without resolving a caller.
 */
export const RETAINED_PUBLISH_STATICS: readonly string[] = Object.freeze(["put", "delete"]);

/**
 * The argument Harper takes as a put()/delete() call's context, read as
 * Harper's transactional() reads it (resources/Resource.ts), or undefined when
 * Harper takes none and uses the ambient context: a truthy third argument;
 * else, for delete(), a truthy second; for put(), a truthy second when the
 * first is a record (the `(data, context)` form) or when the second carries a
 * transaction (carriesTransaction). Harper's released-transaction placeholder
 * counts as absent in either position (isReleasedTransactionPlaceholder).
 * Unlike Harper it never calls `getContext()`: an argument that provides one
 * is classified as given.
 */
function retainedExplicitContext(method: string, args: readonly unknown[]): unknown {
  const present = (value: unknown) => (value && !isReleasedTransactionPlaceholder(value) ? value : undefined);
  const third = present(args[2]);
  if (third) return third;
  const second = present(args[1]);
  if (!second) return undefined;
  if (method === "delete") return second;
  return isContentObject(args[0]) || carriesTransaction(second) ? second : undefined;
}

/**
 * The context of a retained MQTT publish, or undefined for any other
 * put()/delete() call: the argument Harper takes as the call's context
 * (retainedExplicitContext) when it has the shape of a session's own context
 * (isDirectMqttSessionContext) or of a copy of a stored will record
 * (isLastWillReplayContext). Harper's publishMessage passes a session's own
 * context when the session publishes and when Harper publishes its will as it
 * disconnects, and a copy of the stored will record when Harper replays a
 * stored will as its first worker starts, always as `put(target, data,
 * context)` / `delete(target, context)`. This classifies by shape: it does not
 * prove that Harper built the context. It reads only property descriptors —
 * of the argument (own descriptors) and, for a session-shaped one, of its
 * nested session (along its prototype chain) — and invokes no getter and no
 * `getContext()`; a descriptor read that throws propagates. The ambient
 * context is not consulted: Harper's MQTT layer always passes its context
 * explicitly, and a put()/delete() that runs under the ambient context is an
 * in-process call.
 */
export function retainedPublishContext(method: string, args: readonly unknown[]): unknown {
  const explicit = retainedExplicitContext(method, args);
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
      const context = retainedPublishContext(method, args);
      // Every other write goes to the inherited static as it was called: same
      // arguments, same receiver, same synchronous call, with nothing read
      // from its context but the descriptors retainedPublishContext read.
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
  // A named function expression, so the replaced static keeps its name.
  const guarded = {
    async [method](this: unknown, ...args: unknown[]) {
      // Decide on the context Harper will use; where that turns on something
      // flair cannot test, every possible one must be admitted.
      for (const source of harperCallContexts(method, args)) {
        const context = source.from === "argument" ? source.value : deps.ambientContext();
        let caller: SubscriptionCaller;
        try {
          caller = subscriptionCaller(await deps.resolveAuth(context), args[0], context);
        } catch {
          throw unverifiedSubscriberRefusal(action);
        }
        const refusal = tableSubscriptionRefusal(caller, action);
        if (refusal) throw refusal;
      }
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
 * whose context, as Harper reads it, has the shape of an MQTT session's
 * context or of a replayed will record (a retained MQTT PUBLISH or last-will)
 * and pass every other put()/delete() call through, after reading only
 * property descriptors of its arguments (retainedPublishContext) and without
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
