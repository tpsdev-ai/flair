import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse, esc } from "./admin-layout.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

/**
 * GET /AdminMemory                browse + search memories (list view)
 * GET /AdminMemory?id=<id>        per-memory detail view with full provenance pane
 *
 * Provenance pane surfaces:
 *   - Identity: id, agentId, subject, contentHash
 *   - Tags (with source:* / import:* highlighted as origin chips)
 *   - Lineage: derivedFrom, parentId, supersedes (+ reverse: what supersedes this)
 *   - Federation: _originatorInstanceId, _syncedFrom, _syncedAt — set by
 *     Federation sync write path (resources/Federation.ts) when a record
 *     arrives from a peer. Local-origin memories don't have these.
 *   - Lifecycle: createdAt, updatedAt, validFrom, validTo, expiresAt,
 *     archived/archivedAt/archivedBy, promotionStatus/promotedBy/promotedAt
 *   - Usage: retrievalCount, lastRetrieved
 *   - Safety: _safetyFlags
 *
 * "memory that follows the agent across orchestrators" — the provenance pane
 * makes that legible: every memory shows where it came from, what it derived
 * from, what it superseded, and which peer it synced from.
 */
export class AdminMemory extends Resource {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  async get() {
    const request = (this as any).request;
    const url = new URL(request?.url ?? "http://localhost", "http://localhost");
    const id = url.searchParams.get("id") ?? "";

    if (id) {
      return this.renderDetail(id);
    }
    return this.renderList(url);
  }

  // ─── List view ─────────────────────────────────────────────────────────────

