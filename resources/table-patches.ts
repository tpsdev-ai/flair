/**
 * Installs the PATCH guard (resources/table-patch-policy.ts) on every table
 * class in the flair database's table registry when the component loads: a
 * PATCH whose target row does not exist creates nothing unless the caller is an
 * administrator or a trusted internal call. The tables are read from the
 * registry, so the class of a table added to the schema gets the guard without
 * being named here. A resource that overrides `patch()` keeps the guard only by
 * ending in `super.patch()` or by refusing creation itself.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardTablePatches } from "./table-patch-policy.js";

guardTablePatches((databases as any).flair, { resolveAuth: resolveAgentAuth });
