import { Resource } from "@harperfast/harper";
import { layout, htmlResponse } from "./admin-layout.js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { allowAdmin } from "./agent-auth.js";

/**
 * Resolve the public URL operators reach this Flair on.
 *
 * Production deployments (Fabric, VPS-hosted, behind any reverse proxy)
 * should set `FLAIR_PUBLIC_URL` in their launchd / systemd unit. The
 * admin pane then shows the URL operators actually type — not the
 * 127.0.0.1 binding address Harper sees internally — so the Endpoints
 * table is copy-pasteable.
 *
 * Resolution order:
 *   1. `FLAIR_PUBLIC_URL` env var (explicit override, always wins)
 *   2. Request headers (X-Forwarded-Proto + X-Forwarded-Host, or Host)
 *      — derives from how the operator actually reached the page
 *   3. `http://127.0.0.1:${HTTP_PORT}` — local-only installs fallback
 *
 * The request-header path closes the common case from flair#404:
 * remote/Fabric deployments without FLAIR_PUBLIC_URL set rendered
 * localhost URLs that operators couldn't copy-paste. Trusting the Host
 * header is correct when Harper terminates TLS directly; behind a
 * reverse proxy that doesn't set X-Forwarded-* headers correctly, the
 * operator should set FLAIR_PUBLIC_URL explicitly (which wins).
 */
function resolvePublicUrl(request?: { headers?: any }): string {
  if (process.env.FLAIR_PUBLIC_URL) {
    return process.env.FLAIR_PUBLIC_URL.replace(/\/$/, "");
  }

  // Best-effort header derivation. Harper's request.headers exposes
  // both .get(name) and .asObject (case-insensitive). Prefer X-Forwarded-*
  // when present (caller is behind a proxy that set them); fall back
  // to the direct Host header.
  const getHeader = (name: string): string | undefined => {
    const h = request?.headers;
    if (!h) return undefined;
    if (typeof h.get === "function") return h.get(name) ?? h.get(name.toLowerCase()) ?? undefined;
    if (typeof h === "object") {
      const obj = h.asObject ?? h;
      return obj[name] ?? obj[name.toLowerCase()] ?? undefined;
    }
    return undefined;
  };

  const fwdProto = getHeader("X-Forwarded-Proto");
  const fwdHost = getHeader("X-Forwarded-Host");
  const host = fwdHost ?? getHeader("Host");

  if (host && /^[\w.\-:]+$/.test(host)) {
    const scheme = fwdProto && (fwdProto === "http" || fwdProto === "https") ? fwdProto : "https";
    // If no proxy headers and host has no port, assume http for safety —
    // most production deployments are behind a proxy with X-Forwarded-Proto.
    const effectiveScheme = fwdProto ? scheme : (host.includes(":") ? "http" : scheme);
    return `${effectiveScheme}://${host}`;
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
 *
 * allowRead()=allowAdmin (ops-oox7 defense-in-depth): see Admin.ts.
 */
export class AdminInstance extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    const version = resolveVersion();
    // Pass the request through so URL resolution can derive from
    // X-Forwarded-* / Host headers when FLAIR_PUBLIC_URL isn't set.
    const ctx = (this as any).getContext?.() ?? {};
    const request = ctx.request ?? ctx;
    const publicUrl = resolvePublicUrl(request);

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
