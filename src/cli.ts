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
  cpSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { createPrivateKey, sign as nodeCryptoSign, randomUUID, randomBytes } from "node:crypto";
import { create as tarCreate } from "tar";
import { keystore } from "./keystore.js";
import { deploy as deployToFabric, validateOptions as validateDeployOptions, buildTargetUrl as buildDeployUrl } from "./deploy.js";
import { detectClients, wireClaudeCode, wireCodex, wireGemini, wireCursor, type ClientId } from "./install/clients.js";

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

// ─── Secret detection helpers ────────────────────────

/**
 * Check if a value looks like a real secret/password/token.
 * Triggers warning when:
 *   - length >= 8
 *   - contains only alphanumerics and URL-safe punctuation (._-)
 *   - NOT a URL (doesn't contain ://)
 */
function isLikelyRealSecret(value: string): boolean {
  if (!value || value.length < 8) return false;
  if (value.includes("://")) return false; // exclude URLs
  // Match typical password/token format: alphanumerics + URL-safe punct
  const pattern = /^[A-Za-z0-9._-]+$/;
  return pattern.test(value);
}

/**
 * Determine if we should show an inline-secret warning.
 * 
 * @param optValue - The value from the command line option
 * @param fromEnv - Whether the value came from an environment variable (true = no warning)
 * @param secretFlagNames - Set of flag names that carry secrets
 * @param flagName - The flag being checked
 * @returns true if warning should be shown
 */
function shouldShowInlineSecretWarning(
  optValue: string | undefined,
  fromEnv: boolean,
  secretFlagNames: Set<string>,
  flagName: string
): boolean {
  // Skip if no value provided
  if (!optValue || optValue === "") return false;

  // Skip URLs (not secrets)
  if (flagName === "--target" || flagName === "--url") return false;

  // Only warn for secret-bearing flags
  if (!secretFlagNames.has(flagName)) return false;

  // Skip if value came from env (not argv)
  if (fromEnv) return false;

  // Check if value looks like a real secret
  if (!isLikelyRealSecret(optValue)) return false;

  return true;
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

// ─── Target resolution (remote Flair instance) ─────────────────────────────────
// --target <url> (or FLAIR_TARGET env) points all CLI operations at a remote
// Flair instance instead of localhost. This enables bootstrapping and
// managing Fabric-deployed Flair instances.

function resolveTarget(opts: { target?: string }): string | undefined {
  return opts.target || process.env.FLAIR_TARGET || undefined;
}

/** Resolve the ops API target URL from --ops-target flag or FLAIR_OPS_TARGET env.
 *  Returns undefined if neither is set (caller should fall back to derivation or localhost).
 */
function resolveOpsTarget(opts: { opsTarget?: string }): string | undefined {
  return opts.opsTarget || process.env.FLAIR_OPS_TARGET || undefined;
}

/** Derive the ops API URL from a Flair base URL.
 *  Convention: ops port = HTTP port - 1.
 *  If target has an explicit port, use port-1 (validated: must be 1-65535).
 *  If no explicit port: https → 442 (443-1), http → 19925 (19926-1), bare host → https://<host>:19925.
 *  Throws on unparseable URLs.
 */
/** Compute the effective ops API URL for remote commands.
 *  - If --ops-target is set, use it directly (no derivation).
 *  - Else if --target is set, derive ops URL via resolveOpsUrlFromTarget.
 *  - Else return undefined (fall back to localhost resolution).
 */
function resolveEffectiveOpsUrl(opts: { target?: string; opsTarget?: string }): string | undefined {
  const opsTarget = resolveOpsTarget(opts);
  if (opsTarget) return opsTarget.replace(/\/$/, "");
  const target = resolveTarget(opts);
  if (target) return resolveOpsUrlFromTarget(target);
  return undefined;
}

function resolveOpsUrlFromTarget(targetUrl: string): string {
  // Normalise bare hosts: add https:// prefix so URL parser can handle them.
  const normalised = targetUrl.includes("://") ? targetUrl : `https://${targetUrl}`;
  const url = new URL(normalised);
  const port = parseInt(url.port, 10);
  if (!isNaN(port) && port > 0 && port <= 65535) {
    const opsPort = port - 1;
    if (opsPort < 1) throw new Error(`Derived ops port ${opsPort} is out of range; target port must be > 1`);
    url.port = String(opsPort);
    return url.toString().replace(/\/$/, "");
  }
  // No valid explicit port — reject port 0 or out-of-range
  if (url.port !== "" && url.port !== undefined) {
    throw new Error(`Invalid target port: ${url.port} (must be 1-65535)`);
  }
  // No explicit port — infer from scheme
  if (url.protocol === "https:") {
    url.port = "442";
  } else {
    url.port = String(DEFAULT_OPS_PORT);
  }
  return url.toString().replace(/\/$/, "");
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

function isLocalBase(base: string): boolean {
  try {
    const url = new URL(base);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return !base;
  }
}

async function api(method: string, path: string, body?: any, options?: { baseUrl?: string }): Promise<any> {
  // Resolve port: FLAIR_URL env > ~/.flair/config.yaml > default 9926
  // When baseUrl is provided (--target), use it directly.
  const savedPort = readPortFromConfig();
  const defaultUrl = savedPort ? `http://127.0.0.1:${savedPort}` : `http://127.0.0.1:${DEFAULT_PORT}`;
  const base = options?.baseUrl ?? (process.env.FLAIR_URL || defaultUrl);
  const isLocal = isLocalBase(base);

  // Auth resolution order:
  // 1. FLAIR_TOKEN env → Bearer token (backward compat)
  // 2. FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD env → Basic admin auth (remote targets only).
  //    For local targets with authorizeLocal=true, skip Basic auth and let Harper handle it.
  // 3. FLAIR_AGENT_ID env + key file → Ed25519 signature (standard)
  // 4. No auth (Harper authorizeLocal handles local; remote will 401)
  //
  // NOTE: this function is for the Harper HTTP/REST API only. The Harper
  // operations API (used by seedAgentViaOpsApi / seedFederationInstanceViaOpsApi)
  // does NOT honor authorizeLocal — it always requires Basic admin auth, and
  // those helpers send it unconditionally. authorizeLocal=true affects this
  // path; it does not affect ops-API calls.
  let authHeader: string | undefined;
  const token = process.env.FLAIR_TOKEN;
  if (token) {
    authHeader = `Bearer ${token}`;
  } else if (!isLocal && (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD)) {
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
        } catch (err: unknown) {
          // Key exists but auth build failed — warn and continue without auth
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Warning: Ed25519 auth failed for agent '${agentId}': ${message}`);
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

/**
 * Seed an agent record via the Harper operations API.
 * Accepts either a port number (localhost) or a full URL string (--target).
 *
 * `adminPass` is typed as optional but in practice the Harper operations API
 * always requires Basic admin auth — every existing call site passes one.
 * The optional signature leaves headroom for a future Harper that honors
 * `authorizeLocal` on its ops endpoint; until then, callers must pass it.
 */
export async function seedAgentViaOpsApi(
  opsPortOrUrl: number | string,
  agentId: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass?: string,
): Promise<void> {
  const url = typeof opsPortOrUrl === "number"
    ? `http://127.0.0.1:${opsPortOrUrl}/`
    : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  // Send Basic auth whenever the caller passed an adminPass. The caller decides
  // when to omit it (e.g., local target with authorizeLocal=true).
  const auth = adminPass !== undefined ? Buffer.from(`${adminUser}:${adminPass}`).toString("base64") : undefined;
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agentId, name: agentId, publicKey: pubKeyB64url, createdAt: new Date().toISOString() }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Basic ${auth}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) return;
    throw new Error(`Operations API insert failed (${res.status}): ${text}`);
  }
}

