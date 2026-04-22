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
import { keystore } from "./keystore.js";
import { deploy as deployToFabric, validateOptions as validateDeployOptions, buildTargetUrl as buildDeployUrl } from "./deploy.js";

// Federation crypto helpers — inlined to avoid cross-boundary imports from
// src/ into resources/, which don't survive npm packaging (see also
// resources/federation-crypto.ts; the two must stay in sync).
function sortKeys(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}
function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
function signBody(body: Record<string, any>, secretKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalize(body));
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("base64url");
}

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
  } else if (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD) {
    // Admin Basic auth — used by federation, backup, and other admin CLI commands
    const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD!;
    authHeader = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
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
  const url = `http://127.0.0.1:${httpPort}/Health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}` },
        signal: AbortSignal.timeout(2000),
      });
      // 2xx = healthy; 401 = Harper up but credentials wrong — still "reachable"
      // enough for restart success. Anything else (5xx, 502 during shutdown) keeps polling.
      if (res.ok || res.status === 401) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`Harper at port ${httpPort} did not respond within ${timeoutMs}ms (${attempt} attempts)`);
}

// Blocks until the given PID is gone (ESRCH from signal 0), or timeout.
// Used during restart to confirm the old Harper process actually exited before
// we start polling /Health — otherwise the still-shutting-down old process can
// answer and we'd declare restart success while a gap is still ahead.
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

function readHarperPid(dataDir: string): number | null {
  const pidFile = join(dataDir, "hdb.pid");
  if (!existsSync(pidFile)) return null;
  try {
    const n = Number(readFileSync(pidFile, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
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

// ─── First-run soul wizard ────────────────────────────────────────────────────

type SoulEntries = [string, string][];

export function templateSoul(choice: string): SoulEntries {
  const templates: Record<string, SoulEntries> = {
    "1": [
      ["role", "Pair programmer on this machine. Concise, direct, proactive about flagging risks before I hit them."],
      ["project", "(fill in: the main project or repo I'm helping with — shapes what bootstrap prioritizes)"],
      ["standards", "Match existing codebase style. Prefer editing over rewriting. Surface tradeoffs on ambiguous decisions instead of making unilateral calls."],
    ],
    "2": [
      ["role", "Team agent — operates in a shared repo and coordinates with other agents. Communicate through structured channels (PRs, issues, mail), not free-form chat."],
      ["project", "(fill in: the repo or ops flow this agent runs in)"],
      ["standards", "Keep changes minimal and reviewable. Always open PRs, never push to main. Document decisions in the issue tracker, not in agent memory."],
    ],
    "3": [
      ["role", "Research assistant. Survey sources, extract findings, write structured notes. Flag uncertainty explicitly; separate evidence from inference."],
      ["project", "(fill in: the research area or question being tracked)"],
      ["standards", "Cite sources inline. When sources disagree, surface the disagreement rather than picking a side silently. Prefer primary sources."],
    ],
  };
  return templates[choice] ?? [];
}

async function customSoulPrompts(ask: (q: string) => Promise<string>): Promise<SoulEntries> {
  const entries: SoulEntries = [];

  console.log("\n   Three fields. Press Enter on any to skip it.\n");

  console.log("   role — how the agent identifies itself and acts");
  console.log("     \"Senior dev, concise and direct\"");
  console.log("     \"Data-engineering sidekick, SQL-first\"");
  console.log("     \"PM assistant — asks clarifying questions before writing specs\"");
  const role = await ask("   > ");
  if (role.trim()) entries.push(["role", role.trim()]);

  console.log("\n   project — what the agent is currently focused on");
  console.log("     \"LifestyleLab — building Flair and TPS\"");
  console.log("     \"Legal discovery review, Q2 contracts\"");
  console.log("     \"Personal automation scripts in Bash + Python\"");
  const project = await ask("   > ");
  if (project.trim()) entries.push(["project", project.trim()]);

  console.log("\n   standards — communication or coding preferences that should persist");
  console.log("     \"No emojis. Match existing style. Ask before risky ops.\"");
  console.log("     \"Always cite sources. Flag uncertainty explicitly.\"");
  console.log("     \"Typescript strict mode. Prefer composition over inheritance.\"");
  const standards = await ask("   > ");
  if (standards.trim()) entries.push(["standards", standards.trim()]);

  return entries;
}

async function editEntries(ask: (q: string) => Promise<string>, entries: SoulEntries): Promise<SoulEntries> {
  console.log("\n   Press Enter to keep each default, or type a replacement:");
  const result: SoulEntries = [];
  for (const [key, def] of entries) {
    const preview = def.length > 60 ? def.slice(0, 57) + "..." : def;
    console.log(`\n   ${key} [keep: ${preview}]`);
    const input = (await ask("   > ")).trim();
    result.push([key, input || def]);
  }
  return result;
}

export function parseSoulJson(raw: string): SoulEntries {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("no JSON object found in input");
  const parsed = JSON.parse(jsonMatch[0]);
  const entries: SoulEntries = [];
  if (parsed.role) entries.push(["role", String(parsed.role).trim()]);
  if (parsed.project) entries.push(["project", String(parsed.project).trim()]);
  if (parsed.standards) entries.push(["standards", String(parsed.standards).trim()]);
  if (entries.length === 0) throw new Error("JSON had no role/project/standards keys");
  return entries;
}

async function runSoulWizard(agentId: string): Promise<SoulEntries> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Buffered ask: collects rapid input (pasted text) into one answer.
  // Waits 200ms after last line before resolving, so pasted multiline
  // blocks are captured as a single answer instead of spilling across prompts.
  const ask = (q: string): Promise<string> => new Promise(resolve => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rl.removeListener("line", onLine);
      resolve(buffer.trim());
    };
    const onLine = (line: string) => {
      buffer += (buffer ? "\n" : "") + line;
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, 200);
    };
    process.stdout.write(q);
    rl.on("line", onLine);
  });

  console.log("\n🎭 Agent personality setup");
  console.log("   Soul entries shape what every future session starts with.\n");
  console.log("   What best describes this agent?");
  console.log("     (1) Solo developer — helps you with code on this machine");
  console.log("     (2) Team agent — runs in a shared repo / ops flow");
  console.log("     (3) Research assistant — surveys sources, writes notes");
  console.log("     (4) Draft from Claude — paste a Claude-generated JSON draft");
  console.log("     (5) Custom — I'll prompt for each field with examples");
  console.log("     (s) Skip — set up later; `flair doctor` will nudge\n");

  const choice = (await ask("   Choice [1-5/s]: ")).trim().toLowerCase();

  let entries: SoulEntries = [];

  if (choice === "s" || choice === "skip") {
    rl.close();
    return [];
  } else if (choice === "1" || choice === "2" || choice === "3") {
    entries = templateSoul(choice);
    console.log("\n   Template draft:");
    for (const [k, v] of entries) console.log(`     ${k}: ${v}`);
    const edit = (await ask("\n   Edit before saving? [y/N]: ")).trim().toLowerCase();
    if (edit === "y" || edit === "yes") {
      entries = await editEntries(ask, entries);
    }
  } else if (choice === "4") {
    console.log("\n   Paste this prompt into your Claude session:");
    console.log("   ─────────────────────────────────────────────────────────────");
    console.log(`   Generate a JSON object with keys "role", "project", and`);
    console.log(`   "standards" suitable as Flair soul entries for an agent with`);
    console.log(`   id "${agentId}" operating in my current context. Each value`);
    console.log(`   should be 1-2 specific sentences that shape behavior. Output`);
    console.log(`   only the JSON object, no prose.`);
    console.log("   ─────────────────────────────────────────────────────────────\n");
    console.log("   Paste the resulting JSON below:");
    const raw = await ask("   > ");
    try {
      entries = parseSoulJson(raw);
      console.log("\n   Parsed draft:");
      for (const [k, v] of entries) console.log(`     ${k}: ${v}`);
      const edit = (await ask("\n   Edit before saving? [y/N]: ")).trim().toLowerCase();
      if (edit === "y" || edit === "yes") {
        entries = await editEntries(ask, entries);
      }
    } catch (err: any) {
      console.log(`\n   Couldn't parse JSON (${err.message}). Falling back to custom prompts.`);
      entries = await customSoulPrompts(ask);
    }
  } else {
    // Custom (5) or unrecognized input — route to custom prompts
    entries = await customSoulPrompts(ask);
  }

  rl.close();
  return entries.filter(([, v]) => v.trim().length > 0);
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
      console.log(`\n   ┌─────────────────────────────────────────────────┐`);
      console.log(`   │  Harper admin credentials (save these now):     │`);
      console.log(`   │                                                 │`);
      console.log(`   │  Username: ${DEFAULT_ADMIN_USER.padEnd(37)}│`);
      console.log(`   │  Password: ${adminPass.padEnd(37)}│`);
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
            await authFetch(httpUrl, agentId, privPath, "PUT", `/Soul/${agentId}:${key}`,
              { id: `${agentId}:${key}`, agentId, key, value, createdAt: new Date().toISOString() });
            console.log(`   ✓ soul:${key} set`);
          } catch (err: any) {
            console.warn(`   ⚠ soul:${key} failed: ${err.message}`);
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

// ─── flair principal ─────────────────────────────────────────────────────────
// 1.0 identity management. The Principal model extends Agent — this is the
// preferred CLI surface for managing identities going forward.

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
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (id: string, opts) => {
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const adminPass: string | undefined = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS;
    const adminUser = DEFAULT_ADMIN_USER;
    const kind: string = opts.kind ?? "agent";
    const name: string = opts.name ?? id;
    const isAdmin: boolean = opts.admin ?? false;
    const trustTier: string = opts.trust ?? (isAdmin ? "endorsed" : "unverified");
    const runtime: string | undefined = opts.runtime;

    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
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
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
      process.exit(1);
    }

    const kindFilter = opts.kind ? ` WHERE kind = '${opts.kind}'` : "";
    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "sql",
        sql: `SELECT id, name, kind, status, defaultTrustTier, admin, runtime, createdAt FROM flair.Agent${kindFilter} ORDER BY createdAt`,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: ${res.status} ${text}`);
      process.exit(1);
    }

    const records = await res.json() as any[];
    if (records.length === 0) {
      console.log("No principals found.");
      return;
    }

    // Table format
    console.log(`${"ID".padEnd(20)} ${"Kind".padEnd(7)} ${"Trust".padEnd(14)} ${"Admin".padEnd(6)} ${"Status".padEnd(12)} ${"Runtime".padEnd(12)} Created`);
    console.log("─".repeat(95));
    for (const r of records) {
      const kind = r.kind ?? "agent";
      const trust = r.defaultTrustTier ?? "—";
      const admin = r.admin ? "yes" : "no";
      const status = r.status ?? "active";
      const runtime = r.runtime ?? "—";
      const created = r.createdAt?.slice(0, 10) ?? "—";
      console.log(`${String(r.id).padEnd(20)} ${kind.padEnd(7)} ${trust.padEnd(14)} ${admin.padEnd(6)} ${status.padEnd(12)} ${runtime.padEnd(12)} ${created}`);
    }
  });

principal
  .command("show <id>")
  .description("Show principal details")
  .action(async (id: string) => {
    const result = await api("GET", `/Agent/${id}`);
    console.log(JSON.stringify(result, null, 2));
  });

principal
  .command("disable <id>")
  .description("Deactivate a principal (revokes access, preserves data)")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (id: string, opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
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

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
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
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
      process.exit(1);
    }

    const id = `idp_${randomUUID().slice(0, 8)}`;
    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
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
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "sql",
        sql: "SELECT id, name, issuer, requiredDomain, jitProvision, enabled, createdAt FROM flair.IdpConfig ORDER BY createdAt",
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: ${res.status} ${text}`);
      process.exit(1);
    }

    const records = await res.json() as any[];
    if (records.length === 0) {
      console.log("No IdPs configured.");
      return;
    }

    for (const r of records) {
      const status = r.enabled ? "enabled" : "disabled";
      console.log(`${r.name} (${r.id}) — ${status}`);
      console.log(`  Issuer: ${r.issuer}`);
      if (r.requiredDomain) console.log(`  Domain: ${r.requiredDomain}`);
      console.log(`  JIT: ${r.jitProvision ?? true}`);
      console.log();
    }
  });

