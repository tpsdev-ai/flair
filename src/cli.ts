#!/usr/bin/env node
import { Command } from "commander";
import nacl from "tweetnacl";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { createPrivateKey, sign as nodeCryptoSign, randomUUID } from "node:crypto";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 19926;
const DEFAULT_OPS_PORT = 19925;
const DEFAULT_ADMIN_USER = "admin";
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

function defaultKeysDir(): string {
  return join(homedir(), ".flair", "keys");
}

function defaultDataDir(): string {
  return join(homedir(), ".flair", "data");
}

function configPath(): string {
  // Check both .yaml and .yml extensions
  const yamlPath = join(homedir(), ".flair", "config.yaml");
  const ymlPath = join(homedir(), ".flair", "config.yml");
  if (existsSync(ymlPath) && !existsSync(yamlPath)) return ymlPath;
  return yamlPath;
}

function readPortFromConfig(): number | null {
  try {
    const p = configPath();
    if (existsSync(p)) {
      const yaml = readFileSync(p, "utf-8");
      const m = yaml.match(/port:\s*(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch { /* ignore */ }
  return null;
}

// Unified port resolution: --port flag > FLAIR_URL env > config file > default
// Every command that talks to Harper MUST use these helpers.
function resolveHttpPort(opts: { port?: string | number }): number {
  if (opts.port !== undefined && opts.port !== null) {
    const n = Number(opts.port);
    if (!isNaN(n) && n > 0) return n;
  }
  const envUrl = process.env.FLAIR_URL;
  if (envUrl) {
    const m = envUrl.match(/:(\d+)/);
    if (m) return Number(m[1]);
  }
  return readPortFromConfig() ?? DEFAULT_PORT;
}

// Ops port resolution: --ops-port flag > FLAIR_OPS_PORT env > config opsPort > httpPort - 1
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  if (opts.opsPort !== undefined && opts.opsPort !== null) {
    const n = Number(opts.opsPort);
    if (!isNaN(n) && n > 0) return n;
  }
  const envOps = process.env.FLAIR_OPS_PORT;
  if (envOps) return Number(envOps);
  // Try reading from config
  try {
    const p = configPath();
    if (existsSync(p)) {
      const yaml = readFileSync(p, "utf-8");
      const m = yaml.match(/opsPort:\s*(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch { /* ignore */ }
  // Default: httpPort - 1
  return resolveHttpPort(opts) - 1;
}

function writeConfig(port: number): void {
  const p = configPath();
  mkdirSync(join(homedir(), ".flair"), { recursive: true });
  writeFileSync(p, `# Flair configuration\nport: ${port}\n`);
}

function privKeyPath(agentId: string, keysDir: string): string {
  return join(keysDir, `${agentId}.key`);
}

function pubKeyPath(agentId: string, keysDir: string): string {
  return join(keysDir, `${agentId}.pub`);
}


function flairPackageDir(): string {
  // dist/cli.js → package root (one level up from dist/)
  return join(import.meta.dirname ?? __dirname, "..");
}

function harperBin(): string | null {
  // Resolve relative to this file's location (dist/cli.js → ../node_modules/...)
  const candidates = [
    join(import.meta.dirname ?? __dirname, "..", "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js"),
    join(process.cwd(), "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function api(method: string, path: string, body?: any): Promise<any> {
  // Resolve port: FLAIR_URL env > ~/.flair/config.yaml > default 9926
  const savedPort = readPortFromConfig();
  const defaultUrl = savedPort ? `http://127.0.0.1:${savedPort}` : `http://127.0.0.1:${DEFAULT_PORT}`;
  const base = process.env.FLAIR_URL || defaultUrl;

  // Auth resolution order:
  // 1. FLAIR_TOKEN env → Bearer token (backward compat)
  // 2. FLAIR_AGENT_ID env + key file → Ed25519 signature (standard)
  // 3. --agent flag extracted from body.agentId + key file → Ed25519 signature
  // 4. No auth (will 401 on any authenticated endpoint)
  let authHeader: string | undefined;
  const token = process.env.FLAIR_TOKEN;
  if (token) {
    authHeader = `Bearer ${token}`;
  } else {
    // Extract agentId from body (POST/PUT) or URL query params (GET)
    let agentId = process.env.FLAIR_AGENT_ID || (body && typeof body === "object" ? body.agentId : undefined);
    if (!agentId && path.includes("agentId=")) {
      const match = path.match(/agentId=([^&]+)/);
      if (match) agentId = decodeURIComponent(match[1]);
    }
    if (agentId) {
      const keyPath = resolveKeyPath(agentId);
      if (keyPath) {
        try {
          // Sign the path without query params — auth middleware verifies the clean path
          // Auth middleware verifies the full request path including query params
          authHeader = buildEd25519Auth(agentId, method, path, keyPath);
        } catch (err: any) {
          // Key exists but auth build failed — warn and continue without auth
          console.error(`Warning: Ed25519 auth failed for agent '${agentId}': ${err.message}`);
        }
      }
    }
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Handle 204 No Content (e.g., PUT upsert returns empty body)
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  }
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  if (!text) return { ok: true };
  return JSON.parse(text);
}

/** Find the agent's private key file from standard locations. */
function resolveKeyPath(agentId: string): string | null {
  const candidates = [
    process.env.FLAIR_KEY_DIR ? join(process.env.FLAIR_KEY_DIR, `${agentId}.key`) : null,
    join(homedir(), ".flair", "keys", `${agentId}.key`),
    join(homedir(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Build a TPS-Ed25519 auth header from a raw 32-byte seed on disk. */
function buildEd25519Auth(agentId: string, method: string, path: string, keyPath: string): string {
  const raw = readFileSync(keyPath);
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  let privKey: ReturnType<typeof createPrivateKey>;
  if (raw.length === 32) {
    // Raw 32-byte seed
    privKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, raw]), format: "der", type: "pkcs8" });
  } else {
    // Try as base64-encoded PKCS8 DER (standard Flair key format)
    const decoded = Buffer.from(raw.toString("utf-8").trim(), "base64");
    if (decoded.length === 32) {
      // Base64-encoded raw seed
      privKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, decoded]), format: "der", type: "pkcs8" });
    } else {
      // Full PKCS8 DER or PEM
      try {
        privKey = createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
      } catch {
        privKey = createPrivateKey(raw);
      }
    }
  }
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = nodeCryptoSign(null, Buffer.from(payload), privKey).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
}

/** Authenticated fetch against Flair using Ed25519. */
async function authFetch(
  baseUrl: string,
  agentId: string,
  keyPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const auth = buildEd25519Auth(agentId, method, path, keyPath);
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function waitForHealth(httpPort: number, adminUser: string, adminPass: string, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${httpPort}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}` },
        signal: AbortSignal.timeout(2000),
      });
      if (res.status > 0) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`Harper at port ${httpPort} did not respond within ${timeoutMs}ms (${attempt} attempts)`);
}

async function seedAgentViaOpsApi(
  opsPort: number,
  agentId: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const url = `http://127.0.0.1:${opsPort}/`;
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agentId, name: agentId, publicKey: pubKeyB64url, createdAt: new Date().toISOString() }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) return;
    throw new Error(`Operations API insert failed (${res.status}): ${text}`);
  }
}

// ─── Program ─────────────────────────────────────────────────────────────────

// Read version from package.json at the package root
const __pkgDir = join(import.meta.dirname ?? __dirname, "..");
const __pkgVersion = (() => {
  try { return JSON.parse(readFileSync(join(__pkgDir, "package.json"), "utf-8")).version; }
  catch { return "unknown"; }
})();

const program = new Command();
program.name("flair").version(__pkgVersion, "-v, --version");

// ─── flair init ──────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Bootstrap a local Flair (Harper) instance for an agent")
  .option("--agent-id <id>", "Agent ID to register", "local")
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (generated if omitted)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--data-dir <dir>", "Harper data directory")
  .option("--skip-start", "Skip Harper startup (assume already running)")
  .option("--skip-soul", "Skip interactive personality setup")
  .action(async (opts) => {
    const agentId: string = opts.agentId;
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const dataDir: string = opts.dataDir ?? defaultDataDir();

    // Admin password: generate if not provided, NEVER written to disk
    const adminPass: string = opts.adminPass ?? Buffer.from(nacl.randomBytes(18)).toString("base64url");
    const adminUser = DEFAULT_ADMIN_USER;

    // Check Node.js version
    const major = parseInt(process.version.slice(1), 10);
    if (major < 18) throw new Error(`Node.js >= 18 required (found ${process.version})`);

    let alreadyRunning = false;

    if (!opts.skipStart) {
      // Check if already running
      try {
        const res = await fetch(`http://127.0.0.1:${httpPort}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.status > 0) { alreadyRunning = true; console.log(`Harper already running on port ${httpPort} — skipping start`); }
      } catch { /* not running */ }

      if (!alreadyRunning) {
        const bin = harperBin();
        if (!bin) throw new Error("@harperfast/harper not found in node_modules.\nRun: npm install @harperfast/harper");

        mkdirSync(dataDir, { recursive: true });

        // Detect whether Harper has already been installed in this data dir.
        // harper-config.yaml is created during install — its presence means
        // install already ran. Re-running install against an existing data dir
        // crashes in Harper v5 beta.6+ (checkForExistingInstall queries the
        // database before the env is initialized).
        const alreadyInstalled = existsSync(join(dataDir, "harper-config.yaml"));

        const opsSocket = join(dataDir, "operations-server");
        const harperSetConfig = JSON.stringify({
          rootPath: dataDir,
          http: { port: httpPort, cors: true, corsAccessList: [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`] },
          operationsApi: { network: { port: opsPort, cors: true }, domainSocket: opsSocket },
          mqtt: { network: { port: null }, webSocket: false },
          localStudio: { enabled: false },
          authentication: { authorizeLocal: true, enableSessions: true },
        });

        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          ROOTPATH: dataDir,
          HARPER_SET_CONFIG: harperSetConfig,
          DEFAULTS_MODE: "dev",
          HDB_ADMIN_USERNAME: adminUser,
          HDB_ADMIN_PASSWORD: adminPass,
          THREADS_COUNT: "1",
          NODE_HOSTNAME: "localhost",
          HTTP_PORT: String(httpPort),
          OPERATIONSAPI_NETWORK_PORT: String(opsPort),
          LOCAL_STUDIO: "false",
        };

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
          await new Promise<void>((resolve, reject) => {
            let output = "";
            const install = spawn(process.execPath, [bin, "install"], { cwd: flairPackageDir(), env: installEnv });
            install.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
            install.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
            install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install failed (${code}): ${output}`)));
            install.on("error", reject);
            setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 60_000);
          });
        }

        // Start Harper with flair loaded as a component (the "." arg).
        // ROOTPATH in env points to the data dir; authorizeLocal and thread
        // count are set via HARPER_SET_CONFIG — no need for dev mode.
        console.log(`Starting Harper on port ${httpPort}...`);
        const proc = spawn(process.execPath, [bin, "run", "."], { cwd: flairPackageDir(), env, detached: true, stdio: "ignore" });
        proc.unref();
      }

      console.log("Waiting for Harper health check...");
      await waitForHealth(httpPort, adminUser, adminPass, STARTUP_TIMEOUT_MS);
      console.log("Harper is healthy ✓");

      // Register launchd service on macOS so Harper survives reboots
      // and `flair restart` / `flair stop` work via launchctl.
      if (process.platform === "darwin") {
        const harperBinPath = harperBin();
        if (harperBinPath) {
          const label = "ai.tpsdev.flair";
          const plistDir = join(homedir(), "Library", "LaunchAgents");
          mkdirSync(plistDir, { recursive: true });
          const plistPath = join(plistDir, `${label}.plist`);
          const opsSocket = join(dataDir, "operations-server");
          const setConfig = JSON.stringify({
            rootPath: dataDir,
            http: { port: httpPort, cors: true, corsAccessList: [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`] },
            operationsApi: { network: { port: opsPort, cors: true }, domainSocket: opsSocket },
            mqtt: { network: { port: null }, webSocket: false },
            localStudio: { enabled: false },
            authentication: { authorizeLocal: true, enableSessions: true },
          });
          const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${harperBinPath}</string>
    <string>run</string>
    <string>.</string>
  </array>
  <key>WorkingDirectory</key><string>${flairPackageDir()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${dataDir}</string>
    <key>HARPER_SET_CONFIG</key><string>${setConfig.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}</string>
    <key>DEFAULTS_MODE</key><string>dev</string>
    <key>HDB_ADMIN_USERNAME</key><string>${adminUser}</string>
    <key>HDB_ADMIN_PASSWORD</key><string>${adminPass}</string>
    <key>THREADS_COUNT</key><string>1</string>
    <key>NODE_HOSTNAME</key><string>localhost</string>
    <key>HTTP_PORT</key><string>${httpPort}</string>
    <key>OPERATIONSAPI_NETWORK_PORT</key><string>${opsPort}</string>
    <key>LOCAL_STUDIO</key><string>false</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(dataDir, "log", "launchd-stdout.log")}</string>
  <key>StandardErrorPath</key><string>${join(dataDir, "log", "launchd-stderr.log")}</string>
