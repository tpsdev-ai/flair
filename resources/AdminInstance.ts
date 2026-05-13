import { Resource } from "@harperfast/harper";
import { layout, htmlResponse } from "./admin-layout.js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Resolve the public URL operators reach this Flair on.
 *
 * Production deployments (Fabric, VPS-hosted, behind any reverse proxy)
 * should set `FLAIR_PUBLIC_URL` in their launchd / systemd unit. The
 * admin pane then shows the URL operators actually type — not the
 * 127.0.0.1 binding address Harper sees internally — so the Endpoints
 * table is copy-pasteable.
 *
 * Fall back to `http://127.0.0.1:${HTTP_PORT}` for local-only installs.
 */
function resolvePublicUrl(): string {
  // Explicit override wins. Production deployments (Fabric, VPS-hosted)
  // should set FLAIR_PUBLIC_URL in their launchd / systemd unit so the
  // admin pane shows the URL operators actually type, not the binding
  // address Harper sees internally. Auto-detecting from request headers
  // is brittle across reverse-proxy configurations.
  if (process.env.FLAIR_PUBLIC_URL) {
    return process.env.FLAIR_PUBLIC_URL.replace(/\/$/, "");
  }
  return `http://127.0.0.1:${process.env.HTTP_PORT ?? "19926"}`;
}

/**
 * Read the runtime package version from the bundled package.json so the
 * Instance pane shows the real version (e.g. 0.8.3) rather than "dev" —
 * `process.env.npm_package_version` is only populated inside `npm run`.
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* fall through */ }
  return process.env.npm_package_version ?? "dev";
}

/**
 * GET /AdminInstance — instance info, public key, version.
 */
export class AdminInstance extends Resource {
  async get() {
    const version = resolveVersion();
    const publicUrl = resolvePublicUrl();

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
