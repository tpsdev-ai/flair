import { Resource } from "@harperfast/harper";
import { layout, htmlResponse } from "./layout.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * GET /AdminInstance — instance info, public key, version.
 */
export class AdminInstance extends Resource {
  async get() {
    const version = process.env.npm_package_version ?? "dev";
    const httpPort = process.env.HTTP_PORT ?? "19926";
    const publicUrl = process.env.FLAIR_PUBLIC_URL ?? `http://127.0.0.1:${httpPort}`;

    // Try to read instance public key
    let publicKey = "—";
    const keyDir = join(homedir(), ".flair", "keys");
    try {
      // Look for any .pub file
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(keyDir).filter((f: string) => f.endsWith(".pub") || f.endsWith(".key"));
      if (files.length > 0) {
        publicKey = `${files.length} key(s) in ${keyDir}`;
      }
    } catch {
      publicKey = "Key directory not found";
    }

    const content = `
      <h1>Instance</h1>
      <p class="subtitle">Flair instance configuration and identity</p>

      <div class="stats">
        <div class="card">
          <h3>Version</h3>
          <div class="value" style="font-size:1.4em">${version}</div>
        </div>
        <div class="card">
          <h3>Public URL</h3>
          <div style="font-family:monospace;font-size:0.9em;word-break:break-all">${publicUrl}</div>
        </div>
      </div>

      <div class="card">
        <h3>Keys</h3>
        <p>${publicKey}</p>
        <p style="margin-top:8px;color:#666;font-size:0.9em">
          Ed25519 keys are stored in <code>${keyDir}</code>. Each principal has its own keypair.
        </p>
      </div>

      <div class="card">
        <h3>Endpoints</h3>
        <table style="box-shadow:none">
          <tr><td>API</td><td><code>${publicUrl}/</code></td></tr>
          <tr><td>MCP</td><td><code>${publicUrl}/mcp</code></td></tr>
          <tr><td>OAuth Discovery</td><td><code>${publicUrl}/OAuthMetadata</code></td></tr>
          <tr><td>OAuth Authorize</td><td><code>${publicUrl}/OAuthAuthorize</code></td></tr>
          <tr><td>OAuth Token</td><td><code>${publicUrl}/OAuthToken</code></td></tr>
          <tr><td>Admin</td><td><code>${publicUrl}/AdminDashboard</code></td></tr>
        </table>
      </div>
    `;

    return htmlResponse(layout("Instance", content, "instance"));
  }
}
