import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse, esc } from "./admin-layout.js";

/**
 * GET /AdminPrincipals — list all principals with kind, trust, status.
 */
export class AdminPrincipals extends Resource {
  async get() {
    const principals: any[] = [];

    try {
      for await (const p of (databases as any).flair.Agent.search()) {
        principals.push(p);
      }
    } catch { /* table may not exist */ }

    principals.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    let tableRows = "";
    if (principals.length === 0) {
      tableRows = `<tr><td colspan="6" class="empty">No principals registered yet.</td></tr>`;
    } else {
      for (const p of principals) {
        const kind = p.kind ?? "agent";
        const kindBadge = kind === "human"
          ? `<span class="badge badge-blue">human</span>`
          : `<span class="badge badge-gray">agent</span>`;
        const trust = p.defaultTrustTier ?? "—";
        const trustBadge = trust === "endorsed"
          ? `<span class="badge badge-green">${trust}</span>`
          : trust === "corroborated"
            ? `<span class="badge badge-blue">${trust}</span>`
            : `<span class="badge badge-yellow">${trust}</span>`;
        const status = p.status ?? "active";
        const statusBadge = status === "active"
          ? `<span class="badge badge-green">${status}</span>`
          : `<span class="badge badge-gray">${status}</span>`;
        const admin = p.admin ? "yes" : "";
        const created = p.createdAt?.slice(0, 10) ?? "—";

        tableRows += `
          <tr>
            <td><strong>${esc(p.id)}</strong><br><small>${esc(p.displayName || p.name || "")}</small></td>
            <td>${kindBadge}</td>
            <td>${trustBadge}</td>
            <td>${statusBadge}</td>
            <td>${admin}</td>
            <td>${created}</td>
          </tr>`;
      }
    }

    const content = `
      <h1>Principals</h1>
      <p class="subtitle">${principals.length} registered principal${principals.length !== 1 ? "s" : ""}</p>

      <table>
        <thead>
          <tr>
            <th>ID / Name</th>
            <th>Kind</th>
            <th>Trust</th>
            <th>Status</th>
            <th>Admin</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;

    return htmlResponse(layout("Principals", content, "principals"));
  }
}
