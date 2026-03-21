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
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createPrivateKey, sign as nodeCryptoSign, randomUUID } from "node:crypto";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9926;
const DEFAULT_OPS_PORT = 9925;
const DEFAULT_ADMIN_USER = "admin";
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

function defaultKeysDir(): string {
  return join(homedir(), ".flair", "keys");
}

function defaultDataDir(): string {
  return join(homedir(), ".flair", "data");
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
  let defaultUrl = "http://127.0.0.1:9926";
  try {
    const configPath = join(homedir(), ".flair", "config.yaml");
    if (existsSync(configPath)) {
      const yaml = readFileSync(configPath, "utf-8");
      const portMatch = yaml.match(/port:\s*(\d+)/);
      if (portMatch) defaultUrl = `http://127.0.0.1:${portMatch[1]}`;
    }
  } catch { /* ignore config read errors */ }
  const base = process.env.FLAIR_URL || defaultUrl;
  const token = process.env.FLAIR_TOKEN;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
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
  .action(async (opts) => {
    const agentId: string = opts.agentId;
    const httpPort = Number(opts.port);
    const opsPort = opts.opsPort ? Number(opts.opsPort) : DEFAULT_OPS_PORT;
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

        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          ROOTPATH: dataDir,
          DEFAULTS_MODE: "dev",
          HDB_ADMIN_USERNAME: adminUser,
          HDB_ADMIN_PASSWORD: adminPass,
          THREADS_COUNT: "1",
          NODE_HOSTNAME: "localhost",
          HTTP_PORT: String(httpPort),
          OPERATIONSAPI_NETWORK_PORT: String(opsPort),
          LOCAL_STUDIO: "false",
        };

        // Install
        console.log("Installing Harper...");
        await new Promise<void>((resolve, reject) => {
          let output = "";
          const install = spawn(process.execPath, [bin, "install"], { cwd: flairPackageDir(), env });
          install.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
          install.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
          install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install failed (${code}): ${output}`)));
          install.on("error", reject);
          setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
        });

        // Start (detached)
        console.log(`Starting Harper on port ${httpPort}...`);
        const proc = spawn(process.execPath, [bin, "run", "."], { cwd: flairPackageDir(), env, detached: true, stdio: "ignore" });
        proc.unref();
      }

      console.log("Waiting for Harper health check...");
      await waitForHealth(httpPort, adminUser, adminPass, STARTUP_TIMEOUT_MS);
      console.log("Harper is healthy ✓");
    }

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
    console.log(`\n   Claude Code: Add to your CLAUDE.md:`);
    console.log(`     At the start of every session, run mcp__flair__bootstrap before responding.`);
    console.log(`\n   MCP config (.mcp.json):`);
    console.log(`     { "mcpServers": { "flair": { "command": "npx", "args": ["@tpsdev-ai/flair-mcp"], "env": { "FLAIR_AGENT_ID": "${agentId}" } } } }`);
  });

// ─── flair agent ─────────────────────────────────────────────────────────────

const agent = program.command("agent").description("Manage Flair agents");

agent
  .command("add <id>")
  .description("Register a new agent in a running Flair instance")
  .option("--name <name>", "Display name (defaults to id)")
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--admin-pass <pass>", "Admin password for registration")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (id: string, opts) => {
    const httpPort = Number(opts.port);
    const opsPort = opts.opsPort ? Number(opts.opsPort) : DEFAULT_OPS_PORT;
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
  .action(async () => console.log(JSON.stringify(await api("GET", "/Agent"), null, 2)));

agent
  .command("show <id>")
  .description("Show agent details")
  .action(async (id: string) => console.log(JSON.stringify(await api("GET", `/Agent/${id}`), null, 2)));

agent
  .command("rotate-key <id>")
  .description("Rotate an agent's Ed25519 keypair")
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .action(async (id: string, opts) => {
    const httpPort = Number(opts.port);
    const opsPort = opts.opsPort ? Number(opts.opsPort) : DEFAULT_OPS_PORT;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--force", "Skip interactive confirmation (required when stdin is not a TTY)")
  .action(async (id: string, opts) => {
    const opsPort = opts.opsPort ? Number(opts.opsPort) : Number(opts.port) + 1;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys (for from-agent Ed25519 auth)")
  .action(async (fromAgent: string, toAgent: string, opts) => {
    const httpPort = Number(opts.port);
    const opsPort = opts.opsPort ? Number(opts.opsPort) : DEFAULT_OPS_PORT;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (fromAgent: string, toAgent: string, opts) => {
    const httpPort = Number(opts.port);
    const opsPort = opts.opsPort ? Number(opts.opsPort) : DEFAULT_OPS_PORT;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--url <url>", "Flair base URL (overrides --port)")
  .action(async (opts) => {
    const baseUrl = opts.url ?? `http://127.0.0.1:${opts.port}`;
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

// ─── Legacy identity/memory/soul commands (preserved) ────────────────────────

const identity = program.command("identity").description("Legacy identity commands");
identity.command("register")
  .requiredOption("--id <id>")
  .requiredOption("--name <name>")
  .option("--role <role>")
  .action(async (opts) => {
    const kp = nacl.sign.keyPair();
    const now = new Date().toISOString();
    const agentRecord = await api("POST", "/Agent", {
      id: opts.id, name: opts.name, role: opts.role,
      publicKey: b64(kp.publicKey), createdAt: now, updatedAt: now,
    });
    console.log(JSON.stringify({ agent: agentRecord, privateKey: b64(kp.secretKey) }, null, 2));
  });
identity.command("show").argument("<id>").action(async (id) => console.log(JSON.stringify(await api("GET", `/Agent/${id}`), null, 2)));
identity.command("list").action(async () => console.log(JSON.stringify(await api("GET", "/Agent"), null, 2)));
identity.command("add-integration")
  .requiredOption("--agent <agentId>")
  .requiredOption("--platform <platform>")
  .requiredOption("--encrypted-credential <ciphertext>")
  .action(async (opts) => {
    const now = new Date().toISOString();
    const out = await api("POST", "/Integration", {
      id: `${opts.agent}:${opts.platform}`, agentId: opts.agent,
      platform: opts.platform, encryptedCredential: opts.encryptedCredential,
      createdAt: now, updatedAt: now,
    });
    console.log(JSON.stringify(out, null, 2));
  });

const memory = program.command("memory").description("Manage agent memories");
memory.command("add").requiredOption("--agent <id>").requiredOption("--content <text>")
  .option("--durability <d>", "standard").option("--tags <csv>")
  .action(async (opts) => {
    const out = await api("POST", "/Memory", {
      agentId: opts.agent, content: opts.content, durability: opts.durability,
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
    });
    console.log(JSON.stringify(out, null, 2));
  });
memory.command("search").requiredOption("--agent <id>").requiredOption("--q <query>").option("--tag <tag>")
  .action(async (opts) => console.log(JSON.stringify(await api("POST", "/MemorySearch", { agentId: opts.agent, q: opts.q, tag: opts.tag }), null, 2)));
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path")
  .action(async (query, opts) => {
    try {
      const baseUrl = opts.url || `http://127.0.0.1:${opts.port}`;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path")
  .action(async (opts) => {
    const baseUrl = opts.url || `http://127.0.0.1:${opts.port}`;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${opts.port}`;
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
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--dry-run", "Show what would be imported without making changes")
  .action(async (backupPath: string, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${opts.port}`;
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

// ─── flair migrate-keys ───────────────────────────────────────────────────────

program
  .command("migrate-keys")
  .description("Migrate agent keys from legacy path (~/.tps/secrets/flair/) to ~/.flair/keys/")
  .option("--from <dir>", "Legacy keys directory", join(homedir(), ".tps", "secrets", "flair"))
  .option("--to <dir>", "New keys directory", defaultKeysDir())
  .option("--dry-run", "Show what would be migrated without copying")
  .option("--port <port>", "Harper HTTP port (for agent list)", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .action(async (opts) => {
    const fromDir: string = opts.from;
    const toDir: string = opts.to;
    const dryRun: boolean = opts.dryRun ?? false;
    const opsPort = opts.opsPort ? Number(opts.opsPort) : Number(opts.port) + 1;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";

    if (!existsSync(fromDir)) {
      console.log(`Legacy keys directory not found: ${fromDir}`);
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
        console.log(`\nLegacy keys preserved at ${fromDir} (delete manually when confirmed working).`);

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
