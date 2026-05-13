import { Resource } from "@harperfast/harper";

/**
 * GET /Admin — friendly redirect to /AdminDashboard.
 *
 * Operators bookmark or type the bare /Admin path. Without this resource
 * they hit a 404 and assume the admin UI is broken. The dashboard is the
 * canonical landing surface; redirect there.
 */
export class Admin extends Resource {
  async get() {
    return new Response("", {
      status: 302,
      headers: { Location: "/AdminDashboard" },
    });
  }
}