idp
  .command("remove <id>")
  .description("Remove an IdP configuration")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (id: string, opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required");
      process.exit(1);
    }

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
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

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "sql", sql: `SELECT * FROM flair.IdpConfig WHERE id = '${id}'` }),
    });

    const records = await res.json() as any[];
    if (records.length === 0) {
      console.error(`IdP '${id}' not found`);
      process.exit(1);
    }

    const cfg = records[0];
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
    } catch (err: any) {
      console.error(`  ❌ JWKS fetch error: ${err.message}`);
      process.exit(1);
    }
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
        ownerId: fromAgent,
        granteeId: toAgent,
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

// ─── Federation signing helpers ──────────────────────────────────────────────

/**
 * Load the Ed25519 secret key for the local federation instance.
 * Tries keystore first, then falls back to DB-stored seed (migration path).
 */
async function loadInstanceSecretKey(instanceId: string, opts: { adminPass?: string; opsPort?: string | number; port?: string | number }): Promise<Uint8Array> {
  // Try keystore first
  const seed = keystore.getPrivateKeySeed(instanceId);
  if (seed) {
    return nacl.sign.keyPair.fromSeed(seed).secretKey;
  }

  // Fallback: check DB for legacy _keySeed
  const opsPort = resolveOpsPort(opts);
  const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
  const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
  const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ operation: "sql", sql: `SELECT * FROM flair.Instance WHERE id = '${instanceId}'` }),
  });
  if (res.ok) {
    const rows = await res.json() as any[];
    if (rows[0]?._keySeed) {
      const seedFromDb = Buffer.from(rows[0]._keySeed, "base64url");
      // Migrate to keystore
      keystore.setPrivateKeySeed(instanceId, new Uint8Array(seedFromDb));
      return nacl.sign.keyPair.fromSeed(new Uint8Array(seedFromDb)).secretKey;
    }
  }

  throw new Error(`No private key found for instance ${instanceId}. Re-run 'flair federation status' to regenerate.`);
}

/**
 * Sign a request body and return a new body with the signature field added.
 */
function signRequestBody(body: Record<string, any>, secretKey: Uint8Array): Record<string, any> {
  const sig = signBody(body, secretKey);
  return { ...body, signature: sig };
}

// ─── flair federation ────────────────────────────────────────────────────────

const federation = program.command("federation").description("Manage federation (hub-and-spoke sync)");

