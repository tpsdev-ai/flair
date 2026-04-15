import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse, esc } from "./admin-layout.js";

/**
 * GET /AdminMemory — browse and search memories.
 */
export class AdminMemory extends Resource {
  async get() {
    const request = (this as any).request;
    const url = new URL(request?.url ?? "http://localhost", "http://localhost");
    const query = url.searchParams.get("q") ?? "";
    const subject = url.searchParams.get("subject") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const memories: any[] = [];

    try {
      const conditions: any[] = [];
      if (subject) {
        conditions.push({ attribute: "subject", comparator: "equals", value: subject.toLowerCase() });
      }
      conditions.push({ attribute: "archived", comparator: "not_equal", value: true });

      const searchQuery: any = conditions.length > 0 ? { conditions } : {};
      let count = 0;

      for await (const m of (databases as any).flair.Memory.search(searchQuery)) {
        if (m.expiresAt && Date.parse(m.expiresAt) < Date.now()) continue;
        if (query && !String(m.content || "").toLowerCase().includes(query.toLowerCase())) continue;
        memories.push(m);
        count++;
        if (count >= limit) break;
      }
    } catch { /* table may not exist */ }

    memories.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    let tableRows = "";
    if (memories.length === 0) {
      tableRows = `<tr><td colspan="5" class="empty">No memories found${query ? ` matching "${query}"` : ""}.</td></tr>`;
    } else {
      for (const m of memories) {
        const preview = (m.content || "").slice(0, 120) + ((m.content || "").length > 120 ? "…" : "");
        const durability = m.durability ?? "standard";
        const durBadge = durability === "permanent"
          ? `<span class="badge badge-green">${durability}</span>`
          : durability === "persistent"
            ? `<span class="badge badge-blue">${durability}</span>`
            : `<span class="badge badge-gray">${durability}</span>`;
        const subjectStr = m.subject ?? "—";
        const created = m.createdAt?.slice(0, 10) ?? "—";
        const validity = m.validTo ? `<small>expired ${m.validTo.slice(0, 10)}</small>` : "";

        tableRows += `
          <tr>
            <td style="max-width:400px">${esc(preview)}</td>
            <td>${durBadge}</td>
            <td>${esc(subjectStr)}</td>
            <td>${esc(m.agentId ?? "—")}</td>
            <td>${created} ${validity}</td>
          </tr>`;
      }
    }

    const content = `
      <h1>Memory</h1>
      <p class="subtitle">${memories.length} memor${memories.length !== 1 ? "ies" : "y"} shown</p>

      <div style="margin-bottom: 20px">
        <form method="GET" action="/AdminMemory" style="display:flex;gap:8px">
          <input type="text" name="q" value="${esc(query)}" placeholder="Search memories..."
            style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:0.95em">
          <input type="text" name="subject" value="${esc(subject)}" placeholder="Subject filter"
            style="width:150px;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:0.95em">
          <button type="submit" class="btn btn-primary">Search</button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Content</th>
            <th>Durability</th>
            <th>Subject</th>
            <th>Agent</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;

    return htmlResponse(layout("Memory", content, "memory"));
  }
}
