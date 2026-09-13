/**
 * principal.ts — `flair principal` command group (flair#1632 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `principal`
 * commander registration and its `add` / `list` / `show` / `disable` /
 * `promote` handlers (1.0 identity management; Principal extends Agent).
 *
 * SECURITY: multi-tenant / ownership scoping, admin-role checks, and the
 * ops-API trust-tier writes are moved verbatim. No auth, scope, or
 * admin-classification logic was altered.
 *
 * ADMIN_ROLE / agentRecordIsAdmin live here because the flair#941 authority
 * model is defined by principal/admin identity. agentRecordIsAdmin is exported
 * so src/cli.ts can re-export it to the already-extracted agent module.
 *
 * Shared cli.ts-local helpers are injected via bindCli() so this module never
 * imports src/cli.ts (avoids the import cycle and keeps it inside the strict
 * tsconfig.check.src.json set).
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import nacl from "tweetnacl";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import * as render from "../render.js";
import {
  defaultKeysDir,
  resolveLocalAdminPass,
  resolveAdminUser,
} from "../lib/auth-resolve.js";

export type PrincipalCli = {
  api: (method: string, path: string, body?: any, options?: any) => Promise<any>;
  b64url: (bytes: Uint8Array) => string;
  privKeyPath: (agentId: string, keysDir: string) => string;
  pubKeyPath: (agentId: string, keysDir: string) => string;
  relativeTime: (iso: string | null | undefined) => string;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
};

let cli: PrincipalCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: PrincipalCli): void {
  cli = fns;
}

const api = (method: string, path: string, body?: any, options?: any): Promise<any> =>
  cli.api(method, path, body, options);
const b64url = (bytes: Uint8Array): string => cli.b64url(bytes);
const privKeyPath = (agentId: string, keysDir: string): string => cli.privKeyPath(agentId, keysDir);
const pubKeyPath = (agentId: string, keysDir: string): string => cli.pubKeyPath(agentId, keysDir);
const relativeTime = (iso: string | null | undefined): string => cli.relativeTime(iso);
const resolveOpsPort = (opts: { opsPort?: string | number; port?: string | number }): number =>
  cli.resolveOpsPort(opts);

// ─── flair principal ─────────────────────────────────────────────────────────
// 1.0 identity management. The Principal model extends Agent — this is the
// preferred CLI surface for managing identities going forward.

/**
 * The exact `role` value that denotes a flair administrator, and the predicate
 * that reads it.
 *
 * DUPLICATED FROM resources/agent-admin.ts on purpose — the same deliberate
 * copy as the federation crypto helpers above: src/cli.ts must not import from
 * resources/, because those imports don't survive npm packaging. The two must
 * stay in sync.
 *
 * flair#941: `role` is the authority and `admin` is its mirror. The CLI used to
 * both write and display ONLY the mirror, so `principal add --admin` created a
 * principal the gate refuses and `principal show` printed "admin: yes" for it.
 */
const ADMIN_ROLE = "admin";
export function agentRecordIsAdmin(record: any): boolean {
  return record?.role === ADMIN_ROLE;
}