federation
  .command("status")
  .description("Show federation status and peer connections")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    try {
      const instance = await api("GET", "/FederationInstance");
      console.log(`Instance: ${instance.id} (${instance.role})`);
      console.log(`Public key: ${instance.publicKey}`);
      console.log(`Status: ${instance.status}`);
      console.log();

      const { peers } = await api("GET", "/FederationPeers");
      if (peers.length === 0) {
        console.log("No peers configured. Use 'flair federation pair' to connect to a hub.");
      } else {
        console.log(`${"Peer".padEnd(20)} ${"Role".padEnd(8)} ${"Status".padEnd(14)} ${"Last Sync".padEnd(22)} Relay`);
        console.log("─".repeat(80));
        for (const p of peers) {
          const lastSync = p.lastSyncAt?.slice(0, 19) ?? "never";
          console.log(`${p.id.padEnd(20)} ${(p.role ?? "—").padEnd(8)} ${(p.status ?? "—").padEnd(14)} ${lastSync.padEnd(22)} ${p.relayOnly ? "yes" : "no"}`);
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

federation
  .command("pair <hub-url>")
  .description("Pair this spoke with a hub instance")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--token <token>", "One-time pairing token from hub admin")
  .action(async (hubUrl: string, opts) => {
    try {
      const instance = await api("GET", "/FederationInstance");
      console.log(`Local instance: ${instance.id} (${instance.role})`);

      if (!opts.token) {
        console.error("Error: --token is required. Ask the hub admin to run 'flair federation token' and provide the token.");
        process.exit(1);
      }

      // Load secret key and sign the pairing request
      const secretKey = await loadInstanceSecretKey(instance.id, opts);
      const pairBody: Record<string, any> = {
        instanceId: instance.id,
        publicKey: instance.publicKey,
        role: "spoke",
        pairingToken: opts.token,
      };
      const signedBody = signRequestBody(pairBody, secretKey);

      const res = await fetch(`${hubUrl}/FederationPair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedBody),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Pairing failed: ${res.status} ${text}`);
        process.exit(1);
      }

      const result = await res.json() as any;
      console.log(`✅ Paired with hub: ${result.instance?.id ?? hubUrl}`);

      // Record the hub as our peer locally
      const opsPort = resolveOpsPort(opts);
      const adminPass = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (adminPass) {
        const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
        await fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "upsert", database: "flair", table: "Peer",
            records: [{
              id: result.instance?.id ?? "hub",
              publicKey: result.instance?.publicKey ?? "",
              role: "hub", endpoint: hubUrl, status: "paired",
              pairedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
          }),
        });
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

federation
  .command("token")
  .description("Generate a one-time pairing token (run on the hub)")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--ttl <minutes>", "Token TTL in minutes (default: 60)", "60")
  .action(async (opts) => {
    try {
      const { randomBytes } = await import("node:crypto");
      const token = randomBytes(24).toString("base64url");
      const ttlMinutes = parseInt(opts.ttl, 10) || 60;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;

      await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          operation: "upsert", database: "flair", table: "PairingToken",
          records: [{
            id: token,
            createdAt: new Date().toISOString(),
            expiresAt,
          }],
        }),
      });

      console.log(`Pairing token (expires in ${ttlMinutes}m):`);
      console.log(`  ${token}`);
      console.log(`\nGive this to the spoke admin to run:`);
      console.log(`  flair federation pair <this-hub-url> --token ${token}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

federation
  .command("sync")
  .description("Push local changes to the hub")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .action(async (opts) => {
    try {
      const { peers } = await api("GET", "/FederationPeers");
      const hub = peers.find((p: any) => p.role === "hub" && p.status !== "revoked");
      if (!hub) {
        console.error("No hub peer configured. Use 'flair federation pair' first.");
        process.exit(1);
      }

      console.log(`Syncing to hub: ${hub.id}...`);
      const since = hub.lastSyncAt ?? new Date(0).toISOString();
      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
      const tables = ["Memory", "Soul", "Agent", "Relationship"];
      const records: any[] = [];
      const instance = await api("GET", "/FederationInstance");

      for (const table of tables) {
        try {
          const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ operation: "sql", sql: `SELECT * FROM flair.${table} WHERE updatedAt > '${since}'` }),
          });
          if (res.ok) {
            for (const row of await res.json() as any[]) {
              records.push({ table, id: row.id, data: row, updatedAt: row.updatedAt ?? row.createdAt, originatorInstanceId: instance.id });
            }
          }
        } catch {}
      }

      if (records.length === 0) { console.log("No changes since last sync."); return; }

      // Sign the sync request with our instance key
      const secretKey = await loadInstanceSecretKey(instance.id, opts);
      const syncBody: Record<string, any> = { instanceId: instance.id, records, lamportClock: Date.now() };
      const signedSyncBody = signRequestBody(syncBody, secretKey);

      const syncRes = await fetch(`${hub.endpoint ?? hub.id}/FederationSync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedSyncBody),
      });

      if (!syncRes.ok) {
        console.error(`Sync failed: ${syncRes.status} ${await syncRes.text().catch(() => "")}`);
        process.exit(1);
      }

      const result = await syncRes.json() as any;
      console.log(`✅ Synced ${result.merged} records (${result.skipped} skipped) in ${result.durationMs}ms`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem ───────────────────────────────────────────────────────────────
// Memory hygiene and reflection: light (NREM), rapid (REM), restorative (deep).

const rem = program.command("rem").description("Memory hygiene and reflection");

rem
  .command("light")
  .description("NREM — quick cleanup: delete expired, archive old, consolidate candidates")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
  .option("--dry-run", "Preview changes without applying them")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    const dryRun = !!opts.dryRun;

    console.log(`\n-- rem light${dryRun ? " (dry run)" : ""} --`);
    if (agentId) console.log(`Agent: ${agentId}`);

    try {
      // Step 1: Maintenance — expire + archive
      const maint = await api("POST", "/MemoryMaintenance", {
        ...(agentId ? { agentId } : {}),
        dryRun,
      });

      if (maint.error) {
        console.error(`Maintenance error: ${maint.error}`);
        process.exit(1);
      }

      const s = maint.stats ?? {};
      console.log("\nCleanup");
      console.log(`  Expired (deleted): ${s.expired ?? 0}`);
      console.log(`  Archived (soft):   ${s.archived ?? 0}`);
      console.log(`  Total scanned:     ${s.total ?? 0}`);
      if (s.errors) console.log(`  Errors:            ${s.errors}`);

      // Step 2: Consolidation candidates
      if (!agentId) {
        console.log("\nConsolidation skipped — no agent ID (pass --agent or set FLAIR_AGENT_ID)");
        return;
      }

      const consol = await api("POST", "/ConsolidateMemories", {
        agentId,
        scope: "all",
      });

      if (consol.error) {
        console.error(`Consolidation error: ${consol.error}`);
        process.exit(1);
      }

      const candidates = consol.candidates ?? [];
      const promote = candidates.filter((c: any) => c.suggestion === "promote");
      const archive = candidates.filter((c: any) => c.suggestion === "archive");

      console.log("\nConsolidation candidates");
      console.log(`  Promote: ${promote.length}`);
      console.log(`  Archive: ${archive.length}`);

      if (promote.length > 0) {
        console.log("\n  Promote:");
        for (const c of promote) {
          console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
        }
      }
      if (archive.length > 0) {
        console.log("\n  Archive:");
        for (const c of archive) {
          console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
        }
      }

      console.log(`\nDone.${dryRun ? " No changes applied (dry run)." : ""}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

rem
  .command("rapid")
  .description("REM — reflection/learning: generate a structured LLM reflection prompt")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
  .option("--focus <type>", "lessons_learned | patterns | decisions | errors", "lessons_learned")
  .option("--since <date>", "ISO timestamp lower bound (default: 24h ago)")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("Error: --agent <id> or FLAIR_AGENT_ID env required");
      process.exit(1);
    }

    console.log(`\n-- rem rapid --`);
    console.log(`Agent: ${agentId}  Focus: ${opts.focus}`);

    try {
      const body: Record<string, any> = {
        agentId,
        focus: opts.focus,
      };
      if (opts.since) body.since = opts.since;

      const result = await api("POST", "/ReflectMemories", body);

      if (result.error) {
        console.error(`Reflection error: ${result.error}`);
        process.exit(1);
      }

      console.log(`\nSource memories: ${result.count ?? 0}`);
      if (result.suggestedTags?.length) {
        console.log(`Tags: ${result.suggestedTags.join(", ")}`);
      }

      console.log("\n--- Reflection Prompt ---");
      console.log(result.prompt ?? "(no prompt returned)");
      console.log("--- End Prompt ---\n");
      console.log("Feed the prompt above to your LLM, then write insights back with:");
      console.log("  flair memory add --agent <id> --content <insight> --durability persistent");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

rem
  .command("restorative")
  .description("Deep audit: full maintenance + consolidation (olderThan=7d) + reflection")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
  .option("--dry-run", "Preview maintenance changes without applying them")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    const dryRun = !!opts.dryRun;

    console.log(`\n== rem restorative${dryRun ? " (dry run)" : ""} ==`);
    if (agentId) console.log(`Agent: ${agentId}`);

    try {
      // Step 1: Maintenance
      console.log("\n[1/3] Maintenance...");
      const maint = await api("POST", "/MemoryMaintenance", {
        ...(agentId ? { agentId } : {}),
        dryRun,
      });

      if (maint.error) {
        console.error(`Maintenance error: ${maint.error}`);
        process.exit(1);
      }

      const s = maint.stats ?? {};
      console.log(`  Expired: ${s.expired ?? 0}  Archived: ${s.archived ?? 0}  Scanned: ${s.total ?? 0}${s.errors ? `  Errors: ${s.errors}` : ""}`);

      // Step 2: Consolidation (skip if no agentId)
      if (agentId) {
        console.log("\n[2/3] Consolidation (scope=all, olderThan=7d)...");
        const consol = await api("POST", "/ConsolidateMemories", {
          agentId,
          scope: "all",
          olderThan: "7d",
        });

        if (consol.error) {
          console.error(`Consolidation error: ${consol.error}`);
          process.exit(1);
        }

        const candidates = consol.candidates ?? [];
        const promote = candidates.filter((c: any) => c.suggestion === "promote");
        const archive = candidates.filter((c: any) => c.suggestion === "archive");

        console.log(`  Promote candidates: ${promote.length}  Archive candidates: ${archive.length}`);
        for (const c of promote) {
          console.log(`    promote [${c.memory?.id ?? "?"}] ${c.reason}`);
        }
        for (const c of archive) {
          console.log(`    archive [${c.memory?.id ?? "?"}] ${c.reason}`);
        }
      } else {
        console.log("\n[2/3] Consolidation skipped — no agent ID");
      }

      // Step 3: Reflection
      if (agentId) {
        console.log("\n[3/3] Reflection (scope=all)...");
        const reflect = await api("POST", "/ReflectMemories", {
          agentId,
          scope: "all",
        });

        if (reflect.error) {
          console.error(`Reflection error: ${reflect.error}`);
          process.exit(1);
        }

        console.log(`  Source memories: ${reflect.count ?? 0}`);
        if (reflect.suggestedTags?.length) {
          console.log(`  Tags: ${reflect.suggestedTags.join(", ")}`);
        }

        console.log("\n--- Reflection Prompt ---");
        console.log(reflect.prompt ?? "(no prompt returned)");
        console.log("--- End Prompt ---");
      } else {
        console.log("\n[3/3] Reflection skipped — no agent ID");
      }

      console.log(`\nRestorative cycle complete.${dryRun ? " No changes applied (dry run)." : ""}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair status ─────────────────────────────────────────────────────────────

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ago = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ago) || ago < 0) return "—";
  const mins = Math.floor(ago / 60000);
  const hrs = Math.floor(ago / 3600000);
  const days = Math.floor(ago / 86400000);
  return days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : "just now";
}

// Renders OAuth status lines from non-secret metadata. /HealthDetail never
// returns clientSecret — only counts and identifying fields (id, name,
// registeredBy, createdAt, issuer). Inputs are coerced to scalar primitives
// before formatting to keep the display values clearly separated from the
// source record.
function oauthSummaryLines(o: any): string[] {
  const clients = Number(o?.clients ?? 0);
  const idps = Number(o?.idpConfigs ?? 0);
  const tokens = Number(o?.activeTokens ?? 0);
  return [
    "\nOAuth:",
    `  Clients:     ${clients}   IdPs: ${idps}   Active tokens: ${tokens}`,
  ];
}

function oauthDetailLines(o: any): string[] {
  const clients = Number(o?.clients ?? 0);
  const idps = Number(o?.idpConfigs ?? 0);
  const tokens = Number(o?.activeTokens ?? 0);
  const out: string[] = [
    "OAuth:",
    `  Clients:       ${clients}`,
    `  IdP configs:   ${idps}`,
    `  Active tokens: ${tokens}`,
  ];
  if (Array.isArray(o?.clientList) && o.clientList.length > 0) {
    out.push("", "  Clients:");
    for (const c of o.clientList) {
      const id = String(c?.id ?? "");
      const name = String(c?.name ?? "—");
      const registeredBy = String(c?.registeredBy ?? "—");
      const createdAt = String(c?.createdAt ?? "—");
      out.push(`    ${id}  ${name}  ${registeredBy}  ${createdAt}`);
    }
  }
  if (Array.isArray(o?.idpList) && o.idpList.length > 0) {
    out.push("", "  IdPs:");
    for (const i of o.idpList) {
      const id = String(i?.id ?? "");
      const name = String(i?.name ?? "—");
      const issuer = String(i?.issuer ?? "—");
      out.push(`    ${id}  ${name}  ${issuer}`);
    }
  }
  return out;
}

async function fetchHealthDetail(opts: { port?: string; url?: string; agent?: string }): Promise<{
  healthy: boolean;
  baseUrl: string;
  healthData: any | null;
}> {
  const port = resolveHttpPort(opts);
  const baseUrl = opts.url ?? `http://127.0.0.1:${port}`;
  let healthy = false;
  let healthData: any = null;

  try {
    let res = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status === 401) {
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
      if (adminPass) {
        res = await fetch(`${baseUrl}/Health`, {
          headers: { Authorization: `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}` },
          signal: AbortSignal.timeout(5000),
        });
      }
    }
    healthy = res.ok;
  } catch { /* unreachable */ }

  if (healthy) {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    if (agentId) {
      const keyPath = resolveKeyPath(agentId);
      if (keyPath) {
        try {
          const authHeader = buildEd25519Auth(agentId, "GET", "/HealthDetail", keyPath);
          const res = await fetch(`${baseUrl}/HealthDetail`, {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) healthData = await res.json().catch(() => null);
        } catch { /* fall through */ }
      }
    }
    if (!healthData) {
      const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS;
      if (adminPass) {
        try {
          const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
          const res = await fetch(`${baseUrl}/HealthDetail`, {
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) healthData = await res.json().catch(() => null);
        } catch { /* fall through */ }
      }
    }
  }

  return { healthy, baseUrl, healthData };
}

const statusCmd = program
  .command("status")
  .description("Show Flair instance status, memory stats, and agent info")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--json", "Output as JSON")
  .option("--agent <id>", "Agent ID for authenticated detail (or set FLAIR_AGENT_ID)")
  .action(async (opts) => {
    const { healthy, baseUrl, healthData } = await fetchHealthDetail(opts);

    if (opts.json) {
      console.log(JSON.stringify({ healthy, url: baseUrl, flairVersion: __pkgVersion, ...healthData }, null, 2));
      if (!healthy) process.exit(1);
      return;
    }

    if (!healthy) {
      console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
      console.log(`  URL:  ${baseUrl}`);
      console.log(`\n  Run: flair start  or  flair doctor`);
      process.exit(1);
    }

    const uptimeSec = healthData?.uptimeSeconds;
    let uptimeStr = "";
    if (uptimeSec != null) {
      const d = Math.floor(uptimeSec / 86400);
      const h = Math.floor((uptimeSec % 86400) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      uptimeStr = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const pid = healthData?.pid ?? "";
    const agents = healthData?.agents;
    const memories = healthData?.memories;
    const warnings: Array<{ level: string; message: string }> = Array.isArray(healthData?.warnings) ? healthData.warnings : [];
    const hasWarn = warnings.some((w) => w.level === "warn");
    const headerIcon = hasWarn ? "🟡" : "🟢";
    const headerState = hasWarn ? "degraded" : "running";

    console.log(`Flair v${__pkgVersion} — ${headerIcon} ${headerState}${pid ? ` (PID ${pid}` : ""}${uptimeStr ? `, uptime ${uptimeStr})` : pid ? ")" : ""}`);
    console.log(`  URL:        ${baseUrl}`);

    if (warnings.length > 0) {
      console.log(`\n⚠ Warnings:  ${warnings.length}`);
      for (const w of warnings) console.log(`  • ${w.level} ${w.message}`);
    }

    if (memories) {
      console.log("\nMemory:");
      const embStr = memories.withEmbeddings > 0 ? `${memories.withEmbeddings} embedded` : "";
      const hashStr = memories.hashFallback > 0 ? `${memories.hashFallback} hash` : "";
      const detail = [embStr, hashStr].filter(Boolean).join(", ");
      console.log(`  Total:       ${memories.total}${detail ? ` (${detail})` : ""}`);
      if (memories.modelCounts && typeof memories.modelCounts === "object") {
        const entries = Object.entries(memories.modelCounts as Record<string, number>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length > 0) {
          const formatted = entries.map(([k, n]) => `${k}: ${n}`).join(", ");
          console.log(`  Embeddings:  ${formatted}`);
        }
      }
      if (memories.byDurability) {
        const d = memories.byDurability;
        console.log(`  Durability:  ${d.permanent ?? 0} permanent / ${d.persistent ?? 0} persistent / ${d.standard ?? 0} standard / ${d.ephemeral ?? 0} ephemeral`);
      }
      if (typeof memories.archived === "number") console.log(`  Archived:    ${memories.archived}`);
      if (typeof memories.expired === "number" && memories.expired > 0) console.log(`  Expired:     ${memories.expired}`);
      if (healthData?.lastWrite) console.log(`  Last write:  ${relativeTime(healthData.lastWrite)}`);
    }

    if (agents && agents.count > 0) {
      console.log("\nAgents:");
      const nameStr = agents.names?.length > 0 ? ` — ${agents.names.join(", ")}` : "";
      console.log(`  ${agents.count} total${nameStr}`);
      if (agents.count > 1 && Array.isArray(agents.perAgent) && agents.perAgent.length > 0) {
        const idW = Math.max(2, ...agents.perAgent.map((r: any) => (r.id ?? "").length));
        // Older HealthDetail responses only carry id / memoryCount / lastWriteAt.
        // Only print the richer columns if at least one row supplies them.
        const hasDeep = agents.perAgent.some(
          (r: any) => typeof r.hashFallback === "number" || typeof r.writes24h === "number",
        );
        if (hasDeep) {
          console.log(`  ${"id".padEnd(idW)}  memories  hash_fb  24h  last_write`);
          for (const r of agents.perAgent) {
            const fb = typeof r.hashFallback === "number" ? String(r.hashFallback) : "—";
            const w24 = typeof r.writes24h === "number" ? String(r.writes24h) : "—";
            console.log(
              `  ${(r.id ?? "").padEnd(idW)}  ${String(r.memoryCount).padStart(8)}  ${fb.padStart(7)}  ${w24.padStart(3)}  ${relativeTime(r.lastWriteAt)}`,
            );
          }
        } else {
          console.log(`  ${"id".padEnd(idW)}  memories  last_write`);
          for (const r of agents.perAgent) {
            console.log(`  ${(r.id ?? "").padEnd(idW)}  ${String(r.memoryCount).padStart(8)}  ${relativeTime(r.lastWriteAt)}`);
          }
        }
      }
    }

    if (healthData?.relationships) {
      const r = healthData.relationships;
      console.log("\nRelationships:");
      console.log(`  ${r.total} total (${r.active} active)`);
    }

    if (healthData?.soul && healthData.soul.total > 0) {
      const s = healthData.soul;
      const bp = s.byPriority ?? {};
      console.log("\nSoul:");
      console.log(`  ${s.total} entries — ${bp.critical ?? 0} critical / ${bp.high ?? 0} high / ${bp.standard ?? 0} standard / ${bp.low ?? 0} low`);
    } else if (typeof healthData?.soulEntries === "number" && healthData.soulEntries > 0) {
      console.log("\nSoul:");
      console.log(`  ${healthData.soulEntries} entries`);
    }

    if (healthData?.rem) {
      const r = healthData.rem;
      console.log("\nREM:");
      if (r.lastLightAt) console.log(`  Last light:        ${relativeTime(r.lastLightAt)}`);
      if (r.lastRapidAt) console.log(`  Last rapid:        ${relativeTime(r.lastRapidAt)}`);
      if (r.lastRestorativeAt) console.log(`  Last restorative:  ${relativeTime(r.lastRestorativeAt)}`);
      const nightly = r.nightlyEnabled === true ? "enabled" : r.nightlyEnabled === false ? "disabled" : "unknown";
      console.log(`  Nightly:           ${nightly}`);
      if (r.nightlyEnabled && r.lastNightlyAt) console.log(`  Last nightly:      ${relativeTime(r.lastNightlyAt)}`);
      if (typeof r.pendingCandidates === "number" && r.pendingCandidates > 0) {
        console.log(`  Pending candidates: ${r.pendingCandidates}`);
      }
    }

    if (healthData?.federation) {
      const f = healthData.federation;
      console.log("\nFederation:");
      if (f.instance) console.log(`  Instance:    ${f.instance.id} (${f.instance.role ?? "—"}, ${f.instance.status ?? "—"})`);
      if (f.peers) console.log(`  Peers:       ${f.peers.total} (${f.peers.connected} connected / ${f.peers.disconnected} down / ${f.peers.revoked} revoked)`);
      if (f.pendingTokens > 0) console.log(`  Pairing:     ${f.pendingTokens} unconsumed token(s)`);
    }

    if (healthData?.oauth) {
      const lines = oauthSummaryLines(healthData.oauth);
      for (const line of lines) console.log(line);
    }

    if (healthData?.bridges) {
      const b = healthData.bridges;
      console.log("\nBridges:");
      if (Array.isArray(b.installed) && b.installed.length > 0) console.log(`  Installed:   ${b.installed.join(", ")}`);
      if (b.lastImport) console.log(`  Last import: ${relativeTime(b.lastImport)}`);
      if (b.lastExport) console.log(`  Last export: ${relativeTime(b.lastExport)}`);
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log("\nDisk:");
      console.log(`  Data:        ${d.dataDir} — ${humanBytes(d.dataBytes ?? 0)}`);
      console.log(`  Snapshots:   ${d.snapshotDir} — ${humanBytes(d.snapshotBytes ?? 0)}`);
    }

    console.log("");
    if (warnings.length > 0) console.log(`  Health:     ⚠ ${warnings.length} warning(s)`);
    else console.log(`  Health:     ✅ all checks passing`);
  });

statusCmd
  .command("rem")
  .description("Show REM (memory hygiene) subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    if (opts.json) {
      console.log(JSON.stringify({ healthy, rem: healthData?.rem ?? null }, null, 2));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) { console.log("🔴 unreachable"); process.exit(1); }
    const r = healthData?.rem;
    if (!r) { console.log("REM: not configured (no log entries or platform timers found)"); return; }
    console.log("REM:");
    console.log(`  Last light:        ${relativeTime(r.lastLightAt)}`);
    console.log(`  Last rapid:        ${relativeTime(r.lastRapidAt)}`);
    console.log(`  Last restorative:  ${relativeTime(r.lastRestorativeAt)}`);
    const nightly = r.nightlyEnabled === true ? "enabled" : r.nightlyEnabled === false ? "disabled" : "unknown";
    console.log(`  Nightly:           ${nightly}`);
    if (r.lastNightlyAt) console.log(`  Last nightly:      ${relativeTime(r.lastNightlyAt)} (${r.lastNightlyAt})`);
    if (typeof r.pendingCandidates === "number") console.log(`  Pending candidates: ${r.pendingCandidates}`);
    else console.log(`  Pending candidates: — (schema not available)`);
  });

statusCmd
  .command("federation")
  .description("Show federation subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    if (opts.json) {
      console.log(JSON.stringify({ healthy, federation: healthData?.federation ?? null }, null, 2));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) { console.log("🔴 unreachable"); process.exit(1); }
    const f = healthData?.federation;
    if (!f) { console.log("Federation: not configured"); return; }
    console.log("Federation:");
    if (f.instance) console.log(`  Instance:    ${f.instance.id} (${f.instance.role ?? "—"}, ${f.instance.status ?? "—"})`);
    else console.log("  Instance:    —");
    if (f.peers) console.log(`  Peers:       ${f.peers.total} (${f.peers.connected} connected / ${f.peers.disconnected} down / ${f.peers.revoked} revoked)`);
    if (typeof f.pendingTokens === "number" && f.pendingTokens > 0) console.log(`  Pairing:     ${f.pendingTokens} unconsumed token(s)`);
    if (Array.isArray(f.peerList) && f.peerList.length > 0) {
      const idW = Math.max(4, ...f.peerList.map((p: any) => (p.id ?? "").length));
      console.log(`\n  ${"peer".padEnd(idW)}  ${"role".padEnd(5)}  ${"status".padEnd(13)}  last_sync`);
      for (const p of f.peerList) {
        console.log(`  ${(p.id ?? "").padEnd(idW)}  ${(p.role ?? "—").padEnd(5)}  ${(p.status ?? "—").padEnd(13)}  ${p.lastSyncAt ? `${relativeTime(p.lastSyncAt)} (${p.lastSyncAt})` : "never"}`);
      }
    }
  });