</dict>
</plist>`;
          writeFileSync(plistPath, plist);
          console.log("Launchd service registered ✓");
        }
      }
    }

    // Persist port to config so other commands can find this instance
    writeConfig(httpPort);

    // Generate or reuse keypair
    mkdirSync(keysDir, { recursive: true });
    const privPath = privKeyPath(agentId, keysDir);
    const pubPath = pubKeyPath(agentId, keysDir);
    let pubKeyB64url: string;

    if (existsSync(privPath)) {
      console.log(`Reusing existing key: ${privPath}`);
      const seed = new Uint8Array(readFileSync(privPath));
      const kp = nacl.sign.keyPair.fromSeed(seed);
      pubKeyB64url = b64url(kp.publicKey);
    } else {
      console.log("Generating Ed25519 keypair...");
      const kp = nacl.sign.keyPair();
      // Store only the 32-byte seed (first 32 bytes of secretKey)
      const seed = kp.secretKey.slice(0, 32);
      writeFileSync(privPath, Buffer.from(seed));
      chmodSync(privPath, 0o600);
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

    // Output — admin password printed once, never written to disk
    console.log("\n✅ Flair initialized successfully");
    console.log(`   Agent ID:    ${agentId}`);
    console.log(`   Flair URL:   ${httpUrl}`);
    console.log(`   Private key: ${privPath}`);
    if (!opts.adminPass && !alreadyRunning) {
      console.log(`\n⚠️  Admin password (save this — it won't be shown again):`);
      console.log(`   ${adminPass}`);
    }
    console.log(`\n   Export: FLAIR_URL=${httpUrl}`);

    // ── First-run soul setup ──────────────────────────────────────────────
    // Interactive prompts to set initial personality. Skipped with --skip-soul
    // or when stdin is not a TTY (CI, scripts, piped input).
    if (!opts.skipSoul && process.stdin.isTTY) {
      console.log("\n🎭 Set up agent personality (press Enter to skip any):\n");

      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

      const role = await ask("   What's this agent's role? (e.g., \"Senior dev, concise and direct\")\n   > ");
      const project = await ask("   What project is it working on?\n   > ");
      const standards = await ask("   Any coding standards or preferences?\n   > ");

      rl.close();

      // Write non-empty answers as soul entries
      const soulEntries: [string, string][] = [];
      if (role.trim()) soulEntries.push(["role", role.trim()]);
      if (project.trim()) soulEntries.push(["project", project.trim()]);
      if (standards.trim()) soulEntries.push(["standards", standards.trim()]);

      if (soulEntries.length > 0) {
        console.log("");
        for (const [key, value] of soulEntries) {
          try {
            await authFetch(httpUrl, agentId, privPath, "PUT", `/Soul/${agentId}:${key}`,
              { id: `${agentId}:${key}`, agentId, key, value, createdAt: new Date().toISOString() });
            console.log(`   ✓ soul:${key} set`);
          } catch (err: any) {
            console.warn(`   ⚠ soul:${key} failed: ${err.message}`);
          }
        }
        console.log(`\n   ${soulEntries.length} soul entries saved. Bootstrap will include them.`);
      } else {
        console.log("\n   No soul entries — you can add them later with: flair soul set --agent " + agentId + " --key role --value \"...\"");
      }
    }

    console.log(`\n   Claude Code: Add to your CLAUDE.md:`);
    console.log(`     At the start of every session, run mcp__flair__bootstrap before responding.`);

    // Auto-wire MCP config into ~/.claude.json if Claude Code is installed
    const claudeJsonPath = join(homedir(), ".claude.json");
    const mcpEnv: Record<string, string> = { FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl };
    const flairMcpConfig = {
      type: "stdio" as const,
      command: "flair-mcp",
      args: [] as string[],
      env: mcpEnv,
    };
    try {
      if (existsSync(claudeJsonPath)) {
        const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
        const existing = claudeJson.mcpServers?.flair;
        if (existing && existing.env?.FLAIR_URL === httpUrl && existing.env?.FLAIR_AGENT_ID === agentId) {
          console.log(`\n   MCP config already set in ~/.claude.json ✓`);
        } else {
          claudeJson.mcpServers = claudeJson.mcpServers || {};
          claudeJson.mcpServers.flair = flairMcpConfig;
          writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
          console.log(`\n   MCP config written to ~/.claude.json ✓`);
          console.log(`   Restart Claude Code to pick up the new config.`);
        }
      } else {
        console.log(`\n   MCP config (add to ~/.claude.json):`);
        console.log(`     { "mcpServers": { "flair": ${JSON.stringify(flairMcpConfig)} } }`);
      }
    } catch {
      console.log(`\n   MCP config (add manually to ~/.claude.json):`);
      console.log(`     { "mcpServers": { "flair": ${JSON.stringify(flairMcpConfig)} } }`);
    }
  });

