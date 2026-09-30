/**
 * Installs the collection-POST guard (resources/table-post-policy.ts) on every
 * table class in the flair database's table registry when the component loads:
 * on a table whose resource defines no `post()` of its own, a collection POST
 * creates a row only for an administrator or a trusted internal call. The
 * tables are read from the registry, so the class of a table added to the
 * schema gets the guard without being named here.
 *
 * This module deliberately exports nothing: Harper registers exported values of
 * a resource module as routes.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardInheritedPosts } from "./table-post-policy.js";

guardInheritedPosts((databases as any).flair, { resolveAuth: resolveAgentAuth });