/** Register the `flair principal` command group (flair#1632). */
export function register(program: Command): void {

  const principal = program.command("principal").description("Manage principals (humans and agents)");

  principal
    .command("add <id>")
    .description("Create a new principal")
    .option("--kind <kind>", "Principal kind: human or agent", "agent")
    .option("--name <name>", "Display name (defaults to id)")
    .option("--admin", "Grant admin privileges")
    .option("--trust <tier>", "Default trust tier: endorsed, corroborated, or unverified")
    .option("--runtime <runtime>", "Runtime: openclaw, claude-code, headless, external")
    .option("--port <port>", "Harper HTTP port")
    .option("--admin-pass <pass>", "Admin password for registration")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--keys-dir <dir>", "Directory for Ed25519 keys")
    .option("--ops-port <port>", "Harper operations API port")
    .action(async (id: string, opts) => {
      const opsPort = resolveOpsPort(opts);
      const keysDir: string = opts.keysDir ?? defaultKeysDir();
      const adminUser = resolveAdminUser(opts.adminUser);
      const kind: string = opts.kind ?? "agent";
      const name: string = opts.name ?? id;
      const isAdmin: boolean = opts.admin ?? false;
      const trustTier: string = opts.trust ?? (isAdmin ? "endorsed" : "unverified");
      const runtime: string | undefined = opts.runtime;

      // #590 — same local-only fallback as `agent add`: FLAIR_ADMIN_PASS env, then
      // the secure ~/.flair/admin-pass file (mode 0600). `principal add` has no
      // --target/--ops-target (always localhost), so the fallback always applies.
      let adminPass: string | undefined;
      try {
        adminPass = resolveLocalAdminPass(opts.adminPass);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }

      if (!adminPass) {
        console.error(
          "Error: --admin-pass or FLAIR_ADMIN_PASS required (or ensure ~/.flair/admin-pass exists, " +
          "created by `flair init`)"
        );
        process.exit(1);
      }

      // Generate Ed25519 keypair (agents always get one; humans get one for instance-attestation)
      mkdirSync(keysDir, { recursive: true });
      const privPath = privKeyPath(id, keysDir);
      const pubPath = pubKeyPath(id, keysDir);
      let pubKeyB64url: string;

      if (existsSync(privPath)) {
        console.log(`Reusing existing key: ${privPath}`);
        const seed = new Uint8Array(readFileSync(privPath));
        const kp = nacl.sign.keyPair.fromSeed(seed);
        pubKeyB64url = b64url(kp.publicKey);
      } else {
        const kp = nacl.sign.keyPair();
        const seed = kp.secretKey.slice(0, 32);
        writeFileSync(privPath, Buffer.from(seed));
        chmodSync(privPath, 0o600);
        writeFileSync(pubPath, Buffer.from(kp.publicKey));
        pubKeyB64url = b64url(kp.publicKey);
        console.log(`Keypair written: ${privPath}`);
      }

      // Insert via operations API with Principal fields
      const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
      const record = {
        id,
        name,
        displayName: name,
        kind,
        type: kind === "human" ? "human" : "agent",
        status: "active",
        publicKey: pubKeyB64url,
        defaultTrustTier: trustTier,
        // flair#941 — write BOTH. This is an ops-API upsert, so the Agent
        // resource's reconciliation never runs; writing only the `admin` mirror
        // is what made `--admin` a no-op at the gate for every principal this
        // command has ever created.
        role: isAdmin ? ADMIN_ROLE : "agent",
        admin: isAdmin,
        runtime: runtime ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ operation: "upsert", database: "flair", table: "Agent", records: [record] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }

      console.log(`✅ Principal '${id}' created`);
      console.log(`   Kind:       ${kind}`);
      console.log(`   Trust:      ${trustTier}`);
      console.log(`   Admin:      ${isAdmin}`);
      if (runtime) console.log(`   Runtime:    ${runtime}`);
      console.log(`   Public key: ${pubKeyB64url}`);
      console.log(`   Private key: ${privPath}`);
    });

  principal
    .command("list")
    .description("List all principals")
    .option("--kind <kind>", "Filter by kind: human or agent")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--port <port>", "Harper HTTP port")
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
      const conditions = opts.kind
        ? [{ search_attribute: "kind", search_type: "equals", search_value: opts.kind }]
        : [{ search_attribute: "id", search_type: "starts_with", search_value: "" }];
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          operation: "search_by_conditions",
          schema: "flair",
          table: "Agent",
          operator: "and",
          conditions,
          // `role` is the authority behind admin status (flair#941); the
          // projection used to omit it, so this listing could only ever report
          // the mirror.
          get_attributes: ["id", "name", "kind", "status", "defaultTrustTier", "role", "admin", "runtime", "createdAt"],
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
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no principals")}`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(records.length))} principals${opts.kind ? ` ${render.wrap(render.c.dim, `(kind=${opts.kind})`)}` : ""}\n`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
        {
          label: "kind",
          key: "kind",
          format: (v) => {
            const k = String(v ?? "agent");
            return render.wrap(k === "human" ? render.c.cyan : render.c.magenta, k);
          },
        },
        { label: "trust", key: "defaultTrustTier", format: (v) => String(v ?? "—") },
        {
          label: "admin",
          key: "admin",
          // Report the status the gate will apply, and flag a record whose two
          // fields disagree rather than picking a side silently (flair#941).
          format: (_v, row) => {
            const isAdmin = agentRecordIsAdmin(row);
            const mismatch = isAdmin !== (row.admin === true);
            const base = isAdmin ? render.wrap(render.c.red, "yes") : render.wrap(render.c.dim, "no");
            return mismatch ? `${base} ${render.wrap(render.c.yellow, "(!)")}` : base;
          },
        },
        {
          label: "status",
          key: "status",
          format: (v) => {
            const s = String(v ?? "active");
            const color = s === "active" ? render.c.green : s === "disabled" ? render.c.red : render.c.yellow;
            return render.wrap(color, s);
          },
        },
        { label: "runtime", key: "runtime", format: (v) => String(v ?? "—") },
        { label: "created", key: "createdAt", format: (v) => render.wrap(render.c.dim, v ? String(v).slice(0, 10) : "—") },
      ];
      console.log(render.table(cols, records as Array<Record<string, unknown>>));
    });

  principal
    .command("show <id>")
    .description("Show principal details")
    .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (id: string, opts) => {
      const result = await api("GET", `/Agent/${id}`);
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(result));
        return;
      }
      if (!result || (typeof result === "object" && !result.id)) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, `no principal ${id}`)}`);
        return;
      }
      console.log(render.wrap(render.c.bold, String(result.id)));
      if (result.name) console.log(render.kv("name", String(result.name)));
      if (result.kind) console.log(render.kv("kind", render.wrap(result.kind === "human" ? render.c.cyan : render.c.magenta, String(result.kind))));
      if (result.status) {
        const statusColor = result.status === "active" ? render.c.green : result.status === "disabled" ? render.c.red : render.c.yellow;
        console.log(render.kv("status", render.wrap(statusColor, String(result.status))));
      }
      if (result.defaultTrustTier) console.log(render.kv("trust tier", String(result.defaultTrustTier)));
      // flair#941 — read the authority, not the mirror, and say so when the two
      // disagree (only reachable via a raw table write).
      if (agentRecordIsAdmin(result)) console.log(render.kv("admin", render.wrap(render.c.red, "yes")));
      if (agentRecordIsAdmin(result) !== (result.admin === true)) {
        console.log(render.kv("admin", render.wrap(render.c.yellow, `record is inconsistent (role=${result.role ?? "unset"}, admin=${result.admin ?? "unset"}) — re-issue the grant to repair`)));
      }
      if (result.runtime) console.log(render.kv("runtime", String(result.runtime)));
      if (result.email) console.log(render.kv("email", String(result.email)));
      if (result.publicKey) console.log(render.kv("publicKey", render.wrap(render.c.dim, String(result.publicKey))));
      if (result.createdAt) console.log(render.kv("created", `${render.relativeTime(result.createdAt)} ${render.wrap(render.c.dim, `(${result.createdAt})`)}`));
      if (result.updatedAt && result.updatedAt !== result.createdAt) {
        console.log(render.kv("updated", `${render.relativeTime(result.updatedAt)} ${render.wrap(render.c.dim, `(${result.updatedAt})`)}`));
      }
    });

  principal
    .command("disable <id>")
    .description("Deactivate a principal (revokes access, preserves data)")
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
        body: JSON.stringify({
          operation: "update",
          database: "flair",
          table: "Agent",
          records: [{ id, status: "deactivated", updatedAt: new Date().toISOString() }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }

      console.log(`✅ Principal '${id}' deactivated`);
    });

  principal
    .command("promote <id> <tier>")
    .description("Change a principal's trust tier (endorsed, corroborated, unverified)")
    .option("--admin-pass <pass>", "Admin password")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--ops-port <port>", "Harper operations API port")
    .action(async (id: string, tier: string, opts) => {
      const validTiers = ["endorsed", "corroborated", "unverified"];
      if (!validTiers.includes(tier)) {
        console.error(`Error: tier must be one of: ${validTiers.join(", ")}`);
        process.exit(1);
      }

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
        body: JSON.stringify({
          operation: "update",
          database: "flair",
          table: "Agent",
          records: [{ id, defaultTrustTier: tier, updatedAt: new Date().toISOString() }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }

      console.log(`✅ Principal '${id}' trust tier set to '${tier}'`);
    });
}