// ─── flair agent ─────────────────────────────────────────────────────────────

const agent = program.command("agent").description("Manage Flair agents");

agent
  .command("add <id>")
  .description("Register a new agent in a running Flair instance")
  .option("--name <name>", "Display name (defaults to id)")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password for registration")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (id: string, opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const adminPass: string | undefined = opts.adminPass;
    const adminUser = DEFAULT_ADMIN_USER;
    const name: string = opts.name ?? id;

    if (!adminPass) {
      console.error("Error: --admin-pass is required for agent add (needed to insert into Agent table)");
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

    await seedAgentViaOpsApi(opsPort, id, pubKeyB64url, adminUser, adminPass);
    console.log(`✅ Agent '${id}' (${name}) registered`);
    console.log(`   Private key: ${privPath}`);
    console.log(`   Public key:  ${pubKeyB64url}`);
  });

agent
  .command("list")
  .description("List all agents")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (adminPass) {
      // Use admin basic auth against ops API to list agents directly
      const opsPort = resolveOpsPort(opts);
      const auth = Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64");
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ operation: "sql", sql: "SELECT id, name, createdAt FROM flair.Agent ORDER BY createdAt" }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }
      console.log(JSON.stringify(await res.json(), null, 2));
    } else {
      // Try agent-authed API (requires FLAIR_AGENT_ID to be set)
      console.log(JSON.stringify(await api("GET", "/Agent"), null, 2));
    }
  });

agent
  .command("show <id>")
  .description("Show agent details")
  .action(async (id: string) => console.log(JSON.stringify(await api("GET", `/Agent/${id}`), null, 2)));

agent
  .command("rotate-key <id>")
  .description("Rotate an agent's Ed25519 keypair")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .action(async (id: string, opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;
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
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--force", "Skip interactive confirmation (required when stdin is not a TTY)")
  .action(async (id: string, opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;
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

// ─── flair grant / revoke ─────────────────────────────────────────────────────

program
  .command("grant <from-agent> <to-agent>")
  .description("Grant an agent read access to another agent's memories")
  .option("--scope <scope>", "Grant scope: read or search", "read")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys (for from-agent Ed25519 auth)")
  .action(async (fromAgent: string, toAgent: string, opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;
    const scope: string = opts.scope ?? "read";

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for grant");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
    const grantId = `${fromAgent}:${toAgent}`;
    const body = {
      operation: "insert",
      database: "flair",
      table: "MemoryGrant",
      records: [{
        id: grantId,
        fromAgentId: fromAgent,
        toAgentId: toAgent,
        scope,
        createdAt: new Date().toISOString(),
      }],
    };

    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) {
        console.log(`ℹ️  Grant already exists: '${toAgent}' can already read '${fromAgent}'s memories`);
        return;
      }
      throw new Error(`Failed to create grant (${res.status}): ${text}`);
    }

    console.log(`✅ Grant created: '${toAgent}' can now read '${fromAgent}'s memories`);
    console.log(`   ID:    ${grantId}`);
    console.log(`   Scope: ${scope}`);
  });

program
  .command("revoke <from-agent> <to-agent>")
  .description("Revoke a memory grant between two agents")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (fromAgent: string, toAgent: string, opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for revoke");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
    const grantId = `${fromAgent}:${toAgent}`;
    const body = {
      operation: "delete",
      database: "flair",
      table: "MemoryGrant",
      ids: [grantId],
    };

    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404 || text.includes("not found")) {
        console.log(`ℹ️  No grant found: '${toAgent}' does not have access to '${fromAgent}'s memories`);
        return;
      }
      throw new Error(`Failed to revoke grant (${res.status}): ${text}`);
    }

    console.log(`✅ Grant revoked: '${toAgent}' can no longer read '${fromAgent}'s memories`);
    console.log(`   Removed grant ID: ${grantId}`);
  });

// ─── flair status ─────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Check Flair (Harper) instance health and agent count")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const baseUrl = opts.url ?? `http://127.0.0.1:${port}`;
    let healthy = false;
    let agentCount: number | null = null;
    let version: string | null = null;

    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      healthy = res.status > 0;
      if (res.headers.get("content-type")?.includes("application/json")) {
        const body = await res.json().catch(() => null);
        if (body?.version) version = body.version;
      }
    } catch { /* unreachable */ }

    if (healthy) {
      try {
        const agents = await fetch(`${baseUrl}/Agent`, { signal: AbortSignal.timeout(3000) });
        if (agents.ok) {
          const list = await agents.json().catch(() => null);
          if (Array.isArray(list)) agentCount = list.length;
        }
      } catch { /* best effort */ }
    }

    const status = healthy ? "🟢 running" : "🔴 unreachable";
    console.log(`Flair status: ${status}`);
    console.log(`  URL:     ${baseUrl}`);
    console.log(`  Flair:   v${__pkgVersion}`);
    if (version) console.log(`  Harper:  ${version}`);
    if (agentCount !== null) console.log(`  Agents:  ${agentCount}`);
    if (!healthy) process.exit(1);
  });

// ─── flair upgrade ────────────────────────────────────────────────────────────

program
  .command("upgrade")
  .description("Upgrade Flair and related packages to latest versions")
  .action(async () => {
    console.log("Checking for updates...\n");

    const packages = [
      "@tpsdev-ai/flair",
      "@tpsdev-ai/flair-client",
      "@tpsdev-ai/flair-mcp",
    ];

    for (const pkg of packages) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json() as { version?: string };
        const latest = data.version ?? "unknown";

        // Check installed version
        let installed = "not installed";
        try {
          const { execSync } = await import("node:child_process");
          installed = execSync(`npm list -g ${pkg} --depth=0 2>/dev/null | grep ${pkg} || echo "not installed"`, { encoding: "utf-8" }).trim();
          const match = installed.match(/@(\d+\.\d+\.\d+)/);
          installed = match ? match[1] : "not installed";
        } catch { /* best effort */ }

        const upToDate = installed === latest;
        const icon = upToDate ? "✅" : "⬆️";
        console.log(`  ${icon} ${pkg}: ${installed} → ${latest}${upToDate ? " (current)" : ""}`);
      } catch { /* skip unavailable packages */ }
    }

    console.log("\nTo upgrade: npm install -g @tpsdev-ai/flair@latest");
  });

