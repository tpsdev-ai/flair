import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse, esc } from "./layout.js";

/**
 * GET /AdminIdp — enterprise IdP configuration management.
 */
export class AdminIdp extends Resource {
  async get() {
    const idps: any[] = [];

    try {
      for await (const cfg of (databases as any).flair.IdpConfig.search()) {
        idps.push(cfg);
      }
    } catch { /* table may not exist */ }

    let tableRows = "";
    if (idps.length === 0) {
      tableRows = `<tr><td colspan="5" class="empty">No IdPs configured. Use <code>flair idp add</code> to register an enterprise IdP.</td></tr>`;
    } else {
      for (const cfg of idps) {
        const status = cfg.enabled
          ? `<span class="badge badge-green">enabled</span>`
          : `<span class="badge badge-gray">disabled</span>`;
        const jit = cfg.jitProvision ? "yes" : "no";
        const domain = cfg.requiredDomain ?? "—";

        tableRows += `
          <tr>
            <td><strong>${esc(cfg.name)}</strong><br><small>${esc(cfg.id)}</small></td>
            <td>${esc(cfg.issuer)}</td>
            <td>${esc(domain)}</td>
            <td>${jit}</td>
            <td>${status}</td>
          </tr>`;
      }
    }

    const content = `
      <h1>Enterprise IdP</h1>
      <p class="subtitle">Identity providers for XAA (Enterprise-Managed Authorization)</p>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Issuer</th>
            <th>Domain</th>
            <th>JIT</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    `;

    return htmlResponse(layout("IdP", content, "idp"));
  }
}