statusCmd
  .command("auth")
  .description("Show OAuth / IdP subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    if (opts.json) {
      console.log(JSON.stringify({ healthy, oauth: healthData?.oauth ?? null }, null, 2));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) { console.log("🔴 unreachable"); process.exit(1); }
    const o = healthData?.oauth;
    if (!o) { console.log("OAuth: not configured"); return; }
    const lines = oauthDetailLines(o);
    for (const line of lines) console.log(line);
  });

statusCmd
  .command("bridges")
  .description("Show memory bridges subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    if (opts.json) {
      console.log(JSON.stringify({ healthy, bridges: healthData?.bridges ?? null }, null, 2));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) { console.log("🔴 unreachable"); process.exit(1); }
    const b = healthData?.bridges;
    if (!b) { console.log("Bridges: none installed (no flair-bridge-* packages found)"); return; }
    console.log("Bridges:");
    if (Array.isArray(b.installed) && b.installed.length > 0) console.log(`  Installed:   ${b.installed.join(", ")}`);
    if (b.lastImport) console.log(`  Last import: ${relativeTime(b.lastImport)}`);
    if (b.lastExport) console.log(`  Last export: ${relativeTime(b.lastExport)}`);
  });

// ─── flair upgrade ────────────────────────────────────────────────────────────

