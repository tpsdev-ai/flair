/**
 * Installs the table-subscription guard
 * (resources/table-subscription-policy.ts) on every table class in the flair
 * database's table registry when the component loads: the static `connect()`
 * (the entry Harper uses for an exported table's SSE and WebSocket subscription
 * routes), `subscribe()` (an MQTT SUBSCRIBE, and Harper's native MCP
 * `resources/subscribe` when that component is configured) and `publish()` (an
 * MQTT PUBLISH) of each table class admit only administrators and trusted
 * internal calls, and so do its static `put()` and `delete()` for a call where
 * an argument Harper may take as the context carries the markers of an MQTT
 * session's context or of a copy of a stored will record Harper replays (a
 * retained MQTT PUBLISH or last-will); every other put()/delete() call passes
 * through with the same arguments and no caller resolved. Each guarded static
 * decides the contexts Harper may take from the call's arguments (every listed
 * reading, or for put()/delete() every marked candidate; see the policy module
 * for what is read and what is listed); the guard's boundary is protocol-layer
 * callers, whose contexts Harper constructs, and in-process code is trusted.
 * Harper's native MCP route resolves every caller as anonymous, so it refuses
 * administrators too (see the policy module). The tables are read from the
 * registry, so the class of a table added to the schema gets the guard without
 * being named here.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 */
import { databases, getContext } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardTableSubscriptions } from "./table-subscription-policy.js";

guardTableSubscriptions((databases as any).flair, {
  resolveAuth: resolveAgentAuth,
  ambientContext: () => getContext(),
});
