/**
 * idp.ts — `flair idp` command group (flair#1626 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration (add / list / remove / test) and its action
 * handlers. Shared CLI helpers (api, resolveOpsPort) stay in cli.ts and are
 * bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import * as render from "../render.js";
import { resolveAdminUser } from "../lib/auth-resolve.js";

export type IdpCli = {
  api: (...args: any[]) => Promise<any>;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
};

let cli: IdpCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: IdpCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}

/** Register the `flair idp` command group. */
export function register(program: Command): void {
  // ─── flair idp ───────────────────────────────────────────────────────────────
  // XAA Enterprise IdP configuration (per FLAIR-XAA spec § 4).

  const idp = program.command("idp").description("Manage enterprise IdP configurations (XAA)");

  idp
    .command("add")
    .description("Register a trusted enterprise IdP")
    .requiredOption("--name <name>", "Display name (e.g., 'Harper Corporate')")
    .requiredOption("--issuer <url>", "IdP issuer URL (e.g., https://accounts.google.com)")
    .requiredOption("--jwks-uri <url>", "JWKS endpoint URL")
    .requiredOption("--client-id <id>", "Flair's client_id at this IdP")
    .option("--required-domain <domain>", "Reject tokens without this domain (hd/tid claim)")
    .option("--no-jit-provision", "Disable auto-creation of principals for new IdP users")
    .option("--default-trust <tier>", "Trust tier for JIT principals", "unverified")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .action(async (opts) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
        process.exit(1);
      }

      const id = `idp_${randomUUID().slice(0, 8)}`;
      const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
      const now = new Date().toISOString();

      const record = {
        id,
        name: opts.name,
        issuer: opts.issuer,
        jwksUri: opts.jwksUri,
        clientId: opts.clientId,
        requiredDomain: opts.requiredDomain ?? null,
        jitProvision: opts.jitProvision !== false,
        defaultTrustTier: opts.defaultTrust ?? "unverified",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ operation: "upsert", database: "flair", table: "IdpConfig", records: [record] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }

      console.log(`✅ IdP '${opts.name}' registered (id: ${id})`);
      console.log(`   Issuer:   ${opts.issuer}`);
      console.log(`   JWKS:     ${opts.jwksUri}`);
      console.log(`   Client:   ${opts.clientId}`);
      if (opts.requiredDomain) console.log(`   Domain:   ${opts.requiredDomain}`);
      console.log(`   JIT:      ${opts.jitProvision !== false}`);
    });

  idp
    .command("list")
    .description("List configured IdPs")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error(`${render.icons.error} --admin-pass or FLAIR_ADMIN_PASS required`);
        process.exit(1);
      }

      const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          operation: "search_by_value",
          schema: "flair",
          table: "IdpConfig",
          search_attribute: "id",
          search_type: "starts_with",
          search_value: "",
          get_attributes: ["id", "name", "issuer", "requiredDomain", "jitProvision", "enabled", "createdAt"],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`${render.icons.error} ${res.status} ${text}`);
        process.exit(1);
      }

      const records = await res.json() as any[];
      records.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(records));
        return;
      }
      if (records.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no IdPs configured")}`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(records.length))} IdP${records.length === 1 ? "" : "s"}\n`);
      for (const r of records) {
        const enabled = r.enabled ? render.wrap(render.c.green, "enabled") : render.wrap(render.c.dim, "disabled");
        console.log(`${render.wrap(render.c.bold, r.name ?? "?")}  ${render.wrap(render.c.dim, `(${r.id})`)}  ${render.wrap(render.c.dim, "—")}  ${enabled}`);
        console.log(render.kv("issuer", String(r.issuer ?? "—")));
        if (r.requiredDomain) console.log(render.kv("domain", String(r.requiredDomain)));
        console.log(render.kv("JIT", String(r.jitProvision ?? true)));
        console.log();
      }
    });

  idp
    .command("remove <id>")
    .description("Remove an IdP configuration")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .action(async (id: string, opts) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
        process.exit(1);
      }

      const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ operation: "delete", database: "flair", table: "IdpConfig", hash_values: [id] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }

      console.log(`✅ IdP '${id}' removed`);
    });

  idp
    .command("test <id>")
    .description("Test IdP connectivity (fetches JWKS)")
    .option("--admin-pass <pass>", "Admin password")
    .option("--ops-port <port>", "Harper operations API port")
    .action(async (id: string, opts) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
        process.exit(1);
      }

      let cfg: any;
      try {
        cfg = await api("GET", `/IdpConfig/${id}`);
      } catch {
        console.error(`IdP '${id}' not found`);
        process.exit(1);
      }
      console.log(`Testing IdP: ${cfg.name} (${cfg.issuer})`);
      console.log(`  JWKS endpoint: ${cfg.jwksUri}`);

      try {
        const jwksRes = await fetch(cfg.jwksUri, { signal: AbortSignal.timeout(10_000) });
        if (!jwksRes.ok) {
          console.error(`  ❌ JWKS fetch failed: HTTP ${jwksRes.status}`);
          process.exit(1);
        }
        const jwks = await jwksRes.json() as any;
        const keyCount = jwks.keys?.length ?? 0;
        console.log(`  ✅ JWKS reachable — ${keyCount} key(s) found`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ JWKS fetch error: ${message}`);
        process.exit(1);
      }
    });
}