program
  .command("upgrade")
  .description("Upgrade Flair and related packages to latest versions")
  .option("--check", "Only check for updates, don't install")
  .option("--restart", "Restart Flair after upgrade")
  .action(async (opts) => {
    const { execSync } = await import("node:child_process");
    const checkOnly = opts.check ?? false;

    console.log("Checking for updates...\n");

    const packages = [
      "@tpsdev-ai/flair",
      "@tpsdev-ai/flair-client",
      "@tpsdev-ai/flair-mcp",
    ];

    const upgrades: { pkg: string; installed: string; latest: string }[] = [];

    for (const pkg of packages) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json() as { version?: string };
        const latest = data.version ?? "unknown";

        let installed = "not installed";
        try {
          const out = execSync(`npm list -g ${pkg} --depth=0 2>/dev/null || true`, { encoding: "utf-8" }).trim();
          const match = out.match(/@(\d+\.\d+[\d.a-z-]*)/);
          installed = match ? match[1] : "not installed";
        } catch { /* best effort */ }

        const upToDate = installed === latest;
        const icon = upToDate ? "✅" : "⬆️";
        console.log(`  ${icon} ${pkg}: ${installed} → ${latest}${upToDate ? " (current)" : ""}`);
        if (!upToDate && installed !== "not installed") {
          upgrades.push({ pkg, installed, latest });
        }
      } catch { /* skip unavailable packages */ }
    }

    if (upgrades.length === 0) {
      console.log("\n✅ Everything is up to date.");
      return;
    }

    if (checkOnly) {
      console.log(`\n${upgrades.length} update${upgrades.length > 1 ? "s" : ""} available. Run: flair upgrade`);
      return;
    }

    // Perform upgrade
    console.log(`\nUpgrading ${upgrades.length} package${upgrades.length > 1 ? "s" : ""}...\n`);
    for (const { pkg, latest } of upgrades) {
      try {
        console.log(`  Installing ${pkg}@${latest}...`);
        execSync(`npm install -g ${pkg}@${latest}`, { stdio: "pipe" });
        console.log(`  ✅ ${pkg}@${latest} installed`);
      } catch (err: any) {
        console.error(`  ❌ ${pkg} upgrade failed: ${err.message}`);
      }
    }

    if (opts.restart) {
      console.log("\nRestarting Flair...");
      try {
        const port = resolveHttpPort({});
        const label = "ai.tpsdev.flair";
        const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
        if (process.platform === "darwin" && existsSync(plistPath)) {
          try { execSync(`launchctl stop ${label}`, { stdio: "pipe" }); } catch {}
          await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
          console.log("✅ Flair restarted with new version");
        } else {
          console.log("Run: flair restart");
        }
      } catch {
        console.log("Run: flair restart");
      }
    } else {
      console.log("\nRun: flair restart  to use the new version");
    }
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

