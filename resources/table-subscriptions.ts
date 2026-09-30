/**
 * Installs the table-subscription guard (resources/table-subscription-policy.ts)
 * on every table class in the flair database's table registry when the
 * component loads: the static `connect()` of each table class — the entry
 * Harper uses for an exported table's SSE and WebSocket subscription routes —
 * admits only administrators and trusted internal calls. The tables are read
 * from the registry, so the class of a table added to the schema gets the guard
 * without being named here.
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
