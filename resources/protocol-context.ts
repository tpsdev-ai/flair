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
 * over WebSocket (the upgrade request). Harper's MCP resource subscriptions use
 * `{ user, authorize: true, request: <RequestTarget> }`. Harper clears
 * `authorize` once its first entry call has used it (resources/Resource.ts), so
 * the MQTT session object is the marker that stays on the context.
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
 * Whether `context` was built by a protocol layer: an MQTT session's context,
 * or one still carrying Harper's `authorize: true` request for authorization.
 */
export function isProtocolLayerContext(context: unknown): boolean {
  if (context == null || typeof context !== "object") return false;
  return (context as { authorize?: unknown }).authorize === true || isMqttSessionContext(context);
}
