/**
 * Installs the PATCH guard (resources/table-patch-policy.ts) on every table in
 * the flair database when the component loads: a PATCH whose target row does
 * not exist creates nothing unless the caller is an administrator or a trusted
 * internal call. The tables are read from the database's own registry, so a
 * table added to the schema is guarded without being named here.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardTablePatches } from "./table-patch-policy.js";

guardTablePatches((databases as any).flair, { resolveAuth: resolveAgentAuth });