// ─── flair start ──────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start Flair (Harper) — requires a prior 'flair init'")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);

    // Check if already running
    try {
      const res = await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) {
        console.log(`Flair is already running on port ${port}.`);
        return;
      }
    } catch { /* not running — good */ }

    const dataDir = defaultDataDir();
    if (!existsSync(dataDir)) {
      console.error("❌ No Flair data directory found. Run 'flair init' first.");
      process.exit(1);
    }

    const platform = process.platform;
    if (platform === "darwin") {
      const label = "ai.tpsdev.flair";
      const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        try {
          const { execSync } = await import("node:child_process");
          try { execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" }); } catch {}
          execSync(`launchctl start ${label}`, { stdio: "pipe" });
          await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
          console.log("✅ Flair started (launchd)");
          return;
        } catch (err: any) {
          console.error(`launchd start failed, falling back to direct start: ${err.message}`);
        }
      }
    }

    // Direct start (Linux, or macOS fallback when no launchd plist)
    const bin = harperBin();
    if (!bin) {
      console.error("❌ Harper binary not found. Run 'flair init' first.");
      process.exit(1);
    }

    const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS || "";
    const opsPort = resolveOpsPort(opts);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ROOTPATH: dataDir,
      DEFAULTS_MODE: "dev",
      HDB_ADMIN_USERNAME: DEFAULT_ADMIN_USER,
      HTTP_PORT: String(port),
      OPERATIONSAPI_NETWORK_PORT: String(opsPort),
      LOCAL_STUDIO: "false",
    };
    // Only set HDB_ADMIN_PASSWORD if we have a real value — empty string
    // would strip Harper's auth on an existing install
    if (adminPass) {
      env.HDB_ADMIN_PASSWORD = adminPass;
    }

    const proc = spawn(process.execPath, [bin, "run", "."], {
      cwd: flairPackageDir(), env, detached: true, stdio: "ignore",
    });
    proc.unref();

    try {
      await waitForHealth(port, DEFAULT_ADMIN_USER, adminPass, STARTUP_TIMEOUT_MS);
      console.log(`✅ Flair started on port ${port}`);
    } catch {
      console.error("❌ Flair failed to start within timeout. Check logs in " + join(dataDir, "harper.log"));
      process.exit(1);
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
          // Ensure the service is loaded (init writes the plist but doesn't load it)
          try { execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" }); } catch {}
          // Capture the current PID *before* stopping so we can verify exit. Without
          // this, waitForHealth can race against the still-shutting-down old process
          // and return success before KeepAlive brings the new one up.
          const oldPid = readHarperPid(defaultDataDir());
          try { execSync(`launchctl stop ${label}`, { stdio: "pipe" }); } catch {}
          if (oldPid) await waitForProcessExit(oldPid, STARTUP_TIMEOUT_MS);
          await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
          console.log("✅ Flair restarted");
          return;
        } catch (err: any) {
          console.error(`launchd restart failed, falling back to port restart: ${err.message}`);
        }
      }
    }
    {
      // Port-based restart (Linux, or macOS fallback)
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
      // Match `flair start`: accept either HDB_ADMIN_PASSWORD or FLAIR_ADMIN_PASS.
      // Without this, `flair init --admin-pass X` (which only exports HDB_*
      // to the initial Harper spawn) followed by `flair restart` would silently
      // drop admin credentials — any subsequent auth'd call returns 401.
      const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS || "";
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ROOTPATH: dataDir,
        DEFAULTS_MODE: "dev",
        HDB_ADMIN_USERNAME: DEFAULT_ADMIN_USER,
        HTTP_PORT: String(port),
        LOCAL_STUDIO: "false",
      };
      if (adminPass) {
        env.HDB_ADMIN_PASSWORD = adminPass;
      }

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
  .description("Verify the full Flair stack: write, search, and delete a test memory")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

    const agentId = opts.agent ?? process.env.FLAIR_AGENT_ID;
    if (!agentId && !process.env.FLAIR_ADMIN_PASS) {
      console.error(red("Error: set --agent / FLAIR_AGENT_ID or FLAIR_ADMIN_PASS"));
      process.exit(1);
    }

    const baseUrl = `http://127.0.0.1:${resolveHttpPort(opts)}`;
    console.log(`\nFlair test (url: ${baseUrl})\n`);

    let passed = 0;
    let failed = 0;
    let memoryId: string | null = null;

    const check = async (name: string, fn: () => Promise<boolean>) => {
      try {
        const ok = await fn();
        if (ok) { console.log(`  ${green("PASS")} ${name}`); passed++; }
        else { console.log(`  ${red("FAIL")} ${name}`); failed++; }
      } catch (e: any) {
        console.log(`  ${red("FAIL")} ${name}: ${e.message?.slice(0, 120)}`);
        failed++;
      }
    };

    // 1. Write a test memory via PUT /Memory/<id>.
    // Schema only exposes PUT — POST returns 'Memory does not have a post method implemented'.
    await check("Write test memory (PUT /Memory/<id>)", async () => {
      const id = `flair-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body: Record<string, any> = {
        id,
        content: "flair test \u2014 this will be deleted",
        durability: "ephemeral",
        createdAt: new Date().toISOString(),
      };
      if (agentId) body.agentId = agentId;
      await api("PUT", `/Memory/${id}`, body);
      memoryId = id;
      return true;
    });

    // 2. Search for the test memory via POST /SemanticSearch
    await check("Search for test memory (POST /SemanticSearch)", async () => {
      await new Promise(r => setTimeout(r, 1500)); // allow indexing
      const body: Record<string, any> = { q: "flair test", limit: 5 };
      if (agentId) body.agentId = agentId;
      const result = await api("POST", "/SemanticSearch", body);
      return (result?.results?.length ?? 0) > 0;
    });

    // 3. Delete the test memory via DELETE /Memory/<id>
    await check("Delete test memory (DELETE /Memory/<id>)", async () => {
      if (!memoryId) {
        // If write returned ok without an id, skip deletion cleanly
        console.log(`       (skipped — no id returned from write step)`);
        return true;
      }
      await api("DELETE", `/Memory/${memoryId}`, agentId ? { agentId } : undefined);
      return true;
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });

// ─── flair deploy ─────────────────────────────────────────────────────────────

program
  .command("deploy")
  .description("Deploy Flair as a component to a remote Harper Fabric cluster")
  .option("--fabric-org <org>", "Fabric org (env: FABRIC_ORG)")
  .option("--fabric-cluster <cluster>", "Fabric cluster within the org (env: FABRIC_CLUSTER)")
  .option("--fabric-user <user>", "Fabric admin username (env: FABRIC_USER)")
  .option("--fabric-password <pass>", "Fabric admin password (env: FABRIC_PASSWORD)")
  .option("--fabric-token <token>", "OAuth bearer token (env: FABRIC_TOKEN) — reserved for future Fabric bearer support")
  .option("--target <url>", "Override the Fabric URL template (https://<cluster>.<org>.harperfabric.com)")
  .option("--project <name>", "Component name in Fabric", "flair")
  .option("--pkg-version <semver>", "Override version label (default: installed package version)")
  .option("--no-replicated", "Disable cluster-wide replication (default: replicated=true)")
  .option("--no-restart", "Do not restart the component after deploy (default: restart=true)")
  .option("--dry-run", "Resolve package, validate args, skip the deploy call")
  .option("--package-root <dir>", "Override package root (mainly for testing)")
  .action(async (opts) => {
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

    const deployOpts = {
      fabricOrg: opts.fabricOrg ?? process.env.FABRIC_ORG,
      fabricCluster: opts.fabricCluster ?? process.env.FABRIC_CLUSTER,
      fabricUser: opts.fabricUser ?? process.env.FABRIC_USER,
      fabricPassword: opts.fabricPassword ?? process.env.FABRIC_PASSWORD,
      fabricToken: opts.fabricToken ?? process.env.FABRIC_TOKEN,
      target: opts.target,
      project: opts.project,
      version: opts.pkgVersion,
      replicated: opts.replicated !== false,
      restart: opts.restart !== false,
      dryRun: opts.dryRun ?? false,
      packageRoot: opts.packageRoot,
    };

    const errors = validateDeployOptions(deployOpts);
    if (errors.length) {
      console.error(red("flair deploy: missing required options"));
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }

    // Warn on password-via-flag (leaks to shell history). Env is preferred.
    if (opts.fabricPassword && !process.env.FABRIC_PASSWORD) {
      console.error(dim(
        "warning: --fabric-password leaks to shell history. " +
        "Prefer FABRIC_PASSWORD env.",
      ));
    }

    const url = buildDeployUrl(deployOpts);
    console.log(`${green("→")} Deploying ${deployOpts.project} to ${url}`);
    if (deployOpts.dryRun) console.log(dim("  (dry-run: skipping API call)"));

    try {
      const result = await deployToFabric(deployOpts);
      if (result.dryRun) {
        console.log(`${green("✓")} dry-run OK: ${result.project} ${result.version} ready to deploy to ${result.url}`);
        console.log(dim(`  package root: ${result.packageRoot}`));
        return;
      }
      console.log(`\n${green("✓")} Flair ${result.version} deployed`);
      console.log(`\n  URL:     ${result.url}`);
      console.log(`  Project: ${result.project}`);
      console.log(`\nNext steps:`);
      console.log(dim(`  1. Set an admin password in Fabric Studio (Cluster Settings → Admin)`));
      console.log(dim(`  2. Seed your first agent:`));
      console.log(`     flair agent add --remote ${result.url} --name my-agent`);
    } catch (err: any) {
      console.error(red(`\n✗ deploy failed: ${err.message}`));
      const hint = err.message?.toLowerCase();
      if (hint?.includes("401") || hint?.includes("unauthoriz")) {
        console.error(dim("  hint: check Fabric Studio → Cluster Settings → Admin for the admin password"));
      }
      process.exit(1);
    }
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
memory.command("add [content]").requiredOption("--agent <id>")
  .option("--content <text>", "memory content (alias for positional arg)")
  .option("--durability <d>", "standard").option("--tags <csv>")
  .action(async (contentArg, opts) => {
    const content = contentArg ?? opts.content;
    if (!content) { console.error("error: content required (positional arg or --content)"); process.exit(1); }
    const memId = `${opts.agent}-${Date.now()}`;
    const out = await api("PUT", `/Memory/${memId}`, {
      id: memId, agentId: opts.agent, content, durability: opts.durability || "standard",
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
      type: "memory", createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify(out, null, 2));
  });
memory.command("search [query]").requiredOption("--agent <id>")
  .option("--q <query>", "search query (alias for positional arg)")
  .option("--limit <n>", "Max results", "5")
  .option("--tag <tag>")
  .action(async (queryArg, opts) => {
    const q = queryArg ?? opts.q;
    if (!q) { console.error("error: query required (positional arg or --q)"); process.exit(1); }
    const body: Record<string, any> = { agentId: opts.agent, q, limit: parseInt(opts.limit, 10) || 5 };
    if (opts.tag) body.tag = opts.tag;
    console.log(JSON.stringify(await api("POST", "/SemanticSearch", body), null, 2));
  });
memory.command("list")
  .requiredOption("--agent <id>")
  .option("--tag <tag>")
  .option("--hash-fallback", "Only memories with missing or hash-fallback embeddings (for backfill triage)")
  .option("--limit <n>", "Max rows when using --hash-fallback", "50")
  .action(async (opts) => {
    const q = new URLSearchParams({ agentId: opts.agent, ...(opts.tag ? { tag: opts.tag } : {}) }).toString();
    const raw = await api("GET", `/Memory?${q}`);
    if (!opts.hashFallback) {
      console.log(JSON.stringify(raw, null, 2));
      return;
    }
    // --hash-fallback: filter to entries without a real embedding and print as a table.
    // Same predicate HealthDetail uses: missing model or the "hash-512d" marker.
    const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
    const fallback = all.filter((m: any) => !m.embeddingModel || m.embeddingModel === "hash-512d");
    if (fallback.length === 0) {
      console.log(`No hash-fallback memories for agent ${opts.agent}. All embedded.`);
      return;
    }
    const limit = Math.max(1, parseInt(opts.limit, 10) || 50);
    const rows = fallback
      .slice()
      .sort((a: any, b: any) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, limit);
    const idW = Math.max(2, ...rows.map((r: any) => String(r.id ?? "").length));
    console.log(`${fallback.length} hash-fallback memories for agent ${opts.agent} (showing ${rows.length}):\n`);
    console.log(`  ${"id".padEnd(idW)}  created_at            preview`);
    for (const r of rows) {
      const created = r.createdAt ? String(r.createdAt).slice(0, 19).replace("T", " ") : "—".padEnd(19);
      const preview = String(r.content ?? "").replace(/\s+/g, " ").slice(0, 80);
      console.log(`  ${String(r.id ?? "").padEnd(idW)}  ${created}  ${preview}`);
    }
    if (fallback.length > rows.length) {
      console.log(`\n... ${fallback.length - rows.length} more (raise with --limit). To backfill: flair reembed --agent ${opts.agent} --stale-only`);
    } else {
      console.log(`\nTo backfill: flair reembed --agent ${opts.agent} --stale-only`);
    }
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

// ─── flair bridge ────────────────────────────────────────────────────────────
// Slice 1 of FLAIR-BRIDGES: discovery + scaffold. Runtime (import/export/test)
// lands in follow-up PRs. See specs/FLAIR-BRIDGES.md.

const bridge = program.command("bridge").description("Manage memory bridges (import/export between Flair and foreign systems)");

bridge
  .command("list")
  .description("List installed bridges across project YAML, user YAML, npm packages, and built-ins")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { discover } = await import("./bridges/discover.js");
    const found = await discover();
    if (opts.json) {
      console.log(JSON.stringify(found, null, 2));
      return;
    }
    if (found.length === 0) {
      console.log("No bridges installed.");
      console.log("Add one with:  flair bridge scaffold <name> --file");
      console.log("Or install from npm:  npm install flair-bridge-<name>");
      return;
    }
    const nameW = Math.max(4, ...found.map((b) => b.name.length));
    const kindW = Math.max(4, ...found.map((b) => b.kind.length));
    const srcW = Math.max(6, ...found.map((b) => b.source.length));
    console.log(`  ${"name".padEnd(nameW)}  ${"kind".padEnd(kindW)}  ${"source".padEnd(srcW)}  description`);
    for (const b of found) {
      const desc = b.description ?? "";
      console.log(`  ${b.name.padEnd(nameW)}  ${b.kind.padEnd(kindW)}  ${b.source.padEnd(srcW)}  ${desc}`);
    }
  });

bridge
  .command("scaffold <name>")
  .description("Emit starter files for a new bridge. Choose --file (YAML, declarative) or --api (TS code plugin)")
  .option("--file", "YAML file-format bridge (shape A)")
  .option("--api", "TypeScript API bridge (shape B)")
  .option("--force", "Overwrite existing files")
  .action(async (name: string, opts) => {
    if (opts.file && opts.api) {
      console.error("Pick one: --file or --api.");
      process.exit(1);
    }
    const kind = opts.api ? "api" : "file"; // --file is default
    const { scaffold } = await import("./bridges/scaffold.js");
    try {
      const result = await scaffold({ name, kind, force: !!opts.force });
      if (result.createdFiles.length > 0) {
        console.log(`Created ${result.createdFiles.length} file(s):`);
        for (const p of result.createdFiles) console.log(`  + ${p}`);
      }
      if (result.skippedFiles.length > 0) {
        console.log(`Skipped ${result.skippedFiles.length} existing file(s) (pass --force to overwrite):`);
        for (const p of result.skippedFiles) console.log(`  · ${p}`);
      }
      console.log(`\n${result.summary}`);
    } catch (err: any) {
      console.error(`Scaffold failed: ${err.message}`);
      process.exit(1);
    }
  });

// Stubs — runtime coming in slice 2. Kept here so `flair bridge --help`
// documents the full surface and users don't hit "unknown command".
for (const op of ["test", "import", "export"] as const) {
  bridge
    .command(`${op} <name> [args...]`)
    .description(`${op} a bridge — not yet implemented (slice 2 of FLAIR-BRIDGES)`)
    .allowUnknownOption()
    .action(() => {
      console.error(`\`flair bridge ${op}\` is not yet implemented — landing in slice 2 of FLAIR-BRIDGES.`);
      console.error(`Discovery + scaffold shipped first; runtime execution is the next PR.`);
      process.exit(2);
    });
}

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

// Run CLI only when this is the entry point (not when imported for testing)
if (import.meta.main) {
  await program.parseAsync();
}

// ─── Exported for testing ─────────────────────────────────────────────────────
export {
  resolveKeyPath,
  buildEd25519Auth,
  readPortFromConfig,
  resolveHttpPort,
  resolveOpsPort,
  signRequestBody,
  b64,
  b64url,
  program,
};
