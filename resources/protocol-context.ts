/**
 * Which call contexts a protocol layer built, read from what Harper puts on
 * them. Shared by the caller resolver (resources/agent-auth.ts) and the
 * table-subscription guard (resources/table-subscription-policy.ts), so both
 * read a protocol-layer call the same way.
 *
 * Harper's MQTT layer gives every action of a session a context built by the
 * session itself (server/DurableSubscriptionsSession.ts `createContext()`):
 * `{ session, socket, user, authorize: true, request?, url?, headers? }`, where
 * `session` is the MQTT session object and `request` is present only for MQTT
 * over WebSocket (the upgrade request). Harper's native MCP resource
 * subscriptions use `{ user, authorize: true, request: <RequestTarget> }`, a
 * context with no HTTP request; flair has no verified bridge from that Harper
 * user to a flair caller, so the resolver answers anonymous for it. Harper
 * clears `authorize` once its first entry call has used it
 * (resources/Resource.ts), so the MQTT session object is the marker that stays
 * on the context.
 *
 * A retained MQTT PUBLISH reaches a table's static put()/delete(), which
 * ordinary writes also use. isDirectMqttSessionContext recognises the session's
 * context there, and isLastWillReplayContext the copy of a stored will record
 * Harper replays. Both classify by shape (they do not prove Harper built the
 * object) and read property descriptors only — the argument's own, and for a
 * session-shaped argument the nested session's along its prototype chain —
 * so on an ordinary write's context they invoke no getter and no
 * `getContext()`. A Proxy's descriptor traps do run, and an error one throws
 * propagates to the caller.
 *
 * This module has no imports, so it is unit-tested directly.
 */

/** Whether `context` is one Harper's MQTT layer built for a session's action. */
export function isMqttSessionContext(context: unknown): boolean {
  if (context == null || typeof context !== "object") return false;
  const c = context as { session?: unknown };
  if (!("socket" in (context as object)) || c.session == null || typeof c.session !== "object") return false;
  return typeof (c.session as { addSubscription?: unknown }).addSubscription === "function";
}

/**
 * An own data property's value; undefined for a missing key and for an
 * accessor, which is never invoked.
 */
function ownDataValue(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * A data property's value on `target` or its prototype chain; undefined for a
 * missing key and for an accessor, which is never invoked.
 */
function dataValueInChain(target: object, key: string): unknown {
  for (let o: object | null = target; o != null; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}

/**
 * Whether `value` has the shape of the context Harper's MQTT layer builds
 * for a session's action: an own `socket` property (a data property or an
 * accessor, which is not invoked) and an own data property `session` holding
 * an object whose `addSubscription`, found as a data property along that
 * object's prototype chain, is a function. Harper's `createContext()` returns
 * a plain object literal of this shape, and a session's retained will copies
 * it. This classifies by shape: it does not prove that Harper built the
 * object. It reads the own property descriptor of `socket`; only when one
 * exists, the own descriptor of `session`; and only when that holds an
 * object, descriptors along the session's prototype chain (getPrototypeOf
 * included) until it finds `addSubscription`. It invokes no getter or method
 * of `value` or the session (no `getContext()`, no accessor). A descriptor or
 * prototype read that throws propagates.
 */
export function isDirectMqttSessionContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (!Object.getOwnPropertyDescriptor(value, "socket")) return false;
  const session = ownDataValue(value, "session");
  if (session == null || typeof session !== "object") return false;
  return typeof dataValueInChain(session, "addSubscription") === "function";
}

/**
 * Whether `value` has the shape of the context Harper uses when it replays
 * the last-will messages still stored as its first worker starts (an instance
 * start or a worker restart; server/DurableSubscriptionsSession.ts): a
 * shallow copy of
 * the stored will record (`{ id, topic, data, qos, retain, user }`) on which
 * Harper sets `authorize: true`, passed to put()/delete() for a retained will.
 * It carries no HTTP request and no credential flair verifies; its `user` is
 * the name the session connected with, looked up again. Read from own property
 * descriptors only — `authorize` true, then `topic` a string, then `retain`
 * true, each read only while the previous one matches — so no getter is
 * invoked; a descriptor read that throws propagates. It classifies by shape:
 * an object of that shape is decided as a replayed will wherever it came
 * from.
 */
export function isLastWillReplayContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  return ownDataValue(value, "authorize") === true
    && typeof ownDataValue(value, "topic") === "string"
    && ownDataValue(value, "retain") === true;
}

/**
 * Whether `value` has the shape of Harper's released-transaction placeholder
 * (resources/DatabaseTransaction.ts `RELEASED_TRANSACTION`), which Harper
 * treats as an absent argument: a frozen object whose own data properties
 * include an `addWrite` and a `setContext` function and `open` 0. Harper
 * tests identity with that one instance, which flair cannot reach, so this
 * tests the shape, from own property descriptors only (`addWrite` first; the
 * others only while the previous ones match).
 */
export function isReleasedTransactionPlaceholder(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  return typeof ownDataValue(value, "addWrite") === "function"
    && typeof ownDataValue(value, "setContext") === "function"
    && ownDataValue(value, "open") === 0;
}

/**
 * Whether `value` carries a transaction: an own data `transaction` property
 * holding an object with a `commit` method (along its prototype chain), the
 * shape of Harper's DatabaseTransaction. Harper tests `instanceof
 * DatabaseTransaction`, a class flair cannot reach. Reads property
 * descriptors only.
 */
export function carriesTransaction(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const transaction = ownDataValue(value, "transaction");
  if (transaction == null || typeof transaction !== "object") return false;
  return typeof dataValueInChain(transaction, "commit") === "function";
}

/**
 * Whether `context` was built by a protocol layer: an MQTT session's context,
 * or one still carrying Harper's `authorize: true` request for authorization.
 */
export function isProtocolLayerContext(context: unknown): boolean {
  if (context == null || typeof context !== "object") return false;
  return (context as { authorize?: unknown }).authorize === true || isMqttSessionContext(context);
}
