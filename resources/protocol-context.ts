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
 * Harper replays, from the argument's own property descriptors alone: on an
 * ordinary write's context they invoke no getter and no `getContext()`. A
 * Proxy's getOwnPropertyDescriptor trap does run, and an error it throws
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
 * Whether `value` is itself the context Harper's MQTT layer built for a
 * session's action, read from its own data properties only: an own `socket`
 * key and an own `session` holding an object with an `addSubscription`
 * method. Harper's `createContext()` returns a plain object literal, and a
 * session's retained will copies it, so the context Harper passes satisfies
 * this. It reads the own property descriptor of `socket` and, only when that
 * exists, of `session` and the session's `addSubscription` (along its
 * prototype chain); it invokes no getter or method of `value` (no
 * `getContext()`, no accessor). A descriptor read that throws propagates.
 */
export function isDirectMqttSessionContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (!Object.getOwnPropertyDescriptor(value, "socket")) return false;
  const session = ownDataValue(value, "session");
  if (session == null || typeof session !== "object") return false;
  return typeof dataValueInChain(session, "addSubscription") === "function";
}

/**
 * Whether `value` is the context Harper uses when it replays the last-will
 * messages still stored as its first worker starts (an instance start or a
 * worker restart; server/DurableSubscriptionsSession.ts): a shallow copy of
 * the stored will record (`{ id, topic, data, qos, retain, user }`) on which
 * Harper sets `authorize: true`, passed to put()/delete() for a retained will.
 * It carries no HTTP request and no credential flair verifies; its `user` is
 * the name the session connected with, looked up again. Read from own property
 * descriptors only — `authorize` true, then `topic` a string, then `retain`
 * true, each read only while the previous one matches — so no getter is
 * invoked; a descriptor read that throws propagates.
 */
export function isLastWillReplayContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  return ownDataValue(value, "authorize") === true
    && typeof ownDataValue(value, "topic") === "string"
    && ownDataValue(value, "retain") === true;
}

/**
 * Whether `context` was built by a protocol layer: an MQTT session's context,
 * or one still carrying Harper's `authorize: true` request for authorization.
 */
export function isProtocolLayerContext(context: unknown): boolean {
  if (context == null || typeof context !== "object") return false;
  return (context as { authorize?: unknown }).authorize === true || isMqttSessionContext(context);
}