  async renderList(url: URL) {
    const query = url.searchParams.get("q") ?? "";
    const subject = url.searchParams.get("subject") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const memories: any[] = [];

    try {
      const conditions: any[] = [];
      if (subject) {
        conditions.push({ attribute: "subject", comparator: "equals", value: subject.toLowerCase() });
      }

      // Note: Harper's `not_equal true` predicate doesn't match rows where
      // `archived` is `false` *or* unset — boolean comparators behave
      // unevenly across boolean / undefined / null storage states. We skip
      // archived rows in the JS-side filter loop below instead, so the list
      // view actually returns non-archived memories rather than zero.
      const searchQuery: any = conditions.length > 0 ? { conditions } : {};
      let count = 0;

      for await (const m of (databases as any).flair.Memory.search(searchQuery)) {
        if (m.archived === true) continue;
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
      tableRows = `<tr><td colspan="6" class="empty">No memories found${query ? ` matching "${query}"` : ""}.</td></tr>`;
    } else {
      for (const m of memories) {
        const preview = (m.content || "").slice(0, 100) + ((m.content || "").length > 100 ? "…" : "");
        const durability = m.durability ?? "standard";
        const durBadge = durability === "permanent"
          ? `<span class="badge badge-green">${durability}</span>`
          : durability === "persistent"
            ? `<span class="badge badge-blue">${durability}</span>`
            : `<span class="badge badge-gray">${durability}</span>`;
        const subjectStr = m.subject ?? "—";
        const created = m.createdAt?.slice(0, 10) ?? "—";
        const validity = m.validTo ? `<small>expired ${m.validTo.slice(0, 10)}</small>` : "";

        // Surface a small "origin" hint in the list — the source:* tag if
        // present, otherwise blank. Full provenance lives on the detail view.
        const sourceTag = (m.tags ?? []).find((t: string) => t.startsWith("source:"));
        const origin = sourceTag
          ? `<span class="badge badge-yellow">${esc(sourceTag.replace("source:", ""))}</span>`
          : "—";

        tableRows += `
          <tr>
            <td style="max-width:380px"><a href="/AdminMemory?id=${esc(m.id)}" style="color:#2563eb;text-decoration:none">${esc(preview)}</a></td>
            <td>${durBadge}</td>
            <td>${esc(subjectStr)}</td>
            <td>${origin}</td>
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
            <th>Origin</th>
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

  // ─── Detail view ───────────────────────────────────────────────────────────

  async renderDetail(id: string) {
    const memDb = (databases as any).flair.Memory;

    let memory: any = null;
    try {
      memory = await memDb.get(id);
    } catch { /* table missing or other error */ }

    if (!memory) {
      const notFound = `
        <h1>Memory not found</h1>
        <p class="subtitle">No memory with id <code>${esc(id)}</code>.</p>
        <p><a href="/AdminMemory" class="btn btn-primary">Back to memory list</a></p>
      `;
      return htmlResponse(layout("Memory not found", notFound, "memory"));
    }

    // Lookup memories that supersede this one (reverse of supersedes field).
    const supersededBy: any[] = [];
    try {
      for await (const m of memDb.search({ conditions: [{ attribute: "supersedes", comparator: "equals", value: id }] })) {
        supersededBy.push(m);
        if (supersededBy.length >= 5) break;
      }
    } catch { /* swallow */ }

    // Reverse-lookup: memories whose derivedFrom contains this id.
    // Note: derivedFrom is an array; Harper's contains-on-array search via
    // search_by_value is used here. If unavailable, leave empty.
    const derivatives: any[] = [];
    try {
      for await (const m of memDb.search({ conditions: [{ attribute: "derivedFrom", comparator: "contains", value: id }] })) {
        derivatives.push(m);
        if (derivatives.length >= 5) break;
      }
    } catch { /* swallow */ }

    const content = this.renderProvenancePane(memory, supersededBy, derivatives);
    return htmlResponse(layout(`Memory ${id.slice(0, 8)}…`, content, "memory"));
  }

  // ─── Federation provenance card ────────────────────────────────────────────

  /**
   * Surface the federation-write fields stamped by resources/Federation.ts
   * (lines 392–394) when a record arrived from a peer. Local-origin
   * memories don't have these fields set; we render an explicit
   * "local origin" note in that case so the absence is legible.
   */
  renderFederationInfo(m: any): string {
    const orig = m._originatorInstanceId;
    const from = m._syncedFrom;
    const at = m._syncedAt;

    if (!orig && !from && !at) {
      return "<em style='color:#888'>local origin — not synced from a peer</em>";
    }

    const rows: string[] = [];
    if (orig) {
      rows.push(`<dt style="color:#666">Originator instance</dt><dd><code>${esc(orig)}</code></dd>`);
    }
    if (from && from !== orig) {
      // syncedFrom and originator differ when a hub relayed from a third spoke
      rows.push(`<dt style="color:#666">Synced from peer</dt><dd><code>${esc(from)}</code> <small style="color:#888">(relayed)</small></dd>`);
    } else if (from) {
      rows.push(`<dt style="color:#666">Synced from peer</dt><dd><code>${esc(from)}</code></dd>`);
    }
    if (at) {
      rows.push(`<dt style="color:#666">Synced at</dt><dd>${esc(at)}</dd>`);
    }

    return `<dl style="display:grid;grid-template-columns:200px 1fr;gap:8px;margin-top:8px">
      ${rows.join("\n      ")}
    </dl>`;
  }

  // ─── Provenance pane HTML ──────────────────────────────────────────────────

  renderProvenancePane(m: any, supersededBy: any[], derivatives: any[]): string {
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    const sourceTag = tags.find((t) => t.startsWith("source:"));
    const importTag = tags.find((t) => t.startsWith("import:"));
    const otherTags = tags.filter((t) => !t.startsWith("source:") && !t.startsWith("import:"));

    const tagChips = [
      sourceTag ? `<span class="badge badge-yellow" title="origin">${esc(sourceTag)}</span>` : "",
      importTag ? `<span class="badge badge-blue" title="import path">${esc(importTag)}</span>` : "",
      ...otherTags.map((t) => `<span class="badge badge-gray">${esc(t)}</span>`),
    ].filter(Boolean).join(" ");

    // Lineage links (derivedFrom + parentId + supersedes pointers)
    const derivedFrom: string[] = Array.isArray(m.derivedFrom) ? m.derivedFrom : [];
    const derivedFromLinks = derivedFrom.length > 0
      ? derivedFrom.map((d) => `<a href="/AdminMemory?id=${esc(d)}" style="color:#2563eb">${esc(d.slice(0, 12))}…</a>`).join(", ")
      : "<em style='color:#888'>none</em>";

    const parentLink = m.parentId
      ? `<a href="/AdminMemory?id=${esc(m.parentId)}" style="color:#2563eb">${esc(m.parentId.slice(0, 12))}…</a>`
      : "<em style='color:#888'>none</em>";

    const supersedesLink = m.supersedes
      ? `<a href="/AdminMemory?id=${esc(m.supersedes)}" style="color:#2563eb">${esc(m.supersedes.slice(0, 12))}…</a>`
      : "<em style='color:#888'>nothing — this is an original</em>";

    const supersededByLinks = supersededBy.length > 0
      ? supersededBy.map((s) => `<a href="/AdminMemory?id=${esc(s.id)}" style="color:#2563eb">${esc(s.id.slice(0, 12))}…</a>`).join(", ")
      : "<em style='color:#888'>nothing — this is current</em>";

    const derivativesLinks = derivatives.length > 0
      ? derivatives.map((d) => `<a href="/AdminMemory?id=${esc(d.id)}" style="color:#2563eb">${esc(d.id.slice(0, 12))}…</a>`).join(", ")
      : "<em style='color:#888'>none</em>";

    // Promotion details (if promoted)
    const promotionInfo = m.promotionStatus
      ? `<dl style="display:grid;grid-template-columns:140px 1fr;gap:8px;margin-top:8px">
           <dt style="color:#666">Status</dt><dd>${esc(m.promotionStatus)}</dd>
           ${m.promotedAt ? `<dt style="color:#666">Promoted at</dt><dd>${esc(m.promotedAt)}</dd>` : ""}
           ${m.promotedBy ? `<dt style="color:#666">Promoted by</dt><dd>${esc(m.promotedBy)}</dd>` : ""}
         </dl>`
      : "<em style='color:#888'>not promoted</em>";

    // Archive details
    const archiveInfo = m.archived
      ? `<dl style="display:grid;grid-template-columns:140px 1fr;gap:8px;margin-top:8px">
           <dt style="color:#666">Archived at</dt><dd>${esc(m.archivedAt ?? "—")}</dd>
           <dt style="color:#666">Archived by</dt><dd>${esc(m.archivedBy ?? "—")}</dd>
         </dl>`
      : "<em style='color:#888'>active</em>";

    const safetyFlags: string[] = Array.isArray(m._safetyFlags) ? m._safetyFlags : [];
    const safetyDisplay = safetyFlags.length > 0
      ? safetyFlags.map((f) => `<span class="badge badge-yellow">${esc(f)}</span>`).join(" ")
      : "<em style='color:#888'>clean</em>";

    return `
      <div style="margin-bottom:16px">
        <a href="/AdminMemory" style="color:#666;text-decoration:none;font-size:0.9em">← Back to memory list</a>
      </div>

      <h1>Memory ${esc(m.id.slice(0, 8))}…</h1>
      <p class="subtitle">
        agentId: <code>${esc(m.agentId ?? "—")}</code> ·
        subject: ${m.subject ? `<code>${esc(m.subject)}</code>` : "—"}
      </p>

      <div class="card">
        <h3>Content</h3>
        <p style="white-space:pre-wrap;font-family:ui-monospace,SF Mono,monospace;font-size:0.95em;line-height:1.5;margin-top:8px">${esc(m.content ?? "")}</p>
        ${m.summary ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee"><strong style="color:#666;font-size:0.85em">SUMMARY</strong><p style="margin-top:4px">${esc(m.summary)}</p></div>` : ""}
      </div>

      <div class="card">
        <h3>Tags</h3>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          ${tagChips || "<em style='color:#888'>untagged</em>"}
        </div>
      </div>

      <div class="card">
        <h3>Lineage</h3>
        <dl style="display:grid;grid-template-columns:200px 1fr;gap:10px;margin-top:8px">
          <dt style="color:#666">Derived from</dt><dd>${derivedFromLinks}</dd>
          <dt style="color:#666">Parent</dt><dd>${parentLink}</dd>
          <dt style="color:#666">Supersedes</dt><dd>${supersedesLink}</dd>
          <dt style="color:#666">Superseded by</dt><dd>${supersededByLinks}</dd>
          <dt style="color:#666">Derivatives (downstream)</dt><dd>${derivativesLinks}</dd>
          ${m.sessionId ? `<dt style="color:#666">Session</dt><dd><code>${esc(m.sessionId)}</code></dd>` : ""}
        </dl>
      </div>

      <div class="card">
        <h3>Lifecycle</h3>
        <dl style="display:grid;grid-template-columns:200px 1fr;gap:10px;margin-top:8px">
          <dt style="color:#666">Durability</dt><dd>${esc(m.durability ?? "standard")}</dd>
          <dt style="color:#666">Created</dt><dd>${esc(m.createdAt ?? "—")}</dd>
          <dt style="color:#666">Updated</dt><dd>${esc(m.updatedAt ?? "—")}</dd>
          <dt style="color:#666">Valid from</dt><dd>${esc(m.validFrom ?? "—")}</dd>
          <dt style="color:#666">Valid to</dt><dd>${esc(m.validTo ?? "still valid")}</dd>
          <dt style="color:#666">Expires</dt><dd>${esc(m.expiresAt ?? "never")}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Federation</h3>
        ${this.renderFederationInfo(m)}
      </div>

      <div class="card">
        <h3>Promotion</h3>
        ${promotionInfo}
      </div>

      <div class="card">
        <h3>Archive</h3>
        ${archiveInfo}
      </div>

      <div class="card">
        <h3>Usage</h3>
        <dl style="display:grid;grid-template-columns:200px 1fr;gap:10px;margin-top:8px">
          <dt style="color:#666">Retrievals</dt><dd>${m.retrievalCount ?? 0}</dd>
          <dt style="color:#666">Last retrieved</dt><dd>${esc(m.lastRetrieved ?? "—")}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Safety</h3>
        ${safetyDisplay}
      </div>

      <div class="card" style="background:#f8f9fa">
        <h3 style="color:#666;font-size:0.9em">RAW IDENTITY</h3>
        <dl style="display:grid;grid-template-columns:200px 1fr;gap:6px;margin-top:8px;font-family:ui-monospace,SF Mono,monospace;font-size:0.85em">
          <dt style="color:#666">id</dt><dd>${esc(m.id)}</dd>
          <dt style="color:#666">contentHash</dt><dd>${esc(m.contentHash ?? "—")}</dd>
          <dt style="color:#666">visibility</dt><dd>${esc(m.visibility ?? "private")}</dd>
        </dl>
      </div>
    `;
  }
}
