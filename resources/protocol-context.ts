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
 * context there from the argument's own data properties alone, so the guard
 * reads nothing from an ordinary write's context.
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
 * this. No getter or method of `value` is invoked, so a call with any other
 * context reads nothing from it (no `getContext()`, no accessor).
 */
export function isDirectMqttSessionContext(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (!Object.getOwnPropertyDescriptor(value, "socket")) return false;
  const session = ownDataValue(value, "session");
  if (session == null || typeof session !== "object") return false;
  return typeof dataValueInChain(session, "addSubscription") === "function";
}

/**
 * Whether `context` was built by a protocol layer: an MQTT session's context,
 * or one still carrying Harper's `authorize: true` request for authorization.
 */
export function isProtocolLayerContext(context: unknown): boolean {
  if (context == null || typeof context !== "object") return false;
  return (context as { authorize?: unknown }).authorize === true || isMqttSessionContext(context);
}
