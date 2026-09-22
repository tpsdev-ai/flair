/**
 * init.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair init` (first-run provisioning: config, admin pass, launchd service, soul wizard).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { applyOrReportClaudeMdBootstrap, applyOrReportSessionStartHook } from "../doctor-client.js";
import { hookSettingsPath } from "../hook-install.js";
import { ClientId, detectClients, renderWiringSummary, wireAntigravity, wireCodex, wireCursor, wireGemini, wirePi } from "../install/clients.js";
import { DEFAULT_ADMIN_USER, authFetch, defaultAdminPassPath, defaultKeysDir, readAdminPassFileSecure, resolveAdminUser } from "../lib/auth-resolve.js";
import {
  detectPersistedAdminUser,
  executeAdminPasswordRotate,
  initAdminPassRefusalMessage,
  resolveInitAdminPasswordRefuseReason,
  resolveInitAdminPasswordSource,
} from "../lib/init-admin-pass.js";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec, unpinnedSpecWarning } from "../lib/mcp-spec.js";
import { decidePinWrite } from "../lib/pin-write-guard.js";
import * as render from "../render.js";
import { execSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { httpCorsAccessList } from "../lib/http-bind.js";

export type InitCli = {
  api: (...args: any[]) => any;
  b64url: (...args: any[]) => any;
  buildOperationsApiConfig: (...args: any[]) => any;
  cleanupLegacyLaunchdPlist: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  defaultLaunchAgentsDir: (...args: any[]) => any;
  ensureFlairAgentRole: (...args: any[]) => any;
  ensureFlairAgentUser: (...args: any[]) => any;
  ensureFlairPairInitiatorRole: (...args: any[]) => any;
  flairPackageDir: (...args: any[]) => any;
  harperBin: (...args: any[]) => any;
  harperConfigPath: (...args: any[]) => any;
  launchdLabel: (...args: any[]) => any;
  launchdPlistPath: (...args: any[]) => any;
  opsNetworkPortValue: (...args: any[]) => any;
  persistDefaultInstallCoordinates: (...args: any[]) => any;
  privKeyPath: (...args: any[]) => any;
  provisionFabric: (...args: any[]) => any;
  pubKeyPath: (...args: any[]) => any;
  readyOpsSocketPosture: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  writeAdminPassFile: (...args: any[]) => any;
  resolveOpsBindHost: (...args: any[]) => any;
  resolveHttpBindFor: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
  resolveOpsTarget: (...args: any[]) => any;
  resolveOpsUrlFromTarget: (...args: any[]) => any;
  resolveTarget: (...args: any[]) => any;
  runSoulWizard: (...args: any[]) => any;
  seedAgentViaOpsApi: (...args: any[]) => any;
  seedFederationInstanceViaOpsApi: (...args: any[]) => any;
  shouldShowInlineSecretWarning: (...args: any[]) => any;
  verifyAuditLog: (...args: any[]) => any;
  verifySemanticSearch: (...args: any[]) => any;
  waitForHealth: (...args: any[]) => any;
  writeDaemonSidecar: (...args: any[]) => any;
  writeInitLaunchdPlist: (...args: any[]) => any;
  MQTT_DISABLED_CONFIG: any;
  STARTUP_TIMEOUT_MS: any;
};

let cli: InitCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: InitCli): void {
  cli = fns;
}

function api(...args: any[]): any {
  return cli.api(...args);
}

function b64url(...args: any[]): any {
  return cli.b64url(...args);
}

function buildOperationsApiConfig(...args: any[]): any {
  return cli.buildOperationsApiConfig(...args);
}

function cleanupLegacyLaunchdPlist(...args: any[]): any {
  return cli.cleanupLegacyLaunchdPlist(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function defaultLaunchAgentsDir(...args: any[]): any {
  return cli.defaultLaunchAgentsDir(...args);
}

function ensureFlairAgentRole(...args: any[]): any {
  return cli.ensureFlairAgentRole(...args);
}

function ensureFlairAgentUser(...args: any[]): any {
  return cli.ensureFlairAgentUser(...args);
}

function ensureFlairPairInitiatorRole(...args: any[]): any {
  return cli.ensureFlairPairInitiatorRole(...args);
}

function flairPackageDir(...args: any[]): any {
  return cli.flairPackageDir(...args);
}

function harperBin(...args: any[]): any {
  return cli.harperBin(...args);
}

function harperConfigPath(...args: any[]): any {
  return cli.harperConfigPath(...args);
}

function launchdLabel(...args: any[]): any {
  return cli.launchdLabel(...args);
}

function launchdPlistPath(...args: any[]): any {
  return cli.launchdPlistPath(...args);
}

function opsNetworkPortValue(...args: any[]): any {
  return cli.opsNetworkPortValue(...args);
}

function persistDefaultInstallCoordinates(...args: any[]): any {
  return cli.persistDefaultInstallCoordinates(...args);
}

function privKeyPath(...args: any[]): any {
  return cli.privKeyPath(...args);
}

function provisionFabric(...args: any[]): any {
  return cli.provisionFabric(...args);
}

function pubKeyPath(...args: any[]): any {
  return cli.pubKeyPath(...args);
}

function readyOpsSocketPosture(...args: any[]): any {
  return cli.readyOpsSocketPosture(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function writeAdminPassFile(...args: any[]): any {
  return cli.writeAdminPassFile(...args);
}

function resolveOpsBindHost(...args: any[]): any {
  return cli.resolveOpsBindHost(...args);
}

function resolveHttpBindFor(...args: any[]): any {
  return cli.resolveHttpBindFor(...args);
}

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

function resolveOpsTarget(...args: any[]): any {
  return cli.resolveOpsTarget(...args);
}

function resolveOpsUrlFromTarget(...args: any[]): any {
  return cli.resolveOpsUrlFromTarget(...args);
}

function resolveTarget(...args: any[]): any {
  return cli.resolveTarget(...args);
}

function runSoulWizard(...args: any[]): any {
  return cli.runSoulWizard(...args);
}

function seedAgentViaOpsApi(...args: any[]): any {
  return cli.seedAgentViaOpsApi(...args);
}

function seedFederationInstanceViaOpsApi(...args: any[]): any {
  return cli.seedFederationInstanceViaOpsApi(...args);
}

function shouldShowInlineSecretWarning(...args: any[]): any {
  return cli.shouldShowInlineSecretWarning(...args);
}

function verifyAuditLog(...args: any[]): any {
  return cli.verifyAuditLog(...args);
}

function verifySemanticSearch(...args: any[]): any {
  return cli.verifySemanticSearch(...args);
}

function waitForHealth(...args: any[]): any {
  return cli.waitForHealth(...args);
}

function writeDaemonSidecar(...args: any[]): any {
  return cli.writeDaemonSidecar(...args);
}

function writeInitLaunchdPlist(...args: any[]): any {
  return cli.writeInitLaunchdPlist(...args);
}

export function register(program: Command): void {
  const MQTT_DISABLED_CONFIG = cli.MQTT_DISABLED_CONFIG;
  const STARTUP_TIMEOUT_MS = cli.STARTUP_TIMEOUT_MS;

// ─── flair init ──────────────────────────────────────────────────────────────


program
  .command("init")
  .description("One-command Flair setup — bootstrap the instance, register an agent, and wire MCP clients")
  .option("--agent-id <id>", "Agent ID to register (omit to bootstrap instance without agent)")
  .option("--agent <id>", "Alias for --agent-id")
  // No commander default (flair#928). A default here is indistinguishable from
  // the user typing it, so a BARE `flair init` used to state DEFAULT_PORT and
  // renumber an instance already serving a custom one. Absent means absent, and
  // resolveHttpPort's "create" ladder supplies DEFAULT_PORT for a genuinely new
  // instance — which is the only case that ever wanted one.
  .option("--port <port>", "Harper HTTP port (default: this instance's current port, or 19926 for a new one)")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--ops-bind <addr>", "Harper ops API bind address (env: FLAIR_OPS_BIND; default: 127.0.0.1 loopback-only for single-host — pass e.g. 0.0.0.0 for multi-host/Fabric remote admin)")
  .option("--http-bind <addr>", "Harper HTTP bind address (env: FLAIR_HTTP_BIND; default: 127.0.0.1 loopback-only). The listener MUST include IPv4 loopback (Flair's self-calls hardcode 127.0.0.1), so only 127.0.0.1 or a wildcard (0.0.0.0 / ::) is accepted; a specific non-loopback host is refused.")
  .option("--admin-pass <pass>", "Admin password (generated if omitted)")
  .option("--admin-pass-file <path>", "Read admin password from file (chmod 600 recommended)")
  .option("--reset-admin-pass", "Rotate Harper's persisted admin hash via the operations socket, then write ~/.flair/admin-pass")
  .option("--admin-user <name>", "Admin username when authenticating to an already-running instance via --target/--ops-target (env: FLAIR_ADMIN_USER; default: admin — local bootstrap and Fabric provisioning always create 'admin')")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--data-dir <dir>", "Harper data directory")
  .option("--skip-start", "Skip Harper startup (assume already running)")
  .option("--skip-soul", "Skip interactive personality setup")
  .option("--client <client>", "Client(s) to wire: claude-code, codex, gemini, cursor, antigravity, pi (native extension), all, or none")
  .option("--no-mcp", "Skip MCP client wiring (instance + agent only)")
  .option("--skip-smoke", "Skip the MCP smoke test")
  .option("--skip-claude-md", "Skip appending the Flair bootstrap line to CLAUDE.md (claude-code only)")
  .option("--skip-hook", "Skip installing the flair-session-start SessionStart hook (claude-code and Codex)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--remote", "When used with --target, init as hub for remote federation")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .option("--force", "Skip confirmation prompt for remote writes (required with --target)")
  .option("--cluster-admin-user <user>", "Harper cluster admin username (env: FLAIR_CLUSTER_ADMIN_USER)")
  .option("--cluster-admin-pass <pass>", "Harper cluster admin password (env: FLAIR_CLUSTER_ADMIN_PASS)")
  .option("--flair-admin-pass <pass>", "Password for Flair's admin user (env: FLAIR_ADMIN_PASS; generated if omitted)")
  .action(async (opts) => {
    const agentId: string | undefined = opts.agentId ?? opts.agent;
    const target = resolveTarget(opts);
    const opsTarget = resolveOpsTarget(opts);

    // ── Remote init: --target and/or --ops-target drive a remote Flair instance ──
    if (target || opsTarget) {
      // When -only- --ops-target is provided, attempt to derive REST URL
      if (!target && opsTarget) {
        console.error("Error: --ops-target requires --target as well. Pass --target <rest-url> for the REST API surface.");
        console.error("  Currently only explicit --ops-target + --target combination is supported.");
        process.exit(1);
      }
      const baseUrl = target!.replace(/\/$/, "");
      // --ops-target overrides derivation; otherwise derive from --target
      const opsUrl = opsTarget ? opsTarget.replace(/\/$/, "") : resolveOpsUrlFromTarget(baseUrl);

      // Check for cluster-admin provisioning (new atomic flow)
      const clusterAdminUser = opts.clusterAdminUser || process.env.FLAIR_CLUSTER_ADMIN_USER;
      const clusterAdminPass = opts.clusterAdminPass || process.env.FLAIR_CLUSTER_ADMIN_PASS;
      let flairAdminPass = opts.flairAdminPass || process.env.FLAIR_ADMIN_PASS;
      let didProvision = false;

      if (clusterAdminUser && clusterAdminPass) {
        // ── New provisioning path: deploy Flair to Fabric, wait, provision super_user ──
        if (!opts.force) {
          console.error("Error: --force is required with --target/--ops-target (remote init provisions a live Fabric instance)");
          console.error("  Pass --force to confirm this is intended.");
          process.exit(1);
        }

        // Generate flair admin pass if not provided
        if (!flairAdminPass) {
          flairAdminPass = randomBytes(24).toString("base64url");
        }

        // Write the flair admin pass to secrets directory
        const secretsDir = join(homedir(), ".tps", "secrets");
        mkdirSync(secretsDir, { recursive: true });
        const secretPath = join(secretsDir, "flair-fabric-hdb");
        writeFileSync(secretPath, flairAdminPass + "\n", { mode: 0o600 });
        console.log(`Admin password written to ${secretPath}`);

        // Atomic provisioning: deploy + wait + provision user
        await provisionFabric(baseUrl, opsUrl, clusterAdminUser, clusterAdminPass, flairAdminPass);
        didProvision = true;

        // Hub instances (--remote) receive federation pair requests and need
        // the flair_pair_initiator role so bootstrap credentials can pass
        // platform auth before reaching the FederationPair resource handler.
        if (opts.remote) {
          await ensureFlairPairInitiatorRole(opsUrl, DEFAULT_ADMIN_USER, flairAdminPass);
        }

        // Every flair instance has agents, so provision the least-privilege
        // flair_agent role (idempotent, harmless until a user is assigned to it).
        await ensureFlairAgentRole(opsUrl, DEFAULT_ADMIN_USER, flairAdminPass);
        // THE FLIP (auth-rbac): provision the shared least-privilege flair-agent user.
        // This ACTIVATES the gate's per-agent de-elevation (verified non-admin agents
        // resolve to flair-agent instead of admin super_user). Safe now: #487 gave
        // every agent-facing resource its own allow* + resolveAgentAuth, so they no
        // longer rely on the admin super_user bypass. The gate also falls back to
        // admin if this user is ever absent, so de-elevation degrades gracefully.
        await ensureFlairAgentUser(opsUrl, DEFAULT_ADMIN_USER, flairAdminPass);
      } else {
        // ── Existing behavior: --admin-pass required for already-running Flair ──
        if (!opts.adminPass) {
          console.error("Error: --admin-pass is required with --target/--ops-target (remote init without --cluster-admin-user/--cluster-admin-pass)");
          console.error("  Use --cluster-admin-user and --cluster-admin-pass for automated Fabric provisioning.");
          process.exit(1);
        }
        if (!opts.force) {
          const displayTarget = target || opsTarget;
          console.error(`Error: --force is required with --target/--ops-target. Remote init writes to a live Flair instance at ${displayTarget}.`);
          console.error("  Pass --force to confirm this is intended.");
          process.exit(1);
        }
        flairAdminPass = opts.adminPass;
      }

      // flair#1345: only the already-running-instance leg honors --admin-user /
      // FLAIR_ADMIN_USER — the provisioning leg just CREATED the superuser as
      // DEFAULT_ADMIN_USER via provisionFabric, so that name is ground truth.
      const adminUser = didProvision ? DEFAULT_ADMIN_USER : resolveAdminUser(opts.adminUser);
      const auth = `Basic ${Buffer.from(`${adminUser}:${flairAdminPass}`).toString("base64")}`;
      const role = opts.remote ? "hub" : undefined;

      // Generate or reuse keypair (only if --agent-id provided, or --remote needs
      // a public key for the FederationInstance row)
      let pubKeyB64url: string | undefined;
      let privPath: string | undefined;
      let instanceId: string | undefined;

      if (agentId || role) {
        const keysDir: string = opts.keysDir ?? defaultKeysDir();
        mkdirSync(keysDir, { recursive: true });

        if (agentId) {
          privPath = privKeyPath(agentId, keysDir);
          const pubPath = pubKeyPath(agentId, keysDir);

          if (existsSync(privPath!)) {
            console.log(`Reusing existing key: ${privPath}`);
            const seed = new Uint8Array(readFileSync(privPath!));
            const kp = nacl.sign.keyPair.fromSeed(seed);
            pubKeyB64url = b64url(kp.publicKey);
          } else {
            console.log("Generating Ed25519 keypair...");
            const kp = nacl.sign.keyPair();
            const seed = kp.secretKey.slice(0, 32);
            writeFileSync(privPath!, Buffer.from(seed));
            chmodSync(privPath!, 0o600);
            writeFileSync(pubPath, Buffer.from(kp.publicKey));
            pubKeyB64url = b64url(kp.publicKey);
            console.log(`Keypair written: ${privPath} ✓`);
          }

          // Seed agent via remote ops API
          console.log(`Seeding agent '${agentId}' on ${baseUrl}...`);
          await seedAgentViaOpsApi(opsUrl, agentId, pubKeyB64url, adminUser, flairAdminPass);
          console.log(`Agent '${agentId}' registered on remote instance ✓`);
        } else {
          // No agentId -- generate throwaway keypair for FederationInstance row
          console.log("Generating federation instance keypair...");
          const kp = nacl.sign.keyPair();
          pubKeyB64url = b64url(kp.publicKey);
        }
      } else {
        console.log("No --agent-id provided -- skipping agent registration");
      }

      // Write FederationInstance row if --remote (hub role)
      if (role) {
        if (!pubKeyB64url) {
          const kp = nacl.sign.keyPair();
          pubKeyB64url = b64url(kp.publicKey);
        }
        instanceId = randomUUID();
        console.log(`Writing federation Instance (role=${role}) via ops API...`);
        await seedFederationInstanceViaOpsApi(opsUrl, instanceId, pubKeyB64url, role, adminUser, flairAdminPass);
        console.log(`Federation Instance created: ${instanceId} (${role}) ✓`);
      }

      // Verify connectivity
      if (didProvision) {
        // Use /FederationInstance with Basic auth (not /Health which false-401s on Fabric)
        console.log("Verifying remote connectivity...");
        const verifyRes = await fetch(`${baseUrl}/FederationInstance`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(5000),
        });
        if (!verifyRes.ok) {
          const body = await verifyRes.text().catch(() => "");
          console.error(`Remote verification failed (${verifyRes.status}): ${body}`);
          process.exit(1);
        }
        console.log("✓ Hub ready at " + baseUrl);
      } else {
        // Existing behavior: /Health check (already-running Flair)
        console.log("Verifying remote connectivity...");
        const verifyRes = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(5000) });
        if (!verifyRes.ok) {
          console.error(`Remote health check failed: ${verifyRes.status}`);
          process.exit(1);
        }
        console.log("Remote Flair instance healthy ✓");
      }

      // Print summary
      if (didProvision) {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
        const flavor = pkg.version || "(unknown)";
        const displayTarget = target || opsTarget;
        console.log(`\n✓ Flair hub deployed to ${displayTarget}`);
        console.log(`  Component: flair@${flavor}`);
        console.log(`  Admin user: ${adminUser} (pass written to ${join(homedir(), ".tps", "secrets", "flair-fabric-hdb")})`);
        if (instanceId) console.log(`  Instance: ${instanceId} (role=${role})`);
        console.log(`  Federation: ready — run \`flair federation token\` to mint a pairing token`);
      } else {
        console.log(`\n✅ Remote Flair initialized`);
        if (agentId) console.log(`   Agent ID:    ${agentId}`);
        console.log(`   Target:      ${baseUrl}`);
        if (agentId) console.log(`   Private key: ${privPath}`);
        if (role) console.log(`   Role:         ${role}`);
        console.log(`\n   Export: FLAIR_URL=${baseUrl}`);
      }
      return;
    }

    // ── Local init (full one-command setup) ──
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const dataDir: string = opts.dataDir ?? defaultDataDir();
    // "create" mode (flair#914): init ESTABLISHES an instance, so a data
    // directory with no recorded port is a new instance taking the default,
    // not the hard error every other caller gets — otherwise `flair init
    // --data-dir <new>` could never succeed. `dataDir` is resolved first so
    // this is never asked before the instance is known.
    //
    // flair#928: `--port` deliberately carries NO commander default, so a bare
    // `init` reaches the ladder below instead of restating DEFAULT_PORT and
    // renumbering an instance that already serves a custom port. `init` is
    // `flair doctor`'s standing remedy and is recommended in ten places, so the
    // command handed to an operator whose install is already wrong must not be
    // the one that moves their port.
    const httpPort = resolveHttpPort(opts, "create");
    // The already-resolved port is handed to the ops resolver rather than
    // letting it re-resolve — its last rung is `resolveHttpPort(opts) - 1`,
    // which would ask the same question again in "address" mode.
    const opsPort = resolveOpsPort({ ...opts, port: httpPort });
    const opsBindHost = resolveOpsBindHost(opts);
    // HTTP bind (ops-nv9d slice 2): the same escape-hatch shape as the ops API
    // (--http-bind > FLAIR_HTTP_BIND > persisted httpBind > loopback), but
    // VALIDATED — the constructor refuses any host that does not guarantee
    // IPv4-loopback reachability. Resolved before any write so a bad host is
    // refused without touching the instance.
    let httpBind: any;
    try {
      httpBind = resolveHttpBindFor(httpPort, opts);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Resolve MCP client selection (union of init's auto-wire + the multi-client
    // detection/wiring that the front-door command provides). `--no-mcp` sets
    // opts.mcp === false (commander negates the flag). Validate an explicit
    // --client up front so a typo fails before Harper is touched.
    const clientOpt: string | undefined = opts.client;
    const noMcp = opts.mcp === false;
    const selectedClients: ClientId[] = [];
    if (clientOpt && clientOpt !== "all" && clientOpt !== "none" && !noMcp) {
      const valid: ClientId[] = ["claude-code", "codex", "gemini", "cursor", "antigravity", "pi"];
      if (!valid.includes(clientOpt as ClientId)) {
        console.error(`Unknown client: ${clientOpt}. Valid: claude-code, codex, gemini, cursor, antigravity, pi, all, none`);
        process.exit(1);
      }
      selectedClients.push(clientOpt as ClientId);
    }

    // Admin password: determine from opts, env, reuse, rotate, or generate.
    // Priority: 1) --admin-pass-file, 2) env vars, 3) --admin-pass, 4) reuse
    // existing file (#827), 5) refuse / rotate when Harper already has a
    // persisted user and the file is gone (#837), 6) generate new (fresh).
    let adminPass: string;
    let passwordSource: "generated" | "file" | "env" = "generated";
    let reusedExistingAdminPass = false;
    let pendingAdminPassRotate = false;
    const adminPassPath = defaultAdminPassPath();
    const persistedAdminUser = detectPersistedAdminUser(dataDir);
    let alreadyRunning = false;
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status > 0) alreadyRunning = true;
    } catch { /* not running */ }
    const explicitCredential = !!(
      opts.adminPassFile || process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD || opts.adminPass
    );
    const passwordCtx = {
      persistedAdminUser,
      foreignInstanceOnPort: alreadyRunning && !persistedAdminUser,
      explicitCredential,
      resetRequested: !!opts.resetAdminPass,
      opsSocketAvailable: alreadyRunning || !opts.skipStart,
    };

    // Warn if --admin-pass is passed inline (not from env)
    if (shouldShowInlineSecretWarning(opts.adminPass, false, new Set(["--admin-pass"]), "--admin-pass")) {
      console.error(
        "warning: --admin-pass passed inline. Consider --admin-pass-file <path> or FLAIR_ADMIN_PASS env " +
        "to keep secrets out of shell history."
      );
    }

    const refuseIfNeeded = (fileExists: boolean) => {
      const reason = resolveInitAdminPasswordRefuseReason(fileExists, passwordCtx);
      if (!reason) return;
      console.error(initAdminPassRefusalMessage(reason, {
        dataDir,
        httpPort,
        adminPassPath,
      }));
      process.exit(1);
    };

    // Read from file if provided
    if (opts.adminPassFile) {
      try {
        adminPass = readAdminPassFileSecure(opts.adminPassFile);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      passwordSource = "file";
      if (opts.resetAdminPass) {
        refuseIfNeeded(false);
        pendingAdminPassRotate = resolveInitAdminPasswordSource(false, passwordCtx) === "rotate";
      } else if (resolveInitAdminPasswordSource(false, passwordCtx) === "re-persist") {
        writeAdminPassFile(adminPassPath, adminPass + "\n");
      }
    } else if (process.env.FLAIR_ADMIN_PASS) {
      adminPass = process.env.FLAIR_ADMIN_PASS;
      passwordSource = "env";
      if (opts.resetAdminPass) {
        refuseIfNeeded(false);
        pendingAdminPassRotate = resolveInitAdminPasswordSource(false, passwordCtx) === "rotate";
      } else if (resolveInitAdminPasswordSource(false, passwordCtx) === "re-persist") {
        writeAdminPassFile(adminPassPath, adminPass + "\n");
      }
    } else if (process.env.HDB_ADMIN_PASSWORD) {
      adminPass = process.env.HDB_ADMIN_PASSWORD;
      passwordSource = "env";
      if (opts.resetAdminPass) {
        refuseIfNeeded(false);
        pendingAdminPassRotate = resolveInitAdminPasswordSource(false, passwordCtx) === "rotate";
      } else if (resolveInitAdminPasswordSource(false, passwordCtx) === "re-persist") {
        writeAdminPassFile(adminPassPath, adminPass + "\n");
      }
    } else if (opts.adminPass) {
      // Inline admin pass (deprecated)
      adminPass = opts.adminPass;
      passwordSource = "env"; // Treat same as env for display purposes
      if (opts.resetAdminPass) {
        refuseIfNeeded(false);
        pendingAdminPassRotate = resolveInitAdminPasswordSource(false, passwordCtx) === "rotate";
      } else if (resolveInitAdminPasswordSource(false, passwordCtx) === "re-persist") {
        writeAdminPassFile(adminPassPath, adminPass + "\n");
      }
    } else {
      passwordSource = "generated";
      const fileExists = existsSync(adminPassPath);
      const decision = resolveInitAdminPasswordSource(fileExists, passwordCtx);
      if (decision === "reuse-existing") {
        // flair#827: an admin-pass file already on disk means a PRIOR `flair
        // init` already bootstrapped Harper's admin user with this password.
        try {
          adminPass = readAdminPassFileSecure(adminPassPath);
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        reusedExistingAdminPass = true;
      } else if (decision === "generate-new") {
        adminPass = Buffer.from(nacl.randomBytes(18)).toString("base64url");
        writeAdminPassFile(adminPassPath, adminPass + "\n");
      } else if (decision === "rotate") {
        if (!opts.resetAdminPass) {
          throw new Error("unreachable: rotate without --reset-admin-pass");
        }
        adminPass = Buffer.from(nacl.randomBytes(18)).toString("base64url");
        pendingAdminPassRotate = true;
      } else {
        refuseIfNeeded(fileExists);
        // refuseIfNeeded always exits on refuse; keep a throw so TS knows
        // adminPass is assigned on every path.
        throw new Error("unreachable: init admin-pass refuse");
      }
    }
    const adminUser = DEFAULT_ADMIN_USER;

    // If we generated (or reused) the password, report where it lives.
    // A pending rotate writes the file only AFTER alter_user succeeds.
    if (passwordSource === "generated") {
      if (reusedExistingAdminPass) {
        console.log(`Reusing existing admin password from: ${adminPassPath} (flair#827: re-init never rotates it — see the ops runbook to change it deliberately)`);
      } else if (pendingAdminPassRotate) {
        console.log(`Will rotate the persisted admin password and write: ${adminPassPath}`);
      } else {
        console.log(`Admin password saved to: ${adminPassPath}`);
      }
    }
    // Check Node.js version
    const major = parseInt(process.version.slice(1), 10);
    if (major < 18) throw new Error(`Node.js >= 18 required (found ${process.version})`);

    // <ROOTPATH>/models — resources/embeddings-provider.ts's resolveModelsDir()
    // tier 2 default; an operator override already in the environment wins
    // (tier 1). Scoped above the alreadyRunning branch below (not just inside
    // the fresh-start path) since the launchd plist step needs it too, even
    // when Harper was already running and the fresh-spawn branch was skipped.
    const modelsDir = process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models");

    // flair#763: put the ops-socket directory gate in place BEFORE Harper
    // spawns, so the socket is never reachable during the create→chmod window
    // (the dir gate is the race-free primary control). This also validates
    // FLAIR_SOCKET_GROUP early — a bad group fails fast, before a full boot.
    // The socket doesn't exist yet, so only the parent-dir mode is applied here.
    mkdirSync(dataDir, { recursive: true });
    readyOpsSocketPosture(dataDir);

    if (!opts.skipStart) {
      if (alreadyRunning) {
        console.log(`Harper already running on port ${httpPort} — skipping start`);
      }

      if (!alreadyRunning) {
        const bin = harperBin();
        if (!bin) {
          throw new Error(
            "Harper CLI not found: no dist/bin/harper.js under node_modules/harper " +
              "(or the legacy node_modules/@harperfast/harper) next to this flair " +
              `install or in ${process.cwd()}.\n` +
              "Flair ships Harper as a dependency, so this normally means a partial " +
              "or interrupted install.\nFix: reinstall flair — npm install -g @tpsdev-ai/flair",
          );
        }

        mkdirSync(dataDir, { recursive: true });

        // Detect whether Harper has already been installed in this data dir.
        // Harper's config is created during install — its presence means
        // install already ran. Re-running install against an existing data dir
        // crashes in Harper v5 beta.6+ (checkForExistingInstall queries the
        // database before the env is initialized). Goes through
        // harperConfigPath so an install predating Harper's config-file rename
        // (harperdb-config.yaml) is still recognised as installed rather than
        // re-installed over.
        const alreadyInstalled = harperConfigPath(dataDir) !== null;

        const opsSocket = join(dataDir, "operations-server");
        // authorizeLocal: false (flair#654) — a credential-less loopback ops-API
        // request is no longer auto-authorized as super_user. Every ops-API
        // seed call below (seedAgentViaOpsApi et al.) already passes a real
        // adminPass via Basic auth, so this does not change local-init behavior.
        // operationsApi (flair#670): loopback-only by default (buildOperationsApiConfig
        // — see its doc comment for the "host:port" bind mechanism and the
        // domainSocket schema path), escape hatch via --ops-bind/FLAIR_OPS_BIND.
        const harperSetConfig = JSON.stringify({
          rootPath: dataDir,
          http: { port: httpBind.bindValue, cors: true, corsAccessList: httpCorsAccessList(httpPort) },
          operationsApi: buildOperationsApiConfig(opsPort, opsSocket, opsBindHost),
          mqtt: MQTT_DISABLED_CONFIG,
          localStudio: { enabled: false },
          authentication: { authorizeLocal: false, enableSessions: true },
        });

        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          ROOTPATH: dataDir,
          FLAIR_MODELS_DIR: modelsDir,
          HARPER_SET_CONFIG: harperSetConfig,
          DEFAULTS_MODE: "dev",
          HDB_ADMIN_USERNAME: adminUser,
          HDB_ADMIN_PASSWORD: adminPass,
          THREADS_COUNT: "1",
          NODE_HOSTNAME: "localhost",
          HTTP_PORT: httpBind.bindValue,
          // flair#863: host-qualified, NOT a bare port. A bare value here is
          // what Harper latches as `originalValues["operationsApi.network.port"]`
          // when HARPER_SET_CONFIG force-sets the same key — and restores on the
          // first later boot without HARPER_SET_CONFIG, re-widening the bind to
          // all interfaces. See opsNetworkPortValue's doc comment.
          OPERATIONSAPI_NETWORK_PORT: opsNetworkPortValue(opsBindHost, opsPort),
          LOCAL_STUDIO: "false",
          // flair#1586: same MQTT_* re-assert as buildDirectSpawnEnv / the
          // launchd plist, so init cannot restore Harper's 1883/8883 defaults
          // on a later boot that omits HARPER_SET_CONFIG.
          MQTT_NETWORK_PORT: "null",
          MQTT_NETWORK_SECUREPORT: "null",
          MQTT_WEBSOCKET: "false",
        };
        // models (flair#504 Phase 1): the embedding backend registers itself
        // in-process at boot (resources/embeddings-boot.ts, loaded by
        // config.yaml's `jsResource` glob) — NOT via a config env var. See
        // that file's header for why (flair#694: HARPER_CONFIG persisted a
        // `models.embedding.default` block into harper-config.yaml that an
        // older/downgraded build's boot would tear down to an invalid empty
        // shell). FLAIR_MODELS_DIR above is still the channel that tells the
        // registration where to find/download the model.

        if (alreadyInstalled) {
          console.log("Existing Harper installation found — skipping install.");
          console.log("If something is wrong, run: flair doctor");
        } else {
          // Isolate install from any global Harper boot file.
          // ~/.harperdb/hdb_boot_properties.file from an unrelated install
          // causes checkForExistingInstall to crash in Harper v5 beta.6+.
          // Only applied to install — run needs real HOME for npm/node resolution.
          const installEnv = { ...env, HOME: join(dataDir, "..") };
          console.log("Installing Harper...");
          console.log("Downloading embedding model (nomic-embed-text-v1.5, ~80MB) — this may take a minute...");
          await new Promise<void>((resolve, reject) => {
            let output = "";
            let dotTimer: ReturnType<typeof setInterval> | null = null;
            const install = spawn(process.execPath, [bin, "install"], { cwd: flairPackageDir(), env: installEnv });
            // Print progress dots so the terminal doesn't appear frozen during model download
            dotTimer = setInterval(() => process.stdout.write("."), 3000);
            install.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
            install.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
            install.on("exit", (code) => {
              if (dotTimer) { clearInterval(dotTimer); process.stdout.write("\n"); }
              code === 0 ? resolve() : reject(new Error(`Harper install failed (${code}): ${output}`));
            });
            install.on("error", (err) => {
              if (dotTimer) { clearInterval(dotTimer); process.stdout.write("\n"); }
              reject(err);
            });
            setTimeout(() => {
              install.kill();
              if (dotTimer) { clearInterval(dotTimer); process.stdout.write("\n"); }
              reject(new Error(`Harper install timed out: ${output}`));
            }, 60_000);
          });
        }

        // Start Harper with flair loaded as a component (the "." arg).
        // ROOTPATH in env points to the data dir; authorizeLocal and thread
        // count are set via HARPER_SET_CONFIG — no need for dev mode.
        console.log(`Starting Harper on port ${httpPort}...`);
        const proc = spawn(process.execPath, [bin, "run", "."], { cwd: flairPackageDir(), env, detached: true, stdio: "ignore" });
        proc.unref();
        // flair#1454: write the identity sidecar immediately after spawn so
        // `flair stop` and `flair status` can classify this daemon's state
        // without lsof. Same call as startFlairProcess() uses.
        if (proc.pid) writeDaemonSidecar(dataDir, proc.pid, httpPort);
      }

      console.log("Waiting for Harper health check...");
      await waitForHealth(httpPort, adminUser, adminPass, STARTUP_TIMEOUT_MS);
      console.log("Harper is healthy ✓");

      // flair#763: the socket now exists — apply its file mode (+ chgrp for the
      // FLAIR_SOCKET_GROUP opt-in). The dir gate above is re-asserted idempotently.
      readyOpsSocketPosture(dataDir);

      if (pendingAdminPassRotate) {
        // HTTP /Health is not rotate-ready: Harper can answer it before
        // operations-server accepts. Wait for a live socket, then alter_user,
        // then write. A dead leftover inode is not-ready — refuse, no write.
        const opsSocket = join(dataDir, "operations-server");
        try {
          await executeAdminPasswordRotate({
            resetRequested: !!opts.resetAdminPass,
            username: adminUser,
            password: adminPass,
            socketPath: opsSocket,
            adminPassPath,
            writeAdminPassFile,
            onPreflight: (line) => console.log(line),
          });
        } catch (err: any) {
          console.error(err?.message ?? err);
          process.exit(1);
        }
        pendingAdminPassRotate = false;
        console.log(`Admin password saved to: ${adminPassPath}`);
      }

      // Register launchd service on macOS so Harper survives reboots
      // and `flair restart` / `flair stop` work via launchctl.
      if (process.platform === "darwin") {
        const harperBinPath = harperBin();
        if (harperBinPath) {
          const label = launchdLabel(dataDir);
          const plistDir = defaultLaunchAgentsDir();
          mkdirSync(plistDir, { recursive: true });
          const plistPath = launchdPlistPath(label, plistDir);

          // flair#693 + flair#966: a pre-flair#693 install registered under
          // the bare LEGACY_LAUNCHD_LABEL. init always writes fresh plist
          // content below (it has the current ports/creds in hand), so
          // migration here is just "clean up the old registration" —
          // unload + remove it BEFORE writing the new one, so re-running
          // init never leaves two services behind for this data dir.
          //
          // flair#966: the legacy plist is NOT scoped to this data dir —
          // it is a single global label. cleanupLegacyLaunchdPlist reads
          // ROOTPATH to establish ownership before touching it.
          cleanupLegacyLaunchdPlist(dataDir, plistDir, (cmd: string) => {
            execSync(cmd, { stdio: "pipe" });
          });

          const opsSocket = join(dataDir, "operations-server");
          // authorizeLocal: false (flair#654) — same posture as the initial spawn
          // above; the launchd-managed process must not diverge from it.
          // operationsApi (flair#670): same buildOperationsApiConfig posture as the
          // initial spawn above — the launchd-managed process must not diverge.
          const setConfig = JSON.stringify({
            rootPath: dataDir,
            http: { port: httpBind.bindValue, cors: true, corsAccessList: httpCorsAccessList(httpPort) },
            operationsApi: buildOperationsApiConfig(opsPort, opsSocket, opsBindHost),
            mqtt: MQTT_DISABLED_CONFIG,
            localStudio: { enabled: false },
            authentication: { authorizeLocal: false, enableSessions: true },
          });
          // models (flair#504 Phase 1): no env var needed here — the
          // launchd-managed process loads the SAME dist/resources/*.js as any
          // other spawn, so resources/embeddings-boot.ts self-registers the
          // backend on every KeepAlive restart in-process. See that file's
          // header (flair#694) for why this replaced the old HARPER_CONFIG
          // plist line.
          //
          // Credential before plist, ONE shape (flair#1693): the writer always
          // emits the pass-file launcher and never HDB_ADMIN_PASSWORD. It reuses
          // an existing valid ~/.flair/admin-pass, or proves the credential in
          // hand against this (now-healthy) instance and writes it 0600, or
          // refuses without writing a plist. An already-adopted instance is left
          // byte-for-byte unchanged rather than downgraded to the inline shape.
          const outcome = await writeInitLaunchdPlist({
            dataDir,
            plistPath,
            label,
            adminPass,
            adminUser,
            modelsDir,
            execPath: process.execPath,
            harperBinPath,
            workingDirectory: flairPackageDir(),
            httpPort: httpBind.bindValue,
            opsNetworkPort: opsNetworkPortValue(opsBindHost, opsPort),
            setConfig,
            port: httpPort,
          });
          if (outcome.kind === "refused") {
            console.error(`Error: ${outcome.detail}`);
            process.exit(1);
          }
          console.log(
            outcome.kind === "unchanged"
              ? "Launchd service already managed — plist unchanged ✓"
              : "Launchd service registered ✓",
          );
        }
      }
    }

    if (pendingAdminPassRotate) {
      // Same gate as the post-health path: readiness is the operations
      // socket accepting a connection, not HTTP. Never fall through to
      // the HTTP ops path; never write the pass file if rotate did not land.
      const opsSocket = join(dataDir, "operations-server");
      try {
        await executeAdminPasswordRotate({
          resetRequested: !!opts.resetAdminPass,
          username: adminUser,
          password: adminPass,
          socketPath: opsSocket,
          adminPassPath,
          writeAdminPassFile,
          onPreflight: (line) => console.log(line),
        });
      } catch (err: any) {
        console.error(err?.message ?? err);
        process.exit(1);
      }
      pendingAdminPassRotate = false;
      console.log(`Admin password saved to: ${adminPassPath}`);
    }

    // Persist the instance coordinates so other commands can find AND
    // re-assert this instance. flair#863: `opsBind` in particular has to be
    // persisted here, not just handed to this run's spawn — `flair start` /
    // `flair restart` / `flair upgrade` re-assert the bind on every spawn and
    // have no `--ops-bind` flag of their own, so this is the only thing that
    // survives an `--ops-bind` choice past the next restart. It also runs on
    // the already-running path (where init skips the spawn entirely), which is
    // what makes doctor's `flair init && flair restart` remedy actually apply.
    // flair#914: written ONLY when this init is about the default install, so a
    // second instance can no longer overwrite the first's recorded port. This
    // instance's own port needs no write here — Harper has just recorded it in
    // <dataDir>/harper-config.yaml, which is what resolveHttpPort reads (see
    // persistDefaultInstallCoordinates).
    //
    // `httpBind` is persisted with THIS run's resolved host, always — not only
    // when it differs from the loopback default. `undefined` would mean both
    // "no preference" and "read from disk", so persisting it only for a
    // non-default host made the hatch a ONE-WAY DOOR: a later `--http-bind
    // 127.0.0.1` narrowed only that run's spawn, and the next restart re-widened
    // from the still-persisted wildcard. Writing the resolved host on every init
    // means an explicit loopback also persists, so a widening can be reversed.
    persistDefaultInstallCoordinates(dataDir, httpPort, opsPort, opsBindHost, httpBind.host);

    if (agentId) {
      // Generate or reuse keypair
      mkdirSync(keysDir, { recursive: true });
      const privPath = privKeyPath(agentId, keysDir);
      const pubPath = pubKeyPath(agentId, keysDir);
      let pubKeyB64url: string;

      if (existsSync(privPath!)) {
        console.log(`Reusing existing key: ${privPath}`);
        const seed = new Uint8Array(readFileSync(privPath!));
        const kp = nacl.sign.keyPair.fromSeed(seed);
        pubKeyB64url = b64url(kp.publicKey);
      } else {
        console.log("Generating Ed25519 keypair...");
        const kp = nacl.sign.keyPair();
        // Store only the 32-byte seed (first 32 bytes of secretKey)
        const seed = kp.secretKey.slice(0, 32);
        writeFileSync(privPath!, Buffer.from(seed));
        chmodSync(privPath!, 0o600);
        writeFileSync(pubPath, Buffer.from(kp.publicKey));
        pubKeyB64url = b64url(kp.publicKey);
        console.log(`Keypair written: ${privPath} ✓`);
      }

      // Seed agent via operations API
      console.log(`Seeding agent '${agentId}' via operations API...`);
      await seedAgentViaOpsApi(opsPort, agentId, pubKeyB64url, adminUser, adminPass);
      console.log(`Agent '${agentId}' registered ✓`);

      // Verify Ed25519 auth
      console.log("Verifying Ed25519 auth...");
      const httpUrl = `http://127.0.0.1:${httpPort}`;
      const verifyRes = await authFetch(httpUrl, agentId, privPath, "GET", `/Agent/${agentId}`);
      if (!verifyRes.ok) throw new Error(`Ed25519 auth verification failed: ${verifyRes.status}`);
      console.log("Ed25519 auth verified ✓");

      // Verify semantic search ACTUALLY works (real embed→paraphrase-search
      // round-trip). A clean-VM dogfood found semantic search dead out of the box
      // (sudo/root-owned install can't write the embeddings models symlink →
      // EACCES) while init reported success. Never report a clean init when
      // recall-by-meaning is broken. Skipped paths (no key yet) are non-fatal.
      console.log("Verifying semantic search...");
      const embedCheck = await verifySemanticSearch(httpUrl, agentId, keysDir);
      if (embedCheck.state === "ok") {
        console.log(`Semantic search operational ✓ ${render.wrap(render.c.dim, `(paraphrase recall verified, score ${embedCheck.score.toFixed(2)})`)}`);
      } else if (embedCheck.state === "degraded") {
        // LOUD — embeddings not loaded. Same message class as `flair doctor`.
        console.log(`\n${render.icons.error} ${render.wrap(render.c.red, "Semantic search DEGRADED")} — embeddings not loaded; recall-by-meaning will NOT work.`);
        console.log(`   ${render.wrap(render.c.dim, `(${embedCheck.detail})`)}`);
        console.log(`   ${render.wrap(render.c.dim, "Common cause: the embeddings component lacks write access (sudo/root global installs).")}`);
        console.log(`   ${render.wrap(render.c.dim, "Fix: install without sudo (see README Quick Start), then:")} flair restart && flair doctor`);
      } else if (embedCheck.state === "failed") {
        // flair#1501: the instance rejected the probe's signature. init just
        // registered this agent, so this is a genuine auth defect, not a
        // missing identity — surface it loudly with the signer named.
        console.log(`\n${render.icons.error} ${render.wrap(render.c.red, "Semantic search probe rejected")} — ${embedCheck.detail}.`);
        console.log(`   ${render.wrap(render.c.dim, "Fix: register this key on the instance (`flair agent add <id>`) or pass --agent <a registered agent id>.")}`);
      } else {
        console.log(`${render.icons.warn} Semantic search not verified ${render.wrap(render.c.dim, `(${embedCheck.detail})`)}`);
      }

      // Verify the audit log ACTUALLY records (flair#970) — a positive
      // control, not a flag read: `describe_table` reports `audit: true` on
      // nodes whose audit trail is empty (base-copy elision, harper#2212).
      // Same surface as the semantic-search check above.
      console.log("Verifying audit log...");
      const auditCheck = await verifyAuditLog(httpUrl, agentId, keysDir, `http://127.0.0.1:${opsPort}`, adminUser, adminPass);
      if (auditCheck.state === "ok") {
        // Present tense ONLY: the probe proves current recording, never
        // historical completeness — see AuditVerifyResult's doc comment.
        console.log(`Audit log: recording (verified now) ✓ ${render.wrap(render.c.dim, "(verifies current recording, not history — a resynced node's audit has a hard start boundary at its copy time)")}`);
      } else if (auditCheck.state === "degraded") {
        if (auditCheck.cause === "disabled") {
          console.log(`\n${render.icons.error} ${render.wrap(render.c.red, "Audit log DISABLED")} — ${auditCheck.detail}.`);
          console.log(`   ${render.wrap(render.c.dim, "Fix: enable logging.auditLog in the ROOT harperdb-config.yaml (the Harper instance config, NOT flair's component config.yaml), then restart Harper.")}`);
        } else {
          console.log(`\n${render.icons.error} ${render.wrap(render.c.red, "Audit log NOT RECORDING")} — ${auditCheck.detail}.`);
          console.log(`   ${render.wrap(render.c.red, "Audit reports as enabled, but fresh writes produced no audit entries — do not treat the audit log as a record of what happened.")}`);
          console.log(`   ${render.wrap(render.c.dim, "On a node that joined or resynced via cluster base copy, audit history has a hard start boundary at copy time (harper#2212) — \"no history\" does not mean \"nothing happened\".")}`);
          console.log(`   ${render.wrap(render.c.dim, "Check logging.auditLog in the ROOT harperdb-config.yaml (not flair's component config.yaml), then restart Harper.")}`);
        }
      } else if (auditCheck.state === "failed") {
        // Same loud discipline as the semantic-search probe above (flair#1501).
        console.log(`\n${render.icons.error} ${render.wrap(render.c.red, "Audit log probe rejected")} — ${auditCheck.detail}.`);
        console.log(`   ${render.wrap(render.c.dim, "Fix: register this key on the instance (`flair agent add <id>`) or pass --agent <a registered agent id>.")}`);
      } else {
        // An unrun check must not look like a pass.
        console.log(`${render.icons.warn} Audit log: UNVERIFIED (could not probe — ${auditCheck.detail})`);
      }

      // Output — admin password printed once, never written to disk
      console.log("\n✅ Flair initialized successfully");
      console.log(`   Agent ID:    ${agentId}`);
      console.log(`   Flair URL:   ${httpUrl}`);
      console.log(`   Private key: ${privPath}`);
      
      // Display admin credentials when password was generated or from a file
      // Do NOT display when from env (to avoid showing the env var value)
      if (passwordSource !== "env" && !alreadyRunning) {
        const passDisplay = passwordSource === "file"
          ? opts.adminPassFile ?? "(file path)"
          : "~/.flair/admin-pass";
        console.log(`\n   ┌─────────────────────────────────────────────────┐`);
        console.log(`   │  Harper admin credentials (save these now):     │`);
        console.log(`   │                                                 │`);
        console.log(`   │  Username: ${DEFAULT_ADMIN_USER.padEnd(37)}│`);
        console.log(`   │  Password: ${passDisplay.padEnd(37)}│`);
        console.log(`   │                                                 │`);
        console.log(`   │  ⚠️  The password won't be shown again.         │`);
        console.log(`   └─────────────────────────────────────────────────┘`);
      }
      console.log(`\n   Export: FLAIR_URL=${httpUrl}`);

      // ── First-run soul setup ──────────────────────────────────────────────
      // Interactive wizard to set initial personality (see runSoulWizard).
      // Skipped with --skip-soul or when stdin is not a TTY (CI, scripts, pipe).
      //
      // Non-TTY / --skip-soul used to seed placeholder text like
      // "AI assistant [default]" — it leaked into bootstrap output and
      // confused users. Now those paths leave the soul empty and nudge the
      // user toward `flair soul set` / `flair doctor` instead.
      if (!opts.skipSoul && process.stdin.isTTY) {
        const soulEntries = await runSoulWizard(agentId);
        if (soulEntries.length > 0) {
          console.log("");
          for (const [key, value] of soulEntries) {
            try {
              await api("PUT", `/Soul/${agentId}:${key}`,
                { id: `${agentId}:${key}`, agentId, key, value, createdAt: new Date().toISOString() },
                { baseUrl: httpUrl, explicitAdminPass: adminPass, adminUser });
              console.log(`   ✓ soul:${key} set`);
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`   ⚠ soul:${key} failed: ${message}`);
            }
          }
          console.log(`\n   ${soulEntries.length} soul entries saved.`);
          console.log(`   Preview what an agent will see: flair bootstrap --agent ${agentId}`);
        } else {
          console.log(`\n   No soul entries saved. Add later with:`);
          console.log(`     flair soul set --agent ${agentId} --key role --value "..."`);
          console.log(`   Or run \`flair doctor\` anytime for a nudge.`);
        }
      } else {
        const reason = opts.skipSoul ? "--skip-soul" : "non-interactive";
        console.log(`\n   Soul prompts skipped (${reason}). Add entries with:`);
        console.log(`     flair soul set --agent ${agentId} --key role --value "..."`);
      }

      // ── MCP client wiring ────────────────────────────────────────────────
      // The full one-command front door: detect installed MCP clients and wire
      // each to the zero-install `npx -y @tpsdev-ai/flair-mcp@<version>` server
      // (pinned — see mcpServerSpec()). Claude
      // Code is auto-wired into ~/.claude.json (the only client the CLI can
      // safely modify); other clients get copy-paste snippets. `--no-mcp`
      // skips wiring entirely; `--client <name>` targets one client; the
      // default (no flag) wires every detected client.
      const mcpEnv: { FLAIR_AGENT_ID: string; FLAIR_URL: string } = { FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl };
      // `wired` is the load-bearing field (flair#906): it separates "a config
      // file was actually written" from "we printed something and moved on".
      // Both outcomes used to be pushed here indistinguishably as far as the
      // user was concerned, so `--client all` reported success for a client it
      // had not wired.
      const wiringResults: { client: ClientId | string; message: string; wired: boolean }[] = [];
      // Human-readable labels + the clients `--client all` passed over because
      // they aren't installed, so the closing summary can account for every
      // client the user asked for rather than only the ones we tried.
      const clientLabels = new Map<string, string>();
      const skippedUndetected: string[] = [];

      if (!noMcp && clientOpt !== "none") {
        // A spec we cannot pin is a security property quietly downgraded, so
        // say so BEFORE writing it and again in the summary below (flair#907).
        // stderr: this must survive `flair init | tee`, and it is a warning,
        // not part of the command's normal output.
        const pinWarning = unpinnedSpecWarning();
        if (pinWarning) {
          console.error("");
          for (const line of pinWarning.split("\n")) console.error(`   ⚠ ${line}`);
        }

        // Determine which clients to wire.
        let clients = detectClients();
        if (selectedClients.length > 0) {
          clients = clients.filter(c => selectedClients.includes(c.id));
        }
        for (const c of clients) clientLabels.set(c.id, c.label);
        const detected = clients.filter(c => c.detected);

        if (!clientOpt) {
          if (detected.length === 0) {
            console.log("\n   No MCP clients detected. Run with --client <name> to wire a specific client.");
          } else {
            console.log(`\n   Detected MCP clients: ${detected.map(c => c.label).join(", ")}`);
          }
        }

        const toWire: ClientId[] = clientOpt === "all"
          ? clients.filter(c => c.detected).map(c => c.id)
          : selectedClients.length > 0
            ? selectedClients
            : clients.filter(c => c.detected).map(c => c.id);

        // `--client all` is a promise about every client, so the ones it
        // passed over have to be accounted for too — silently omitting them
        // is how "all" reports success for work it never did (flair#906).
        if (clientOpt === "all") {
          for (const c of clients) {
            if (!c.detected) skippedUndetected.push(c.label);
          }
        }

        for (const clientId of toWire) {
          if (clientId === "claude-code") {
            // Claude Code gets real auto-wiring into ~/.claude.json (zero-install
            // npx form; matches the snippets everywhere else). Other clients only
            // get printed instructions — the CLI can't safely edit their configs.
            const claudeJsonPath = join(homedir(), ".claude.json");
            const flairMcpConfig = {
              type: "stdio" as const,
              command: "npx",
              args: ["-y", mcpServerSpec()] as string[],
              // flair#718 authorship-provenance: each client's wired env block
              // gets its OWN FLAIR_CLIENT label (never the shared mcpEnv
              // object directly — that would stamp the same label into every
              // client's config) so writes from THIS client's proxy stamp
              // provenance.claimed.client = "claude-code".
              env: { ...mcpEnv, FLAIR_CLIENT: "claude-code" },
            };
            // ~/.claude.json exists once Claude Code has been RUN, not once it
            // is installed — so gating the write on it skipped every user who
            // installed Claude Code and Flair in the same sitting (flair#906).
            // The file is Claude Code's own and creating it with a single
            // `mcpServers` key is exactly what `claude mcp add` does, so an
            // absent file is created rather than turned into a printed snippet
            // the user has to notice and act on.
            try {
              const claudeJsonExisted = existsSync(claudeJsonPath);
              const claudeJson = claudeJsonExisted
                ? JSON.parse(readFileSync(claudeJsonPath, "utf-8"))
                : {};
              const existing = claudeJson.mcpServers?.flair;
              const currentSpec = mcpServerSpec();
              const existingArgs = existing?.args;
              const argsMatch = Array.isArray(existingArgs) && existingArgs.includes(currentSpec);
              const urlAgentMatch = existing && existing.env?.FLAIR_URL === httpUrl && existing.env?.FLAIR_AGENT_ID === agentId;
              // flair#1135: the pin in `args` must match the current mcpServerSpec().
              // A matching pin stays a no-op (idempotent); only a stale pin triggers a re-write.
              if (urlAgentMatch && argsMatch) {
                console.log(`   ✓ Claude Code already wired in ~/.claude.json`);
                wiringResults.push({ client: "claude-code", message: "already wired", wired: true });
              } else {
                // flair#1778 slice 2c-i-a2: a pin mismatch is NOT automatically a
                // re-write — never LOWER the pin already in ~/.claude.json (and
                // never overwrite a range/tag/unsupported spec, nor write when
                // this CLI cannot read its own version).
                const decision = decidePinWrite({
                  pkg: FLAIR_MCP_PACKAGE,
                  entry: "Claude Code config ~/.claude.json",
                  existingText: existing ? JSON.stringify(existing) : null,
                  runningVersion: flairCliVersion(),
                });
                if (decision.action !== "write") {
                  console.log(`   ${render.icons.warn} ${decision.line}`);
                  wiringResults.push({
                    client: "claude-code",
                    message: decision.action === "hold"
                      ? "held the existing pin in ~/.claude.json"
                      : "refused to write ~/.claude.json (unreadable CLI version)",
                    wired: !!existing,
                  });
                } else {
                claudeJson.mcpServers = claudeJson.mcpServers || {};
                claudeJson.mcpServers.flair = flairMcpConfig;
                writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
                const action = urlAgentMatch ? "refreshed pin in ~/.claude.json"
                  : claudeJsonExisted ? "wired in ~/.claude.json"
                  : "wired in ~/.claude.json (created)";
                console.log(`   ✓ Claude Code ${action} (restart Claude Code to pick it up)`);
                wiringResults.push({
                  client: "claude-code",
                  message: urlAgentMatch ? "refreshed pin in ~/.claude.json"
                    : claudeJsonExisted ? "wired ~/.claude.json"
                    : "created and wired ~/.claude.json",
                  wired: true,
                });
                }
              }
            } catch (err: unknown) {
              // Only a genuine read/parse/write failure lands here now (bad
              // permissions, malformed existing JSON) — never merely "the file
              // does not exist yet".
              const reason = err instanceof Error ? err.message : String(err);
              console.log(`   ${render.icons.warn} Claude Code: could not write ~/.claude.json (${reason})`);
              console.log(`   MCP config (add manually to ~/.claude.json):`);
              console.log(`     { "mcpServers": { "flair": ${JSON.stringify(flairMcpConfig)} } }`);
              wiringResults.push({ client: "claude-code", message: `snippet printed (${reason})`, wired: false });
            }

            // ── CLAUDE.md bootstrap line (flair#597) ──────────────────────────
            // The MCP block alone isn't a working setup — Claude Code also needs
            // the bootstrap instruction in CLAUDE.md, or it never calls
            // mcp__flair__bootstrap and memory silently does nothing. Applied
            // automatically here (same "just do it" shape as the MCP block
            // above); --skip-claude-md opts out and prints the exact line to
            // add by hand instead.
            const claudeMdResult = applyOrReportClaudeMdBootstrap(process.cwd(), homedir(), !!opts.skipClaudeMd);
            console.log(`   ${claudeMdResult.ok ? "✓" : "•"} ${claudeMdResult.message}`);
            if (claudeMdResult.hint) {
              for (const line of claudeMdResult.hint.split("\n")) console.log(`   ${line}`);
            }

            // ── SessionStart hook (flair#597) ─────────────────────────────────
            // Auto-recall on session start needs this hook wired into
            // ~/.claude/settings.json — without it, mcp__flair__bootstrap only
            // ever runs if the agent remembers to call it itself.
            // --skip-hook opts out and prints the exact JSON to add by hand.
            const hookResult = applyOrReportSessionStartHook(homedir(), agentId, !!opts.skipHook);
            console.log(`   ${hookResult.ok ? "✓" : "•"} ${hookResult.message}`);
            if (hookResult.hint) {
              for (const line of hookResult.hint.split("\n")) console.log(`   ${line}`);
            }
          } else {
            let result: { ok: boolean; message: string };
            // flair#718 authorship-provenance — see the claude-code branch's
            // identical comment above: FLAIR_CLIENT is per-client, so it's
            // added at each call site rather than baked into the shared mcpEnv.
            switch (clientId) {
              case "codex": result = wireCodex({ ...mcpEnv, FLAIR_CLIENT: "codex" }); break;
              case "gemini": result = wireGemini({ ...mcpEnv, FLAIR_CLIENT: "gemini" }); break;
              case "cursor": result = wireCursor({ ...mcpEnv, FLAIR_CLIENT: "cursor" }); break;
              case "antigravity": result = wireAntigravity({ ...mcpEnv, FLAIR_CLIENT: "antigravity" }); break;
              // pi is a NATIVE EXTENSION, not an MCP client (flair#1342):
              // wirePi edits ~/.pi/agent/settings.json `packages`, and pi
              // settings carry no env block — no FLAIR_CLIENT to stamp; the
              // wire message tells the user what to export at pi launch.
              case "pi": result = wirePi(mcpEnv); break;
              default: result = { ok: false, message: `Unknown client: ${clientId}` };
            }
            wiringResults.push({ client: clientId, message: result.message, wired: result.ok });
            console.log(`   ${result.ok ? "✓" : "•"} ${result.message}`);
            // Codex SessionStart hook (flair#1148 / #1439) — the hook is not
            // optional on Codex (no CLAUDE.md alternative). Init is the
            // consent to set up the client, same as the Claude Code hook
            // applied above. --skip-hook opts out and prints the JSON.
            if (clientId === "codex" && result.ok) {
              const hookResult = applyOrReportSessionStartHook(
                homedir(),
                agentId,
                !!opts.skipHook,
                hookSettingsPath(homedir(), "codex"),
              );
              console.log(`   ${hookResult.ok ? "✓" : "•"} ${hookResult.message}`);
              if (hookResult.hint) {
                for (const line of hookResult.hint.split("\n")) console.log(`   ${line}`);
              }
            }
          }
        }
      }

      // ── Smoke-test the MCP server ────────────────────────────────────────
      // Launch flair-mcp and confirm it answers a JSON-RPC initialize over
      // stdio. Best-effort: failures warn but never fail the command. Skipped
      // with --skip-smoke, --no-mcp, --client none, or when nothing was wired.
      // pi doesn't run flair-mcp (native extension, flair#1342), so a pi-only
      // wiring has nothing this smoke test exercises — spawning it anyway
      // would render a green "MCP server responded" for a setup that never
      // starts an MCP server.
      const wiredAnyMcpClient = wiringResults.some((r) => r.client !== "pi");
      if (!opts.skipSmoke && !noMcp && clientOpt !== "none" && wiringResults.length > 0 && wiredAnyMcpClient) {
        console.log("\n   Smoke-testing MCP server...");
        try {
          // Same spec that gets WIRED above — the smoke test must exercise the
          // exact version the user will run, not whatever npm resolves latest to.
          const mcpProc = spawn("npx", ["-y", mcpServerSpec()], {
            env: { ...process.env, FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "0.1", capabilities: {}, clientInfo: { name: "flair-init", version: "1.0.0" } } });
          mcpProc.stdin!.write(initMsg + "\n");
          mcpProc.stdin!.end();
          let stdout = "";
          mcpProc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
          // A single timer drives the timeout AND cleanup. It MUST be cleared on
          // settle — an un-cleared setTimeout is a live handle that keeps Node's
          // event loop alive (the ~60s phantom hang after `flair init` printed
          // success: the smoke timer + the lingering npx child both pinned the
          // loop). We clear it on every exit path below.
          let smokeTimer: ReturnType<typeof setTimeout> | null = null;
          await new Promise<void>((resolve, reject) => {
            const settle = (fn: () => void) => {
              if (smokeTimer) { clearTimeout(smokeTimer); smokeTimer = null; }
              fn();
            };
            mcpProc.on("exit", (code) => {
              settle(() => {
                if (code === 0 && stdout.length > 0) resolve();
                else reject(new Error(`MCP server exited with code ${code}`));
              });
            });
            mcpProc.on("error", (err) => settle(() => reject(err)));
            smokeTimer = setTimeout(() => settle(() => { mcpProc.kill("SIGKILL"); reject(new Error("MCP smoke test timed out")); }), 15_000);
          });
          try {
            const lines = stdout.split("\n").filter(l => l.trim());
            for (const line of lines) {
              const parsed = JSON.parse(line);
              if (parsed.jsonrpc === "2.0" && parsed.id === 1 && !parsed.error) {
                console.log("   ✓ MCP server responded");
                break;
              }
            }
          } catch {
            console.log("   ⚠ MCP server responded but response could not be parsed");
          } finally {
            // Reap the child even on the resolve path: the MCP server exits on
            // stdin close, but the `npx` wrapper can linger holding the loop.
            // SIGKILL is safe — we already have the response we need.
            try { if (mcpProc.exitCode === null) mcpProc.kill("SIGKILL"); } catch { /* already gone */ }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`   ⚠ MCP smoke test failed: ${message}`);
          console.log("   Use --skip-smoke to bypass.");
        }
      }

      // ── MCP wiring summary (flair#906) ───────────────────────────────────
      // LAST thing init prints, deliberately. Every fact below was already
      // available mid-run, but a client that was not wired appeared only as a
      // snippet in the middle of a wall of output, after a success line — so
      // the user's next action was to open their client and find nothing
      // there, with no reason to suspect init. A client the user asked for and
      // did NOT get must still be on screen when the command finishes.
      if (!noMcp && clientOpt !== "none") {
        // The pin warning repeats here for the same reason the summary exists:
        // a warning only in scrollback is a warning the user acts on never.
        const summaryLines = renderWiringSummary(wiringResults, {
          labels: clientLabels,
          skippedUndetected,
          rewireHint: `flair init --agent ${agentId} --client all`,
          unpinned: unpinnedSpecWarning() !== null,
        });
        for (const line of summaryLines) {
          const icon =
            line.level === "ok" ? render.icons.ok :
            line.level === "error" ? render.icons.error :
            line.level === "warn" ? render.icons.warn :
            line.level === "muted" ? render.icons.bullet :
            null;
          if (line.level === "heading") console.log(`\n   ${line.text}`);
          else console.log(`   ${icon} ${line.text}`);
        }
      }
    } else {
      const httpUrl = `http://127.0.0.1:${httpPort}`;
      console.log("\n✅ Flair initialized (no agent registered)");
      console.log(`   Flair URL:   ${httpUrl}`);
      
      // Display admin credentials when password was generated or from a file
      // Do NOT display when from env (to avoid showing the env var value)
      if (passwordSource !== "env" && !alreadyRunning) {
        const passDisplay = passwordSource === "file"
          ? opts.adminPassFile ?? "(file path)"
          : "~/.flair/admin-pass";
        console.log(`\n   ┌─────────────────────────────────────────────────┐`);
        console.log(`   │  Harper admin credentials (save these now):     │`);
        console.log(`   │                                                 │`);
        console.log(`   │  Username: ${DEFAULT_ADMIN_USER.padEnd(37)}│`);
        console.log(`   │  Password: ${passDisplay.padEnd(37)}│`);
        console.log(`   │                                                 │`);
        console.log(`   │  ⚠️  The password won't be shown again.         │`);
        console.log(`   └─────────────────────────────────────────────────┘`);
      }
      console.log(`\n   Export: FLAIR_URL=${httpUrl}`);

      // flair#802a: a non-interactive shell (CI, Docker, an unattended setup
      // script) that omits --agent lands here with NO indication that agent
      // registration, MCP client wiring, and the smoke test were all skipped
      // — the run exits 0 and looks complete. In a real TTY the missing
      // --agent is usually obvious from the command the user just typed;
      // non-interactively it's easy to never notice until something that
      // needed the agent (recall, an MCP client) mysteriously doesn't work.
      if (!process.stdin.isTTY) {
        console.log(`\n   ℹ Non-interactive shell: skipped agent registration, MCP client wiring, and the smoke test.`);
        console.log(`     Complete setup with: flair init --agent <id> --client all`);
      }
    }

    // All init work is genuinely done at this point: Harper is installed +
    // running (detached, unref'd — survives this process exiting), the agent is
    // registered, semantic search is verified, MCP clients are wired, and the
    // smoke test ran. The MCP smoke subprocess can leave a lingering npx handle
    // that pins Node's event loop for ~60s after success ("rc=0 but doesn't
    // return"). We've cleared/unref'd the known timers above; exit explicitly so
    // the prompt returns in a couple seconds regardless of any stray handle. The
    // running Harper instance is unaffected.
    await new Promise<void>((r) => process.stdout.write("", () => r()));
    process.exit(0);
  });

}
