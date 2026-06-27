import { Resource } from "@harperfast/harper";
import { MCP_HIDDEN } from "./mcp-curation.js";

/**
 * GET /Admin — friendly redirect to /AdminDashboard.
 *
 * Operators bookmark or type the bare /Admin path. Without this resource
 * they hit a 404 and assume the admin UI is broken. The dashboard is the
 * canonical landing surface; redirect there.
 */
export class Admin extends Resource {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  async get() {
    return new Response("", {
      status: 302,
      headers: { Location: "/AdminDashboard" },
    });
  }
}