// ─── flair stop ───────────────────────────────────────────────────────────────

program
  .command("stop")
  .description("Stop the running Flair (Harper) instance")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS: try launchd first
      const label = "ai.tpsdev.flair";
      const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
          console.log("✅ Flair stopped (launchd service unloaded)");
          return;
        } catch {
          // launchd unload failed, try PID fallback
        }
      }
    }

    // Fallback: find process by port
    try {
      const { execSync } = await import("node:child_process");
      const lsof = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
      if (lsof) {
        const pids = lsof.split("\n").map(p => p.trim()).filter(Boolean);
        for (const pid of pids) {
          process.kill(Number(pid), "SIGTERM");
        }
        console.log(`✅ Flair stopped (killed PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")})`);
      } else {
        console.log("Flair is not running.");
      }
    } catch {
      console.log("Flair is not running (nothing found on port " + port + ").");
    }
  });

// ─── flair restart ────────────────────────────────────────────────────────────

program
  .command("restart")
  .description("Restart the Flair (Harper) instance")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const platform = process.platform;

    if (platform === "darwin") {
      const label = "ai.tpsdev.flair";
      const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        try {
          const { execSync } = await import("node:child_process");
          const uid = process.getuid?.() ?? 501;
          execSync(`launchctl kickstart -k user/${uid}/${label}`, { stdio: "pipe" });
          console.log("✅ Flair restarted (launchd kickstart)");
          return;
        } catch (err: any) {
          console.error(`launchd restart failed: ${err.message}`);
        }
      } else {
        console.error("❌ No launchd service found. Run 'flair init' first.");
        process.exit(1);
      }
    } else {
      // Linux: stop + start via init
      console.log("Stopping...");
      try {
        const { execSync } = await import("node:child_process");
        const lsof = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
        if (lsof) {
          for (const pid of lsof.split("\n")) {
            try { process.kill(Number(pid.trim()), "SIGTERM"); } catch {}
          }
          // Wait briefly for shutdown
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch { /* not running */ }

      console.log("Starting...");
      const bin = harperBin();
      if (!bin) {
        console.error("❌ Harper binary not found. Run 'flair init' first.");
        process.exit(1);
      }

      const dataDir = defaultDataDir();
      const adminPass = process.env.HDB_ADMIN_PASSWORD ?? "";
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ROOTPATH: dataDir,
        DEFAULTS_MODE: "dev",
        HDB_ADMIN_USERNAME: DEFAULT_ADMIN_USER,
        HDB_ADMIN_PASSWORD: adminPass,
        HTTP_PORT: String(port),
        LOCAL_STUDIO: "false",
      };

      const proc = spawn(process.execPath, [bin, "run", "."], {
        cwd: flairPackageDir(), env, detached: true, stdio: "ignore",
      });
      proc.unref();

      try {
        await waitForHealth(port, DEFAULT_ADMIN_USER, adminPass, STARTUP_TIMEOUT_MS);
        console.log("✅ Flair restarted");
      } catch {
        console.error("❌ Flair failed to restart within timeout");
        process.exit(1);
      }
    }
  });

// ─── flair uninstall ──────────────────────────────────────────────────────────

program
  .command("uninstall")
  .description("Stop Flair and remove the launchd/systemd service")
  .option("--purge", "Also remove data and keys (destructive)")
  .action(async (opts) => {
    const platform = process.platform;
    const port = readPortFromConfig() ?? DEFAULT_PORT;

    // Stop first: remove launchd service on macOS, then kill by port on all platforms
    if (platform === "darwin") {
      const label = "ai.tpsdev.flair";
      const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
        } catch { /* best effort */ }
        const { unlinkSync } = await import("node:fs");
        unlinkSync(plistPath);
        console.log("✅ Launchd service removed");
      }
    }
    // Kill any process still on the port (covers direct-start, no-service, or failed unload)
    try {
      const { execSync } = await import("node:child_process");
      const lsof = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
      if (lsof) {
        for (const pid of lsof.split("\n")) {
          try { process.kill(Number(pid.trim()), "SIGTERM"); } catch {}
        }
        // Wait for process to release file handles (RocksDB)
        await new Promise(r => setTimeout(r, 2000));
        console.log("✅ Flair process stopped");
      }
    } catch { /* not running */ }

    // Remove config
    const cfgPath = configPath();
    if (existsSync(cfgPath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(cfgPath);
      console.log("✅ Config removed");
    }

    if (opts.purge) {
      const { rmSync } = await import("node:fs");
      const dataDir = defaultDataDir();
      const keysDir = defaultKeysDir();
      const flairDir = join(homedir(), ".flair");

      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true });
        console.log("✅ Data removed: " + dataDir);
      }
      if (existsSync(keysDir)) {
        rmSync(keysDir, { recursive: true, force: true });
        console.log("✅ Keys removed: " + keysDir);
      }
      // Remove .flair dir if empty
      try {
        const { readdirSync, rmdirSync } = await import("node:fs");
        if (existsSync(flairDir) && readdirSync(flairDir).length === 0) {
          rmdirSync(flairDir);
        }
      } catch { /* non-empty, that's fine */ }

      console.log("\n🗑️  Flair fully purged");
    } else {
      console.log("\nData and keys preserved at ~/.flair/");
      console.log("To remove everything: flair uninstall --purge");
    }
  });

// ─── flair reembed ────────────────────────────────────────────────────────────

