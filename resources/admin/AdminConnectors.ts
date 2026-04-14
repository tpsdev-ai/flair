import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse, esc } from "./layout.js";

/**
 * GET /AdminConnectors — OAuth clients and active sessions.
 */
export class AdminConnectors extends Resource {
  async get() {
    const clients: any[] = [];

    try {
      for await (const c of (databases as any).flair.OAuthClient.search()) {
        clients.push(c);
      }
    } catch { /* table may not exist */ }

    clients.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    let tableRows = "";
    if (clients.length === 0) {
      tableRows = `<tr><td colspan="4" class="empty">No OAuth clients registered. Clients are created via Dynamic Client Registration when Claude connects.</td></tr>`;
    } else {
      for (const c of clients) {
        const created = c.createdAt?.slice(0, 10) ?? "—";
        const source = c.registeredBy === "dcr" ? "DCR" : c.registeredBy ?? "—";
        const redirects = (c.redirectUris ?? []).join(", ");

        tableRows += `
          <tr>
            <td><strong>${esc(c.name || "Unnamed")}</strong><br><small>${esc(c.id)}</small></td>
            <td>${esc(redirects || "—")}</td>
            <td><span class="badge badge-gray">${esc(source)}</span></td>
            <td>${created}</td>
          </tr>`;
      }
    }

    const content = `
      <h1>Connectors</h1>
      <p class="subtitle">OAuth clients that can access this Flair instance</p>

      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Redirect URIs</th>
            <th>Source</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;

    return htmlResponse(layout("Connectors", content, "connectors"));
  }
}
