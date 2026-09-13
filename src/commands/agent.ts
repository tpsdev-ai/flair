/**
 * agent.ts — `flair agent` command group (flair#1630 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `agent`
 * commander registration (`add`, `list`/`show`, `remove`, ...) and its action
 * handlers — including the Ed25519 keypair generation in `agent add` and the
 * interactive-removal flow in `agent remove`, both moved verbatim.
 *
 * SECURITY: this module only relocates existing identity/auth logic. It does not
 * add or alter any registration, signing, key-generation, or key-permission
 * behavior.
 *
 * Shared cli.ts-local helpers are injected via bindCli() so this module never
 * imports src/cli.ts (avoids the import cycle and keeps it inside the strict
 * tsconfig.check.src.json set).
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import nacl from "tweetnacl";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as render from "../render.js";
import {
  readAdminPassFileSecure,
  defaultKeysDir,
  resolveLocalAdminPass,
  resolveAdminUser,
  resolveKeyPath,
  authFetch,
} from "../lib/auth-resolve.js";

export type AgentCli = {
  api: (method: string, path: string, body?: any, options?: any) => Promise<any>;
  b64url: (bytes: Uint8Array) => string;
  privKeyPath: (agentId: string, keysDir: string) => string;
  pubKeyPath: (agentId: string, keysDir: string) => string;
  shouldShowInlineSecretWarning: (
    optValue: string | undefined,
    fromEnv: boolean,
    secretFlagNames: Set<string>,
    flagName: string,
  ) => boolean;
  resolveHttpPort: (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create") => number;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  resolveEffectiveOpsUrl: (opts: { target?: string; opsTarget?: string }) => string | undefined;
  seedAgentViaOpsApi: (
    opsPortOrUrl: number | string,
    agentId: string,
    pubKeyB64url: string,
    adminUser: string,
    adminPass?: string,
  ) => Promise<void>;
  agentRecordIsAdmin: (record: any) => boolean;
};

let cli: AgentCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: AgentCli): void {
  cli = fns;
}

const api = (method: string, path: string, body?: any, options?: any): Promise<any> =>
  cli.api(method, path, body, options);
const b64url = (bytes: Uint8Array): string => cli.b64url(bytes);
const privKeyPath = (agentId: string, keysDir: string): string => cli.privKeyPath(agentId, keysDir);
const pubKeyPath = (agentId: string, keysDir: string): string => cli.pubKeyPath(agentId, keysDir);
const shouldShowInlineSecretWarning = (
  optValue: string | undefined,
  fromEnv: boolean,
  secretFlagNames: Set<string>,
  flagName: string,
): boolean => cli.shouldShowInlineSecretWarning(optValue, fromEnv, secretFlagNames, flagName);
const resolveHttpPort = (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create"): number =>
  cli.resolveHttpPort(opts, mode);
const resolveOpsPort = (opts: { opsPort?: string | number; port?: string | number }): number =>
  cli.resolveOpsPort(opts);
const resolveEffectiveOpsUrl = (opts: { target?: string; opsTarget?: string }): string | undefined =>
  cli.resolveEffectiveOpsUrl(opts);
const seedAgentViaOpsApi = (
  opsPortOrUrl: number | string,
  agentId: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass?: string,
): Promise<void> => cli.seedAgentViaOpsApi(opsPortOrUrl, agentId, pubKeyB64url, adminUser, adminPass);
const agentRecordIsAdmin = (record: any): boolean => cli.agentRecordIsAdmin(record);

/** Register the `flair agent` command group (flair#1630). */
export function register(program: Command): void {
  // ─── flair agent ─────────────────────────────────────────────────────────────

  const agent = program.command("agent").description("Manage Flair agents");

  agent
    .command("add <id>")
    .description("Register a new agent in a running Flair instance")
    .option("--name <name>", "Display name (defaults to id)")
    .option("--port <port>", "Harper HTTP port")
    .option("--admin-pass <pass>", "Admin password for registration")
    .option("--admin-pass-file <path>", "Read the admin password from a file (chmod 600 enforced). Preferred over inline --admin-pass — keeps the secret out of ps and shell history; works for remote targets too (an explicit flag is operator intent).")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--keys-dir <dir>", "Directory for Ed25519 keys")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--target <url>", "Remote Flair REST URL; derives the ops API URL (port-1) to seed the Agent there (env: FLAIR_TARGET)")
    .option("--ops-target <url>", "Explicit ops API URL to seed the Agent on (env: FLAIR_OPS_TARGET; bypasses port derivation)")
    .action(async (id: string, opts) => {
      const httpPort = resolveHttpPort(opts);
      const opsPort = resolveOpsPort(opts);
      const keysDir: string = opts.keysDir ?? defaultKeysDir();
      const adminUser = resolveAdminUser(opts.adminUser);
      const name: string = opts.name ?? id;
      // Where to seed the Agent record. Default is localhost (opsPort). When
      // --ops-target or --target is given, seed on the remote instead of localhost
      // (#514 — agent add could only ever hit localhost ops). Precedence matches
      // `flair import`: explicit --ops-target > derive from --target > localhost.
      const seedOpsTarget: number | string =
        resolveEffectiveOpsUrl({ target: opts.target, opsTarget: opts.opsTarget }) ?? opsPort;
      const isRemoteTarget = typeof seedOpsTarget === "string";

      // flair#1259 — --admin-pass-file resolves into the same explicit slot the
      // inline flag uses (same shape as `flair federation sync`), read in-process
      // via readAdminPassFileSecure so the secret never appears in ps or shell
      // history. This does NOT weaken the #1085 remote guard below: an explicit
      // flag naming a file IS operator intent toward this target, exactly like an
      // explicit inline --admin-pass — what the guard blocks is the AMBIENT
      // env/local-file fallbacks silently traveling to a third-party host.
      if (!opts.adminPass && opts.adminPassFile) {
        try {
          opts.adminPass = readAdminPassFileSecure(opts.adminPassFile);
        } catch (err: any) {
          console.error(`Error reading --admin-pass-file ${opts.adminPassFile}: ${err.message}`);
          process.exit(1);
        }
      }

      // #590 — local convenience fallback: FLAIR_ADMIN_PASS env, then the secure
      // ~/.flair/admin-pass file `flair init` already writes (mode 0600). Never
      // applied for a remote target — see resolveLocalAdminPass.
      let adminPass: string | undefined;
      try {
        adminPass = resolveLocalAdminPass(opts.adminPass, isRemoteTarget);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }

      if (!adminPass) {
        if (isRemoteTarget) {
          console.error(
            "Error: --admin-pass <pass> or --admin-pass-file <path> is required for agent add when targeting " +
            "a remote instance (--target/--ops-target) — the local ~/.flair/admin-pass and FLAIR_ADMIN_PASS " +
            "fallbacks are never used for remote targets. Prefer --admin-pass-file: it keeps the secret out of ps."
          );
        } else {
          console.error(
            "Error: --admin-pass <pass> or --admin-pass-file <path> is required for agent add (needed to insert " +
            "into Agent table). Set FLAIR_ADMIN_PASS, or make sure ~/.flair/admin-pass exists (created by `flair init`)."
          );
        }
        process.exit(1);
      }

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

      await seedAgentViaOpsApi(seedOpsTarget, id, pubKeyB64url, adminUser, adminPass);
      console.log(
        typeof seedOpsTarget === "string"
          ? `✅ Agent '${id}' (${name}) registered (ops: ${seedOpsTarget})`
          : `✅ Agent '${id}' (${name}) registered`,
      );
      console.log(`   Private key: ${privPath}`);
      console.log(`   Public key:  ${pubKeyB64url}`);
      // flair#1280 — connector legibility at provisioning time: an OAuth /mcp
      // connector resolves its own token subject to an Agent via
      // Credential(kind:idp), NOT via this key, and the two identities are
      // DISTINCT unless linked. One line here saves the "my connector memory is
      // empty" discovery later.
      console.log(
        `   Note: an OAuth /mcp connector maps its own IdP subject to an Agent (distinct from '${id}' by default).\n` +
          `   To point a connector at '${id}': flair mcp enable --principal ${id} --idp-subject <your-idp-login>`,
      );
    });

  agent
    .command("list")
    .description("List all agents")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--agent <id>", "Agent ID to authenticate as via Ed25519 (or FLAIR_AGENT_ID env) when no admin pass")
    .option("--keys-dir <dir>", "Directory holding the agent's Ed25519 key")
    .option("--port <port>", "Harper HTTP port")
    .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts) => {
      const port = resolveHttpPort(opts);
      // fromEnv is true ONLY when the resolved value came from env (no inline override).
      const adminPassFromEnv = !opts.adminPass && (!!process.env.FLAIR_ADMIN_PASS || !!process.env.HDB_ADMIN_PASSWORD);
      if (shouldShowInlineSecretWarning(opts.adminPass, adminPassFromEnv, new Set(["--admin-pass"]), "--admin-pass")) {
        console.error(
          "warning: --admin-pass passed inline. Consider --admin-pass-from <file> or FLAIR_ADMIN_PASS env " +
          "to keep secrets out of shell history."
        );
      }
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
      const mode = render.resolveOutputMode(opts);
      let agents: any[];
      if (adminPass) {
        const opsPort = resolveOpsPort(opts);
        const auth = Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64");
        // List every Agent without null-scanning the primary key. A
        // `starts_with ""` on `id` makes Harper search the index for nulls, which
        // the bundled Harper (5.0.21) rejects with "id is not indexed for nulls".
        // Use `createdAt > 1970-01-01` as the total "select all" predicate: every
        // Agent row has a non-null createdAt (schema: createdAt: String!), and its
        // index is built — same pattern as the `flair reembed` Memory scan. (#500)
        const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
          body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table: "Agent", operator: "and", conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }], get_attributes: ["id", "name", "createdAt"] }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`${render.icons.error} ${res.status} ${text}`);
          process.exit(1);
        }
        agents = await res.json() as any[];
      } else {
        // No admin pass → authenticate as the AGENT via Ed25519. The Agent table's
        // allowRead() is allowVerified — a bare unauthenticated GET /Agent returns
        // 403 AccessViolation (the dogfood symptom: the natural "did my agent
        // register?" check errored on a healthy install). A verified agent reads
        // the principal table for discovery, so sign the request with its key.
        const baseUrl = `http://127.0.0.1:${port}`;
        const agentId = opts.agent ?? process.env.FLAIR_AGENT_ID;
        const keysDir: string = opts.keysDir ?? process.env.FLAIR_KEY_DIR ?? defaultKeysDir();
        let res: Response;
        if (agentId) {
          const keyPath = resolveKeyPath(agentId) ?? join(keysDir, `${agentId}.key`);
          if (!existsSync(keyPath)) {
            console.error(`${render.icons.error} no key for agent '${agentId}' (looked in ${keysDir}). Pass --admin-pass, --keys-dir, or a registered --agent.`);
            process.exit(1);
          }
          res = await authFetch(baseUrl, agentId, keyPath, "GET", "/Agent");
        } else {
          // No agent identity available either. Try anonymously, but if it 403s
          // (the common case), tell the user exactly how to authenticate rather
          // than dumping a raw AccessViolation.
          res = await fetch(`${baseUrl}/Agent`, { headers: { "Content-Type": "application/json" } });
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 403 && !agentId) {
            console.error(`${render.icons.error} 403 — listing agents requires authentication.`);
            console.error(`   Use ${render.wrap(render.c.cyan, "--agent <id>")} (or set FLAIR_AGENT_ID) to authenticate as a registered agent,`);
            console.error(`   or ${render.wrap(render.c.cyan, "--admin-pass")} / FLAIR_ADMIN_PASS for the admin view.`);
          } else {
            console.error(`${render.icons.error} ${res.status} ${text}`);
          }
          process.exit(1);
        }
        const data = await res.json();
        agents = Array.isArray(data) ? data.map((a: any) => ({ id: a.id, name: a.name, createdAt: a.createdAt })) : [];
      }
      agents.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

      if (mode === "json") {
        console.log(render.asJSON(agents));
        return;
      }
      if (agents.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no agents")}`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(agents.length))} agents\n`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
        { label: "name", key: "name", format: (v) => String(v ?? "—") },
        { label: "created", key: "createdAt", format: (v) => render.wrap(render.c.dim, v ? String(v).slice(0, 10) : "—") },
      ];
      console.log(render.table(cols, agents as Array<Record<string, unknown>>));
    });

  agent
    .command("show <id>")
    .description("Show agent details")
    .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (id: string, opts) => {
      const out = await api("GET", `/Agent/${id}`);
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(out));
        return;
      }
      if (!out || (typeof out === "object" && !out.id)) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, `no agent ${id}`)}`);
        return;
      }
      console.log(render.wrap(render.c.bold, String(out.id)));
      if (out.name) console.log(render.kv("name", String(out.name)));
      if (out.kind) console.log(render.kv("kind", render.wrap(render.c.cyan, String(out.kind))));
      if (out.status) {
        const statusColor = out.status === "active" ? render.c.green : out.status === "disabled" ? render.c.red : render.c.yellow;
        console.log(render.kv("status", render.wrap(statusColor, String(out.status))));
      }
      if (out.defaultTrustTier) console.log(render.kv("trust tier", String(out.defaultTrustTier)));
      // flair#941 — read the authority, not the mirror. See `principal show`.
      if (agentRecordIsAdmin(out)) console.log(render.kv("admin", render.wrap(render.c.magenta, "yes")));
      if (out.runtime) console.log(render.kv("runtime", String(out.runtime)));
      if (out.publicKey) console.log(render.kv("publicKey", render.wrap(render.c.dim, String(out.publicKey))));
      if (out.createdAt) console.log(render.kv("created", `${render.relativeTime(out.createdAt)} ${render.wrap(render.c.dim, `(${out.createdAt})`)}`));
      if (out.updatedAt && out.updatedAt !== out.createdAt) {
        console.log(render.kv("updated", `${render.relativeTime(out.updatedAt)} ${render.wrap(render.c.dim, `(${out.updatedAt})`)}`));
      }
    });

  agent
    .command("rotate-key <id>")
    .description("Rotate an agent's Ed25519 keypair")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--keys-dir <dir>", "Directory for Ed25519 keys")
    .action(async (id: string, opts) => {
      const httpPort = resolveHttpPort(opts);
      const opsPort = resolveOpsPort(opts);
      // fromEnv is true ONLY when the resolved value came from env (no inline override).
      const adminPassFromEnv = !opts.adminPass && !!process.env.FLAIR_ADMIN_PASS;
      if (shouldShowInlineSecretWarning(opts.adminPass, adminPassFromEnv, new Set(["--admin-pass"]), "--admin-pass")) {
        console.error(
          "warning: --admin-pass passed inline. Consider --admin-pass-from <file> or FLAIR_ADMIN_PASS env " +
          "to keep secrets out of shell history."
        );
      }
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const adminUser = resolveAdminUser(opts.adminUser);
      const keysDir: string = opts.keysDir ?? defaultKeysDir();

      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for key rotation");
        process.exit(1);
      }

      mkdirSync(keysDir, { recursive: true });
      const currentPrivPath = privKeyPath(id, keysDir);
      const currentPubPath = pubKeyPath(id, keysDir);
      const backupPrivPath = currentPrivPath + ".bak";

      // Generate new keypair
      console.log(`Generating new keypair for agent '${id}'...`);
      const kp = nacl.sign.keyPair();
      const newSeed = kp.secretKey.slice(0, 32);
      const newPubKeyB64url = b64url(kp.publicKey);

      // Back up old key if it exists
      if (existsSync(currentPrivPath)) {
        writeFileSync(backupPrivPath, readFileSync(currentPrivPath));
        chmodSync(backupPrivPath, 0o600);
        console.log(`Old key backed up to: ${backupPrivPath}`);
      }

      // Update publicKey in Flair via operations API
      console.log(`Updating public key in Flair via operations API...`);
      const opsUrl = `http://127.0.0.1:${opsPort}/`;
      const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
      const updateBody = {
        operation: "update",
        database: "flair",
        table: "Agent",
        records: [{ id, publicKey: newPubKeyB64url, updatedAt: new Date().toISOString() }],
      };
      const updateRes = await fetch(opsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify(updateBody),
        signal: AbortSignal.timeout(10_000),
      });
      if (!updateRes.ok) {
        const text = await updateRes.text().catch(() => "");
        // Roll back: keep old key in place (don't write new key yet)
        if (existsSync(backupPrivPath)) {
          // Restore not needed — we haven't written new key yet
        }
        throw new Error(`Failed to update public key in Flair (${updateRes.status}): ${text}`);
      }
      console.log(`Public key updated in Flair ✓`);

      // Write new private key (only after Flair update succeeds)
      writeFileSync(currentPrivPath, Buffer.from(newSeed));
      chmodSync(currentPrivPath, 0o600);
      writeFileSync(currentPubPath, Buffer.from(kp.publicKey));
      console.log(`New private key written: ${currentPrivPath} ✓`);

      // Verify new key works
      console.log(`Verifying new Ed25519 auth...`);
      const httpUrl = `http://127.0.0.1:${httpPort}`;
      const verifyRes = await authFetch(httpUrl, id, currentPrivPath, "GET", `/Agent/${id}`);
      if (!verifyRes.ok) {
        console.error(`⚠️  Auth verification failed (${verifyRes.status}). Old key is backed up at: ${backupPrivPath}`);
        process.exit(1);
      }
      console.log(`Ed25519 auth verified ✓`);

      console.log(`\n✅ Key rotation complete for agent '${id}'`);
      console.log(`   New public key: ${newPubKeyB64url}`);
      console.log(`   Private key:    ${currentPrivPath}`);
      console.log(`   Old key backup: ${backupPrivPath}`);
    });

  // ─── flair agent remove ──────────────────────────────────────────────────────

  agent
    .command("remove <id>")
    .description("Remove an agent and all its data from Flair")
    .option("--keep-keys", "Do not delete key files from disk")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--keys-dir <dir>", "Directory for Ed25519 keys")
    .option("--force", "Skip interactive confirmation (required when stdin is not a TTY)")
    .action(async (id: string, opts) => {
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const adminUser = resolveAdminUser(opts.adminUser);
      const keysDir: string = opts.keysDir ?? defaultKeysDir();

      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for agent remove");
        process.exit(1);
      }

      const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

      async function opsPost(body: unknown): Promise<Response> {
        return fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      }

      // Fetch agent info and memory count for confirmation
      const agentRes = await opsPost({ operation: "search_by_value", database: "flair", table: "Agent", search_attribute: "id", search_value: id, get_attributes: ["id", "name"] });
      const agentData = agentRes.ok ? await agentRes.json().catch(() => null) : null;
      const agentName = agentData?.[0]?.name ?? id;

      const memRes = await opsPost({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "agentId", search_value: id, get_attributes: ["id"] });
      const memories = memRes.ok ? await memRes.json().catch(() => []) : [];
      const memoryCount = Array.isArray(memories) ? memories.length : 0;

      // Confirmation
      const isInteractive = process.stdin.isTTY;
      if (!opts.force) {
        if (!isInteractive) {
          console.error("Error: stdin is not a TTY. Use --force to skip confirmation.");
          process.exit(1);
        }
        console.log(`⚠️  About to permanently remove agent '${agentName}' (${id})`);
        console.log(`   Memories to delete: ${memoryCount}`);
        process.stdout.write(`\nType 'yes' to confirm: `);
        const answer = await new Promise<string>((resolve) => {
          let buf = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.resume();
          process.stdin.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("\n")) { process.stdin.pause(); resolve(buf.trim()); }
          });
        });
        if (answer !== "yes") {
          console.log("Aborted.");
          process.exit(0);
        }
      } else {
        console.log(`Removing agent '${agentName}' (${id}) with ${memoryCount} memories...`);
      }

      // Delete all memories
      if (memoryCount > 0) {
        console.log(`Deleting ${memoryCount} memories...`);
        for (const mem of (Array.isArray(memories) ? memories : [])) {
          if (!mem?.id) continue;
          await opsPost({ operation: "delete", database: "flair", table: "Memory", ids: [mem.id] }).catch(() => {});
        }
      }

      // Delete all souls
      const soulRes = await opsPost({ operation: "search_by_value", database: "flair", table: "Soul", search_attribute: "agentId", search_value: id, get_attributes: ["id"] });
      const souls = soulRes.ok ? await soulRes.json().catch(() => []) : [];
      if (Array.isArray(souls) && souls.length > 0) {
        console.log(`Deleting ${souls.length} soul entries...`);
        for (const soul of souls) {
          if (!soul?.id) continue;
          await opsPost({ operation: "delete", database: "flair", table: "Soul", ids: [soul.id] }).catch(() => {});
        }
      }

      // Delete agent record
      const delRes = await opsPost({ operation: "delete", database: "flair", table: "Agent", ids: [id] });
      if (!delRes.ok) {
        const text = await delRes.text().catch(() => "");
        throw new Error(`Failed to delete agent record (${delRes.status}): ${text}`);
      }

      // Delete key files (unless --keep-keys)
      if (!opts.keepKeys) {
        const privPath = privKeyPath(id, keysDir);
        const pubPath = pubKeyPath(id, keysDir);
        const backupPath = privPath + ".bak";
        for (const p of [privPath, pubPath, backupPath]) {
          if (existsSync(p)) {
            try { const { unlinkSync: ul } = await import("node:fs"); ul(p); } catch { /* best effort */ }
          }
        }
        console.log("Key files deleted.");
      } else {
        console.log("Key files preserved (--keep-keys).");
      }

      console.log(`\n✅ Agent '${id}' removed successfully`);
    });
}