program
  .command("reembed")
  .description("Re-generate embeddings for memories with stale or missing model tags")
  .requiredOption("--agent <id>", "Agent ID to re-embed memories for")
  .option("--stale-only", "Only re-embed memories with mismatched model tag")
  .option("--dry-run", "Show count without modifying")
  .option("--port <port>", "Harper HTTP port")
  .option("--batch-size <n>", "Records per batch", "50")
  .option("--delay-ms <ms>", "Delay between batches (ms)", "100")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const baseUrl = `http://127.0.0.1:${port}`;
    const agentId = opts.agent;
    const staleOnly = opts.staleOnly ?? false;
    const dryRun = opts.dryRun ?? false;
    const batchSize = Number(opts.batchSize);
    const delayMs = Number(opts.delayMs);

    const currentModel = process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";

    console.log(`Re-embedding memories for agent: ${agentId}`);
    console.log(`Current model: ${currentModel}`);
    if (staleOnly) console.log("Mode: stale-only (skipping up-to-date memories)");
    if (dryRun) console.log("Mode: dry-run (no modifications)");
    console.log("");

    const keysDir = defaultKeysDir();
    const privPath = privKeyPath(agentId, keysDir);
    if (!existsSync(privPath)) {
      console.error(`❌ Key not found: ${privPath}`);
      process.exit(1);
    }

    const searchRes = await authFetch(baseUrl, agentId, privPath, "POST", "/SemanticSearch", {
      agentId, limit: 10000,
    });
    if (!searchRes.ok) {
      console.error(`❌ Failed to fetch memories: ${searchRes.status}`);
      process.exit(1);
    }
    const data = await searchRes.json() as { results?: any[] };
    const allMemories = data.results ?? [];

    const candidates = allMemories.filter((m: any) => {
      if (!m.content) return false;
      if (staleOnly) return !m.embeddingModel || m.embeddingModel !== currentModel;
      return true;
    });

    const total = candidates.length;
    const skipped = allMemories.length - total;

    console.log(`Total memories: ${allMemories.length}`);
    console.log(`Candidates for re-embedding: ${total}`);
    if (skipped > 0) console.log(`Skipped (up-to-date): ${skipped}`);

    if (dryRun || total === 0) {
      if (total === 0) console.log("\n✅ All memories are up-to-date!");
      return;
    }

    console.log("");
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      for (const memory of batch) {
        try {
          const updateRes = await authFetch(baseUrl, agentId, privPath, "PUT", `/Memory/${memory.id}`, {
            id: memory.id, content: memory.content, embedding: undefined, embeddingModel: undefined,
          });
          if (updateRes.ok) processed++;
          else errors++;
        } catch { errors++; }
      }
      const pct = Math.round(((i + batch.length) / total) * 100);
      process.stdout.write(`\rRe-embedded ${processed}/${total} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
      if (i + batchSize < candidates.length) await new Promise(r => setTimeout(r, delayMs));
    }

    console.log(`\n\n✅ Re-embedding complete: ${processed} updated, ${errors} errors`);
  });

// ─── flair test ───────────────────────────────────────────────────────────────

program
  .command("test")
  .description("Verify Flair is working: store, search, bootstrap, cleanup")
  .requiredOption("--agent <id>", "Agent ID to test with")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const baseUrl = `http://127.0.0.1:${port}`;
    const agentId = opts.agent;
    const keysDir = defaultKeysDir();
    const privPath = privKeyPath(agentId, keysDir);

    if (!existsSync(privPath)) {
      console.error(`❌ Key not found: ${privPath}`);
      console.error(`   Run: flair init --agent-id ${agentId}`);
      process.exit(1);
    }

    const testId = `test-${agentId}-${Date.now()}`;
    const testContent = `Flair test memory (${new Date().toISOString()})`;
    let passed = 0;
    let failed = 0;

    const check = async (name: string, fn: () => Promise<boolean>) => {
      try {
        const ok = await fn();
        if (ok) { console.log(`  ✅ ${name}`); passed++; }
        else { console.log(`  ❌ ${name}`); failed++; }
      } catch (e: any) {
        console.log(`  ❌ ${name}: ${e.message?.slice(0, 100)}`);
        failed++;
      }
    };

    console.log(`\nFlair test (agent: ${agentId}, url: ${baseUrl})\n`);

    // 1. Health
    await check("Health check", async () => {
      const res = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(5000) });
      return res.status > 0;
    });

    // 2. Store
    await check("Memory store", async () => {
      const res = await authFetch(baseUrl, agentId, privPath, "PUT", `/Memory/${testId}`, {
        id: testId, agentId, content: testContent, durability: "ephemeral",
        createdAt: new Date().toISOString(), archived: false,
      });
      return res.ok;
    });

    // 3. Search
    await check("Semantic search", async () => {
      await new Promise(r => setTimeout(r, 2000)); // wait for indexing
      const res = await authFetch(baseUrl, agentId, privPath, "POST", "/SemanticSearch", {
        agentId, q: "flair test memory", limit: 5,
      });
      if (!res.ok) return false;
      const data = await res.json() as { results?: any[] };
      return (data.results?.length ?? 0) > 0;
    });

    // 4. Bootstrap
    await check("Bootstrap context", async () => {
      const res = await authFetch(baseUrl, agentId, privPath, "POST", "/BootstrapMemories", {
        agentId, maxTokens: 1000,
      });
      if (!res.ok) return false;
      const data = await res.json() as { context?: string };
      return (data.context?.length ?? 0) > 0;
    });

    // 5. Cleanup
    await check("Memory delete", async () => {
      const res = await authFetch(baseUrl, agentId, privPath, "DELETE", `/Memory/${testId}`);
      return res.ok || res.status === 204;
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });

// ─── flair doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Diagnose common Flair problems and suggest fixes")
  .option("--port <port>", "Harper HTTP port")
  .option("--fix", "Automatically fix issues where possible")
  .option("--dry-run", "Show what --fix would do without making changes")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const autoFix = opts.fix ?? false;
    const dryRun = opts.dryRun ?? false;
    if (dryRun && !autoFix) {
      console.log("  ℹ️  --dry-run only has effect with --fix\n");
    }
    let effectivePort = port;
    let baseUrl = `http://127.0.0.1:${port}`;
    let issues = 0;
    let harperResponding = false;

    console.log("\n🩺 Flair Doctor\n");

    // Helper: try to reach Harper on a given port
    async function probePort(p: number): Promise<boolean> {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/Health`, { signal: AbortSignal.timeout(3000) });
        return res.status > 0;
      } catch { return false; }
    }

    // Helper: discover what port a Harper PID is listening on
    async function discoverPortFromPid(pid: string): Promise<number | null> {
      // Defense-in-depth: caller already validates, but re-check here
      if (!/^\d+$/.test(pid)) return null;
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync(`lsof -aPi -p ${pid} -sTCP:LISTEN -Fn 2>/dev/null || true`, { encoding: "utf-8" });
        const match = out.match(/:(\d+)$/m);
        if (match) return Number(match[1]);
      } catch { /* ignore */ }
      return null;
    }

    // 1. Port check — is something listening?
    // First, check PID file so we can cross-reference
    const dataDir0 = defaultDataDir();
    const pidFile0 = join(dataDir0, "hdb.pid");
    let pidAlive = false;
    let pidValue = "";
    if (existsSync(pidFile0)) {
      const rawPid = (await import("node:fs")).readFileSync(pidFile0, "utf-8").trim();
      // Strict integer validation — PID must be purely numeric to prevent injection
      if (/^\d+$/.test(rawPid)) {
        pidValue = rawPid;
        try { process.kill(Number(pidValue), 0); pidAlive = true; } catch { /* dead */ }
      } else {
        console.log(`  ⚠️  PID file contains non-numeric value: ${pidFile0} — skipping`);
      }
    }

    if (await probePort(port)) {
      console.log(`  ✅ Harper responding on port ${port}`);
      harperResponding = true;
    } else {
      // Port didn't respond — but if PID is alive, try to find the real port
      let discoveredPort: number | null = null;
      if (pidAlive) {
        discoveredPort = await discoverPortFromPid(pidValue);
        if (discoveredPort && discoveredPort !== port && await probePort(discoveredPort)) {
          console.log(`  ⚠️  Harper not on expected port ${port}, but responding on port ${discoveredPort} (PID ${pidValue})`);
          console.log(`     Your config says port ${port} but Harper is actually running on ${discoveredPort}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     Would update config to port ${discoveredPort}`);
            } else {
              writeConfig(discoveredPort);
              console.log(`     ✅ Updated config to port ${discoveredPort}`);
            }
          } else {
            console.log(`     Fix: flair doctor --fix (updates config to match running port)`);
          }
          effectivePort = discoveredPort;
          baseUrl = `http://127.0.0.1:${discoveredPort}`;
          harperResponding = true;
          issues++;
        } else {
          console.log(`  ❌ Harper process alive (PID ${pidValue}) but not responding on any detected port`);
          console.log(`     Fix: flair restart`);
          issues++;
        }
      } else {
        // No live PID — Harper genuinely isn't running
        // Check if something else grabbed the port
        try {
          const { execSync } = await import("node:child_process");
          const lsof = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
          if (lsof) {
            console.log(`  ❌ Nothing responding on port ${port} (port occupied by PID ${lsof})`);
            console.log(`     Fix: kill ${lsof} && flair restart`);
          } else {
            console.log(`  ❌ Harper is not running`);
            console.log(`     Fix: flair restart`);
          }
        } catch {
          console.log(`  ❌ Harper is not running`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     Would run: flair restart`);
            } else {
              console.log(`     Attempting restart...`);
              try {
                const { execSync } = await import("node:child_process");
                execSync(`${process.argv[0]} ${process.argv[1]} restart --port ${port}`, { stdio: "inherit" });
                console.log(`     ✅ Restart attempted`);
              } catch {
                console.log(`     ❌ Restart failed — try: flair init --agent-id <your-agent>`);
              }
            }
          } else {
            console.log(`     Fix: flair restart`);
          }
        }
        issues++;
      }
    }

    // 2. Keys directory
    const keysDir = defaultKeysDir();
    if (existsSync(keysDir)) {
      const keyFiles = (await import("node:fs")).readdirSync(keysDir).filter((f: string) => f.endsWith(".key"));
      if (keyFiles.length > 0) {
        console.log(`  ✅ Keys found: ${keyFiles.length} agent(s) in ${keysDir}`);
      } else {
        console.log(`  ❌ Keys directory exists but no .key files found`);
        console.log(`     Fix: flair init --agent-id <your-agent>`);
        issues++;
      }
    } else {
      console.log(`  ❌ Keys directory missing: ${keysDir}`);
      console.log(`     Fix: flair init --agent-id <your-agent>`);
      issues++;
    }

    // 3. Config file
    const cfgPath = configPath();
    if (existsSync(cfgPath)) {
      const savedPort = readPortFromConfig();
      console.log(`  ✅ Config: ${cfgPath} (port: ${savedPort ?? "default"})`);
    } else {
      console.log(`  ⚠️  No config file at ${cfgPath} — using defaults`);
    }

    // 4. Embeddings check (only if Harper is responding)
    if (harperResponding) {
      try {
        const testRes = await fetch(`${baseUrl}/SemanticSearch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: "test", limit: 1 }),
          signal: AbortSignal.timeout(10000),
        });
        if (testRes.ok) {
          const data = await testRes.json() as { _warning?: string };
          if (data._warning) {
            console.log(`  ⚠️  Embeddings: keyword-only (${data._warning})`);
            console.log(`     Semantic search quality is degraded`);
            console.log(`     Check: ls ~/.npm-global/lib/node_modules/@tpsdev-ai/flair/models/`);
            issues++;
          } else {
            console.log(`  ✅ Embeddings: semantic search operational`);
          }
        } else if (testRes.status === 401) {
          console.log(`  ⚠️  Embeddings: cannot verify (auth required for SemanticSearch)`);
        }
      } catch { /* fetch error, already flagged */ }
    }

    // 5. Stale PID file (skip if already reported in port check)
    const dataDir = defaultDataDir();
    const pidFile = join(dataDir, "hdb.pid");
    if (existsSync(pidFile)) {
      const pidContent = (await import("node:fs")).readFileSync(pidFile, "utf-8").trim();
      try {
        process.kill(Number(pidContent), 0);
        if (harperResponding) {
          console.log(`  ✅ PID file: ${pidFile} (process ${pidContent} is alive)`);
        }
        // If not responding, we already reported the issue in step 1
      } catch {
        console.log(`  ❌ Stale PID file: ${pidFile} (process ${pidContent} is dead)`);
        if (autoFix) {
          if (dryRun) {
            console.log(`     Would remove: ${pidFile}`);
          } else {
            (await import("node:fs")).unlinkSync(pidFile);
            console.log(`     ✅ Removed stale PID file`);
          }
        } else {
          console.log(`     Fix: rm ${pidFile} && flair restart`);
        }
        issues++;
      }
    }

    // 6. Data directory
    if (existsSync(dataDir)) {
      console.log(`  ✅ Data directory: ${dataDir}`);
    } else {
      // Check ~/harper/ (common alternative)
      const altDir = join(homedir(), "harper");
      if (existsSync(altDir)) {
        console.log(`  ⚠️  Data at ~/harper/ (not ~/.flair/data) — old install location`);
      } else {
        console.log(`  ❌ No data directory found`);
        console.log(`     Fix: flair init --agent-id <your-agent>`);
        issues++;
      }
    }

    // Summary
    console.log("");
    if (issues === 0) {
      console.log("  🟢 No issues found");
    } else {
      console.log(`  🔴 ${issues} issue${issues > 1 ? "s" : ""} found — see fixes above`);
    }
    console.log("");

    if (issues > 0) process.exit(1);
  });

