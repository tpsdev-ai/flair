import { Resource } from "@harperfast/harper";
import { allowAdmin } from "./agent-auth.js";

/**
 * GET /Admin — friendly redirect to /AdminDashboard.
 *
 * Operators bookmark or type the bare /Admin path. Without this resource
 * they hit a 404 and assume the admin UI is broken. The dashboard is the
 * canonical landing surface; redirect there.
 *
 * allowRead()=allowAdmin (ops-oox7 defense-in-depth): the /Admin* pathname
 * gate in auth-middleware.ts only 401s when there's NO Authorization header
 * at all (or Basic creds don't resolve to a real user) — a validly-verified
 * TPS-Ed25519 agent that is NOT an admin, or a valid-but-non-super_user Basic
 * user, currently sails through the middleware with no admin resource-level
 * check at all. allowRead closes that gap the same way WorkspaceLatest.ts /
 * MemoryReindex.ts already gate their own custom (non-@table) Resources.
 */
export class Admin extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    return new Response("", {
      status: 302,
      headers: { Location: "/AdminDashboard" },
    });
  }
}