// Seed an agent record via the Harper REST API.
// Uses localhost and the given HTTP port.
export async function seedAgentViaRestApi(
  httpPort: number,
  agentId: string,
  pubKeyB64url: string,
  adminPass: string,
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agentId, name: agentId, publicKey: pubKeyB64url, createdAt: new Date().toISOString() }],
  };

  // Only send Authorization header if adminPass is provided.
  // Matches the auth pattern in api() which respects authorizeLocal=true.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminPass) {
    headers.Authorization = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
  }

  const res = await fetch(`${baseUrl}/Agent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) return;
    throw new Error(`REST API insert failed (${res.status}): ${text}`);
  }
}

// ─── FederationInstance seed via ops API ──────────────────────────────────────
//
// Remote init writes FederationInstance through the ops API (Basic auth with
// admin:admin-pass), not the REST API (which needs server-side HDB_ADMIN_PASSWORD
// — unavailable on Fabric).  Same pattern as seedAgentViaOpsApi above.
//
// `adminPass` is optional in the signature for symmetry with seedAgentViaOpsApi
// and to keep the door open for a future Harper that honors authorizeLocal on
// its ops endpoint. Today the Harper operations API always requires Basic admin
// auth; every current caller passes it.

export async function seedFederationInstanceViaOpsApi(
  opsPortOrUrl: number | string,
  instanceId: string,
  publicKey: string,
  role: string,
  adminUser: string,
  adminPass?: string,
): Promise<void> {
  const url = typeof opsPortOrUrl === "number"
    ? `http://127.0.0.1:${opsPortOrUrl}/`
    : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  // Send Basic auth whenever the caller passed an adminPass. The caller decides
  // when to omit it (e.g., local target with authorizeLocal=true).
  const auth = adminPass !== undefined ? Buffer.from(`${adminUser}:${adminPass}`).toString("base64") : undefined;
  const now = new Date().toISOString();
  const body = {
    operation: "insert",
    database: "flair",
    table: "Instance",
    records: [{
      id: instanceId,
      publicKey,
      role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Basic ${auth}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) return;
    throw new Error(`Federation Instance insert via ops API failed (${res.status}): ${text}`);
  }
}

// ─── Provision Flair on Harper Fabric (ops-2kyi) ───────────────────────────
//
// Atomic provisioning for a fresh Harper Fabric cluster: builds a deploy
// tarball with .env baked in, deploys via ops API, waits for restart, and
// creates the super_user admin account.

export async function callOpsApi(
  opsUrl: string,
  body: Record<string, unknown>,
  user: string,
  pass: string,
): Promise<any> {
  const url = `${opsUrl.replace(/\/$/, "")}/`;
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Basic ${auth}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ops API call failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function buildDeployTarball(
  projectRoot: string,
  flairAdminPass: string,
): Promise<{ tarballB64: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "flair-deploy-"));
  try {
    // Copy deployment files into temp directory
    const entries = ["dist", "schemas", "config.yaml", "package.json", "LICENSE", "README.md", "SECURITY.md"];
    if (existsSync(join(projectRoot, "ui"))) entries.push("ui");

    for (const entry of entries) {
      const src = join(projectRoot, entry);
      const dst = join(tmpDir, entry);
      if (existsSync(src)) {
        cpSync(src, dst, { recursive: true });
      }
    }

    // Write .env with 600 permissions
    const envContent = [
      `HDB_ADMIN_PASSWORD=${flairAdminPass}`,
      `FLAIR_ADMIN_PASSWORD=${flairAdminPass}`,
      "",
    ].join("\n");
    writeFileSync(join(tmpDir, ".env"), envContent, { mode: 0o600 });

    // Build compressed tarball
    const tarballPath = join(tmpDir, "deploy.tar.gz");
    await tarCreate(
      { gzip: true, cwd: tmpDir, file: tarballPath, portable: true },
      entries,
    );

    const buf = readFileSync(tarballPath);
    return { tarballB64: buf.toString("base64") };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function waitForFlairRestart(
  targetUrl: string,
  maxWaitMs: number = 30_000,
): Promise<void> {
  const url = `${targetUrl.replace(/\/$/, "")}/FederationPair`;
  const intervalMs = 1_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text().catch(() => "");
      // The resource handler responds with "instanceId and publicKey required"
      // when the deployment is live and Flair is serving requests.
      if (text.includes("instanceId and publicKey required")) return;
    } catch {
      // Not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Flair did not respond within ${maxWaitMs / 1000}s`);
}

export async function provisionFabric(
  target: string,
  opsTarget: string,
  clusterAdminUser: string,
  clusterAdminPass: string,
  flairAdminPass: string,
): Promise<void> {
  const projectRoot = process.cwd();

  // 1. Build and deploy component tarball
  console.log("Building deploy tarball...");
  const { tarballB64 } = await buildDeployTarball(projectRoot, flairAdminPass);

  console.log("Deploying via ops API...");
  await callOpsApi(opsTarget, {
    operation: "deploy_component",
    project: "flair",
    payload: tarballB64,
    restart: "rolling",
  }, clusterAdminUser, clusterAdminPass);

  // 2. Wait for restart
  console.log("Waiting for Flair to restart...");
  await waitForFlairRestart(target);
  console.log("Flair is running ✓");

  // 3. Provision Harper super_user
  // Since ops-lzmg is merged, the username doesn't have to be "admin".
  // We can use the cluster-admin user directly if it's already a super_user.
  // Check if cluster admin is already a super_user first:
  let clusterAdminIsSuperUser = false;
  try {
    const userInfo = await callOpsApi(opsTarget, {
      operation: "list_users",
    }, clusterAdminUser, clusterAdminPass);
    // list_users returns an array of user objects with role/permission info
    const users = Array.isArray(userInfo) ? userInfo : [];
    const adminRecord = users.find(
      (u: any) => u.username === clusterAdminUser || u.user?.username === clusterAdminUser,
    );
    clusterAdminIsSuperUser = !!(
      adminRecord?.role?.permission?.super_user ??
      adminRecord?.permission?.super_user ??
      false
    );
  } catch {
    // If we can't check, assume not and proceed with add_user
  }

  if (clusterAdminIsSuperUser) {
    console.log(`Cluster admin '${clusterAdminUser}' is already a super_user — skipping user provisioning`);
  } else {
    console.log(`Provisioning Harper user 'admin' as super_user...`);
    try {
      await callOpsApi(opsTarget, {
        operation: "add_user",
        username: "admin",
        password: flairAdminPass,
        role: "super_user",
        active: true,
      }, clusterAdminUser, clusterAdminPass);
      console.log("User 'admin' created ✓");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        // Idempotent: fall back to alter_user
        console.log("User 'admin' already exists — updating password...");
        await callOpsApi(opsTarget, {
          operation: "alter_user",
          username: "admin",
          password: flairAdminPass,
          role: "super_user",
          active: true,
        }, clusterAdminUser, clusterAdminPass);
        console.log("User 'admin' updated ✓");
      } else {
        throw err;
      }
    }
  }
}

// ─── Upgrade presence probes ──────────────────────────────────────────────────
//
// `flair upgrade` previously called `npm list -g <pkg>` to detect the installed
// version. That assumed the default npm global prefix and failed (silently,
// reporting "not installed") for mise / fnm / nvm / volta users whose prefix
// lives elsewhere — including for the running flair binary itself, which is
// clearly installed somewhere. These probes locate the package regardless of
// install path.

export function probeBinVersion(
  execFileSync: typeof import("node:child_process").execFileSync,
  bin: string,
): string | null {
  // Run the binary's --version via argv (no shell). PATH resolution still
  // happens (so we find the binary wherever npm/mise/fnm installed it),
  // but there's no shell-string to inject into. CodeQL-safe and simpler.
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    // Accept either "0.6.0" on its own or a line containing a semver.
    const m = out.match(/\b(\d+\.\d+\.\d+(?:[\d.a-z.-]*)?)\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function probeLibVersion(pkgName: string): string | null {
  // Resolve the package's package.json from the running flair's module graph.
  // If the lib is installed anywhere Node can see (including bundled as a
  // dep of flair itself, sibling global install, or linked workspace), this
  // finds it. If it's truly missing, require.resolve throws → null.
  try {
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n   Couldn't parse JSON (${message}). Falling back to custom prompts.`);
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
  .description("Bootstrap a Flair (Harper) instance for an agent")
  .option("--agent-id <id>", "Agent ID to register (omit to bootstrap instance without agent)")
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (generated if omitted)")
  .option("--admin-pass-file <path>", "Read admin password from file (chmod 600 recommended)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--data-dir <dir>", "Harper data directory")
  .option("--skip-start", "Skip Harper startup (assume already running)")
  .option("--skip-soul", "Skip interactive personality setup")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--remote", "When used with --target, init as hub for remote federation")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .option("--force", "Skip confirmation prompt for remote writes (required with --target)")
  .option("--cluster-admin-user <user>", "Harper cluster admin username (env: FLAIR_CLUSTER_ADMIN_USER)")
  .option("--cluster-admin-pass <pass>", "Harper cluster admin password (env: FLAIR_CLUSTER_ADMIN_PASS)")
  .option("--flair-admin-pass <pass>", "Password for Flair's admin user (env: FLAIR_ADMIN_PASS; generated if omitted)")
  .action(async (opts) => {
    const agentId: string | undefined = opts.agentId;
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

      const adminUser = DEFAULT_ADMIN_USER;
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

          if (existsSync(privPath)) {
            console.log(`Reusing existing key: ${privPath}`);
            const seed = new Uint8Array(readFileSync(privPath));
            const kp = nacl.sign.keyPair.fromSeed(seed);
            pubKeyB64url = b64url(kp.publicKey);
          } else {
            console.log("Generating Ed25519 keypair...");
            const kp = nacl.sign.keyPair();
            const seed = kp.secretKey.slice(0, 32);
            writeFileSync(privPath, Buffer.from(seed));
            chmodSync(privPath, 0o600);
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

    // ── Local init (original behavior) ──
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const dataDir: string = opts.dataDir ?? defaultDataDir();

    // Admin password handling
    // Priority: 1) --admin-pass-file (read from file), 2) env vars, 3) generate new
    // --admin-pass is deprecated; warn if used inline (not from env)
    const adminPassFromFile = opts.adminPassFile ? readFileSync(opts.adminPassFile, "utf-8").trim() : undefined;
    const adminPassDeprecated = !!process.env.FLAIR_ADMIN_PASS;
    
    // Warn if --admin-pass is passed inline (not from env)
    // fromEnv is false if inline value is provided
    const adminPassPassedInline = !opts.adminPassFile && !!opts.adminPass;
    if (shouldShowInlineSecretWarning(opts.adminPass, adminPassDeprecated, new Set(["--admin-pass"]), "--admin-pass")) {
      console.error(
        "warning: --admin-pass passed inline. Consider --admin-pass-file <path> or FLAIR_ADMIN_PASS env " +
        "to keep secrets out of shell history."
      );
    }
    
    // Resolve password: file > env > generate
    let adminPass: string;
    let passwordSource: "generated" | "file" | "env" = "generated";
    
    if (adminPassFromFile) {
      adminPass = adminPassFromFile;
      passwordSource = "file";
    } else if (process.env.FLAIR_ADMIN_PASS) {
      adminPass = process.env.FLAIR_ADMIN_PASS;
      passwordSource = "env";
    } else if (process.env.HDB_ADMIN_PASSWORD) {
      adminPass = process.env.HDB_ADMIN_PASSWORD;
      passwordSource = "env";
    } else {
      // Generate new password and write to file
      adminPass = Buffer.from(nacl.randomBytes(18)).toString("base64url");
      const passDir = join(homedir(), ".flair");
      const passFile = join(passDir, "admin-pass");
      mkdirSync(passDir, { recursive: true });
      writeFileSync(passFile, adminPass + "\n", { mode: 0o600 });
      passwordSource = "generated";
    }
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

    if (agentId) {
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

      // Output — admin password written to file, path shown only
      console.log("\n✅ Flair initialized successfully");
      console.log(`   Agent ID:    ${agentId}`);
      console.log(`   Flair URL:   ${httpUrl}`);
      console.log(`   Private key: ${privPath}`);
      
      // Determine the password file path for display
      let passFilePath: string;
      if (opts.adminPassFile) {
        passFilePath = resolvePath(opts.adminPassFile);
      } else if (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD) {
        passFilePath = "(from env var)";
      } else {
        passFilePath = join(homedir(), ".flair", "admin-pass");
      }
      
      if (passwordSource === "generated" && !alreadyRunning) {
        console.log(`\n   Admin password saved to: ${passFilePath}`);
        console.log(`     chmod 600 ${passFilePath}`);
      } else if (passwordSource === "file") {
        console.log(`\n   Admin password read from: ${passFilePath}`);
      } else if (passwordSource === "env") {
        console.log(`\n   Admin password: from FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD env`);
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
    } else {
      const httpUrl = `http://127.0.0.1:${httpPort}`;
      console.log("\n✅ Flair initialized (no agent registered)");
      console.log(`   Flair URL:   ${httpUrl}`);
      
      // Determine the password file path for display
      let passFilePath: string;
      if (opts.adminPassFile) {
        passFilePath = resolvePath(opts.adminPassFile);
      } else if (process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD) {
        passFilePath = "(from env var)";
      } else {
        passFilePath = join(homedir(), ".flair", "admin-pass");
      }
      
      if (passwordSource === "generated" && !alreadyRunning) {
        console.log(`\n   Admin password saved to: ${passFilePath}`);
        console.log(`     chmod 600 ${passFilePath}`);
      } else if (passwordSource === "file") {
        console.log(`\n   Admin password read from: ${passFilePath}`);
      } else if (passwordSource === "env") {
        console.log(`\n   Admin password: from FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD env`);
      }
      console.log(`\n   Export: FLAIR_URL=${httpUrl}`);
    }

  });

// ─── flair install ───────────────────────────────────────────────────────────

program
  .command("install")
  .description("One-command Flair setup — init, agent, and MCP client wiring")
  .option("--client <client>", "MCP client(s) to wire: claude-code, codex, gemini, cursor, all, or none")
  .option("--agent <id>", "Agent ID (defaults to hostname short-form)")
  .option("--no-mcp", "Skip MCP wiring (init + agent only)")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--data-dir <dir>", "Harper data directory")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--skip-smoke", "Skip MCP smoke test")
  .action(async (opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const dataDir: string = opts.dataDir ?? defaultDataDir();

    // Resolve client selection
    const clientOpt: string | undefined = opts.client;
    const noMcp = opts.noMcp === true;
    const selectedClients: ClientId[] = [];

    if (clientOpt === "none" || noMcp) {
      // Skip MCP entirely — just init + agent
    } else if (clientOpt === "all") {
      // Wire all detected clients
    } else if (clientOpt) {
      // Wire a specific client
      const valid: ClientId[] = ["claude-code", "codex", "gemini", "cursor"];
      if (!valid.includes(clientOpt as ClientId)) {
        console.error(`Unknown client: ${clientOpt}. Valid: claude-code, codex, gemini, cursor, all, none`);
        process.exit(1);
      }
      selectedClients.push(clientOpt as ClientId);
    }
    // If no --client flag: interactive detection later

    // ── Step 1: Ensure Flair is initialized ──
    let alreadyInitialized = false;
    let alreadyRunning = false;
    let adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
    const adminUser = DEFAULT_ADMIN_USER;

    // Check if Flair is already initialized (config with port exists)
    try {
      const cp = configPath();
      if (existsSync(cp)) {
        const yaml = readFileSync(cp, "utf-8");
        if (yaml.match(/port:\s*\d+/)) {
          alreadyInitialized = true;
          console.log("Flair already initialized — skipping init.");
        }
      }
    } catch { /* not initialized */ }

    if (!alreadyInitialized) {
      const major = parseInt(process.version.slice(1), 10);
      if (major < 18) throw new Error(`Node.js >= 18 required (found ${process.version})`);

      // Only generate a password if none provided via env (fresh install)
      if (!adminPass) {
        adminPass = Buffer.from(nacl.randomBytes(18)).toString("base64url");
      }

      // Check if Harper is already running on this port
      try {
        const res = await fetch(`http://127.0.0.1:${httpPort}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.status > 0) { alreadyRunning = true; console.log(`Harper already running on port ${httpPort} — skipping start`); }
      } catch { /* not running */ }

      if (!alreadyRunning) {
        const bin = harperBin();
        if (!bin) throw new Error("@harperfast/harper not found in node_modules.\nRun: npm install @harperfast/harper");

        mkdirSync(dataDir, { recursive: true });

        const alreadyInstalled = existsSync(join(dataDir, "harper-config.yaml"));

        const harperSetConfig = JSON.stringify({
          rootPath: dataDir,
          http: { port: httpPort, cors: true, corsAccessList: [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`] },
          operationsApi: { network: { port: opsPort, cors: true }, domainSocket: join(dataDir, "operations-server") },
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
        } else {
          const installEnv = { ...env, HOME: join(dataDir, "..") };
          console.log("Installing Harper...");
          console.log("Downloading embedding model (nomic-embed-text-v1.5, ~80MB) — this may take a minute...");
          await new Promise<void>((resolve, reject) => {
            let output = "";
            let dotTimer: ReturnType<typeof setInterval> | null = null;
            const install = spawn(process.execPath, [bin, "install"], { cwd: flairPackageDir(), env: installEnv });
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

        // Start Harper
        console.log(`Starting Harper on port ${httpPort}...`);
        const proc = spawn(process.execPath, [bin, "run", "."], { cwd: flairPackageDir(), env, detached: true, stdio: "ignore" });
        proc.unref();
      }

      // Wait for health
      console.log("Waiting for Harper health check...");
      await waitForHealth(httpPort, adminUser, adminPass, STARTUP_TIMEOUT_MS);
      console.log("Harper is healthy ✓");

      // Write config so other commands can find this instance
      writeConfig(httpPort);
    } else {
      // Flair already initialized — resolve admin pass from env or running instance
      adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
    }

    const httpUrl = `http://127.0.0.1:${httpPort}`;

    // ── Step 2: Detect MCP clients ──
    let clients = detectClients();

    if (selectedClients.length > 0) {
      // Explicit --client flag — override detection
      if (clientOpt === "all" || clientOpt === "none" || noMcp) {
        // all/none handled below
      } else {
        // Filter to only the selected client
        clients = [{ id: selectedClients[0], label: selectedClients[0], detected: true }];
      }
    }

    if (!clientOpt && !noMcp) {
      // No --client flag — print detected clients
      const detected = clients.filter(c => c.detected);
      if (detected.length === 0) {
        console.log("No MCP clients detected. Run with --client <name> to wire a specific client.");
      } else {
        console.log(`Detected MCP clients: ${detected.map(c => c.label).join(", ")}`);
      }
    }

    // ── Step 3: Resolve agent identity ──
    const agentId: string = opts.agent ?? (() => {
      try {
        const hn = hostname();
        return hn.split(".")[0];
      } catch {
        return "flair-agent";
      }
    })();

    // Validate agentId to prevent path traversal
    const VALID_AGENT_ID = /^[a-zA-Z0-9_-]+$/;
    if (!VALID_AGENT_ID.test(agentId)) {
      throw new Error(`Invalid agent ID: ${agentId}. Agent ID must contain only letters, numbers, underscores, and hyphens.`);
    }

    let agentExists = false;

    // Check if agent already exists locally
    const privPath = privKeyPath(agentId, keysDir);
    if (existsSync(privPath)) {
      agentExists = true;
      console.log(`Agent '${agentId}' already exists ✓`);
    } else {
      // Create agent
      mkdirSync(keysDir, { recursive: true });
      const pubPath = pubKeyPath(agentId, keysDir);
      console.log("Generating Ed25519 keypair...");
      const kp = nacl.sign.keyPair();
      const seed = kp.secretKey.slice(0, 32);
      writeFileSync(privPath, Buffer.from(seed));
      chmodSync(privPath, 0o600);
      writeFileSync(pubPath, Buffer.from(kp.publicKey));
      const pubKeyB64url = b64url(kp.publicKey);
      console.log(`Keypair written: ${privPath} ✓`);

      // Seed agent - use REST API for local Harper, Ops API only when --ops-target is specified
      if (opts.opsTarget) {
        // Remote Harper via explicit ops target
        console.log(`Seeding agent '${agentId}' via operations API (--ops-target)...`);
        await seedAgentViaOpsApi(opts.opsTarget, agentId, pubKeyB64url, adminUser, adminPass);
      } else {
        // Local Harper - use REST API
        console.log(`Seeding agent '${agentId}' via REST API...`);
        await seedAgentViaRestApi(httpPort, agentId, pubKeyB64url, adminPass);
      }
      console.log(`Agent '${agentId}' registered ✓`);
    }

    // ── Step 4: Wire MCP clients ──
    const mcpEnv = { FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl };
    const wiringResults: { client: string; message: string }[] = [];

    if (!noMcp && clientOpt !== "none") {
      const toWire = clientOpt === "all"
        ? clients.filter(c => c.detected).map(c => c.id)
        : selectedClients.length > 0
          ? selectedClients
          : clients.filter(c => c.detected).map(c => c.id);

      for (const clientId of toWire) {
        let result: { ok: boolean; message: string };
        switch (clientId) {
          case "claude-code": result = wireClaudeCode(mcpEnv, httpUrl); break;
          case "codex": result = wireCodex(mcpEnv); break;
          case "gemini": result = wireGemini(mcpEnv); break;
          case "cursor": result = wireCursor(mcpEnv); break;
          default: result = { ok: false, message: `Unknown client: ${clientId}` };
        }
        wiringResults.push({ client: clientId, message: result.message });
        console.log(`  ${result.ok ? "✓" : "✗"} ${result.message}`);
      }
    }

    // ── Step 5: Smoke test the MCP server ──
    if (!opts.skipSmoke && !noMcp && clientOpt !== "none" && wiringResults.length > 0) {
      console.log("Smoke-testing MCP server...");
      try {
        // Launch flair-mcp and send initialize request over stdio
        const mcpProc = spawn("npx", ["-y", "@tpsdev-ai/flair-mcp"], {
          env: { ...process.env, FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15_000,
        });

        // Send initialize request
        const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "0.1", capabilities: {}, clientInfo: { name: "flair-install", version: "1.0.0" } } });
        mcpProc.stdin!.write(initMsg + "\n");
        mcpProc.stdin!.end();

        let stdout = "";
        mcpProc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });

        await new Promise<void>((resolve, reject) => {
          mcpProc.on("exit", (code) => {
            if (code === 0 && stdout.length > 0) {
              resolve();
            } else {
              reject(new Error(`MCP server exited with code ${code}`));
            }
          });
          mcpProc.on("error", reject);
          setTimeout(() => { mcpProc.kill(); reject(new Error("MCP smoke test timed out")); }, 15_000);
        });

        // Check for a valid JSON-RPC response
        try {
          const lines = stdout.split("\n").filter(l => l.trim());
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.jsonrpc === "2.0" && parsed.id === 1 && !parsed.error) {
              console.log("  ✓ MCP server responded");
              break;
            }
          }
        } catch {
          console.log("  ⚠ MCP server responded but response could not be parsed");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  ⚠ MCP smoke test failed: ${message}`);
        console.log("  Use --skip-smoke to bypass.");
      }
    }

    // ── Step 6: Summary ──
    console.log("");
    console.log("✓ Flair installed.");
    console.log(`   Agent: ${agentId}`);
    if (existsSync(privKeyPath(agentId, keysDir))) {
      console.log(`   Private key: ${privKeyPath(agentId, keysDir)}`);
    }
    console.log(`   Local: ${httpUrl}`);
    console.log(`   MCP: ${wiringResults.length > 0 ? wiringResults.map(r => r.client).join(", ") + " ✓ wired" : "none wired"}`);
    console.log("");
    console.log(`   Try it: in Claude Code, ask the agent "what do you remember about me?"`);
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
    // fromEnv is true ONLY when the resolved value came from env (no inline override).
    const adminPassFromEnv = !opts.adminPass && (!!process.env.FLAIR_ADMIN_PASS || !!process.env.HDB_ADMIN_PASSWORD);
    if (shouldShowInlineSecretWarning(opts.adminPass, adminPassFromEnv, new Set(["--admin-pass"]), "--admin-pass")) {
      console.error(
        "warning: --admin-pass passed inline. Consider --admin-pass-from <file> or FLAIR_ADMIN_PASS env " +
        "to keep secrets out of shell history."
      );
    }
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
    if (adminPass) {
      // Use admin basic auth against ops API to list agents directly
      const opsPort = resolveOpsPort(opts);
      const auth = Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64");
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ operation: "search_by_value", schema: "flair", table: "Agent", search_attribute: "id", search_type: "starts_with", search_value: "", get_attributes: ["id", "name", "createdAt"] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }
      const agents = await res.json() as any[];
      agents.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      console.log(JSON.stringify(agents, null, 2));
    } else {
      // Localhost operator path: allow IDs-only enumeration without per-agent auth
      // This treats localhost as a trusted boundary for read-only public metadata
      const baseUrl = `http://127.0.0.1:${port}`;
      const res = await fetch(`${baseUrl}/Agent`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Error: ${res.status} ${text}`);
        process.exit(1);
      }
      const data = await res.json();
      // Filter to IDs-only to respect the localhost trust boundary
      if (Array.isArray(data)) {
        console.log(JSON.stringify(data.map((a: any) => ({ id: a.id, name: a.name, createdAt: a.createdAt })), null, 2));
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
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
    // fromEnv is true ONLY when the resolved value came from env (no inline override).
    const adminPassFromEnv = !opts.adminPass && !!process.env.FLAIR_ADMIN_PASS;
    if (shouldShowInlineSecretWarning(opts.adminPass, adminPassFromEnv, new Set(["--admin-pass"]), "--admin-pass")) {
      console.error(
        "warning: --admin-pass passed inline. Consider --admin-pass-from <file> or FLAIR_ADMIN_PASS env " +
        "to keep secrets out of shell history."
      );
    }
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

    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
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
        get_attributes: ["id", "name", "kind", "status", "defaultTrustTier", "admin", "runtime", "createdAt"],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: ${res.status} ${text}`);
      process.exit(1);
    }

    const records = await res.json() as any[];
    records.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
      console.error(`Error: ${res.status} ${text}`);
      process.exit(1);
    }

    const records = await res.json() as any[];
    records.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
    body: JSON.stringify({ operation: "search_by_value", schema: "flair", table: "Instance", search_attribute: "id", search_type: "equals", search_value: instanceId, get_attributes: ["*"] }),
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
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    try {
      const instance = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
      console.log(`Instance: ${instance.id} (${instance.role})`);
      console.log(`Public key: ${instance.publicKey}`);
      console.log(`Status: ${instance.status}`);
      console.log();

      const { peers } = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
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
  .option("--token <token>", "One-time pairing token from hub admin (env: FLAIR_PAIRING_TOKEN)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (hubUrl: string, opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    try {
      const instance = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
      console.log(`${target ? "Remote" : "Local"} instance: ${instance.id} (${instance.role})`);

      if (!opts.token) {
        console.error("Error: --token is required. Ask the hub admin to run 'flair federation token' and provide the token.");
        process.exit(1);
      }

      // Warning: inline token may leak to shell history.
      // fromEnv is true ONLY when the resolved value came from env (no inline override).
      const tokenFromEnv = !opts.token && !!process.env.FLAIR_PAIRING_TOKEN;
      if (shouldShowInlineSecretWarning(opts.token, tokenFromEnv, new Set(["--token"]), "--token")) {
        console.error(
          "warning: --token passed inline. Consider --token-from <file> or FLAIR_PAIRING_TOKEN env " +
          "to keep secrets out of shell history."
        );
      }

      // Load secret key and sign the pairing request. The pairing token is
      // included in the signed body (not in an Authorization header) because
      // Harper's auth layer claims any "Bearer X" Authorization header for
      // itself and 401s before our resource ever runs.
      const secretKey = await loadInstanceSecretKey(instance.id, opts);
      // Env var fallback for --token: FLAIR_PAIRING_TOKEN
      const pairingToken = opts.token || process.env.FLAIR_PAIRING_TOKEN;
      const pairBody: Record<string, any> = {
        instanceId: instance.id,
        publicKey: instance.publicKey,
        role: "spoke",
        pairingToken,
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

      // Record the hub as our peer — locally or remotely depending on --target
      const adminPass = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (adminPass) {
        const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
        const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
        await fetch(`${opsEndpoint}/`, {
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
          signal: AbortSignal.timeout(10_000),
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
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    try {
      const { randomBytes } = await import("node:crypto");
      const token = randomBytes(24).toString("base64url");
      const ttlMinutes = parseInt(opts.ttl, 10) || 60;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

      const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;

      const opsRes = await fetch(`${opsEndpoint}/`, {
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
        signal: AbortSignal.timeout(10_000),
      });
      if (!opsRes.ok) {
        const detail = await opsRes.text().catch(() => "");
        throw new Error(`Failed to persist pairing token (${opsRes.status}): ${detail || "no body"}`);
      }

      console.log(`Pairing token (expires in ${ttlMinutes}m):`);
      console.log(`  ${token}`);
      console.log(`\nGive this to the spoke admin to run:`);
      console.log(`  flair federation pair <this-hub-url> --token ${token}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export async function runFederationSyncOnce(opts: any): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const target = resolveTarget(opts);
  const baseUrl = target ? target.replace(/\/$/, "") : undefined;
  const apiOpts = baseUrl ? { baseUrl } : undefined;
  try {
    const { peers } = await api("GET", "/FederationPeers", undefined, apiOpts);
    const hub = peers.find((p: any) => p.role === "hub" && p.status !== "revoked");
    if (!hub) {
      return { pushed: 0, skipped: 0, error: new Error("No hub peer configured. Use 'flair federation pair' first.") };
    }

    console.log(`Syncing to hub: ${hub.id}...`);
    const since = hub.lastSyncAt ?? new Date(0).toISOString();
    const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    const tables = ["Memory", "Soul", "Agent", "Relationship"];
    const records: any[] = [];
    const instance = await api("GET", "/FederationInstance", undefined, apiOpts);

    for (const table of tables) {
      let res: Response;
      try {
        res = await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table, operator: "and", conditions: [{ search_attribute: "updatedAt", search_type: "greater_than", search_value: since }], get_attributes: ["*"] }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err: any) {
        return { pushed: 0, skipped: 0, error: err instanceof Error ? err : new Error(String(err)) };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { pushed: 0, skipped: 0, error: new Error(`SQL query failed (${res.status}): ${text}`) };
      }
      for (const row of await res.json() as any[]) {
        records.push({ table, id: row.id, data: row, updatedAt: row.updatedAt ?? row.createdAt, originatorInstanceId: instance.id });
      }
    }

    if (records.length === 0) { console.log("No changes since last sync."); return { pushed: 0, skipped: 0 }; }

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
      const text = await syncRes.text().catch(() => "");
      return { pushed: 0, skipped: 0, error: new Error(`Sync failed: ${syncRes.status} ${text}`) };
    }

    const result = await syncRes.json() as any;
    console.log(`✅ Synced ${result.merged} records (${result.skipped} skipped) in ${result.durationMs}ms`);
    return { pushed: result.merged ?? 0, skipped: result.skipped ?? 0 };
  } catch (err: any) {
    return { pushed: 0, skipped: 0, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

federation
  .command("sync")
  .description("Push local changes to the hub")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (opts) => {
    const r = await runFederationSyncOnce(opts);
    if (r.error) {
      console.error(`Error: ${r.error.message}`);
      process.exit(1);
    }
  });

export async function runFederationWatch(opts: any): Promise<void> {
  const intervalMs = Math.max(5, parseFloat(opts.interval) || 30) * 1000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`flair federation watch — interval ${intervalMs / 1000}s. Ctrl-C to stop.`);
  try {
    while (!stopped) {
      try {
        const r = await runFederationSyncOnce(opts);
        const ts = new Date().toISOString();
        if (r.error) console.error(`[${ts}] sync error: ${r.error.message}`);
        else console.log(`[${ts}] sync ok — pushed ${r.pushed}, skipped ${r.skipped}`);
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] watch loop error: ${err.message}`);
      }
      // Sleep but exit early on signal
      const t = Date.now();
      while (!stopped && Date.now() - t < intervalMs) {
        const remaining = intervalMs - (Date.now() - t);
        await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  console.log("flair federation watch — stopped.");
}

federation
  .command("watch")
  .description("Run federation sync in a loop (foreground daemon)")
  .option("--interval <seconds>", "Seconds between syncs", "30")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--target <url>", "Remote Flair URL")
  .option("--ops-target <url>", "Explicit ops API URL")
  .action(async (opts) => {
    await runFederationWatch(opts);
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

async function fetchHealthDetail(opts: { port?: string; url?: string; target?: string; agent?: string }): Promise<{
  healthy: boolean;
  baseUrl: string;
  healthData: any | null;
}> {
  const port = resolveHttpPort(opts);
  // --target takes precedence, then --url, then FLAIR_TARGET, then FLAIR_URL, then localhost
  const baseUrl = opts.target || opts.url || process.env.FLAIR_TARGET || (process.env.FLAIR_URL ?? `http://127.0.0.1:${port}`);
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
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
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
    // Scope warnings to the filtered agent if --agent is set
    const scopedWarnings = opts.agent && healthData?.agents?.perAgent
      ? warnings.filter((w: any) => {
          // Hash-fallback warnings contain agent-specific counts
          if (w.message.includes("hash-fallback")) {
            const match = w.message.match(/\b(\d+)\/(\d+) \((\d+)%\)/);
            if (match) {
              const hashCount = parseInt(match[1]);
              const totalCount = parseInt(match[2]);
              const agentRow = healthData.agents.perAgent.find((r: any) => r.id === opts.agent);
              if (agentRow && agentRow.hashFallback === hashCount && agentRow.memoryCount === totalCount) {
                return true;
              }
              return false;
            }
          }
          // Mixed-model warnings are fleet-wide; keep them
          if (w.message.includes("multiple embedding models")) return true;
          // Federation warnings are fleet-wide; keep them
          if (w.message.includes("federation")) return true;
          // REM warnings are fleet-wide; keep them
          if (w.message.includes("REM") || w.message.includes("nightly")) return true;
          // Default: keep fleet-wide warnings
          return !w.message.includes(opts.agent);
        })
      : warnings;

    const hasWarn = scopedWarnings.some((w) => w.level === "warn");
    const headerIcon = hasWarn ? "🟡" : "🟢";

    console.log(`Flair v${__pkgVersion} — ${headerIcon} running${pid ? ` (PID ${pid}` : ""}${uptimeStr ? `, uptime ${uptimeStr})` : pid ? ")" : ""}`);
    console.log(`  URL:        ${baseUrl}`);

    if (scopedWarnings.length > 0) {
      console.log(`\n⚠ Warnings:  ${scopedWarnings.length}`);
      for (const w of scopedWarnings) console.log(`  • ${w.level} ${w.message}`);
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
    } else {
      console.log("\nFederation: not configured");
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
    } else {
      console.log("\nBridges: none installed");
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log("\nDisk:");
      console.log(`  Data:        ${d.dataDir} — ${humanBytes(d.dataBytes ?? 0)}`);
      console.log(`  Snapshots:   ${d.snapshotDir} — ${humanBytes(d.snapshotBytes ?? 0)}`);
    }

    console.log("");
    if (scopedWarnings.length > 0) console.log(`  Health:     ⚠ ${scopedWarnings.length} warning(s)`);
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
    const { execSync, execFileSync } = await import("node:child_process");
    const checkOnly = opts.check ?? false;

    console.log("Checking for updates...\n");

    // Per-package install probes. `npm list -g` assumed the default global
    // prefix and silently mis-reported "not installed" for anyone using
    // mise / fnm / nvm / volta / non-default-prefix npm — including the
    // running flair binary itself, which was obviously installed. Each
    // entry now has a locator that works regardless of install path:
    //
    //   - For packages with a bin: shell out to the bin with --version
    //     (same PATH lookup that got them invokable in the first place).
    //   - For library packages: require.resolve the package.json from the
    //     running flair's module graph (works whether it's a sibling
    //     global install or a bundled dep).
    const packages: Array<{
      name: string;
      probe: () => string | null;
    }> = [
      {
        name: "@tpsdev-ai/flair",
        probe: () => probeBinVersion(execFileSync,"flair"),
      },
      {
        name: "@tpsdev-ai/flair-client",
        probe: () => probeLibVersion("@tpsdev-ai/flair-client"),
      },
      {
        name: "@tpsdev-ai/flair-mcp",
        probe: () => probeBinVersion(execFileSync,"flair-mcp"),
      },
    ];

    // Three-state status per package:
    //   current    — installed version matches registry latest
    //   outdated   — installed version is older than latest
    //   missing    — not detected anywhere; optionally install
    type Status = "current" | "outdated" | "missing";
    const findings: Array<{ name: string; installed: string | null; latest: string; status: Status }> = [];

    for (const { name, probe } of packages) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json() as { version?: string };
        const latest = data.version ?? "unknown";

        const installed = probe();
        const status: Status = installed === null ? "missing" : installed === latest ? "current" : "outdated";
        findings.push({ name, installed, latest, status });

        const icon = status === "current" ? "✅" : status === "outdated" ? "⬆️" : "❔";
        const installedLabel = installed ?? "not detected";
        const suffix = status === "current" ? " (current)" : status === "missing" ? " (run: npm install -g)" : "";
        console.log(`  ${icon} ${name}: ${installedLabel} → ${latest}${suffix}`);
      } catch { /* skip unavailable packages */ }
    }

    const outdated = findings.filter((f) => f.status === "outdated");
    const missing = findings.filter((f) => f.status === "missing");
    const upgrades = outdated.map(({ name, installed, latest }) => ({ pkg: name, installed: installed ?? "unknown", latest }));

    if (outdated.length === 0 && missing.length === 0) {
      console.log("\n✅ Everything is up to date.");
      return;
    }

    if (missing.length > 0 && outdated.length === 0) {
      console.log(`\n❔ ${missing.length} package${missing.length > 1 ? "s" : ""} not detected — all detected packages are up to date.`);
      console.log(`   Install missing: npm install -g ${missing.map((f) => f.name).join(" ")}`);
      return;
    }

    if (checkOnly) {
      console.log(`\n${outdated.length} update${outdated.length > 1 ? "s" : ""} available. Run: flair upgrade`);
      if (missing.length > 0) {
        console.log(`${missing.length} package${missing.length > 1 ? "s" : ""} not detected${missing.length > 0 ? ": " + missing.map((f) => f.name).join(", ") : ""}.`);
      }
      return;
    }

    // Perform upgrade. `latest` comes from the npm registry's HTTP
    // response, so CodeQL (correctly) treats it as untrusted input.
    // Use execFileSync with argv — the spec `<name>@<version>` becomes a
    // single argument to npm, no shell to inject into.
    console.log(`\nUpgrading ${upgrades.length} package${upgrades.length > 1 ? "s" : ""}...\n`);
    for (const { pkg, latest } of upgrades) {
      try {
        console.log(`  Installing ${pkg}@${latest}...`);
        execFileSync("npm", ["install", "-g", `${pkg}@${latest}`], { stdio: "pipe" });
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
  .option("--agent <id>", "Agent ID to re-embed memories for (defaults to all agents with stale rows)")
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

    if (agentId) {
      console.log(`Re-embedding memories for agent: ${agentId}`);
    } else {
      console.log("Re-embedding memories for all agents with stale rows");
    }
    console.log(`Current model: ${currentModel}`);
    if (staleOnly) console.log("Mode: stale-only (skipping up-to-date memories)");
    if (dryRun) console.log("Mode: dry-run (no modifications)");
    console.log("");

    // When no agent specified, use admin auth to fetch all memories
    if (!agentId) {
      const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
      if (!adminPass) {
        console.error("❌ Admin password required when --agent is not specified (set FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD)");
        process.exit(1);
      }

      // Fetch all memories with admin auth
      const searchRes = await fetch(`${baseUrl}/SemanticSearch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`,
        },
        body: JSON.stringify({ limit: 10000 }),
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories: ${searchRes.status}`);
        process.exit(1);
      }
      const data = await searchRes.json() as { results?: any[] };
      const allMemories = data.results ?? [];

      // Group by agentId
      const byAgent = new Map<string, any[]>();
      for (const m of allMemories) {
        if (!m.content) continue;
        if (staleOnly && m.embeddingModel === currentModel) continue;
        const agent = m.agentId || "unknown";
        if (!byAgent.has(agent)) byAgent.set(agent, []);
        byAgent.get(agent)!.push(m);
      }

      // Process each agent
      let totalProcessed = 0;
      let totalErrors = 0;
      const agentCount = byAgent.size;
      let agentIndex = 0;

      for (const [agent, memories] of byAgent) {
        agentIndex++;
        console.log(`\nAgent ${agentIndex}/${agentCount}: ${agent}`);
        console.log(`  Memories to re-embed: ${memories.length}`);

        const keysDir = defaultKeysDir();
        const privPath = privKeyPath(agent, keysDir);
        if (!existsSync(privPath)) {
          console.error(`  ❌ Key not found: ${privPath} — skipping`);
          continue;
        }

        if (dryRun) continue;

        let processed = 0;
        let errors = 0;
        for (let i = 0; i < memories.length; i += batchSize) {
          const batch = memories.slice(i, i + batchSize);
          for (const memory of batch) {
            try {
              const updateRes = await authFetch(baseUrl, agent, privPath, "PUT", `/Memory/${memory.id}`, {
                id: memory.id, content: memory.content, embedding: undefined, embeddingModel: undefined, agentId: memory.agentId || agent,
              });
              if (updateRes.ok) processed++;
              else errors++;
            } catch { errors++; }
          }
          const pct = Math.round(((i + batch.length) / memories.length) * 100);
          process.stdout.write(`  \r  Re-embedded ${processed}/${memories.length} (${pct}%)${errors > 0 ? ` [${errors} errors]` : ""}`);
          if (i + batchSize < memories.length) await new Promise(r => setTimeout(r, delayMs));
        }
        console.log(`\n  ✅ Agent ${agent}: ${processed} updated, ${errors} errors`);
        totalProcessed += processed;
        totalErrors += errors;
      }

      console.log(`\n\n✅ Re-embedding complete: ${totalProcessed} updated, ${totalErrors} errors`);
      return;
    }

    // Original single-agent path
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
            id: memory.id, content: memory.content, embedding: undefined, embeddingModel: undefined, agentId: memory.agentId || opts.agent,
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
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`  ${red("FAIL")} ${name}: ${message?.slice(0, 120)}`);
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

// NOTE on env-var naming for `flair deploy`: the FABRIC_* env vars below intentionally
// do NOT carry the FLAIR_ prefix that the rest of the CLI uses (FLAIR_ADMIN_PASS,
// FLAIR_TARGET, FLAIR_PAIRING_TOKEN, etc.). FABRIC_* credentials are shared with
// the broader TPS tooling stack — multiple tools deploy to the same Harper Fabric
// org/cluster with the same auth, and demanding a tool-specific prefix would force
// operators to maintain duplicated env vars. Per Kern review on PR #306: the
// inconsistency is deliberate, document it here so the next agent doesn't "fix" it.
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
// Slice 1: discovery + scaffold. Slice 2: YAML runtime + `import` for Shape A
// + agentic-stack reference adapter as a built-in.
// `test` and `export` are still stubbed; Shape B (npm code plugins) too.
// See specs/FLAIR-BRIDGES.md.

const bridge = program.command("bridge").description("Manage memory bridges (import/export between Flair and foreign systems)");

bridge
  .command("list")
  .description("List installed bridges across project YAML, user YAML, npm packages, and built-ins")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { discover } = await import("./bridges/discover.js");
    const { builtinDiscoveryRecords } = await import("./bridges/builtins/index.js");
    const found = await discover({ builtins: builtinDiscoveryRecords() });
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
    const { BUILTIN_BY_NAME } = await import("./bridges/builtins/index.js");
    if (BUILTIN_BY_NAME.has(name)) {
      console.error(`"${name}" is a built-in bridge name and can't be scaffolded — pick a different name.`);
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

bridge
  .command("import <name> [src]")
  .description("Import memories from a foreign system into Flair via a bridge (Shape A YAML / built-in)")
  .option("--agent <id>", "Default agent ID for memories that don't carry one (or set FLAIR_AGENT_ID)")
  .option("--cwd <dir>", "Filesystem root the descriptor's relative paths resolve against (default: cwd)")
  .option("--dry-run", "Validate + count, don't write to Flair")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path (default: resolved from agent)")
  .action(async (name: string, srcArg: string | undefined, opts) => {
    const agentId: string | undefined = opts.agent ?? process.env.FLAIR_AGENT_ID;
    const cwd: string = opts.cwd ?? srcArg ?? process.cwd();

    const { discover } = await import("./bridges/discover.js");
    const { builtinDiscoveryRecords } = await import("./bridges/builtins/index.js");
    const { loadBridge } = await import("./bridges/runtime/load-bridge.js");
    const { runImport } = await import("./bridges/runtime/import-runner.js");
    const { makeContext } = await import("./bridges/runtime/context.js");
    const { BridgeRuntimeError } = await import("./bridges/types.js");

    const found = await discover({ builtins: builtinDiscoveryRecords() });
    const target = found.find((b) => b.name === name);
    if (!target) {
      console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
      process.exit(1);
    }

    let loaded;
    try {
      loaded = await loadBridge(target);
    } catch (err: any) {
      printBridgeError(err);
      process.exit(1);
    }

    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const ctx = makeContext({ bridge: name });

    // Memory POST: Ed25519-signed when an agent key is available, fall back
    // to the shared `api()` helper otherwise. Mirrors how `flair memory add`
    // works (see the `memory.command("add")` handler above).
    const putMemory = async (body: import("./bridges/runtime/import-runner.js").PutMemoryBody): Promise<void> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath: string | null = opts.key ?? resolveKeyPath(body.agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(body.agentId, "PUT", `/Memory/${body.id}`, keyPath);
      }
      const res = await fetch(`${baseUrl}/Memory/${encodeURIComponent(body.id)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PUT /Memory/${body.id} → ${res.status}: ${text || res.statusText}`);
      }
    };

    let lastReportedAt = Date.now();
    let lastReportedOrdinal = 0;
    const onProgress = (ev: import("./bridges/runtime/import-runner.js").ProgressEvent): void => {
      // Throttle in-progress chatter to at most one line every 2s + the
      // final summary. Avoids flooding stdout for big imports.
      if (ev.type === "done") {
        const noun = (n: number): string => `${n} ${n === 1 ? "memory" : "memories"}`;
        if (opts.dryRun) {
          console.log(`\n${target.name}: would import ${noun(ev.total)}. Re-run without --dry-run to write to Flair.`);
        } else {
          console.log(`\n${target.name}: imported ${ev.imported}/${ev.total} memories${ev.skipped > 0 ? ` (${ev.skipped} skipped)` : ""}.`);
        }
        return;
      }
      const now = Date.now();
      if (now - lastReportedAt < 2000 && ev.ordinal - lastReportedOrdinal < 25) return;
      lastReportedAt = now;
      lastReportedOrdinal = ev.ordinal;
      if (ev.type === "memory-imported") {
        process.stdout.write(`\r  ${ev.ordinal} imported (${ev.foreignId ?? ev.flairId})`.padEnd(80));
      } else if (ev.type === "memory-skipped") {
        process.stdout.write(`\r  ${ev.ordinal} skipped (${ev.reason})`.padEnd(80));
      }
    };

    try {
      if (loaded.kind === "yaml") {
        await runImport({
          bridgeName: target.name,
          descriptor: loaded.descriptor,
          cwd,
          agentId,
          dryRun: !!opts.dryRun,
          putMemory,
          onProgress,
          ctx,
        });
      } else {
        // Code plugin: invoke bridge.import(opts, ctx) directly; the plugin
        // returns an AsyncIterable of BridgeMemory that runImport processes.
        if (!loaded.plugin.import) {
          console.error(`Bridge "${name}" is a code plugin without an import() function — can only export through it.`);
          process.exit(1);
        }
        // Code-plugin options: pass through all --X flags as a single object.
        // The plugin's declared `options` descriptor validates what it actually cares about.
        const pluginOpts: Record<string, unknown> = { ...opts };
        const source = loaded.plugin.import(pluginOpts, ctx);
        await runImport({
          bridgeName: target.name,
          source,
          cwd,
          agentId,
          dryRun: !!opts.dryRun,
          putMemory,
          onProgress,
          ctx,
        });
      }
    } catch (err: any) {
      if (err instanceof BridgeRuntimeError) {
        printBridgeError(err);
        process.exit(1);
      }
      console.error(`Bridge import failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

bridge
  .command("export <name> <dst>")
  .description("Export memories from Flair to a foreign system via a bridge (Shape A YAML / built-in)")
  .requiredOption("--agent <id>", "Agent ID to export memories for (or set FLAIR_AGENT_ID)")
  .option("--source <tag>", "Filter to memories with a matching `source:` tag (typical for round-tripping a single bridge's data)")
  .option("--subject <subj>", "Filter to memories with a matching `subject:` tag")
  .option("--since <iso>", "Only memories with createdAt >= this ISO-8601 timestamp")
  .option("--cwd <dir>", "Filesystem root the descriptor's relative target paths resolve against (default: cwd)")
  .option("--dry-run", "Validate + count + apply maps, don't write to the target")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--key <path>", "Ed25519 private key path (default: resolved from agent)")
  .action(async (name: string, dst: string, opts) => {
    const agentId: string = opts.agent ?? process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
      process.exit(1);
    }
    const cwd: string = opts.cwd ?? dst;

    const { discover } = await import("./bridges/discover.js");
    const { builtinDiscoveryRecords } = await import("./bridges/builtins/index.js");
    const { loadBridge } = await import("./bridges/runtime/load-bridge.js");
    const { runExport } = await import("./bridges/runtime/export-runner.js");
    const { makeContext } = await import("./bridges/runtime/context.js");
    const { BridgeRuntimeError } = await import("./bridges/types.js");

    const found = await discover({ builtins: builtinDiscoveryRecords() });
    const target = found.find((b) => b.name === name);
    if (!target) {
      console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
      process.exit(1);
    }

    let loaded;
    try {
      loaded = await loadBridge(target);
    } catch (err: any) {
      printBridgeError(err);
      process.exit(1);
    }
    if (loaded.kind === "yaml" && !loaded.descriptor.export) {
      console.error(`Bridge "${name}" has no export block — cannot export through it.`);
      process.exit(1);
    }
    if (loaded.kind === "code" && !loaded.plugin.export) {
      console.error(`Bridge "${name}" is a code plugin without an export() function — can only import through it.`);
      process.exit(1);
    }

    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const ctx = makeContext({ bridge: name });

    // Memory fetcher — paginates GET /Memory?agentId=... applying any
    // descriptor + caller-side filters in memory. Slice 3a does the
    // simplest thing: one round trip, no streaming. Slice 3b can move
    // to cursor-paginated streaming if real corpora warrant it.
    const fetchMemories = async function*(filters: import("./bridges/runtime/export-runner.js").ExportFilters) {
      const params = new URLSearchParams({ agentId });
      if (opts.subject) params.set("subject", opts.subject);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath: string | null = opts.key ?? resolveKeyPath(agentId);
      const path = `/Memory?${params.toString()}`;
      if (keyPath) headers["authorization"] = buildEd25519Auth(agentId, "GET", path, keyPath);
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET /Memory → ${res.status}: ${text || res.statusText}`);
      }
      const raw = await res.json();
      const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
      const sourceFilter = opts.source as string | undefined;
      const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
      for (const m of all) {
        if (sourceFilter && m.source !== sourceFilter) continue;
        if (sinceMs !== null && m.createdAt && new Date(m.createdAt).getTime() < sinceMs) continue;
        yield m as import("./bridges/types.js").BridgeMemory;
      }
      void filters;
    };

    let lastReportedAt = Date.now();
    const onProgress = (ev: import("./bridges/runtime/export-runner.js").ProgressEvent): void => {
      if (ev.type === "done") {
        if (opts.dryRun) {
          console.log(`\n${target.name}: would export ${ev.exported} memor${ev.exported === 1 ? "y" : "ies"} from ${ev.total} total. Re-run without --dry-run to write.`);
        } else {
          console.log(`\n${target.name}: exported ${ev.exported} memor${ev.exported === 1 ? "y" : "ies"} from ${ev.total} total.`);
        }
        return;
      }
      if (ev.type === "target-write") {
        console.log(`  ✓ ${ev.path} (${ev.written} record${ev.written === 1 ? "" : "s"})`);
        return;
      }
      if (ev.type === "target-skipped") {
        console.log(`  · ${ev.path} skipped (${ev.reason})`);
        return;
      }
      // memory-skipped events throttled to one line every 2s
      const now = Date.now();
      if (now - lastReportedAt < 2000) return;
      lastReportedAt = now;
      process.stdout.write(`\r  filtering memory ${ev.ordinal}...`.padEnd(60));
    };

    try {
      if (loaded.kind === "yaml") {
        await runExport({
          descriptor: loaded.descriptor,
          cwd,
          fetchMemories,
          filters: { agentId, subject: opts.subject, source: opts.source, since: opts.since },
          dryRun: !!opts.dryRun,
          ctx,
          onProgress,
        });
      } else {
        // Code plugin export: invoke plugin.export(memoryStream, opts, ctx) directly.
        // Plugin writes to its target however it likes (HTTP, file, etc.).
        if (opts.dryRun) {
          console.log(`${target.name}: dry-run not supported for code-plugin exports; aborting before invoking plugin.export().`);
          process.exit(2);
        }
        const pluginOpts: Record<string, unknown> = { ...opts };
        await loaded.plugin.export!(fetchMemories({ agentId, subject: opts.subject, source: opts.source, since: opts.since }), pluginOpts, ctx);
        console.log(`${target.name}: code-plugin export completed. Record count not reported by the plugin.`);
      }
    } catch (err: any) {
      if (err instanceof BridgeRuntimeError) {
        printBridgeError(err);
        process.exit(1);
      }
      console.error(`Bridge export failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

bridge
  .command("test <name>")
  .description("Round-trip a bridge through its fixture: import → export → re-import → diff. Pass iff the stable fields (content/subject/tags/durability) match.")
  .option("--fixture <path>", "Override the import source path (defaults to descriptor's import.sources[0].path)")
  .option("--cwd <dir>", "Filesystem root the descriptor's relative paths resolve against (default: cwd)")
  .option("--json", "Emit the full RoundTripResult as JSON on stdout")
  .action(async (name: string, opts) => {
    const cwd: string = opts.cwd ?? process.cwd();

    const { discover } = await import("./bridges/discover.js");
    const { builtinDiscoveryRecords } = await import("./bridges/builtins/index.js");
    const { loadBridge } = await import("./bridges/runtime/load-bridge.js");
    const { runRoundTrip } = await import("./bridges/runtime/roundtrip.js");
    const { BridgeRuntimeError } = await import("./bridges/types.js");

    const found = await discover({ builtins: builtinDiscoveryRecords() });
    const target = found.find((b) => b.name === name);
    if (!target) {
      console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
      process.exit(1);
    }

    let loaded;
    try {
      loaded = await loadBridge(target);
    } catch (err: any) {
      printBridgeError(err);
      process.exit(1);
    }

    if (loaded.kind === "code") {
      console.error(`Bridge "${name}" is a code plugin — round-trip testing for code plugins lands in slice 3d (requires mocked fetch transport).`);
      console.error(`For now, code plugins should ship their own tests alongside the npm package.`);
      process.exit(2);
    }

    try {
      const result = await runRoundTrip({ descriptor: loaded.descriptor, cwd, fixturePath: opts.fixture });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.passed ? 0 : 1);
      }
      if (result.passed) {
        console.log(`✅ ${target.name} round-trip passed (${result.expectedCount} record${result.expectedCount === 1 ? "" : "s"}).`);
        process.exit(0);
      }
      console.log(`❌ ${target.name} round-trip failed.`);
      console.log(`   expected ${result.expectedCount} records, got ${result.actualCount} back.`);
      if (result.missingInPass2.length > 0) {
        console.log(`   missing from re-import (${result.missingInPass2.length}):`);
        for (const m of result.missingInPass2.slice(0, 5)) console.log(`     - ${m.key}`);
        if (result.missingInPass2.length > 5) console.log(`     ... ${result.missingInPass2.length - 5} more`);
      }
      if (result.unexpectedInPass2.length > 0) {
        console.log(`   unexpected extras in re-import (${result.unexpectedInPass2.length}):`);
        for (const m of result.unexpectedInPass2.slice(0, 5)) console.log(`     - ${m.key}`);
        if (result.unexpectedInPass2.length > 5) console.log(`     ... ${result.unexpectedInPass2.length - 5} more`);
      }
      if (result.mismatches.length > 0) {
        console.log(`   field mismatches (${result.mismatches.length}):`);
        for (const m of result.mismatches.slice(0, 10)) {
          console.log(`     - record ${m.ordinal} (${m.key}) field ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
        }
        if (result.mismatches.length > 10) console.log(`     ... ${result.mismatches.length - 10} more`);
      }
      console.log(`\n   Intermediate export at: ${result.tmpExportPath}`);
      process.exit(1);
    } catch (err: any) {
      if (err instanceof BridgeRuntimeError) {
        printBridgeError(err);
        process.exit(1);
      }
      console.error(`Bridge test failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

bridge
  .command("allow <name>")
  .description("Approve an npm code-plugin bridge for execution. Approval is pinned to the package's location and package.json contents — a malicious package squatting on the same name in a different node_modules tree will be refused at load-time.")
  .action(async (name: string) => {
    const { discover } = await import("./bridges/discover.js");
    const { builtinDiscoveryRecords } = await import("./bridges/builtins/index.js");
    const { allow } = await import("./bridges/runtime/allow-list.js");

    const found = await discover({ builtins: builtinDiscoveryRecords() });
    const target = found.find((b) => b.name === name);
    if (!target) {
      console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
      process.exit(1);
    }
    if (target.source !== "npm-package") {
      console.error(`"${name}" is a ${target.source} bridge; only npm code plugins require allow-list approval.`);
      console.error(`YAML and built-in bridges run via the descriptor runtime and don't execute arbitrary JS.`);
      process.exit(1);
    }

    try {
      const result = await allow(name, target.path);
      if (result.alreadyAllowed) {
        console.log(`${name} was already allowed at ${result.entry.packageDir} — no change.`);
        return;
      }
      const verb = result.updated ? "re-approved" : "allowed";
      console.log(`✓ ${name} ${verb}.`);
      console.log(`  location: ${result.entry.packageDir}`);
      console.log(`  version:  ${result.entry.version ?? "(not declared)"}`);
      console.log(`  digest:   ${result.entry.packageJsonSha256.slice(0, 16)}…`);
      console.log(`  If the package later moves or its package.json content changes, execution is refused until you re-run this command.`);
      console.log(`  Revoke anytime with: flair bridge revoke ${name}`);
    } catch (err: any) {
      console.error(`Failed to approve "${name}": ${err?.message ?? err}`);
      process.exit(1);
    }
  });

bridge
  .command("revoke <name>")
  .description("Revoke approval for an npm code-plugin bridge (future invocations will require `flair bridge allow <name>` again)")
  .action(async (name: string) => {
    const { revoke } = await import("./bridges/runtime/allow-list.js");
    const result = await revoke(name);
    if (!result.wasAllowed) {
      console.log(`${name} was not on the allow-list — no change.`);
      return;
    }
    console.log(`✓ ${name} revoked. Future invocations require \`flair bridge allow ${name}\` again.`);
  });

bridge
  .command("allow-list")
  .description("Show the allow-listed code-plugin bridges")
  .option("--json", "Emit raw JSON")
  .action(async (opts) => {
    const { list: listAllowed } = await import("./bridges/runtime/allow-list.js");
    const entries = await listAllowed();
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (entries.length === 0) {
      console.log("No code-plugin bridges are allow-listed yet.");
      console.log("Allow one with: flair bridge allow <name>");
      return;
    }
    const nameW = Math.max(4, ...entries.map((e) => e.name.length));
    const verW = Math.max(7, ...entries.map((e) => (e.version ?? "—").length));
    console.log(`  ${"name".padEnd(nameW)}  ${"version".padEnd(verW)}  allowed-at               location / digest`);
    for (const e of entries) {
      console.log(`  ${e.name.padEnd(nameW)}  ${(e.version ?? "—").padEnd(verW)}  ${e.allowedAt}  ${e.packageDir}`);
      console.log(`  ${" ".repeat(nameW)}  ${" ".repeat(verW)}  ${" ".repeat(24)}  sha256:${e.packageJsonSha256.slice(0, 16)}…`);
    }
  });

function printBridgeError(err: unknown): void {
  // Pretty-print BridgeRuntimeError as the structured shape from §10 of the
  // spec, plus a one-line human summary so the operator gets both.
  const detail = (err as { detail?: Record<string, unknown> })?.detail;
  if (detail && typeof detail === "object") {
    // Trust-check failures get a dedicated, operator-facing rendering.
    // Dumping the full spec-§10 JSON is useful when an operator is
    // debugging a broken YAML descriptor; for trust errors it buries the
    // one thing that matters — the command to re-approve.
    if ((detail as any).field === "(trust)") {
      printTrustError(detail as any);
      return;
    }
    console.error(`Bridge error: ${(detail as any).hint ?? (err as Error).message}`);
    console.error(JSON.stringify(detail, null, 2));
  } else {
    console.error(`Bridge error: ${(err as Error).message ?? String(err)}`);
  }
}

function printTrustError(detail: { bridge?: string; got?: string; context?: Record<string, string> }): void {
  const name = detail.bridge ?? "(unknown)";
  const ctx = detail.context ?? {};
  const reapprove = `  flair bridge allow ${name}`;
  const bar = "─".repeat(60);

  const header = (title: string) => {
    console.error("");
    console.error(`⚠ ${title} — ${name}`);
    console.error(bar);
  };

  const footer = (label: string) => {
    console.error("");
    console.error(`${label}:`);
    console.error(reapprove);
    console.error("");
  };

  switch (detail.got) {
    case "not-allowed":
      header("Approval required");
      console.error("This bridge is an npm code plugin — it runs arbitrary JavaScript.");
      console.error("First-use approval is required before Flair will execute it.");
      footer("Approve it with");
      return;

    case "path-mismatch":
      header("Trust check failed: package location changed");
      console.error("A different package with the same name was discovered. This is how");
      console.error("local squatting attacks present — a planted `node_modules/flair-bridge-*`");
      console.error("in an unrelated project tree.");
      console.error("");
      console.error(`  approved: ${ctx.approvedPath ?? "(unknown)"}`);
      console.error(`            version ${ctx.approvedVersion ?? "?"} at ${ctx.approvedAt ?? "?"}`);
      console.error(`  now:      ${ctx.observedPath ?? "(unknown)"}`);
      footer("If the new location is intentional, re-approve");
      return;

    case "digest-mismatch":
      header("Trust check failed: package contents changed");
      console.error("The package.json at the approved location has changed since you");
      console.error("approved this bridge. This fires on every upgrade — it's a trust");
      console.error("event, not an error. If the update is intentional, re-approve.");
      console.error("");
      console.error(`  location:          ${ctx.packagePath ?? "(unknown)"}`);
      console.error(`  approved version:  ${ctx.approvedVersion ?? "?"}   (at ${ctx.approvedAt ?? "?"})`);
      console.error(`  approved digest:   sha256:${(ctx.approvedDigest ?? "").slice(0, 16)}…`);
      console.error(`  observed digest:   sha256:${(ctx.observedDigest ?? "").slice(0, 16)}…`);
      footer("Re-approve");
      return;

    case "entry-incomplete":
      header("Trust check failed: approval record is incomplete");
      console.error("The allow-list entry for this bridge is missing a location or digest.");
      console.error("This usually means the record was created by a pre-fix Flair version");
      console.error("(0.6.0 / 0.6.1) that only stored the name. Re-approve to upgrade.");
      footer("Re-approve");
      return;

    case "package-missing":
      header("Trust check failed: approved package missing on disk");
      console.error("The package location recorded at allow-time is no longer readable.");
      console.error("");
      console.error(`  approved at:  ${ctx.approvedPath ?? "(unknown)"}`);
      console.error(`  discovered:   ${ctx.discoveredPath ?? "(unknown)"}`);
      footer("Reinstall the package, then re-approve");
      return;

    default:
      // Unknown trust sub-reason — fall back to the raw structured print.
      console.error(`Bridge error (trust): ${(detail as any).hint ?? detail.got ?? "unknown"}`);
      console.error(JSON.stringify(detail, null, 2));
  }
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
  resolveTarget,
  resolveOpsTarget,
  resolveEffectiveOpsUrl,
  resolveOpsUrlFromTarget,
  signRequestBody,
  b64,
  b64url,
  program,
  api,
  isLocalBase,
  isLikelyRealSecret,
  shouldShowInlineSecretWarning,
};