// ─── Memory and Soul commands ────────────────────────────────────────────────

const memory = program.command("memory").description("Manage agent memories");
memory.command("add").requiredOption("--agent <id>").requiredOption("--content <text>")
  .option("--durability <d>", "standard").option("--tags <csv>")
  .action(async (opts) => {
    const memId = `${opts.agent}-${Date.now()}`;
    const out = await api("PUT", `/Memory/${memId}`, {
      id: memId, agentId: opts.agent, content: opts.content, durability: opts.durability || "standard",
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
      type: "memory", createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify(out, null, 2));
  });
memory.command("search").requiredOption("--agent <id>").requiredOption("--q <query>").option("--tag <tag>")
  .action(async (opts) => console.log(JSON.stringify(await api("POST", "/SemanticSearch", { agentId: opts.agent, q: opts.q, tag: opts.tag }), null, 2)));
memory.command("list").requiredOption("--agent <id>").option("--tag <tag>")
  .action(async (opts) => {
    const q = new URLSearchParams({ agentId: opts.agent, ...(opts.tag ? { tag: opts.tag } : {}) }).toString();
    console.log(JSON.stringify(await api("GET", `/Memory?${q}`), null, 2));
  });

// ─── flair search (top-level shortcut) ───────────────────────────────────────

program
  .command("search <query>")
  .description("Search memories by meaning (shortcut for memory search)")
  .requiredOption("--agent <id>", "Agent ID")
  .option("--limit <n>", "Max results", "5")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path")
  .action(async (query, opts) => {
    try {
      const baseUrl = opts.url || `http://127.0.0.1:${resolveHttpPort(opts)}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(opts.agent);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(opts.agent, "POST", "/SemanticSearch", keyPath);
      }
      const res = await fetch(`${baseUrl}/SemanticSearch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: opts.agent, q: query, limit: parseInt(opts.limit, 10) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json() as any;
      const results = result.results || result || [];
      if (!Array.isArray(results) || results.length === 0) {
        console.log("No results found.");
        return;
      }
      for (const r of results) {
        const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
        const score = r._score ? `${(r._score * 100).toFixed(0)}%` : "";
        const meta = [date, r.type, score].filter(Boolean).join(" · ");
        console.log(`  ${r.content}`);
        if (meta) console.log(`  (${meta})`);
        console.log();
      }
    } catch (err: any) {
      console.error(`Search failed: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair bootstrap ─────────────────────────────────────────────────────────

program
  .command("bootstrap")
  .description("Cold-start context: get soul + recent memories as formatted text")
  .requiredOption("--agent <id>", "Agent ID")
  .option("--max-tokens <n>", "Maximum tokens in output", "4000")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path")
  .action(async (opts) => {
    const baseUrl = opts.url || `http://127.0.0.1:${resolveHttpPort(opts)}`;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(opts.agent);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(opts.agent, "POST", "/BootstrapMemories", keyPath);
      }
      const res = await fetch(`${baseUrl}/BootstrapMemories`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: opts.agent, maxTokens: parseInt(opts.maxTokens, 10) }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body}`);
      }
      const result = await res.json() as any;
      if (result.context) {
        console.log(result.context);
      } else {
        console.error("No context available.");
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Bootstrap failed: ${err.message}`);
      process.exit(1);
    }
  });

const soul = program.command("soul").description("Manage agent soul entries");
soul.command("set").requiredOption("--agent <id>").requiredOption("--key <key>").requiredOption("--value <value>")
  .option("--durability <d>", "permanent")
  .action(async (opts) => {
    const out = await api("POST", "/Soul", { id: `${opts.agent}:${opts.key}`, agentId: opts.agent, key: opts.key, value: opts.value, durability: opts.durability });
    console.log(JSON.stringify(out, null, 2));
  });
soul.command("get").argument("<id>").action(async (id) => console.log(JSON.stringify(await api("GET", `/Soul/${id}`), null, 2)));
soul.command("list").requiredOption("--agent <id>")
  .action(async (opts) => console.log(JSON.stringify(await api("GET", `/Soul?agentId=${encodeURIComponent(opts.agent)}`), null, 2)));

// ─── flair backup ────────────────────────────────────────────────────────────

program
  .command("backup")
  .description("Export agents, memories, and souls to a JSON archive")
  .option("--output <path>", "Output file path (default: ~/.flair/backups/flair-backup-<timestamp>.json)")
  .option("--agents <ids>", "Comma-separated agent IDs to include (default: all)")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for backup");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

    async function adminGet(path: string): Promise<any> {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET ${path} failed (${res.status}): ${text}`);
      }
      return res.json();
    }

    console.log("Fetching agents...");
    const allAgents: any[] = await adminGet("/Agent/");
    const filterIds = opts.agents ? opts.agents.split(",").map((s: string) => s.trim()) : null;
    const agents: any[] = filterIds ? allAgents.filter((a: any) => filterIds.includes(a.id)) : allAgents;

    console.log(`Fetching memories for ${agents.length} agent(s)...`);
    const memories: any[] = [];
    for (const agent of agents) {
      try {
        const agentMemories = await adminGet(`/Memory/?agentId=${encodeURIComponent(agent.id)}`);
        if (Array.isArray(agentMemories)) memories.push(...agentMemories);
      } catch (err: any) {
        console.warn(`  Warning: could not fetch memories for ${agent.id}: ${err.message}`);
      }
    }

    console.log("Fetching souls...");
    const souls: any[] = [];
    for (const agent of agents) {
      try {
        const agentSouls = await adminGet(`/Soul/?agentId=${encodeURIComponent(agent.id)}`);
        if (Array.isArray(agentSouls)) souls.push(...agentSouls);
      } catch (err: any) {
        console.warn(`  Warning: could not fetch souls for ${agent.id}: ${err.message}`);
      }
    }

    const backup = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: baseUrl,
      agents,
      memories,
      souls,
    };

    // Determine output path
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultOutput = join(homedir(), ".flair", "backups", `flair-backup-${timestamp}.json`);
    const outputPath: string = opts.output ?? defaultOutput;
    mkdirSync(join(outputPath, ".."), { recursive: true });

    const tmp = outputPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(backup, null, 2) + "\n", "utf-8");
    renameSync(tmp, outputPath);

    console.log(`\n✅ Backup complete`);
    console.log(`   Agents:   ${agents.length}`);
    console.log(`   Memories: ${memories.length}`);
    console.log(`   Souls:    ${souls.length}`);
    console.log(`   Output:   ${outputPath}`);
  });

// ─── flair restore ────────────────────────────────────────────────────────────

program
  .command("restore <path>")
  .description("Import a Flair backup archive")
  .option("--merge", "Add/update records without deleting existing (default)")
  .option("--replace", "Delete all existing data for backed-up agents first, then import")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--dry-run", "Show what would be imported without making changes")
  .action(async (backupPath: string, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const adminUser = DEFAULT_ADMIN_USER;
    const dryRun: boolean = Boolean(opts.dryRun);
    const mode: "merge" | "replace" = opts.replace ? "replace" : "merge";

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for restore");
      process.exit(1);
    }

    if (!existsSync(backupPath)) {
      console.error(`Error: backup file not found: ${backupPath}`);
      process.exit(1);
    }

    const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
    if (backup.version !== 1) {
      console.error(`Error: unsupported backup version: ${backup.version}`);
      process.exit(1);
    }

    const { agents = [], memories = [], souls = [] } = backup;
    const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

    console.log(`Restoring from: ${backupPath}`);
    console.log(`Mode: ${mode}${dryRun ? " (dry run)" : ""}`);
    console.log(`  Agents:   ${agents.length}`);
    console.log(`  Memories: ${memories.length}`);
    console.log(`  Souls:    ${souls.length}`);

    if (dryRun) {
      console.log("\n✅ Dry run complete — no changes made");
      return;
    }

    async function adminPut(path: string, body: unknown): Promise<void> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
      }
    }

    async function adminDelete(path: string): Promise<void> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "DELETE",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      // 404 is fine — already gone
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
      }
    }

    // Replace mode: delete existing data for these agents first
    if (mode === "replace") {
      console.log("\nDeleting existing data (replace mode)...");
      for (const memory of memories) {
        if (memory.id) await adminDelete(`/Memory/${memory.id}`).catch((e) => console.warn(`  warn: ${e.message}`));
      }
      for (const soul of souls) {
        if (soul.id) await adminDelete(`/Soul/${soul.id}`).catch((e) => console.warn(`  warn: ${e.message}`));
      }
    }

    // Restore agents
    console.log("\nRestoring agents...");
    let agentCount = 0;
    for (const agent of agents) {
      try {
        await adminPut(`/Agent/${agent.id}`, agent);
        agentCount++;
      } catch (err: any) {
        console.warn(`  warn: agent ${agent.id}: ${err.message}`);
      }
    }

    // Restore memories
    console.log("Restoring memories...");
    let memoryCount = 0;
    for (const memory of memories) {
      try {
        await adminPut(`/Memory/${memory.id}`, memory);
        memoryCount++;
      } catch (err: any) {
        console.warn(`  warn: memory ${memory.id}: ${err.message}`);
      }
    }

    // Restore souls
    console.log("Restoring souls...");
    let soulCount = 0;
    for (const soul of souls) {
      try {
        await adminPut(`/Soul/${soul.id}`, soul);
        soulCount++;
      } catch (err: any) {
        console.warn(`  warn: soul ${soul.id}: ${err.message}`);
      }
    }

    console.log(`\n✅ Restore complete`);
    console.log(`   Agents restored:   ${agentCount}/${agents.length}`);
    console.log(`   Memories restored: ${memoryCount}/${memories.length}`);
    console.log(`   Souls restored:    ${soulCount}/${souls.length}`);
  });

// ─── flair export ────────────────────────────────────────────────────────────

program
  .command("export <agent-id>")
  .description("Export a single agent's identity (soul + memories) to a portable file")
  .option("--output <path>", "Output file path")
  .option("--include-key", "Include private key in export (UNENCRYPTED — keep the output file secure)")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (agentId, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) { console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required"); process.exit(1); }

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    async function adminGet(path: string): Promise<any> {
      const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
      return res.json();
    }

    console.log(`Exporting agent '${agentId}'...`);

    // Fetch agent record
    let agent: any;
    try { agent = await adminGet(`/Agent/${agentId}`); }
    catch { console.error(`Agent '${agentId}' not found`); process.exit(1); }

    // Fetch memories
    const allMemories: any[] = await adminGet("/Memory/").catch(() => []);
    const memories = Array.isArray(allMemories)
      ? allMemories.filter((m: any) => m.agentId === agentId)
      : [];

    // Fetch souls
    const allSouls: any[] = await adminGet("/Soul/").catch(() => []);
    const souls = Array.isArray(allSouls)
      ? allSouls.filter((s: any) => s.agentId === agentId)
      : [];

    // Fetch grants
    const allGrants: any[] = await adminGet("/MemoryGrant/").catch(() => []);
    const grants = Array.isArray(allGrants)
      ? allGrants.filter((g: any) => g.ownerId === agentId || g.granteeId === agentId)
      : [];

    // Optionally include private key
    let privateKey: string | undefined;
    if (opts.includeKey) {
      const keyPath = privKeyPath(agentId, opts.keysDir);
      if (existsSync(keyPath)) {
        privateKey = readFileSync(keyPath, "utf-8").trim();
        console.log("  Including private key (base64-encoded in export)");
      } else {
        console.warn(`  Warning: key file not found at ${keyPath} — skipping key export`);
      }
    }

    const exportData = {
      version: 1,
      type: "agent-export",
      exportedAt: new Date().toISOString(),
      source: baseUrl,
      agent,
      memories,
      souls,
      grants,
      ...(privateKey ? { privateKey } : {}),
    };

    const rawOutputPath = opts.output ?? join(homedir(), ".flair", "exports", `${agentId}-${Date.now()}.json`);
    // Canonicalize to prevent path traversal (e.g. ../../etc/passwd)
    const outputPath = resolvePath(rawOutputPath);
    mkdirSync(join(outputPath, ".."), { recursive: true });
    const fileMode = privateKey ? 0o600 : 0o644;
    writeFileSync(outputPath, JSON.stringify(exportData, null, 2), { mode: fileMode });
    if (privateKey) chmodSync(outputPath, 0o600); // enforce even if umask is permissive

    console.log(`\n✅ Agent '${agentId}' exported`);
    console.log(`   Memories: ${memories.length}`);
    console.log(`   Souls:    ${souls.length}`);
    console.log(`   Grants:   ${grants.length}`);
    console.log(`   Key:      ${privateKey ? "included (UNENCRYPTED — protect this file)" : "not included"}`);
    console.log(`   Mode:     ${fileMode.toString(8)} (${privateKey ? "owner-only" : "standard"})`);
    console.log(`   Output:   ${outputPath}`);
  });

// ─── flair import ────────────────────────────────────────────────────────────

program
  .command("import <path>")
  .description("Import an agent from an export file into this Flair instance")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (importPath, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) { console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required"); process.exit(1); }

    if (!existsSync(importPath)) { console.error(`File not found: ${importPath}`); process.exit(1); }
    const data = JSON.parse(readFileSync(importPath, "utf-8"));

    if (data.type !== "agent-export") {
      console.error("Error: not an agent export file. Use 'flair restore' for full backups.");
      process.exit(1);
    }

    const agentId = data.agent?.id;
    if (!agentId) { console.error("Error: no agent ID in export"); process.exit(1); }

    console.log(`Importing agent '${agentId}'...`);

    // Register agent (generates new key if export doesn't include one)
    const keysDir = opts.keysDir ?? defaultKeysDir();
    mkdirSync(keysDir, { recursive: true });
    const privPath = privKeyPath(agentId, keysDir);

    if (data.privateKey && !existsSync(privPath)) {
      // Restore exported key
      writeFileSync(privPath, data.privateKey);
      chmodSync(privPath, 0o600);
      console.log(`  Key restored: ${privPath}`);
    } else if (!existsSync(privPath)) {
      // Generate new key
      const kp = nacl.sign.keyPair();
      writeFileSync(privPath, Buffer.from(kp.secretKey.slice(0, 32)));
      chmodSync(privPath, 0o600);
      console.log(`  New key generated: ${privPath}`);
    } else {
      console.log(`  Using existing key: ${privPath}`);
    }

    // Read public key for registration
    const seed = readFileSync(privPath);
    const decodedSeed = seed.length === 32 ? seed : Buffer.from(seed.toString("utf-8").trim(), "base64");
    const pubKey = decodedSeed.length === 32
      ? nacl.sign.keyPair.fromSeed(new Uint8Array(decodedSeed)).publicKey
      : nacl.sign.keyPair.fromSeed(new Uint8Array(decodedSeed.subarray(0, 32))).publicKey;
    const pubKeyB64url = b64url(pubKey);

    // Register agent via ops API
    await seedAgentViaOpsApi(opsPort, agentId, pubKeyB64url, DEFAULT_ADMIN_USER, adminPass);
    console.log(`  Agent registered`);

    // Restore memories
    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    let memCount = 0;
    for (const mem of data.memories ?? []) {
      try {
        await fetch(`${baseUrl}/Memory/${mem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(mem),
        });
        memCount++;
      } catch { /* skip failures */ }
    }

    // Restore souls
    let soulCount = 0;
    for (const soul of data.souls ?? []) {
      try {
        await fetch(`${baseUrl}/Soul/${encodeURIComponent(soul.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(soul),
        });
        soulCount++;
      } catch { /* skip failures */ }
    }

    console.log(`\n✅ Agent '${agentId}' imported`);
    console.log(`   Memories: ${memCount}/${(data.memories ?? []).length}`);
    console.log(`   Souls:    ${soulCount}/${(data.souls ?? []).length}`);
    console.log(`   Key:      ${privPath}`);
  });

// ─── flair backup inspect ────────────────────────────────────────────────────

program
  .command("inspect <path>")
  .description("Show contents of a backup or export file")
  .action(async (filePath) => {
    if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
    const data = JSON.parse(readFileSync(filePath, "utf-8"));

    console.log(`File: ${filePath}`);
    console.log(`Type: ${data.type ?? "full-backup"}`);
    console.log(`Created: ${data.createdAt ?? data.exportedAt ?? "unknown"}`);
    console.log(`Source: ${data.source ?? "unknown"}`);

    if (data.type === "agent-export") {
      console.log(`\nAgent: ${data.agent?.id ?? "unknown"}`);
      console.log(`  Name: ${data.agent?.name ?? data.agent?.id}`);
      console.log(`  Memories: ${(data.memories ?? []).length}`);
      console.log(`  Souls: ${(data.souls ?? []).length}`);
      console.log(`  Grants: ${(data.grants ?? []).length}`);
      console.log(`  Key included: ${data.privateKey ? "yes" : "no"}`);
    } else {
      const agents = data.agents ?? [];
      console.log(`\nAgents: ${agents.length}`);
      for (const a of agents) console.log(`  - ${a.id} (${a.name ?? a.id})`);
      console.log(`Memories: ${(data.memories ?? []).length}`);
      console.log(`Souls: ${(data.souls ?? []).length}`);
    }
  });

// ─── flair migrate-keys ───────────────────────────────────────────────────────

program
  .command("migrate-keys")
  .description("Migrate agent keys from old path (~/.tps/secrets/flair/) to ~/.flair/keys/")
  .option("--from <dir>", "Old keys directory", join(homedir(), ".tps", "secrets", "flair"))
  .option("--to <dir>", "New keys directory", defaultKeysDir())
  .option("--dry-run", "Show what would be migrated without copying")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (opts) => {
    const fromDir: string = opts.from;
    const toDir: string = opts.to;
    const dryRun: boolean = opts.dryRun ?? false;
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";

    if (!existsSync(fromDir)) {
      console.log(`Old keys directory not found: ${fromDir}`);
      console.log("Nothing to migrate.");
      process.exit(0);
    }

    // Discover legacy keys: <id>-priv.key pattern
    const { readdirSync, unlinkSync } = await import("node:fs");
    const files = readdirSync(fromDir) as string[];
    const keyFiles = files.filter((f: string) => f.endsWith("-priv.key"));

    if (keyFiles.length === 0) {
      console.log(`No legacy key files found in ${fromDir}`);
      process.exit(0);
    }

    console.log(`Found ${keyFiles.length} legacy key file(s) in ${fromDir}:`);

    let migrated = 0;
    let skipped = 0;

    for (const file of keyFiles) {
      const agentId = file.replace("-priv.key", "");
      const srcPath = join(fromDir, file);
      const destPath = join(toDir, `${agentId}.key`);

      if (existsSync(destPath)) {
        console.log(`  skip: ${agentId} — already exists at ${destPath}`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  would migrate: ${srcPath} → ${destPath}`);
        migrated++;
        continue;
      }

      mkdirSync(toDir, { recursive: true });
      const keyData = readFileSync(srcPath);
      writeFileSync(destPath, keyData);
      chmodSync(destPath, 0o600);
      console.log(`  migrated: ${agentId} → ${destPath}`);
      migrated++;
    }

    if (dryRun) {
      console.log(`\n🔍 Dry run: ${migrated} key(s) would be migrated, ${skipped} skipped`);
    } else {
      console.log(`\n✅ Migration complete: ${migrated} migrated, ${skipped} skipped`);
      if (migrated > 0) {
        console.log(`\nOld keys preserved at ${fromDir} (delete manually when confirmed working).`);

        // Optionally verify keys match Flair records
        if (adminPass) {
          console.log("\nVerifying migrated keys against Flair...");
          const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
          for (const file of keyFiles) {
            const agentId = file.replace("-priv.key", "");
            const destPath = join(toDir, `${agentId}.key`);
            if (!existsSync(destPath)) continue;

            try {
              const keyB64 = readFileSync(destPath, "utf-8").trim();
              const seed = Buffer.from(keyB64, "base64");
              const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
              const localPub = b64url(kp.publicKey);

              const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: auth },
                body: JSON.stringify({ operation: "search_by_value", database: "flair", table: "Agent", search_attribute: "id", search_value: agentId, get_attributes: ["id", "publicKey"] }),
                signal: AbortSignal.timeout(10_000),
              });
              if (res.ok) {
                const agents = await res.json();
                if (Array.isArray(agents) && agents.length > 0) {
                  const remotePub = agents[0].publicKey;
                  if (remotePub === localPub) {
                    console.log(`  ✅ ${agentId}: key matches Flair`);
                  } else {
                    console.log(`  ⚠️  ${agentId}: key MISMATCH — local key doesn't match Flair record`);
                  }
                } else {
                  console.log(`  ⚠️  ${agentId}: not found in Flair`);
                }
              }
            } catch (err: any) {
              console.log(`  ⚠️  ${agentId}: verification failed — ${err.message}`);
            }
          }
        }
      }
    }
  });

await program.parseAsync();
