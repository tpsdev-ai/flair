#!/usr/bin/env node
import { Command } from "commander";
import nacl from "tweetnacl";
import { load as parseYaml } from "js-yaml";
import * as render from "./render.js";
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
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, createPrivateKey, sign as nodeCryptoSign, randomUUID, randomBytes } from "node:crypto";
import { create as tarCreate, extract as tarExtract, list as tarList } from "tar";
import { keystore } from "./keystore.js";
import { deploy as deployToFabric, validateOptions as validateDeployOptions, buildTargetUrl as buildDeployUrl } from "./deploy.js";
import { fabricUpgrade } from "./fabric-upgrade.js";
import { checkVersion, formatVersionNudge } from "./version-check.js";
import { checkServerHandshake, formatHandshakeNudge } from "./version-handshake.js";
import { probeInstance, type ProbeResult } from "./probe.js";
import {
  sweepFleet,
  renderFleetSweepTable,
  FLEET_EXIT_OK,
  type FleetSweepResult,
} from "./fleet-verify.js";
import { markStale, sortOldestVersionFirst, type FleetPresenceRow } from "./fleet-presence.js";
import { detectClients, wireClaudeCode, wireCodex, wireGemini, wireCursor, type ClientId } from "./install/clients.js";
import {
  readClientMcpBlock,
  checkClaudeMdBootstrap,
  checkSessionStartHook,
  fixClaudeMdBootstrap,
  fixSessionStartHook,
  applyOrReportClaudeMdBootstrap,
  applyOrReportSessionStartHook,
} from "./doctor-client.js";

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

// Per-record principalId (federation-edge-hardening slice 3a) — INFORMATIONAL
// only; the receiver (resources/Federation.ts) never treats it as verified
// identity or uses it in any auth decision. Sourced from the write-time
// provenance stamp (memory-provenance slice 1, Memory.ts's buildProvenance)
// when present. `provenance` is persisted as a JSON STRING (not an object),
// so it must be parsed — a raw `row.provenance?.verified?.agentId` would
// silently always be undefined. Soul/Agent/Relationship rows never carry a
// provenance stamp today, so this is a no-op for them.
function principalIdFromRow(row: any): string | undefined {
  if (typeof row?.provenance !== "string" || row.provenance.length === 0) return undefined;
  try {
    return JSON.parse(row.provenance)?.verified?.agentId ?? undefined;
  } catch {
    return undefined;
  }
}

// Federation push private-visibility filter — inlined for the SAME reason as
// the crypto helpers above (see comment there; also resources/memory-
// visibility.ts, the canonical definition; the two must stay in sync).
//
// federation-edge-hardening slice 2 (the office-visibility read leak: one rule, one place): the
// push side of federation sync (runFederationSyncOnce below) must exclude
// `private` Memory rows from what gets sent to peers, using the EXACT same
// "not private" semantics as resources/memory-read-scope.ts's resolveReadScope()
// — a record with NO visibility field (legacy, pre-dates the field) is NOT
// private and must keep syncing exactly as before. Only `visibility ===
// "private"` is excluded; null/undefined/"shared"/anything else is included.
const FEDERATION_PRIVATE_VISIBILITY = "private";
function isFederationPrivateVisibility(visibility: string | null | undefined): boolean {
  return visibility === FEDERATION_PRIVATE_VISIBILITY;
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

/**
 * Read a secret (admin password, Fabric password, ...) from a file, refusing
 * if the file is world/group readable.
 *
 * Secret files (default ~/.flair/admin-pass; also used for --fabric-password-file)
 * are short-lived values generated by `openssl rand` — mode 0600 keeps them
 * out of reach of other local users + most backup tooling. A 0644 file
 * silently leaks the secret to anyone with read access to the user's home
 * (multi-user hosts, NFS, time-machine snapshots, etc.).
 *
 * Throws with an actionable error if the file isn't owner-only, otherwise
 * returns the trimmed file content (values generated by `openssl rand
 * -base64` conventionally end in a newline). `flagName` is only used to
 * personalize the error text (e.g. "--admin-pass-file" vs
 * "--fabric-password-file") — the check itself is identical either way.
 */
function readSecretFileSecure(path: string, flagName: string): string {
  if (!existsSync(path)) {
    throw new Error(`${flagName} path does not exist: ${path}`);
  }
  const st = statSync(path);
  if (st.mode & 0o077) {
    const modeOctal = (st.mode & 0o777).toString(8).padStart(3, "0");
    throw new Error(
      `Refusing to read ${flagName} at ${path}: permissions ${modeOctal} are too open. ` +
        `Run \`chmod 600 ${path}\` to restrict to owner-only.`
    );
  }
  const content = readFileSync(path, "utf-8").replace(/\s+$/, "");
  if (!content) {
    throw new Error(`${flagName}: file is empty or contains only whitespace: ${path}`);
  }
  return content;
}

/** `readSecretFileSecure` specialized for --admin-pass-file (see that function for the shared check). */
export function readAdminPassFileSecure(path: string): string {
  return readSecretFileSecure(path, "--admin-pass-file");
}

function defaultAdminPassPath(): string {
  return join(homedir(), ".flair", "admin-pass");
}

/**
 * Resolve an admin password for LOCAL-only CLI convenience (`agent add`,
 * `principal add`) without requiring `--admin-pass` on every call (#590).
 * Also reused by `api()`'s local-target auth fallback (flair#634) — called
 * there as `resolveLocalAdminPass(undefined, !isLocal)`, so only its file leg
 * ever fires (the env leg is already handled by `api()` itself first).
 *
 * Resolution order: explicit value (the `--admin-pass` flag) → `FLAIR_ADMIN_PASS`
 * env → the secure `~/.flair/admin-pass` file `flair init` already writes with
 * mode 0600 (read via `readAdminPassFileSecure`, which enforces that mode).
 *
 * When `isRemoteTarget` is true, ONLY the explicit value is honored — the env
 * and file legs are skipped entirely. This is the security-critical guard: a
 * `--target`/`--ops-target` deploy must never silently reuse THIS machine's
 * local admin secret against someone else's Harper instance. Remote callers
 * keep requiring an explicit `--admin-pass`.
 *
 * Throws (via readAdminPassFileSecure) if the file exists but has unsafe
 * permissions, so a misconfigured file surfaces as an actionable chmod error
 * instead of a generic "admin pass required" message.
 */
function resolveLocalAdminPass(
  explicit: string | undefined,
  isRemoteTarget = false,
  adminPassPath: string = defaultAdminPassPath(),
): string | undefined {
  if (explicit) return explicit;
  if (isRemoteTarget) return undefined;
  if (process.env.FLAIR_ADMIN_PASS) return process.env.FLAIR_ADMIN_PASS;
  if (!existsSync(adminPassPath)) return undefined;
  return readAdminPassFileSecure(adminPassPath);
}

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

// Unified base URL resolution. Precedence:
//   --target > --url > FLAIR_TARGET env > FLAIR_URL env > http://127.0.0.1:<resolveHttpPort>
//
// Every user-facing command that talks to a Flair instance should call this
// instead of hand-rolling the precedence. Keeps remote-target switching
// (e.g. CI hitting Fabric) consistent across `flair status`, `flair search`,
// `flair bootstrap`, etc.
function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return (
    opts.target
    || opts.url
    || process.env.FLAIR_TARGET
    || process.env.FLAIR_URL
    || `http://127.0.0.1:${resolveHttpPort(opts)}`
  );
}

// Resolve agent id from --agent flag or FLAIR_AGENT_ID env.
// Returns null if neither is set; caller decides whether that's fatal.
function resolveAgentIdOrEnv(opts: { agent?: string }): string | null {
  return opts.agent || process.env.FLAIR_AGENT_ID || null;
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

  // Auth resolution order (flair#634 — local targets used to send NO auth at
  // all here and ride Harper's authorizeLocal forged super_user; #632 gated
  // FederationInstance/FederationPeers behind allowAdmin, so credential-less
  // local calls to those now 403 instead of silently passing):
  // 1. FLAIR_TOKEN env → Bearer token (backward compat)
  // 2. FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD env → Basic admin auth. Applies to
  //    BOTH local and remote targets — an explicit env var always wins, local
  //    included, so a caller that sets it never depends on authorizeLocal.
  // 3. FLAIR_AGENT_ID env + key file → Ed25519 signature (standard)
  // 4. LOCAL TARGETS ONLY: the secure ~/.flair/admin-pass file `flair init`
  //    writes (#593) → Basic admin auth, via the same resolveLocalAdminPass
  //    convenience `agent add`/`principal add` already use (#590). Guarded to
  //    isLocal so a --target/FLAIR_URL request aimed elsewhere never rides
  //    this machine's local admin secret.
  // 5. No auth (remote will 401/403; local now also gets a real 403 from
  //    #632-gated resources instead of the old forged-admin passthrough)
  //
  // NOTE: this function is for the Harper HTTP/REST API only. The Harper
  // operations API (used by seedAgentViaOpsApi / seedFederationInstanceViaOpsApi)
  // ALSO honors authorizeLocal: a header-less loopback request to the ops port
  // is auto-authorized as super_user (verified by live probe — flair#610). Those
  // helpers nonetheless send Basic admin auth UNCONDITIONALLY, so they never
  // depend on that ambient elevation and behave identically against a remote or
  // hardened instance. Hardening the ops-API loopback posture itself (bind scope
  // / disabling authorizeLocal there) is tracked separately in flair#654 and is
  // out of scope for this HTTP/REST auth path.
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
        } catch (err: unknown) {
          // Key exists but auth build failed — warn and continue without auth
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Warning: Ed25519 auth failed for agent '${agentId}': ${message}`);
        }
      }
    }

    // Local-only fallback (flair#634): no explicit env, no usable agent key.
    // FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD are already ruled out by this point
    // (handled above), so resolveLocalAdminPass's env leg is a no-op here and
    // this only ever resolves the ~/.flair/admin-pass file — isRemoteTarget
    // is `!isLocal` so it's skipped entirely for --target/FLAIR_URL requests.
    if (!authHeader) {
      try {
        const filePass = resolveLocalAdminPass(undefined, !isLocal);
        if (filePass) {
          authHeader = `Basic ${Buffer.from(`admin:${filePass}`).toString("base64")}`;
        }
      } catch (err: unknown) {
        // File exists but has unsafe permissions — warn (never the secret
        // itself) and fall through to no-auth.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Warning: ~/.flair/admin-pass unusable: ${message}`);
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
  if (!res.ok) {
    // 403 with no credentials sent at all is the flair#634 case: a gated
    // resource (e.g. #632's FederationInstance/FederationPeers) rejected a
    // credential-less call. Name the fix instead of surfacing the raw
    // "forbidden" body — never a stack trace.
    if (res.status === 403 && !authHeader) {
      const hint = isLocal
        ? "Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass."
        : "Set FLAIR_ADMIN_PASS (remote targets have no local admin-pass fallback).";
      throw new Error(`HTTP 403: no credentials sent. ${hint}`);
    }
    throw new Error(text || `HTTP ${res.status}`);
  }
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

/**
 * Result of a real embed→search round-trip:
 *   - ok:       semantic recall verified (paraphrase, no keyword overlap, matched by meaning)
 *   - degraded: embeddings are NOT loaded — recall-by-meaning is dead (LOUD failure)
 *   - skipped:  could not run the check (no agent / no key / write failed for unrelated reasons)
 */
export type SemanticVerifyResult =
  | { state: "ok"; score: number }
  | { state: "degraded"; detail: string }
  | { state: "skipped"; detail: string };

/**
 * Verify that semantic search ACTUALLY works by storing a memory with a
 * distinctive phrase and searching for a PARAPHRASE (different words, same
 * meaning). If embeddings are loaded, the paraphrase recovers the memory by
 * meaning with a genuine semantic score. If embeddings are NOT loaded,
 * SemanticSearch falls back to keyword-only scan: the paraphrase shares no
 * keywords with the stored content, so the memory is NOT recovered (or only via
 * the `_warning` keyword-fallback marker) → "degraded".
 *
 * The probe is authenticated as a real agent (Ed25519) because SemanticSearch
 * rejects anonymous callers (401) and per-agent scoping requires it. We pick the
 * given agentId, else FLAIR_AGENT_ID, else the first `.key` in keysDir.
 *
 * Exported so the init smoke test and unit tests can reuse the exact same gate.
 */
export async function verifySemanticSearch(
  baseUrl: string,
  agentIdOpt: string | undefined,
  keysDir: string,
): Promise<SemanticVerifyResult> {
  // Resolve an agent + key to sign with.
  let agentId = agentIdOpt || process.env.FLAIR_AGENT_ID || undefined;
  if (!agentId) {
    try {
      const keyFiles = readdirSync(keysDir).filter((f) => f.endsWith(".key"));
      if (keyFiles.length > 0) agentId = keyFiles[0].replace(/\.key$/, "");
    } catch { /* keysDir missing */ }
  }
  if (!agentId) {
    return { state: "skipped", detail: "no agent id or key found" };
  }
  // Find the signing key. Prefer the standard locations (resolveKeyPath), but
  // fall back to the keysDir we were handed — `flair init` keys live there and
  // it may not be a standard location (e.g. --keys-dir, tests).
  let keyPath = resolveKeyPath(agentId);
  if (!keyPath) {
    const candidate = join(keysDir, `${agentId}.key`);
    if (existsSync(candidate)) keyPath = candidate;
  }
  if (!keyPath) {
    return { state: "skipped", detail: `no private key for agent '${agentId}'` };
  }

  // Distinctive content vs. a PARAPHRASE query with deliberately ZERO shared
  // content words. If the search recovers the memory it can ONLY be by meaning.
  //   content: "The feline predator silently stalked its unsuspecting rodent quarry at dusk."
  //   query:   "a cat hunting a mouse in the evening"
  // No word in the query appears in the content (cat≠feline, mouse≠rodent,
  // hunting≠stalked, evening≠dusk), so a keyword scan returns nothing.
  const marker = `flair-doctor-embed-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = marker;
  const content = `The feline predator silently stalked its unsuspecting rodent quarry at dusk. [${marker}]`;
  const paraphrase = "a cat hunting a mouse in the evening";

  let stored = false;
  try {
    // Write the test memory (ephemeral so it's never durable). PUT /Memory/<id>.
    const writeRes = await authFetch(baseUrl, agentId, keyPath, "PUT", `/Memory/${id}`, {
      id, agentId, content, durability: "ephemeral", createdAt: new Date().toISOString(),
    });
    if (!writeRes.ok && writeRes.status !== 204) {
      const text = await writeRes.text().catch(() => "");
      return { state: "skipped", detail: `could not write probe memory: HTTP ${writeRes.status} ${text.slice(0, 80)}` };
    }
    stored = true;

    // Allow the HNSW index to catch up before searching.
    await new Promise((r) => setTimeout(r, 1500));

    // Search by PARAPHRASE. scoring: "raw" so we read the unweighted semantic
    // similarity (_rawScore) directly, without recency/durability composites
    // muddying the keyword-vs-semantic distinction.
    const searchRes = await authFetch(baseUrl, agentId, keyPath, "POST", "/SemanticSearch", {
      agentId, q: paraphrase, limit: 10, scoring: "raw",
    });
    if (!searchRes.ok) {
      const text = await searchRes.text().catch(() => "");
      return { state: "skipped", detail: `SemanticSearch failed: HTTP ${searchRes.status} ${text.slice(0, 80)}` };
    }
    const data = await searchRes.json() as { results?: any[]; _warning?: string };

    // The server sets _warning ONLY when getMode() === "none" — i.e. the
    // embedding engine failed to init and the search ran keyword-only. That is
    // the unambiguous "embeddings not loaded" signal.
    if (data._warning) {
      return { state: "degraded", detail: data._warning };
    }

    const results = data.results ?? [];
    const hit = results.find((r) => r.id === id);
    if (!hit) {
      // The paraphrase shares no keywords with the content, so a keyword-only
      // fallback can't find it. Missing the memory == recall-by-meaning is dead.
      return { state: "degraded", detail: "paraphrase did not recall the probe memory (keyword-only fallback active)" };
    }

    // A genuine semantic hit has a positive similarity score. The keyword bonus
    // is +0.05; since there is no keyword overlap here, any score above that
    // floor can only come from vector similarity. Require a real semantic score.
    const score = typeof hit._rawScore === "number" ? hit._rawScore : (hit._score ?? 0);
    if (score <= 0.05) {
      return { state: "degraded", detail: `probe recalled with non-semantic score ${score} (keyword/zero)` };
    }
    return { state: "ok", score };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "skipped", detail: `probe error: ${message.slice(0, 100)}` };
  } finally {
    // Best-effort cleanup of the ephemeral probe memory.
    if (stored) {
      try {
        await authFetch(baseUrl, agentId, keyPath, "DELETE", `/Memory/${id}`);
      } catch { /* leave the ephemeral row; it'll age out */ }
    }
  }
}

// ─── Doctor: client-integration network checks (flair#588) ────────────────────
//
// The pure filesystem checks (MCP block parsing, CLAUDE.md, SessionStart hook)
// live in src/doctor-client.ts. These two are network-dependent and live here
// because they reuse authFetch/resolveKeyPath, which are private to this file.

/**
 * Quick, offline-tolerant reachability probe for a Flair instance's HTTP
 * endpoint — GETs /Health with a short timeout. Never hangs, never throws:
 * any failure (timeout, DNS, connection refused, bad URL) is "unreachable".
 * Mirrors the doctor action's own probePort helper (3000ms AbortSignal.timeout
 * style), but takes a full URL since client configs point at arbitrary hosts.
 */
export async function probeFlairReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/Health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Is `agentId` actually registered on the Flair instance at `baseUrl`? Signs
 * GET /Agent/:id with the agent's own key (same pattern as the `flair init`
 * verification at line ~2043 and `flair agent rotate` at line ~2596) —
 * reuses authFetch/resolveKeyPath rather than duplicating the signing logic.
 *
 *   200            -> "registered"
 *   401/403 carrying the server's "unknown_agent" signal -> "not-registered"
 *     (see below — this is the actual live behavior for a missing agent, NOT
 *     404)
 *   any other status, or a network error/timeout -> "unreachable" (could not
 *     verify one way or the other — e.g. a bare 401/403/500 doesn't tell us
 *     whether the agent exists, so we don't claim NOT registered on those)
 *   no local key found for agentId (checked resolveKeyPath, then keysDir) -> "no-key"
 *     (can't sign the request at all — distinct from "unreachable" so the
 *     caller can print an accurate reason)
 *
 * Why not 404: an unregistered agent never actually reaches the /Agent/:id
 * resource handler (which is where a 404 would come from) — Flair's own
 * signed-auth middleware (resources/auth-middleware.ts) rejects the request
 * first, once it can't find an Agent record matching the signing identity.
 * On current main that's an explicit `401 {"error":"unknown_agent"}` — Live-
 * verified 2026-07-07 against a local Flair instance with a resolvable-but-
 * unregistered signing key: `401 Unauthorized`, body `{"error":"unknown_agent"}`.
 * Some server versions/paths may instead surface Harper's native
 * AccessViolation as a 403 for the same condition, so both codes are checked
 * — but ONLY when the response also carries the unknown-agent marker; a bare
 * 401/403 without it (e.g. a real AccessViolation for an agent that exists
 * but fails a resource-level authorization check) stays "unreachable", since
 * the server can't always distinguish "agent doesn't exist" from "signing key
 * doesn't match a known agent" and we don't want to falsely claim
 * not-registered on that ambiguity. We only make the not-registered call
 * because we ALREADY have a local signing key that resolved for this
 * agentId (checked above) — so this isn't a client-side key problem, and the
 * server naming the agent unknown is a reliable, actionable signal.
 */
export async function checkAgentRegistered(
  baseUrl: string,
  agentId: string,
  keysDir: string,
): Promise<{ state: "registered" | "not-registered" | "unreachable" | "no-key"; detail?: string }> {
  let keyPath = resolveKeyPath(agentId);
  if (!keyPath) {
    const candidate = join(keysDir, `${agentId}.key`);
    if (existsSync(candidate)) keyPath = candidate;
  }
  if (!keyPath) {
    return { state: "no-key", detail: `no local key for agent '${agentId}' to sign the check` };
  }
  try {
    const res = await authFetch(baseUrl, agentId, keyPath, "GET", `/Agent/${agentId}`);
    if (res.ok) return { state: "registered" };
    if (res.status === 404) return { state: "not-registered" };
    const text = await res.text().catch(() => "");
    if ((res.status === 401 || res.status === 403) && /unknown_agent/i.test(text)) {
      return { state: "not-registered", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    return { state: "unreachable", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unreachable", detail: `instance unreachable: ${message.slice(0, 100)}` };
  }
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
 * `adminPass` is optional: a local caller may omit it and ride Harper's
 * `authorizeLocal`, which auto-authorizes a header-less loopback request to
 * the ops port as super_user (current behavior, verified by live probe —
 * flair#610). When passed, the helper sends Basic admin auth so it never
 * depends on that ambient elevation and behaves identically against a remote
 * or hardened instance. Hardening the ops-API loopback posture is tracked in
 * flair#654.
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
  // The ops-API insert bypasses the Agent resource layer, so Agent.post()'s
  // 1.0 Principal defaults (kind/status/displayName/admin/defaultTrustTier/type)
  // never run. Without them a remote-seeded agent lands kind=null, status=null
  // and is invisible to roster/presence/Office-Space queries that filter on
  // status='active' or kind='agent' (#521). Mirror Agent.post() exactly here.
  const now = new Date().toISOString();
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{
      id: agentId,
      name: agentId,
      type: "agent",
      kind: "agent",
      status: "active",
      displayName: agentId,
      admin: false,
      defaultTrustTier: "unverified",
      publicKey: pubKeyB64url,
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
    throw new Error(`Operations API insert failed (${res.status}): ${text}`);
  }
}

// NOTE: agent records are seeded exclusively via the Harper operations API
// (seedAgentViaOpsApi above). A former seedAgentViaRestApi() helper POSTed the
// ops-insert body to the REST root, which Harper 405s as a collection POST to
// /Agent (the Agent table resource has no POST handler). It was removed in the
// #499 fix; do not reintroduce a REST-root insert path.

// ─── FederationInstance seed via ops API ──────────────────────────────────────
//
// Remote init writes FederationInstance through the ops API (Basic auth with
// admin:admin-pass), not the REST API (which needs server-side HDB_ADMIN_PASSWORD
// — unavailable on Fabric).  Same pattern as seedAgentViaOpsApi above.
//
// `adminPass` is optional (symmetry with seedAgentViaOpsApi): a local caller may
// omit it and ride authorizeLocal, which the Harper ops API honors today — a
// header-less loopback request is auto-authorized as super_user (flair#610).
// When passed, the helper sends Basic admin auth so it never depends on that
// ambient elevation and behaves identically against a remote or hardened
// instance. Hardening that posture is tracked in flair#654.

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

// ─── Provision Flair on Harper Fabric ──────────────────────────────────────
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
  // Since custom-admin-username support is merged, the username doesn't have to be "admin".
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

// ─── flair_pair_initiator role ──────────────────────────────────────────────
//
// Hub instances need a `flair_pair_initiator` role so that bootstrap credentials
// (created in PR-2) can pass platform auth on Harper Fabric before reaching the
// FederationPair resource handler.  The role carries no table permissions itself
// — the resource's own allowCreate bypass handles route-level access once the
// request gets through the auth gate.

/**
 * Canonical permission spec for flair_pair_initiator.
 *
 * The role intentionally carries NO table permissions — its only job is to exist
 * so bootstrap credentials can pass Harper platform auth before reaching the
 * FederationPair resource handler (the resource's own allowCreate bypass handles
 * route-level access). A bare role with both flags false is valid, grants nothing,
 * and is exactly that intent.
 *
 * This previously carried an all-false `flair.tables` block, but Harper's add_role
 * REJECTED the whole spec with a 400 (verified live against a spawned Harper):
 *   - `cluster_user` is not a recognized top-level key — Harper reads unknown keys
 *     as database names ("database 'cluster_user' does not exist");
 *   - the table names were the logical shorthand, not the real @table names
 *     ("Table 'flair.Workspace' does not exist" — it's WorkspaceState; "Event" is
 *     OrgEvent; "OAuth" is OAuthClient);
 *   - each grant omitted the required `attribute_permissions` array.
 * The all-false block granted nothing anyway, so dropping it loses no capability
 * and unbreaks fresh hub provisioning (where add_role runs and the 400 aborted
 * `flair init --remote`). Only top-level booleans Harper recognizes remain.
 */
const PAIR_INITIATOR_PERMISSION = {
  super_user: false,
  structure_user: false,
} as const;

/**
 * Idempotently ensures the `flair_pair_initiator` role exists on the Harper
 * instance at `opsUrl` with the canonical permission spec.
 *
 * - If the role is absent → `add_role`
 * - If it exists with different permissions → `alter_role` to bring it into spec
 * - If it already matches → no-op
 */
export async function ensureFlairPairInitiatorRole(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const ROLE_NAME = "flair_pair_initiator";

  // 1. Check for existing role
  let roles: any[] = [];
  try {
    const result = await callOpsApi(opsUrl, { operation: "list_roles" }, adminUser, adminPass);
    roles = Array.isArray(result) ? result : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ensureFlairPairInitiatorRole: list_roles failed: ${msg}`);
  }

  const existing = roles.find(
    (r: any) => r.role === ROLE_NAME || r.name === ROLE_NAME,
  );

  if (!existing) {
    // 2a. Role absent → create it
    console.log(`Creating role '${ROLE_NAME}'...`);
    await callOpsApi(opsUrl, {
      operation: "add_role",
      role: ROLE_NAME,
      permission: PAIR_INITIATOR_PERMISSION,
    }, adminUser, adminPass);
    console.log(`Role '${ROLE_NAME}' created ✓`);
    return;
  }

  // 2b. Role exists — check if permissions match the canonical spec
  const existingPerm = existing.permission ?? existing.role?.permission;
  const canonicalStr = JSON.stringify(PAIR_INITIATOR_PERMISSION);
  const existingStr  = JSON.stringify(existingPerm);

  if (existingStr === canonicalStr) {
    console.log(`Role '${ROLE_NAME}' already exists with correct permissions — skipping`);
    return;
  }

  // 2c. Permissions differ → bring into spec via alter_role
  console.log(`Role '${ROLE_NAME}' exists but permissions differ — updating...`);
  await callOpsApi(opsUrl, {
    operation: "alter_role",
    role: ROLE_NAME,
    permission: PAIR_INITIATOR_PERMISSION,
  }, adminUser, adminPass);
  console.log(`Role '${ROLE_NAME}' updated ✓`);
}

// ─── flair_agent role ────────────────────────────────────────────────────────
//
// The auth reshape replaces the global gate's "verified agent borrows admin
// super_user" elevation with a real, least-privilege Harper role. After an
// agent's Ed25519 signature verifies, resources resolve the request to the
// shared `flair_agent`-roled user instead of admin — so agents get exactly the
// table CRUD below and nothing more. Critically: with no `super_user` and no
// operations grants, /sql and /graphql become NATIVELY 403 for agents (the
// raw-query block the gate hand-rolled is now enforced by Harper itself).
//
// Row-level ownership (an agent touches only its OWN memories/soul/events) is
// NOT expressible in Harper's role model — it stays in each resource's allow*,
// keyed on the Ed25519-verified agentId. So these per-table grants are the
// coarse CRUD envelope; allow* is the ownership boundary inside it.
//
// VALIDATION GATES (must confirm against a live Harper before this role goes
// live — flagged for Sherlock + the PR, not assumed):
//   1. HNSW/vector search (SemanticSearch over Memory) works with table `read`
//      alone — the old elevation comment claimed admin perms were needed for
//      "HNSW-capable" access; confirm `read` suffices or widen precisely.
//   2. Role table keys must EXACTLY match the @table names (Memory, OrgEvent,
//      WorkspaceState, OAuthClient — NOT the logical Memory/Event/Workspace/OAuth
//      shorthand the flair_pair_initiator spec used, which was harmless only
//      because every grant there is false).

// Harper 5.0.21 add_role requires an `attribute_permissions` array on EVERY table
// grant (empty = no attribute-level restriction, so the table-level CRUD applies);
// omitting it makes add_role reject the whole spec ("Missing 'attribute_permissions'
// array"). Validated live against a spawned Harper. This helper guarantees the
// array is never forgotten. Also: `cluster_user` is NOT a valid top-level key —
// Harper reads unrecognized top-level keys as database names ("database
// 'cluster_user' does not exist"); only super_user / structure_user are recognized.
const grant = (read: boolean, insert: boolean, update: boolean, del: boolean) =>
  ({ read, insert, update, delete: del, attribute_permissions: [] });

/** Canonical permission spec for flair_agent (least-privilege; real @table names). */
const FLAIR_AGENT_PERMISSION = {
  super_user: false,
  structure_user: false,
  flair: {
    tables: {
      // Core agent-owned data — CRUD envelope; ownership enforced in allow*.
      Memory:          grant(true,  true,  true,  true),
      MemoryCandidate: grant(true,  true,  true,  true),
      MemoryGrant:     grant(true,  true,  true,  true),
      Soul:            grant(true,  true,  true,  false),
      OrgEvent:        grant(true,  true,  true,  true),
      WorkspaceState:  grant(true,  true,  true,  true),
      Relationship:    grant(true,  true,  true,  true),
      Integration:     grant(true,  true,  true,  true),
      Credential:      grant(true,  true,  true,  true),
      Presence:        grant(true,  true,  true,  false),
      // MemoryUsage (flair#683): the usage-feedback dedup ledger. Read (own
      // contributions, scoped in resources/MemoryUsage.ts) + insert (a fresh
      // contribution row) only — NO update/delete. This is load-bearing, not
      // just least-privilege tidiness: the dedup rule ("(agent, memory)
      // contributes ≤ 1") is enforced by requiring a NEW ledger row before
      // any usageCount bump; if an agent could delete its own row, it could
      // re-trigger the /RecordUsage endpoint for the same memory indefinitely
      // (create → count → delete → count again → repeat), defeating the cap
      // entirely. See resources/MemoryUsage.ts's module doc.
      MemoryUsage:     grant(true,  true,  false, false),
      // Agent: read for discovery, update own card; creation/removal is admin.
      Agent:           grant(true,  false, true,  false),
      // Read-only reference data.
      Instance:        grant(true,  false, false, false),
      // Federation / OAuth / IdP / internal — system + admin only; agents get none.
      Peer:          grant(false, false, false, false),
      PairingToken:  grant(false, false, false, false),
      SyncLog:       grant(false, false, false, false),
      OAuthClient:   grant(false, false, false, false),
      OAuthToken:    grant(false, false, false, false),
      OAuthAuthCode: grant(false, false, false, false),
      IdpConfig:     grant(false, false, false, false),
      IdJagReplay:   grant(false, false, false, false),
    },
  },
};

/**
 * Idempotently ensures the `flair_agent` role exists on the Harper instance at
 * `opsUrl` with the canonical least-privilege spec. Same list/add/alter shape as
 * ensureFlairPairInitiatorRole.
 *
 * - absent → `add_role`
 * - exists with different permissions → `alter_role`
 * - already matches → no-op
 */
export async function ensureFlairAgentRole(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const ROLE_NAME = "flair_agent";

  let roles: any[] = [];
  try {
    const result = await callOpsApi(opsUrl, { operation: "list_roles" }, adminUser, adminPass);
    roles = Array.isArray(result) ? result : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ensureFlairAgentRole: list_roles failed: ${msg}`);
  }

  const existing = roles.find(
    (r: any) => r.role === ROLE_NAME || r.name === ROLE_NAME,
  );

  if (!existing) {
    console.log(`Creating role '${ROLE_NAME}'...`);
    await callOpsApi(opsUrl, {
      operation: "add_role",
      role: ROLE_NAME,
      permission: FLAIR_AGENT_PERMISSION,
    }, adminUser, adminPass);
    console.log(`Role '${ROLE_NAME}' created ✓`);
    return;
  }

  const existingPerm = existing.permission ?? existing.role?.permission;
  const canonicalStr = JSON.stringify(FLAIR_AGENT_PERMISSION);
  const existingStr  = JSON.stringify(existingPerm);

  if (existingStr === canonicalStr) {
    console.log(`Role '${ROLE_NAME}' already exists with correct permissions — skipping`);
    return;
  }

  console.log(`Role '${ROLE_NAME}' exists but permissions differ — updating...`);
  await callOpsApi(opsUrl, {
    operation: "alter_role",
    role: ROLE_NAME,
    permission: FLAIR_AGENT_PERMISSION,
  }, adminUser, adminPass);
  console.log(`Role '${ROLE_NAME}' updated ✓`);
}

/**
 * Shared Harper user that verified Ed25519 agents are resolved to.
 * MUST match FLAIR_AGENT_USERNAME in resources/agent-auth.ts (the gate side).
 * Not imported from there because cli.ts is standalone and that module pulls in
 * Harper's native bindings — kept as a cross-referenced literal instead.
 */
export const FLAIR_AGENT_USERNAME = "flair-agent";

/**
 * Idempotently ensures the shared `flair-agent` Harper user exists with the
 * `flair_agent` role. Verified Ed25519 agents are resolved to THIS user
 * (`getUser("flair-agent", null)` — no password check, identity already proven
 * cryptographically), replacing the old `getUser("admin")` super_user elevation.
 *
 * The password is random and never used for authentication: the agent path
 * resolves the user without it, and the auth gate's Basic path only accepts
 * super_user / pair-bootstrap (a flair_agent Basic login is rejected there), so
 * a Basic login as this user can't reach anything. Random + unused = safe.
 *
 * Row-level ownership stays in each resource's allow* (keyed on the verified
 * agentId); this shared user only carries the flair_agent role's table grants.
 */
export async function ensureFlairAgentUser(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
): Promise<void> {
  const unusedPassword = randomBytes(32).toString("base64url");
  try {
    await callOpsApi(opsUrl, {
      operation: "add_user",
      username: FLAIR_AGENT_USERNAME,
      password: unusedPassword,
      role: "flair_agent",
      active: true,
    }, adminUser, adminPass);
    console.log(`User '${FLAIR_AGENT_USERNAME}' created ✓`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      // Idempotent: ensure the role is correct without churning the password.
      await callOpsApi(opsUrl, {
        operation: "alter_user",
        username: FLAIR_AGENT_USERNAME,
        role: "flair_agent",
        active: true,
      }, adminUser, adminPass);
      console.log(`User '${FLAIR_AGENT_USERNAME}' already exists — role ensured ✓`);
    } else {
      throw err;
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

/**
 * Read the version of an OpenClaw plugin from `~/.openclaw/extensions/<name>/package.json`.
 *
 * `flair upgrade` uses this to surface the installed `@tpsdev-ai/openclaw-flair`
 * version even though it isn't a globally-installed bin or a flair lib dep.
 * Returns null if openclaw isn't installed, the extension isn't installed, or
 * the package.json can't be parsed.
 *
 * @param extensionName — the directory name under `~/.openclaw/extensions/`
 *                        (typically the plugin name without scope, e.g. `openclaw-flair`)
 */
export function probeOpenclawPluginVersion(extensionName: string): string | null {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const { homedir } = require("node:os") as typeof import("node:os");
    const { resolve } = require("node:path") as typeof import("node:path");
    // process.env.HOME first so tests can override; homedir() as fallback —
    // homedir() doesn't honor runtime HOME changes (caches at module load).
    const home = process.env.HOME ?? homedir();
    const pkgJsonPath = resolve(home, ".openclaw", "extensions", extensionName, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Status of a package in the `flair upgrade` listing.
 *   current  — installed version matches registry latest
 *   outdated — installed version is older than latest
 *   missing  — not detected; default packages → install advised
 *   optional — openclaw plugin; openclaw isn't installed (don't nag)
 */
export type UpgradeStatus = "current" | "outdated" | "missing" | "optional";

/**
 * Whether a package's status line should be printed in the default `flair
 * upgrade` listing. Suppresses optional-because-openclaw-is-absent lines
 * — pure noise on machines without openclaw — unless `--all`
 * (showAll) is set. All other statuses always print.
 */
export function shouldPrintUpgradeLine(status: UpgradeStatus, showAll: boolean): boolean {
  if (status === "optional" && !showAll) return false;
  return true;
}

/**
 * Pure flag resolution for `flair upgrade`'s restart/verify defaults
 * (flair#635 decision: restart is now the default; `--no-restart` opts
 * out). `--restart` is a deprecated no-op accepted for backward compat —
 * `deprecatedRestartFlagUsed` tells the caller to print a one-time notice
 * without re-deriving the raw Commander value itself.
 *
 * Commander quirk this relies on: registering both `--restart` (plain
 * boolean) and `--no-restart` (negatable) on the same command means
 * `opts.restart` is `undefined` when neither flag is passed, `true` when
 * `--restart` is passed, and `false` when `--no-restart` is passed — so
 * `!== false` is the correct "should restart" default-true test, and
 * `=== true` isolates "the user explicitly typed the deprecated flag".
 */
export function resolveUpgradeRestartVerify(opts: { restart?: boolean; verify?: boolean }): {
  restart: boolean;
  verify: boolean;
  deprecatedRestartFlagUsed: boolean;
} {
  return {
    restart: opts.restart !== false,
    verify: opts.verify !== false,
    deprecatedRestartFlagUsed: opts.restart === true,
  };
}

/**
 * Whether `flair deploy` / `flair upgrade --target` should run the
 * post-deploy fleet convergence sweep (flair#636). Registering
 * `--no-fleet-verify` via commander leaves `opts.fleetVerify` undefined when
 * unset, `false` when the flag is passed — mirrors resolveUpgradeRestartVerify's
 * `!== false` default-true idiom above.
 */
export function shouldRunFleetVerify(opts: { fleetVerify?: boolean }): boolean {
  return opts.fleetVerify !== false;
}

/**
 * Decide what to do after post-restart verification (flair#635). Pure —
 * takes the ProbeResult and the previously-installed @tpsdev-ai/flair
 * version (known from the pre-upgrade probe findings), returns the action
 * without performing any I/O.
 */
export type UpgradeVerifyAction =
  | { kind: "ok" }
  | { kind: "rollback"; reason: string; toVersion: string }
  | { kind: "cannot-rollback"; reason: string };

export function decideAfterVerify(result: ProbeResult, previousVersion: string | null): UpgradeVerifyAction {
  if (result.ok) return { kind: "ok" };
  const reason = result.error ?? "post-restart verification failed";
  if (!previousVersion) return { kind: "cannot-rollback", reason };
  return { kind: "rollback", reason, toVersion: previousVersion };
}

/** Decide the final outcome after re-verifying a rollback (flair#635). Pure. */
export type RollbackVerifyAction =
  | { kind: "rolled-back" }
  | { kind: "rollback-failed"; reason: string };

export function decideAfterRollbackVerify(result: ProbeResult): RollbackVerifyAction {
  if (result.ok) return { kind: "rolled-back" };
  return { kind: "rollback-failed", reason: result.error ?? "rollback verification failed" };
}

/**
 * Order a soul key→count map for display: highest count first, ties broken
 * alphabetically for stable output. Soul entries are keyed identity facts
 * (role / project / standards / …) — this is the honest breakdown dimension.
 * (Replaced a priority breakdown that was dead telemetry — see flair#453:
 * nothing ever writes Soul.priority to anything but "standard".)
 */
export function sortSoulKeyEntries(byKey: Record<string, number>): Array<[string, number]> {
  return Object.entries(byKey ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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

// ─── CLI↔server version handshake (flair#695 §B) ────────────────────────────
// Every command invocation gets a cheap, cached (~60s), short-timeout check
// of the running server's version against this CLI's own — catches the
// bare-npm-upgrade trap where `npm i -g @tpsdev-ai/flair@latest` swaps the
// CLI binary but the already-running Harper daemon keeps serving the OLD
// code until `flair restart`. `doctor` is excluded here — it already prints
// a richer version triple (CLI/installed, running, latest-published) plus
// migration state, so a global hook nudge on top of that would be
// redundant noise on the one command whose whole job is this exact report.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  if (actionCommand.name() === "doctor") return;
  // Interactive-only: this is a pure stderr UX nudge for a human at a
  // terminal ("bare-npm users must not get stuck"), not a machine-consumed
  // signal — it never changes exit codes or stdout. Gating on TTY means a
  // piped/scripted/CI invocation (and every existing test that spawns the
  // CLI against a mock server) never pays the extra network round trip,
  // which matters beyond latency: several unit tests spawn this CLI against
  // a single-shot mock HTTP server asserting on exactly one received
  // request (e.g. test/unit/presence-set.test.ts) — an unconditional extra
  // GET /Health here would silently consume that slot and break them.
  if (!process.stdout.isTTY) return;
  try {
    const opts = (actionCommand.opts?.() ?? {}) as { port?: string | number };
    const serverUrl = `http://127.0.0.1:${resolveHttpPort(opts)}`;
    // Cache key component: prefer the server's own ROOTPATH if this shell
    // happens to have it set (operating a non-default Harper instance
    // root), else fall back to Flair's own resolved data directory — same
    // "which local install is this" identity every other doctor/status
    // check already keys off, so a stale cache from a since-reinstalled
    // instance sharing the same port never bleeds into a fresh one.
    const rootPath = process.env.ROOTPATH ?? defaultDataDir();
    const result = await checkServerHandshake(__pkgVersion, rootPath, serverUrl);
    const nudge = formatHandshakeNudge(result);
    if (nudge) console.error(`⚠️  ${nudge}`);
  } catch {
    // NEVER block or fail the underlying command over this check.
  }
});

// ─── flair init ──────────────────────────────────────────────────────────────

program
  .command("init")
  .description("One-command Flair setup — bootstrap the instance, register an agent, and wire MCP clients")
  .option("--agent-id <id>", "Agent ID to register (omit to bootstrap instance without agent)")
  .option("--agent <id>", "Alias for --agent-id")
  .option("--port <port>", "Harper HTTP port", String(DEFAULT_PORT))
  .option("--ops-port <port>", "Harper operations API port")
  .option("--admin-pass <pass>", "Admin password (generated if omitted)")
  .option("--admin-pass-file <path>", "Read admin password from file (chmod 600 recommended)")
  .option("--keys-dir <dir>", "Directory for Ed25519 keys")
  .option("--data-dir <dir>", "Harper data directory")
  .option("--skip-start", "Skip Harper startup (assume already running)")
  .option("--skip-soul", "Skip interactive personality setup")
  .option("--client <client>", "MCP client(s) to wire: claude-code, codex, gemini, cursor, all, or none")
  .option("--no-mcp", "Skip MCP client wiring (instance + agent only)")
  .option("--skip-smoke", "Skip the MCP smoke test")
  .option("--skip-claude-md", "Skip appending the Flair bootstrap line to CLAUDE.md (claude-code only)")
  .option("--skip-hook", "Skip installing the flair-session-start SessionStart hook (claude-code only)")
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

    // ── Local init (full one-command setup) ──
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const dataDir: string = opts.dataDir ?? defaultDataDir();

    // Resolve MCP client selection (union of init's auto-wire + the multi-client
    // detection/wiring that the front-door command provides). `--no-mcp` sets
    // opts.mcp === false (commander negates the flag). Validate an explicit
    // --client up front so a typo fails before Harper is touched.
    const clientOpt: string | undefined = opts.client;
    const noMcp = opts.mcp === false;
    const selectedClients: ClientId[] = [];
    if (clientOpt && clientOpt !== "all" && clientOpt !== "none" && !noMcp) {
      const valid: ClientId[] = ["claude-code", "codex", "gemini", "cursor"];
      if (!valid.includes(clientOpt as ClientId)) {
        console.error(`Unknown client: ${clientOpt}. Valid: claude-code, codex, gemini, cursor, all, none`);
        process.exit(1);
      }
      selectedClients.push(clientOpt as ClientId);
    }

    // Admin password: determine from opts, env, or generate
    // Priority: 1) --admin-pass-file, 2) env vars, 3) generate new
    let adminPass: string;
    let passwordSource: "generated" | "file" | "env" = "generated";
    
    // Warn if --admin-pass is passed inline (not from env)
    if (shouldShowInlineSecretWarning(opts.adminPass, false, new Set(["--admin-pass"]), "--admin-pass")) {
      console.error(
        "warning: --admin-pass passed inline. Consider --admin-pass-file <path> or FLAIR_ADMIN_PASS env " +
        "to keep secrets out of shell history."
      );
    }
    
    // Read from file if provided
    if (opts.adminPassFile) {
      try {
        adminPass = readAdminPassFileSecure(opts.adminPassFile);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      passwordSource = "file";
    } else if (process.env.FLAIR_ADMIN_PASS) {
      adminPass = process.env.FLAIR_ADMIN_PASS;
      passwordSource = "env";
    } else if (process.env.HDB_ADMIN_PASSWORD) {
      adminPass = process.env.HDB_ADMIN_PASSWORD;
      passwordSource = "env";
    } else if (opts.adminPass) {
      // Inline admin pass (deprecated)
      adminPass = opts.adminPass;
      // Don't generate - don't write to file
      passwordSource = "env"; // Treat same as env for display purposes
    } else {
      // Generate new password and write to file atomically
      adminPass = Buffer.from(nacl.randomBytes(18)).toString("base64url");
      passwordSource = "generated";
      
      // Atomic write: create temp file in same dir, then rename
      const flairDir = join(homedir(), ".flair");
      mkdirSync(flairDir, { recursive: true });
      const adminPassPath = join(flairDir, "admin-pass");
      const tempPath = mkdtempSync(join(flairDir, ".admin-pass.tmp-"));
      const finalTempPath = join(tempPath, "admin-pass");
      try {
        writeFileSync(finalTempPath, adminPass + "\n", { mode: 0o600 });
        renameSync(finalTempPath, adminPassPath);
        rmSync(tempPath, { recursive: true, force: true });
      } catch (err) {
        // Clean up temp dir on failure
        try { rmSync(tempPath, { recursive: true, force: true }); } catch {}
        throw err;
      }
    }
    const adminUser = DEFAULT_ADMIN_USER;
    
    // If we generated the password, report where it was saved
    if (passwordSource === "generated") {
      const adminPassPath = join(homedir(), ".flair", "admin-pass");
      console.log(`Admin password saved to: ${adminPassPath}`);
    }
    // Check Node.js version
    const major = parseInt(process.version.slice(1), 10);
    if (major < 18) throw new Error(`Node.js >= 18 required (found ${process.version})`);

    let alreadyRunning = false;

    // <ROOTPATH>/models — resources/embeddings-provider.ts's resolveModelsDir()
    // tier 2 default; an operator override already in the environment wins
    // (tier 1). Scoped above the alreadyRunning branch below (not just inside
    // the fresh-start path) since the launchd plist step needs it too, even
    // when Harper was already running and the fresh-spawn branch was skipped.
    const modelsDir = process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models");

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
        // authorizeLocal: false (flair#654) — a credential-less loopback ops-API
        // request is no longer auto-authorized as super_user. Every ops-API
        // seed call below (seedAgentViaOpsApi et al.) already passes a real
        // adminPass via Basic auth, so this does not change local-init behavior.
        const harperSetConfig = JSON.stringify({
          rootPath: dataDir,
          http: { port: httpPort, cors: true, corsAccessList: [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`] },
          operationsApi: { network: { port: opsPort, cors: true }, domainSocket: opsSocket },
          mqtt: { network: { port: null }, webSocket: false },
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
          HTTP_PORT: String(httpPort),
          OPERATIONSAPI_NETWORK_PORT: String(opsPort),
          LOCAL_STUDIO: "false",
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
          // authorizeLocal: false (flair#654) — same posture as the initial spawn
          // above; the launchd-managed process must not diverge from it.
          const setConfig = JSON.stringify({
            rootPath: dataDir,
            http: { port: httpPort, cors: true, corsAccessList: [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`] },
            operationsApi: { network: { port: opsPort, cors: true }, domainSocket: opsSocket },
            mqtt: { network: { port: null }, webSocket: false },
            localStudio: { enabled: false },
            authentication: { authorizeLocal: false, enableSessions: true },
          });
          // models (flair#504 Phase 1): no env var needed here — the
          // launchd-managed process loads the SAME dist/resources/*.js as any
          // other spawn, so resources/embeddings-boot.ts self-registers the
          // backend on every KeepAlive restart in-process. See that file's
          // header (flair#694) for why this replaced the old HARPER_CONFIG
          // plist line.
          const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
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
    <key>FLAIR_MODELS_DIR</key><string>${modelsDir}</string>
    <key>HARPER_SET_CONFIG</key><string>${escapeXml(setConfig)}</string>
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
      } else {
        console.log(`${render.icons.warn} Semantic search not verified ${render.wrap(render.c.dim, `(${embedCheck.detail})`)}`);
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

      // ── MCP client wiring ────────────────────────────────────────────────
      // The full one-command front door: detect installed MCP clients and wire
      // each to the zero-install `npx -y @tpsdev-ai/flair-mcp` server. Claude
      // Code is auto-wired into ~/.claude.json (the only client the CLI can
      // safely modify); other clients get copy-paste snippets. `--no-mcp`
      // skips wiring entirely; `--client <name>` targets one client; the
      // default (no flag) wires every detected client.
      const mcpEnv: { FLAIR_AGENT_ID: string; FLAIR_URL: string } = { FLAIR_AGENT_ID: agentId, FLAIR_URL: httpUrl };
      const wiringResults: { client: string; message: string }[] = [];

      if (!noMcp && clientOpt !== "none") {
        // Determine which clients to wire.
        let clients = detectClients();
        if (selectedClients.length > 0) {
          clients = clients.filter(c => selectedClients.includes(c.id));
        }
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

        for (const clientId of toWire) {
          if (clientId === "claude-code") {
            // Claude Code gets real auto-wiring into ~/.claude.json (zero-install
            // npx form; matches the snippets everywhere else). Other clients only
            // get printed instructions — the CLI can't safely edit their configs.
            const claudeJsonPath = join(homedir(), ".claude.json");
            const flairMcpConfig = {
              type: "stdio" as const,
              command: "npx",
              args: ["-y", "@tpsdev-ai/flair-mcp"] as string[],
              env: mcpEnv,
            };
            try {
              if (existsSync(claudeJsonPath)) {
                const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
                const existing = claudeJson.mcpServers?.flair;
                if (existing && existing.env?.FLAIR_URL === httpUrl && existing.env?.FLAIR_AGENT_ID === agentId) {
                  console.log(`   ✓ Claude Code already wired in ~/.claude.json`);
                  wiringResults.push({ client: "claude-code", message: "already wired" });
                } else {
                  claudeJson.mcpServers = claudeJson.mcpServers || {};
                  claudeJson.mcpServers.flair = flairMcpConfig;
                  writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
                  console.log(`   ✓ Claude Code wired in ~/.claude.json (restart Claude Code to pick it up)`);
                  wiringResults.push({ client: "claude-code", message: "wired ~/.claude.json" });
                }
              } else {
                console.log(`   MCP config (add to ~/.claude.json):`);
                console.log(`     { "mcpServers": { "flair": ${JSON.stringify(flairMcpConfig)} } }`);
                wiringResults.push({ client: "claude-code", message: "snippet printed (no ~/.claude.json)" });
              }
            } catch {
              console.log(`   MCP config (add manually to ~/.claude.json):`);
              console.log(`     { "mcpServers": { "flair": ${JSON.stringify(flairMcpConfig)} } }`);
              wiringResults.push({ client: "claude-code", message: "snippet printed" });
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
            switch (clientId) {
              case "codex": result = wireCodex(mcpEnv); break;
              case "gemini": result = wireGemini(mcpEnv); break;
              case "cursor": result = wireCursor(mcpEnv); break;
              default: result = { ok: false, message: `Unknown client: ${clientId}` };
            }
            wiringResults.push({ client: clientId, message: result.message });
            console.log(`   ${result.ok ? "✓" : "•"} ${result.message}`);
          }
        }
      }

      // ── Smoke-test the MCP server ────────────────────────────────────────
      // Launch flair-mcp and confirm it answers a JSON-RPC initialize over
      // stdio. Best-effort: failures warn but never fail the command. Skipped
      // with --skip-smoke, --no-mcp, --client none, or when nothing was wired.
      if (!opts.skipSmoke && !noMcp && clientOpt !== "none" && wiringResults.length > 0) {
        console.log("\n   Smoke-testing MCP server...");
        try {
          const mcpProc = spawn("npx", ["-y", "@tpsdev-ai/flair-mcp"], {
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
  .option("--target <url>", "Remote Flair REST URL; derives the ops API URL (port-1) to seed the Agent there (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL to seed the Agent on (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (id: string, opts) => {
    const httpPort = resolveHttpPort(opts);
    const opsPort = resolveOpsPort(opts);
    const keysDir: string = opts.keysDir ?? defaultKeysDir();
    const adminUser = DEFAULT_ADMIN_USER;
    const name: string = opts.name ?? id;
    // Where to seed the Agent record. Default is localhost (opsPort). When
    // --ops-target or --target is given, seed on the remote instead of localhost
    // (#514 — agent add could only ever hit localhost ops). Precedence matches
    // `flair import`: explicit --ops-target > derive from --target > localhost.
    const seedOpsTarget: number | string =
      resolveEffectiveOpsUrl({ target: opts.target, opsTarget: opts.opsTarget }) ?? opsPort;
    const isRemoteTarget = typeof seedOpsTarget === "string";

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
          "Error: --admin-pass is required for agent add when targeting a remote instance " +
          "(--target/--ops-target) — the local ~/.flair/admin-pass fallback is not used for remote targets."
        );
      } else {
        console.error(
          "Error: --admin-pass is required for agent add (needed to insert into Agent table). " +
          "Set FLAIR_ADMIN_PASS, or make sure ~/.flair/admin-pass exists (created by `flair init`)."
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
  });

agent
  .command("list")
  .description("List all agents")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
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
      const auth = Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64");
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
    if (out.admin) console.log(render.kv("admin", render.wrap(render.c.magenta, "yes")));
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
    const adminUser = DEFAULT_ADMIN_USER;
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
  .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error(`${render.icons.error} --admin-pass or FLAIR_ADMIN_PASS required`);
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
        format: (v) => (v ? render.wrap(render.c.red, "yes") : render.wrap(render.c.dim, "no")),
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
    if (result.admin) console.log(render.kv("admin", render.wrap(render.c.red, "yes")));
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
  .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass) {
      console.error(`${render.icons.error} --admin-pass or FLAIR_ADMIN_PASS required`);
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
  // Fresh signing with anti-replay: embeds _ts and _nonce before signing.
  // Equivalent to federation-crypto.ts signBodyFresh — duplicated here because
  // the CLI module has its own local signBody for dependency isolation.
  const freshBody = {
    ...body,
    _ts: Date.now(),
    _nonce: Buffer.from(nacl.randomBytes(16)).toString("base64url"),
  };
  const sig = signBody(freshBody, secretKey);
  return { ...freshBody, signature: sig };
}

// Alias: signBodyFresh for clarity at call sites
const signBodyFresh = signRequestBody;

// ─── flair federation ────────────────────────────────────────────────────────

const federation = program.command("federation").description("Manage federation (hub-and-spoke sync)");

federation
  .command("status")
  .description("Show federation status and peer connections")
  .option("--port <port>", "Harper HTTP port")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .option("--json", "Emit JSON {instance, peers} (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    const mode = render.resolveOutputMode(opts);
    try {
      const instance = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
      const { peers } = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);

      if (mode === "json") {
        console.log(render.asJSON({ instance, peers }));
        return;
      }

      const statusColor = instance.status === "active" ? render.c.green : render.c.yellow;
      console.log(render.wrap(render.c.bold, "Federation"));
      console.log(render.kv("Instance", `${instance.id}  ${render.wrap(render.c.dim, `(${instance.role})`)}`));
      console.log(render.kv("Public key", render.wrap(render.c.dim, instance.publicKey)));
      console.log(render.kv("Status", render.wrap(statusColor, instance.status)));

      if (peers.length === 0) {
        console.log(`\n${render.icons.info} ${render.wrap(render.c.dim, "No peers configured. Use 'flair federation pair' to connect to a hub.")}`);
        return;
      }

      const now = Date.now();
      const formatPeerAge = (iso: string | null, refNow: number, staleAfterMs: number): string => {
        if (!iso) return render.wrap(render.c.red, "never");
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return render.wrap(render.c.red, "never");
        const ageMs = refNow - t;
        const ageStr = ageMs < 60_000 ? "<1m ago"
          : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago`
          : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
          : `${Math.floor(ageMs / 86_400_000)}d ago`;
        const stale = ageMs > staleAfterMs;
        return render.wrap(stale ? render.c.yellow : render.c.dim, ageStr);
      };
      console.log();
      const cols: render.TableColumn[] = [
        { label: "peer", key: "id" },
        { label: "role", key: "role", format: (v) => String(v ?? "—") },
        {
          label: "status",
          key: "status",
          format: (v) => {
            const s = String(v ?? "—");
            const color = s === "paired" || s === "connected" || s === "active" ? render.c.green : s === "revoked" ? render.c.red : render.c.yellow;
            return render.wrap(color, s);
          },
        },
        {
          // Liveness: "did we hear from this peer recently?" Updates on every
          // contact, even when 100% of records were skipped. See flair#444.
          label: "last_sync",
          key: "lastSyncAt",
          format: (v) => formatPeerAge(v as string | null, now, 86_400_000),
        },
        {
          // Progress: "did data actually flow in?" Updates only when merged>0.
          // Diverging from last_sync means contact-yes but data-no — investigate.
          label: "last_merge",
          key: "lastMergeAt",
          format: (v) => formatPeerAge(v as string | null, now, 86_400_000),
        },
        {
          label: "relay",
          key: "relayOnly",
          format: (v) => (v ? render.wrap(render.c.cyan, "yes") : render.wrap(render.c.dim, "no")),
        },
      ];
      console.log(render.table(cols, peers as Array<Record<string, unknown>>));

      // Stale warning is gated on lastMergeAt (real progress), not lastSyncAt.
      // A peer that "syncs" every 5min but hasn't merged a record in 24h is
      // exactly the failure mode we want surfaced.
      const haveStale = peers.some((p: any) => {
        const cursor = p.lastMergeAt ?? p.lastSyncAt;
        if (!cursor) return true;
        const t = Date.parse(cursor);
        return !Number.isFinite(t) || (now - t) > 86_400_000;
      });
      if (haveStale) {
        console.log();
        console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "One or more peers haven't merged a record in >24h.")} ${render.wrap(render.c.dim, "Check skippedReasons in SyncLog or run 'flair federation sync'.")}`);
      }

      const haveContactButNoMerge = peers.some((p: any) => {
        if (!p.lastSyncAt || !Number.isFinite(Date.parse(p.lastSyncAt))) return false;
        if ((now - Date.parse(p.lastSyncAt)) > 3_600_000) return false; // only recent contact
        // Contact within the last hour, but no merge ever (or stale by >1h)
        if (!p.lastMergeAt) return true;
        const tm = Date.parse(p.lastMergeAt);
        return !Number.isFinite(tm) || (now - tm) > 3_600_000;
      });
      if (haveContactButNoMerge && !haveStale) {
        console.log();
        console.log(`${render.icons.warn} ${render.wrap(render.c.yellow, "Peer contact is fresh but no records merged in the last hour.")} ${render.wrap(render.c.dim, "Possible silent-skip scenario — check SyncLog.skippedReasons.")}`);
      }
    } catch (err: any) {
      const msg = String(err.message ?? err);
      if (msg.includes("missing_or_invalid_authorization") || msg.includes("401")) {
        console.error(`${render.icons.error} federation status requires auth.`);
        console.error(`  ${render.wrap(render.c.dim, "Set one of:")}`);
        console.error(`    ${render.wrap(render.c.cyan, "FLAIR_AGENT_ID=<your-agent-id>")}     ${render.wrap(render.c.dim, "(Ed25519 — uses ~/.flair/keys/<id>.key)")}`);
        console.error(`    ${render.wrap(render.c.cyan, "FLAIR_ADMIN_PASS=<admin-password>")}  ${render.wrap(render.c.dim, "(admin Basic auth, remote targets)")}`);
        console.error(`    ${render.wrap(render.c.cyan, "FLAIR_TOKEN=<bearer>")}               ${render.wrap(render.c.dim, "(legacy)")}`);
        process.exit(1);
      }
      console.error(`${render.icons.error} ${msg}`);
      process.exit(1);
    }
  });

// `flair federation reachability` — probe local instance + all paired peers.
// Productizes flair#695: a single command that tells
// you whether memories CAN flow across the federation right now. Read-only;
// no mutations, no side effects beyond a single tagged status read per peer.
federation
  .command("reachability")
  .description("Probe local Flair + each paired peer for reachability (read-only)")
  .option("--port <port>", "Harper HTTP port")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--quiet", "Suppress output on full success")
  .option("--json", "Emit machine-readable JSON instead of text")
  .option("--peer-timeout <seconds>", "HTTP timeout per peer probe (default 5)", "5")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    const timeoutMs = (Number(opts.peerTimeout) || 5) * 1000;
    type Result = { host: string; port: number | null; status: "ok" | "fail" | "skip"; detail: string };
    const results: Result[] = [];

    // 1. Local probe.
    try {
      const inst = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
      results.push({ host: "local", port: null, status: "ok", detail: `instance ${inst.id} (${inst.role}, ${inst.status})` });
    } catch (e: any) {
      results.push({ host: "local", port: null, status: "fail", detail: e.message });
    }

    // 2. Per-peer probes. For each peer with an `endpoint` (URL), probe it.
    // Peers without an endpoint are reverse-tunnel-paired (the spoke can't
    // reach the hub directly without the tunnel) and we skip.
    let peers: any[] = [];
    try {
      const r = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
      peers = r.peers ?? [];
    } catch (e: any) {
      results.push({ host: "/FederationPeers", port: null, status: "fail", detail: e.message });
    }

    for (const p of peers) {
      const endpoint = p.endpoint as string | undefined;
      if (!endpoint) {
        results.push({ host: p.id, port: null, status: "skip", detail: `${p.role ?? "—"} (no endpoint — needs tunnel)` });
        continue;
      }
      // Any HTTP response (including 401) means the peer is reachable + responding.
      // We're checking the network path, not auth; 401 is expected for unauth probes.
      // Use new URL() to avoid path-swallowing when endpoint includes a query
      // (Sherlock review on #314).
      let probeUrl: URL;
      try {
        probeUrl = new URL("/Health", endpoint);
      } catch {
        results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} invalid endpoint URL` });
        continue;
      }
      if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") {
        results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} unsupported protocol ${probeUrl.protocol}` });
        continue;
      }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(probeUrl, { signal: ctrl.signal });
        clearTimeout(t);
        results.push({ host: p.id, port: null, status: "ok", detail: `${p.role ?? "—"} HTTP ${res.status}` });
      } catch (e: any) {
        const msg = e.name === "AbortError" ? `timeout after ${opts.peerTimeout}s` : e.message;
        results.push({ host: p.id, port: null, status: "fail", detail: `${p.role ?? "—"} ${msg}` });
      }
    }

    const failures = results.filter(r => r.status === "fail").length;

    if (opts.json) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), failures, results }, null, 2));
    } else if (!(opts.quiet && failures === 0)) {
      console.log(`── Flair reachability — ${new Date().toISOString()} ──`);
      for (const r of results) {
        const tag = r.status === "ok" ? "OK  " : r.status === "skip" ? "SKIP" : "FAIL";
        console.log(`${tag} ${r.host.padEnd(40)} ${r.detail}`);
      }
      if (failures > 0) {
        console.log(`── ${failures} path(s) FAILED ──`);
      } else {
        console.log("── all reachable ──");
      }
    }

    if (failures > 0) process.exit(1);
  });

/** Parse a JSON triple file for --token-from.
 *  Expected shape: { "token": "...", "user": "pair-bootstrap-<id>", "password": "...", "expiresAt": "<ISO>" }
 *  Returns the triple on success. Validation failures exit(1).
 */
function parseTokenFromFile(filePath: string): {
  token: string; user: string; password: string; expiresAt: string;
} {
  let raw: string;
  if (filePath === "-") {
    raw = readFileSync("/dev/stdin", "utf-8");
  } else {
    if (!existsSync(filePath)) {
      console.error(`Error: --token-from file not found: ${filePath}`);
      process.exit(1);
    }
    raw = readFileSync(filePath, "utf-8");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Error: --token-from file is not valid JSON: ${filePath}`);
    process.exit(1);
  }

  // Validate all four fields present and non-empty
  const required = ["token", "user", "password", "expiresAt"] as const;
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      console.error(`Error: --token-from JSON is missing or has empty required field "${field}"`);
      process.exit(1);
    }
  }

  // Validate expiresAt is a parseable date and is in the future
  const expiry = new Date(parsed.expiresAt);
  if (isNaN(expiry.getTime())) {
    console.error(`Error: --token-from JSON has invalid expiresAt date: "${parsed.expiresAt}"`);
    process.exit(1);
  }
  const now = new Date();
  if (expiry <= now) {
    console.error(`Error: --token-from JSON has expired token (expiresAt: ${parsed.expiresAt})`);
    process.exit(1);
  }
  const fiveMin = 5 * 60 * 1000;
  if (expiry.getTime() - now.getTime() < fiveMin) {
    console.error(`warning: pairing token expires in less than 5 minutes (expiresAt: ${parsed.expiresAt})`);
  }

  return {
    token: parsed.token.trim(),
    user: parsed.user.trim(),
    password: parsed.password.trim(),
    expiresAt: parsed.expiresAt.trim(),
  };
}

federation
  .command("pair <hub-url>")
  .description("Pair this spoke with a hub instance")
  .option("--port <port>", "Harper HTTP port")
  .option("--admin-pass <pass>", "Admin password")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--token <token>", "One-time pairing token from hub admin (env: FLAIR_PAIRING_TOKEN) [deprecated: use --token-from]")
  .option("--token-from <file>", "Read bootstrap triple from JSON file (use '-' for stdin)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .option("--ops-target <url>", "Explicit ops API URL (env: FLAIR_OPS_TARGET; bypasses port derivation)")
  .action(async (hubUrl: string, opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    try {
      const instance = await api("GET", "/FederationInstance", undefined, baseUrl ? { baseUrl } : undefined);
      console.log(`${target ? "Remote" : "Local"} instance: ${instance.id} (${instance.role})`);

      // Determine token source: --token-from wins if both specified
      if (opts.tokenFrom && opts.token) {
        console.error("warning: --token-from takes precedence over --token. The --token flag is deprecated; use --token-from <file> instead.");
      }

      let pairingToken: string;
      let authHeader: string | undefined;

      if (opts.tokenFrom) {
        // ── Bootstrap triple path (--token-from) ──
        const triple = parseTokenFromFile(opts.tokenFrom);
        pairingToken = triple.token;
        authHeader = `Basic ${Buffer.from(`${triple.user}:${triple.password}`).toString("base64")}`;
        console.log(`Using bootstrap user: ${triple.user}`);
      } else if (opts.token) {
        // ── Bare token path (--token) — deprecated ──
        pairingToken = opts.token || process.env.FLAIR_PAIRING_TOKEN;
        console.error("warning: --token is deprecated. Use --token-from <file> to keep credentials out of shell history.");

        // Warning: inline token may leak to shell history.
        const tokenFromEnv = !opts.token && !!process.env.FLAIR_PAIRING_TOKEN;
        if (shouldShowInlineSecretWarning(opts.token, tokenFromEnv, new Set(["--token"]), "--token")) {
          console.error(
            "warning: --token passed inline. Consider --token-from <file> or FLAIR_PAIRING_TOKEN env " +
            "to keep secrets out of shell history."
          );
        }
      } else {
        console.error("Error: --token or --token-from is required. Ask the hub admin to run 'flair federation token' and provide the token.");
        process.exit(1);
      }

      // Load secret key and sign the pairing request.
      const secretKey = await loadInstanceSecretKey(instance.id, opts);
      const pairBody: Record<string, any> = {
        instanceId: instance.id,
        publicKey: instance.publicKey,
        role: "spoke",
        pairingToken,
      };
      const signedBody = signBodyFresh(pairBody, secretKey);

      const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (authHeader) {
        fetchHeaders.Authorization = authHeader;
      }

      const res = await fetch(`${hubUrl}/FederationPair`, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify(signedBody),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Pairing failed: ${res.status} ${text}`);
        process.exit(1);
      }

      const result = await res.json() as any;
      console.log(`✅ Paired with hub: ${result.instance?.id ?? hubUrl}`);

      // Record the hub as our local peer. This is REQUIRED, not optional:
      // `flair federation sync` reads the Peer table to find the hub, so
      // without this record sync reports "No hub peer configured" and silently
      // never runs. Previously this was gated on `if (adminPass)` and the write
      // result was never checked — pairing with only an agent key (or a failed
      // upsert) left no peer behind a misleadingly green "✅ Paired".
      const adminPass = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD ?? "";
      if (!adminPass) {
        console.error(
          "Error: paired on the hub, but the local hub-peer record needs admin auth to write — " +
          "pass --admin-pass, or set FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD, then re-run pair. " +
          "Without it, 'flair federation sync' will report 'No hub peer configured'."
        );
        process.exit(1);
      }
      const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
      const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
      const peerRes = await fetch(`${opsEndpoint}/`, {
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
      if (!peerRes.ok) {
        const text = await peerRes.text().catch(() => "");
        console.error(
          `Error: paired with the hub but failed to write the local hub-peer record ` +
          `(${peerRes.status} ${text.slice(0, 200)}). Ops endpoint: ${opsEndpoint}. ` +
          `'flair federation sync' will not find the hub until this succeeds — check --admin-pass and the ops port.`
        );
        process.exit(1);
      }
      console.log(`✅ Recorded hub as local peer: ${result.instance?.id ?? "hub"} → ${hubUrl}`);
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
  .option("--format <format>", "Output format: json (default) or text (bare token, deprecated)", "json")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    try {
      const token = randomBytes(24).toString("base64url");
      const ttlMinutes = parseInt(opts.ttl, 10) || 60;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

      const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;

      // 1. Persist the PairingToken record
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

      // 2. Create bootstrap user for this token
      const bootstrapPassword = randomBytes(32).toString("base64url");
      const bootstrapUsername = `pair-bootstrap-${token.slice(0, 8)}`;

      let addUserRes: Response;
      try {
        addUserRes = await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "add_user",
            username: bootstrapUsername,
            password: bootstrapPassword,
            role: "flair_pair_initiator",
            active: true,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err: any) {
        // Network failure creating bootstrap user — roll back PairingToken
        await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "delete",
            database: "flair",
            table: "PairingToken",
            hash_value: token,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
        throw new Error(`Failed to create bootstrap user (network): ${err.message}`);
      }

      if (!addUserRes.ok) {
        // add_user failed — roll back PairingToken so the two stay in sync
        await fetch(`${opsEndpoint}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "delete",
            database: "flair",
            table: "PairingToken",
            hash_value: token,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
        const detail = await addUserRes.text().catch(() => "");
        throw new Error(`Failed to create bootstrap user (${addUserRes.status}): ${detail || "no body"}`);
      }

      // 3. Output
      const format = (opts.format ?? "json").toLowerCase();
      if (format === "text") {
        process.stderr.write(`[DEPRECATION] --format text is deprecated. Default output is now JSON.\n`);
        console.log(token);
      } else {
        console.log(JSON.stringify({ token, user: bootstrapUsername, password: bootstrapPassword, expiresAt }, null, 2));
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export async function runFederationSyncOnce(opts: any): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const target = resolveTarget(opts);
  const baseUrl = target ? target.replace(/\/$/, "") : undefined;
  const apiOpts = baseUrl ? { baseUrl } : undefined;
  let totalMerged = 0;
  let totalSkipped = 0;
  try {
    const { peers } = await api("GET", "/FederationPeers", undefined, apiOpts);
    const hub = peers.find((p: any) => p.role === "hub" && p.status !== "revoked");
    if (!hub) {
      return { pushed: 0, skipped: 0, error: new Error("No hub peer configured. Use 'flair federation pair' first.") };
    }

    console.log(`Syncing to hub: ${hub.id}...`);
    const since = hub.lastSyncAt ?? new Date(0).toISOString();
    // Capture sync start time BEFORE we query records. We advance the local
    // hub peer's lastSyncAt to this value after success so the next poll's
    // `since` cursor moves forward — fixes task #146 (federation peer
    // .lastSyncAt update bug). Records updated DURING this sync will have
    // updatedAt > syncStartedAt and be picked up next cycle, not missed.
    const syncStartedAt = new Date().toISOString();
    const opsEndpoint = resolveEffectiveOpsUrl(opts) ?? `http://127.0.0.1:${resolveOpsPort(opts)}`;
    const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
    const tables = ["Memory", "Soul", "Agent", "Relationship"];
    const instance = await api("GET", "/FederationInstance", undefined, apiOpts);
    const hubUrl = hub.endpoint ?? hub.id;

    // ── Batching constants ──────────────────────────────────────────────
    // 2MB JSON budget (server cap is 10MB; 2MB leaves headroom for headers
    // and signature metadata) + 50 records max per batch. The hub merge itself
    // is fast (~1.7s/50 records, per its SyncLog), but the Fabric ingress was
    // observed to intermittently stall on larger POSTs — a 50-record batch hung
    // ~2 min while the same records split into 2×25 went through immediately.
    // 50 keeps batches in the reliable range, and sendBatch's adaptive split
    // recovers if a stretch still stalls.
    const BUDGET_BYTES = 2_000_000;
    const BUDGET_RECORDS = 50;

    // ── sendBatch helper ────────────────────────────────────────────────
    // Secret key is lazy-loaded: only needed when there are records to send.
    // Loading earlier would cause a spurious error when SQL queries fail
    // (e.g. 401) before we know we have records.
    let secretKey: Uint8Array | undefined;
    // Statuses the Fabric ingress returns when a batch POST didn't complete in
    // time (408) or was too large (413), plus the transient gateway 5xx family.
    // Splitting the batch and retrying smaller chunks lets the sync converge
    // instead of aborting the whole run.
    const TIMEOUT_STATUSES = new Set([408, 413, 502, 503, 504]);
    // Per-batch wall-clock cap. Without it a stalled connection to the Fabric
    // ingress hangs the whole sync until the *gateway's* timeout fires (~2 min
    // observed), which is what stranded the re-pair. A 45s cap is generous —
    // a healthy 50-record batch merges in <2s — so a trip means a real stall,
    // and we split-and-retry rather than wait it out.
    const BATCH_TIMEOUT_MS = 45_000;
    async function sendBatch(batch: any[]): Promise<{ merged: number; skipped: number }> {
      if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);
      const syncBody: Record<string, any> = { instanceId: instance.id, records: batch, lamportClock: Date.now() };
      const signedSyncBody = signBodyFresh(syncBody, secretKey);

      // Halve and retry down to a single record. Covers both an explicit
      // timeout status AND a client-side abort (stalled socket). The hub
      // merges idempotently (put-by-id), so retried records are safe.
      const splittable = (status: number | null) =>
        batch.length > 1 && (status === null || TIMEOUT_STATUSES.has(status));
      const split = async () => {
        const mid = Math.floor(batch.length / 2);
        const left = await sendBatch(batch.slice(0, mid));
        const right = await sendBatch(batch.slice(mid));
        return { merged: left.merged + right.merged, skipped: left.skipped + right.skipped };
      };

      let syncRes: Response;
      try {
        syncRes = await fetch(`${hubUrl}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signedSyncBody),
          signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
        });
      } catch (err: any) {
        // Timeout/abort or network drop — no status. Split if we can.
        if (splittable(null)) return await split();
        throw new Error(`Sync batch (${batch.length} record${batch.length === 1 ? "" : "s"}) failed: ${err?.message ?? err}`);
      }
      if (!syncRes.ok) {
        if (splittable(syncRes.status)) return await split();
        const text = await syncRes.text().catch(() => "");
        throw new Error(`Sync batch failed: ${syncRes.status} ${text}`);
      }
      return await syncRes.json() as { merged: number; skipped: number };
    }

    let totalBatches = 0;

    for (const table of tables) {
      let rows: any[] = [];
      for (const query of [
        { search_attribute: "updatedAt", search_type: "greater_than", search_value: since },
        // Rows with null updatedAt (legacy direct-insert rows) use createdAt.
        // COALESCE(updatedAt, createdAt) > since → pick up null-updatedAt rows
        // whose createdAt > since. Filtered in JS below.
        { search_attribute: "updatedAt", search_type: "equals", search_value: null },
      ]) {
        let res: Response;
        try {
          res = await fetch(`${opsEndpoint}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table, operator: "and", conditions: [query], get_attributes: ["*"] }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err: any) {
          return { pushed: totalMerged, skipped: totalSkipped, error: err instanceof Error ? err : new Error(String(err)) };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { pushed: totalMerged, skipped: totalSkipped, error: new Error(`SQL query failed (${res.status}): ${text}`) };
        }
        const batch = await res.json() as any[];
        // For null-updatedAt rows, use createdAt as the effective timestamp.
        // Skip rows created before the last sync cursor. Only Memory carries
        // a `visibility` field (Soul/Agent/Relationship don't — see
        // schemas/memory.graphql vs agent.graphql), so the private-exclusion
        // filter only applies there; on the other 3 tables `row.visibility`
        // is always undefined, which isFederationPrivateVisibility() treats
        // as non-private (included) — a no-op for them.
        rows = rows.concat(
          batch
            .filter((r: any) => r.updatedAt !== null || r.createdAt > since)
            .filter((r: any) => table !== "Memory" || !isFederationPrivateVisibility(r.visibility)),
        );
      }
      if (rows.length === 0) continue;

      // Records are signed (below) before they're batched, so the secret key
      // is needed here rather than only inside sendBatch. Still deferred
      // until we know THIS table has rows to send — preserves the "don't
      // load the key on a no-op run" property the original lazy load had.
      if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);

      let batch: any[] = [];
      let batchBytes = 0;

      for (const row of rows) {
        const updatedAt = row.updatedAt ?? row.createdAt;
        const originatorInstanceId = instance.id;

        // Per-record signature (federation-edge-hardening slice 3a): signed by
        // THIS instance — the originator — over a versioned canonical form, so
        // a receiver (including a hub relaying this record onward to other
        // spokes) can verify authorship independent of who forwarded the
        // batch. Closes the hub-relay forgery hole — see
        // resources/Federation.ts FederationSync.post's verification gate.
        //
        // CONTRACT — must match Federation.ts's verification payload
        // byte-for-byte: keys { v, table, id, data, updatedAt,
        // originatorInstanceId }. canonicalize() sorts keys, so field ORDER
        // doesn't matter, but the field SET and values do. `v: 1` versions the
        // canonical form itself: bump it on BOTH sides together if the signed
        // field set ever changes, so an old signature fails closed instead of
        // silently mis-verifying under a new form.
        //
        // Additive/backward-compatible: pre-3a receivers don't read
        // `signature`/`principalId` at all and merge exactly as before.
        const signature = signBody(
          { v: 1, table, id: row.id, data: row, updatedAt, originatorInstanceId },
          secretKey,
        );

        const sr: Record<string, any> = { table, id: row.id, data: row, updatedAt, originatorInstanceId, signature };

        // Informational only (see principalIdFromRow) — never verified by the
        // receiver as proof of authorship. Omitted entirely when the row
        // carries no write-time provenance stamp.
        const principalId = principalIdFromRow(row);
        if (principalId) sr.principalId = principalId;

        const srBytes = JSON.stringify(sr).length;

        if (batch.length >= BUDGET_RECORDS || (batch.length > 0 && batchBytes + srBytes > BUDGET_BYTES)) {
          const result = await sendBatch(batch);
          totalMerged += result.merged;
          totalSkipped += result.skipped;
          totalBatches++;
          batch = [];
          batchBytes = 0;
        }

        batch.push(sr);
        batchBytes += srBytes;
      }

      // Send final partial batch for this table
      if (batch.length > 0) {
        const result = await sendBatch(batch);
        totalMerged += result.merged;
        totalSkipped += result.skipped;
        totalBatches++;
      }
    }

    // Advance the local hub peer's lastSyncAt cursor. The hub-side
    // FederationSync handler updates ITS view of the spoke peer, but the
    // spoke never updated its own view of the hub — so `since` stayed at
    // whatever value was on the peer record at pair time (often near-epoch),
    // and every poll re-queried `updatedAt > since` and re-sent every
    // memory ever written. The receiver-side contentHash gate in
    // Federation.ts prevents the actual blob re-write, but advancing the
    // cursor here stops the redundant network traffic + Lambda compute
    // entirely. Task #146. Even no-change runs should advance.
    try {
      const advanceRes = await fetch(`${opsEndpoint}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          operation: "update",
          database: "flair",
          table: "Peer",
          records: [{ id: hub.id, lastSyncAt: syncStartedAt }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!advanceRes.ok) {
        const txt = await advanceRes.text().catch(() => "");
        console.warn(`⚠️  Local hub.lastSyncAt advance failed (${advanceRes.status}): ${txt.slice(0, 200)}. Next poll will re-send memories.`);
      }
    } catch (advErr: any) {
      console.warn(`⚠️  Local hub.lastSyncAt advance error: ${advErr?.message ?? advErr}. Next poll will re-send memories.`);
    }

    if (totalBatches === 0) {
      // No-change syncs must still ping the hub so it updates the
      // spoke's lastSyncAt (liveness). Without this, idle-but-alive spokes
      // look indistinguishable from dead ones on the hub dashboard.
      try {
        if (!secretKey) secretKey = await loadInstanceSecretKey(instance.id, opts);
        const pingBody = signBodyFresh({
          instanceId: instance.id,
          records: [],
          lamportClock: Date.now(),
        }, secretKey);
        const pingRes = await fetch(`${hubUrl}/FederationSync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pingBody),
          signal: AbortSignal.timeout(10_000),
        });
        if (!pingRes.ok) {
          const txt = await pingRes.text().catch(() => "");
          console.warn(`⚠️  Liveness ping to hub failed (${pingRes.status}): ${txt.slice(0, 200)}. Hub won't update spoke liveness.`);
        }
      } catch (pingErr: any) {
        console.warn(`⚠️  Liveness ping error: ${pingErr?.message ?? pingErr}. Hub won't update spoke liveness.`);
      }

      console.log("No changes since last sync.");
      return { pushed: 0, skipped: 0 };
    }

    console.log(`✅ Synced ${totalMerged} records (${totalSkipped} skipped) across ${totalBatches} batches`);
    return { pushed: totalMerged, skipped: totalSkipped };
  } catch (err: any) {
    return { pushed: totalMerged, skipped: totalSkipped, error: err instanceof Error ? err : new Error(String(err)) };
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

// `flair federation prune` — remove stale spoke peers (never the hub).
// Productizes flair#695 into a real CLI
// subcommand with safety: dry-run is the default, --apply required to delete.
function parseDuration(spec: string): number | null {
  // Accept forms like "30d", "12h", "90m". Returns milliseconds.
  // Rejects zero and sub-1-minute durations: a 0-ms cutoff would equal Date.now()
  // and prune every non-hub peer (Sherlock review on #314).
  const m = spec.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mul = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit] ?? null;
  if (mul == null) return null;
  const ms = n * mul;
  const ONE_MINUTE = 60 * 1000;
  if (ms < ONE_MINUTE) return null;
  return ms;
}

federation
  .command("prune")
  .description("Remove stale spoke peers (older than --older-than). Hub is never pruned. Default dry-run.")
  .option("--older-than <duration>", "Duration spec (e.g. 30d, 12h, 90m)", "30d")
  .option("--apply", "Actually delete (default is dry-run)")
  .option("--include <pattern>", "Only consider peer IDs starting with this prefix")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--target <url>", "Remote Flair URL")
  .option("--ops-target <url>", "Explicit ops API URL")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    const olderThanMs = parseDuration(opts.olderThan);
    if (olderThanMs == null) {
      console.error(`Error: invalid or unsafe --older-than '${opts.olderThan}'. Use forms like 30d, 12h, 90m. Minimum 1 minute.`);
      process.exit(2);
    }
    const cutoff = Date.now() - olderThanMs;

    let peers: any[] = [];
    try {
      const r = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
      peers = r.peers ?? [];
    } catch (e: any) {
      console.error(`Error fetching peers: ${e.message}`);
      process.exit(1);
    }

    const candidates = peers.filter(p => {
      // Hub-protection: never prune. Case-insensitive; null/undefined role is
      // treated as "unknown — refuse to prune to be safe" (Sherlock review on #314).
      const role = (p.role ?? "").toString().toLowerCase();
      if (role === "hub" || role === "") return false;
      // Include filter.
      if (opts.include && !String(p.id ?? "").startsWith(opts.include)) return false;
      // Stale threshold: a peer with NO lastSyncAt is treated as having been
      // born and immediately abandoned — qualifies if it's older than the
      // threshold based on pairedAt instead.
      const ts = p.lastSyncAt ?? p.pairedAt;
      if (!ts) return true; // truly orphaned record — prune candidate.
      return new Date(ts).getTime() < cutoff;
    });

    if (candidates.length === 0) {
      console.log(`flair federation prune: no peers older than ${opts.olderThan} (and not hub) — nothing to do.`);
      return;
    }

    if (!opts.apply) {
      console.log(`── flair federation prune — dry-run (use --apply to delete) ──`);
      console.log(`Would delete ${candidates.length} peer(s) older than ${opts.olderThan}:`);
      for (const p of candidates) {
        const ts = p.lastSyncAt ?? p.pairedAt ?? "never";
        const age = ts === "never" ? "(never synced/paired)" : `${Math.floor((Date.now() - new Date(ts).getTime()) / (24 * 60 * 60 * 1000))}d ago`;
        console.log(`  ${p.id}  ${(p.role ?? "—").padEnd(8)} lastSyncAt ${ts} (${age})`);
      }
      console.log(`Run with --apply to actually delete.`);
      return;
    }

    // Apply path. Delete each peer via the Harper ops API. We use the
    // domain-socket form when local; otherwise we fall back to the resource
    // DELETE which requires admin auth.
    let deleted = 0;
    let errors = 0;
    for (const p of candidates) {
      try {
        const res = await api("DELETE", `/FederationPeers/${encodeURIComponent(p.id)}`, undefined, baseUrl ? { baseUrl } : undefined);
        const ok = res?.ok ?? res?.deleted ?? true;
        if (ok) {
          deleted++;
          const ts = p.lastSyncAt ?? p.pairedAt ?? "never";
          console.log(`Deleted ${p.id} (last seen ${ts}).`);
        } else {
          errors++;
          console.log(`Failed to delete ${p.id}: ${JSON.stringify(res)}`);
        }
      } catch (e: any) {
        errors++;
        console.log(`Failed to delete ${p.id}: ${e.message}`);
      }
    }
    console.log(`${deleted} peer(s) deleted; ${errors} error(s).`);
    if (errors > 0) process.exit(1);
  });

// `flair federation verify` — end-to-end roundtrip: write a tagged memory
// locally, wait for federation push, probe peers for the tag. Productizes
// flair#695 Cleans up the test memory at the end.
federation
  .command("verify")
  .description("End-to-end check: write a tagged memory locally and verify it shows up on each peer")
  .option("--peer <id>", "Verify only against this peer ID (default: all hubs + spokes)")
  .option("--wait <seconds>", "How long to wait for federation push (default 60)", "60")
  .option("--tag <prefix>", "Memory tag prefix (default: fed-verify)", "fed-verify")
  .option("--port <port>", "Harper HTTP port")
  .option("--target <url>", "Remote Flair URL")
  .action(async (opts) => {
    const target = resolveTarget(opts);
    const baseUrl = target ? target.replace(/\/$/, "") : undefined;
    const waitMs = (Number(opts.wait) || 60) * 1000;
    const tag = `${opts.tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`── flair federation verify — ${new Date().toISOString()} ──`);
    console.log(`Tag: ${tag}, wait window: ${opts.wait}s`);

    // Resolve agent ID for the local write.
    const agentId = process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("Error: FLAIR_AGENT_ID not set. Set it or use 'flair agent default <id>'.");
      process.exit(1);
    }

    // 1. Write tagged ephemeral memory locally (mirror `flair memory add`).
    // The whole post-write block is wrapped in try/finally so cleanup runs on
    // every exit path (Sherlock review on #314: previous early-exits leaked
    // the probe memory).
    const memId = `${agentId}-${Date.now()}-fed-verify`;
    try {
      await api("PUT", `/Memory/${encodeURIComponent(memId)}`, {
        id: memId,
        agentId,
        content: `${tag} — federation verify probe written at ${new Date().toISOString()}`,
        type: "memory",
        durability: "ephemeral",
        tags: ["federation-verify", tag],
        createdAt: new Date().toISOString(),
      }, baseUrl ? { baseUrl } : undefined);
      console.log(`1. Wrote local memory: ${memId}`);
    } catch (e: any) {
      console.error(`1. Local write FAILED: ${e.message}`);
      // No memory was written — nothing to clean up. Direct exit is safe.
      process.exit(1);
    }

    // From here, memId is committed and MUST be cleaned up regardless of how
    // we leave this block.
    let exitCode = 0;
    try {
      // 2. List peers to probe.
      let peers: any[] = [];
      try {
        const r = await api("GET", "/FederationPeers", undefined, baseUrl ? { baseUrl } : undefined);
        peers = r.peers ?? [];
        if (opts.peer) peers = peers.filter(p => p.id === opts.peer);
      } catch (e: any) {
        console.error(`Failed to list peers: ${e.message}`);
      }
      if (peers.length === 0) {
        console.log("(no peers to probe)");
        // Still falls through to finally for cleanup.
      } else {
        console.log(`2. Probing ${peers.length} peer(s) over ${opts.wait}s window…`);

        // 3. Poll each peer until found OR window elapses.
        const started = Date.now();
        const found = new Set<string>();
        const failed = new Set<string>();
        while (Date.now() - started < waitMs && (found.size + failed.size) < peers.length) {
          for (const p of peers) {
            if (found.has(p.id) || failed.has(p.id)) continue;
            const endpoint = p.endpoint;
            if (!endpoint) {
              // Tunnel-paired — no direct endpoint to probe. Mark as skipped.
              failed.add(p.id);
              console.log(`   ${p.id}  SKIP (no endpoint — tunnel-paired)`);
              continue;
            }
            // Reject non-http(s) endpoints to keep the probe surface small.
            // (Sherlock review on #314 — protocol allowlist.)
            let probeUrl: URL;
            try {
              probeUrl = new URL("/SemanticSearch", endpoint);
            } catch {
              failed.add(p.id);
              console.log(`   ${p.id}  FAIL (invalid endpoint URL: ${endpoint})`);
              continue;
            }
            if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") {
              failed.add(p.id);
              console.log(`   ${p.id}  FAIL (unsupported endpoint protocol: ${probeUrl.protocol})`);
              continue;
            }
            try {
              const res = await fetch(probeUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ q: tag, limit: 5 }),
                signal: AbortSignal.timeout(5000),
              });
              if (res.status === 401) {
                // Auth-gated — can't verify without admin creds for the peer.
                // Fail the probe with diagnostic.
                failed.add(p.id);
                console.log(`   ${p.id}  FAIL (HTTP 401 — peer auth-gated; needs cross-instance admin auth)`);
                continue;
              }
              if (!res.ok) {
                failed.add(p.id);
                console.log(`   ${p.id}  FAIL (HTTP ${res.status})`);
                continue;
              }
              const data = await res.json().catch(() => ({}));
              const results = (data as any).results ?? [];
              if (results.some((r: any) => (r.content ?? "").includes(tag))) {
                const elapsed = Math.floor((Date.now() - started) / 1000);
                console.log(`   ${p.id}  OK (memory found after ${elapsed}s)`);
                found.add(p.id);
              }
            } catch {
              // Don't mark failed yet — peer might just be slow. Retry next iteration.
            }
          }
          await new Promise(res => setTimeout(res, 5000));
        }

        // Anything still pending is a timeout failure.
        for (const p of peers) {
          if (!found.has(p.id) && !failed.has(p.id)) {
            failed.add(p.id);
            console.log(`   ${p.id}  FAIL (timeout — memory did not propagate within ${opts.wait}s)`);
          }
        }

        // 5. Summary + diagnostics on failure.
        if (failed.size > 0) {
          console.log(`── FAIL: ${failed.size}/${peers.length} peer(s) did not see the memory ──`);
          console.log(`Diagnostics to run next:`);
          console.log(`  flair federation status     # confirm peers are paired + lastSyncAt is recent`);
          console.log(`  flair federation reachability  # confirm peers are HTTP-reachable`);
          console.log(`  launchctl list | grep fed-sync  # confirm federation-sync daemon is running (macOS)`);
          console.log(`  curl <peer-endpoint>/Health  # raw probe`);
          exitCode = 1;
        } else {
          console.log(`── PASS: memory propagated to all ${peers.length} peer(s) ──`);
        }
      }
    } finally {
      // 4. Cleanup: delete the local probe memory. Runs on EVERY exit path.
      try {
        await api("DELETE", `/Memory/${encodeURIComponent(memId)}`, undefined, baseUrl ? { baseUrl } : undefined);
        console.log(`4. Cleanup: deleted local memory ${memId}`);
      } catch {
        console.log(`4. Cleanup: could NOT delete local memory ${memId} (manual cleanup needed)`);
      }
    }
    if (exitCode !== 0) process.exit(exitCode);
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
      console.log("  flair memory add --agent <id> --content <insight> --durability persistent --derived-from <source-ids>");
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

// ─── flair rem candidates ─────────────────────────────────────────────────────
// Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists staged distillations from the
// MemoryCandidate table. Empty until the nightly cycle (later slice) starts
// populating. Per spec § 5: candidates are NEVER auto-promoted; this command
// is the operator's review surface.

rem
  .command("candidates")
  .description("List staged memory candidates from the FLAIR-NIGHTLY-REM cycle (pending review)")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
  .option("--status <s>", "Filter by status: pending | promoted | rejected (default: pending)")
  .option("--json", "Output as JSON for scripting")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    const status = opts.status ?? "pending";
    const validStatuses = new Set(["pending", "promoted", "rejected"]);
    if (!validStatuses.has(status)) {
      console.error(`Error: --status must be one of: pending, promoted, rejected (got: ${status})`);
      process.exit(1);
    }

    if (!agentId) {
      console.error(`${render.icons.error} --agent is required (or set FLAIR_AGENT_ID)`);
      process.exit(1);
    }

    try {
      const result = await api("POST", "/MemoryCandidate/search_by_conditions", {
        operator: "and",
        conditions: [
          { search_attribute: "agentId", search_type: "equals", search_value: agentId },
          { search_attribute: "status", search_type: "equals", search_value: status },
        ],
        get_attributes: ["id", "claim", "generatedBy", "generatedAt", "status", "target", "reviewerId", "decidedAt", "supersedes"],
      });

      const candidates: any[] = Array.isArray(result) ? result : (result?.results ?? []);
      const mode = render.resolveOutputMode(opts);

      if (mode === "json") {
        console.log(render.asJSON({ agentId, status, count: candidates.length, candidates }));
        return;
      }

      const statusColor = status === "promoted" ? render.c.green : status === "rejected" ? render.c.red : render.c.yellow;
      console.log(
        `${render.wrap(render.c.bold, "REM candidates")}  ${render.wrap(render.c.dim, "—")} agent ${render.wrap(render.c.bold, agentId)} ${render.wrap(render.c.dim, "·")} ${render.wrap(statusColor, status)}`,
      );

      if (candidates.length === 0) {
        console.log(`\n${render.icons.info} ${render.wrap(render.c.dim, `No ${status} candidates.`)}`);
        if (status === "pending") {
          console.log(
            `${render.wrap(render.c.dim, "  Run")} flair rem nightly enable ${render.wrap(render.c.dim, "to start the nightly distillation cycle that populates this table.")}`,
          );
        }
        return;
      }

      candidates.sort((a, b) => String(b.generatedAt ?? "").localeCompare(String(a.generatedAt ?? "")));

      console.log();
      for (const c of candidates) {
        let tag: string;
        if (c.status === "promoted") {
          tag = `${render.wrap(render.c.green, "✓ promoted")} ${render.wrap(render.c.dim, "→")} ${render.wrap(render.c.bold, c.target ?? "?")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
        } else if (c.status === "rejected") {
          tag = `${render.wrap(render.c.red, "✗ rejected")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
        } else {
          tag = `${render.wrap(render.c.yellow, "○ pending")} ${render.wrap(render.c.dim, `— ${c.generatedBy ?? "?"} ${render.relativeTime(c.generatedAt)}`)}`;
        }
        console.log(`  ${render.wrap(render.c.dim, c.id)}  ${tag}`);
        console.log(`    ${c.claim}`);
        if (c.supersedes) {
          console.log(`    ${render.wrap(render.c.dim, `(supersedes ${c.supersedes} — recurring proposal)`)}`);
        }
        console.log("");
      }

      console.log(
        `${render.wrap(render.c.bold, String(candidates.length))} candidate${candidates.length > 1 ? "s" : ""}.`,
      );
      if (status === "pending") {
        console.log(`${render.wrap(render.c.dim, "Promote:")} flair rem promote <id> --rationale "<why>" --to (soul|memory)`);
        console.log(`${render.wrap(render.c.dim, "Reject: ")} flair rem reject <id> --reason "<why>"`);
      }
    } catch (err: any) {
      console.error(`${render.icons.error} ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem promote / reject helpers ──────────────────────────────────────
// Pure validators extracted for testability. The action callbacks below thread
// these through process.exit on failure; the helpers themselves are
// side-effect-free.

export function validatePromoteOpts(opts: { rationale?: string; to?: string; key?: string }): string | null {
  if (!opts.rationale || !opts.rationale.trim()) {
    return "--rationale is required (per spec § 5: no rubber-stamp)";
  }
  if (!opts.to || (opts.to !== "soul" && opts.to !== "memory")) {
    return "--to must be 'soul' or 'memory'";
  }
  if (opts.to === "soul" && (!opts.key || !opts.key.trim())) {
    return "--key is required when --to=soul (gives the Soul entry a meaningful identifier)";
  }
  return null;
}

export function validateRejectOpts(opts: { reason?: string }): string | null {
  if (!opts.reason || !opts.reason.trim()) {
    return "--reason is required";
  }
  return null;
}

/**
 * Decide whether a promote/reject action can proceed against a candidate's
 * current state, and what message to surface to the operator. Pure function;
 * action side effects happen in the CLI body after this returns ok.
 */
export function decideCandidateAction(
  candidate: { status?: string; target?: string; reviewerId?: string; decidedAt?: string } | null,
  action: "promote" | "reject",
): { ok: true } | { ok: false; severity: "error" | "info"; message: string } {
  if (!candidate) return { ok: false, severity: "error", message: "candidate not found" };
  const status = candidate.status;
  if (status === "promoted") {
    return action === "promote"
      ? { ok: false, severity: "error", message: `already promoted (target=${candidate.target}, reviewer=${candidate.reviewerId})` }
      : { ok: false, severity: "error", message: `already promoted; cannot reject after promotion` };
  }
  if (status === "rejected") {
    return action === "reject"
      ? { ok: false, severity: "info", message: `already rejected on ${candidate.decidedAt} by ${candidate.reviewerId}` }
      : { ok: false, severity: "error", message: `already rejected; use a fresh candidate or reset status manually` };
  }
  return { ok: true };
}

// ─── flair rem promote ───────────────────────────────────────────────────────
// Slice 2 of FLAIR-NIGHTLY-REM (ops-2qq). Promote a candidate to either Soul
// or persistent Memory. Both --rationale and --to are required (spec § 5: no
// rubber-stamp). When --to=soul, --key is also required so the resulting
// Soul row has a meaningful identifier.
//
// Trust-tier policy is enforced by the caller's authentication today (1.0):
// admin pass → any promote; agent key → can write to own Memory/Soul. Server-
// side trust-tier enforcement (endorsed agents → memory only, never soul) is
// scoped for slice 2b when agent-routed promotion lands. For now, the
// human-operator workflow is the supported path.

rem
  .command("promote")
  .description("Promote a memory candidate to Soul or persistent Memory (rationale required)")
  .argument("<candidate-id>", "MemoryCandidate id to promote")
  .option("--port <port>", "Harper HTTP port")
  .option("--rationale <text>", "Why this candidate is being promoted (required, no rubber-stamp)")
  .option("--to <target>", "Promotion target: 'soul' or 'memory'")
  .option("--key <key>", "Soul key (required when --to=soul; e.g. 'lessons', 'preference-X')")
  .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
  .action(async (candidateId, opts) => {
    const validationErr = validatePromoteOpts(opts);
    if (validationErr) {
      console.error(`Error: ${validationErr}`);
      process.exit(1);
    }
    const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";

    try {
      // Fetch the candidate
      const candidate = await api("GET", `/MemoryCandidate/${encodeURIComponent(candidateId)}`);
      const candidateData = (candidate && !candidate.error) ? candidate : null;
      const decision = decideCandidateAction(candidateData, "promote");
      if (!decision.ok) {
        const msg: string = (decision as { ok: false; message: string }).message;
        console.error(`Error: candidate ${candidateId} ${msg}`);
        process.exit(1);
      }

      const decidedAt = new Date().toISOString();

      // Write the resulting Soul or Memory entry
      if (opts.to === "memory") {
        const memId = `${candidate.agentId}-promoted-${Date.now()}`;
        const memWrite = await api("PUT", `/Memory/${encodeURIComponent(memId)}`, {
          id: memId,
          agentId: candidate.agentId,
          content: candidate.claim,
          durability: "persistent",
          tags: ["nightly-rem-promoted", `from:${candidateId}`],
          derivedFrom: candidate.sourceMemoryIds ?? [],
          promotionStatus: "approved",
          promotedAt: decidedAt,
          promotedBy: reviewerId,
          createdAt: decidedAt,
        });
        if (memWrite?.error) {
          console.error(`Error writing Memory: ${memWrite.error}`);
          process.exit(1);
        }
        console.log(`✅ Wrote Memory ${memId} (durability=persistent)`);
      } else {
        // soul
        const soulId = `${candidate.agentId}-${opts.key}`;
        const soulWrite = await api("PUT", `/Soul/${encodeURIComponent(soulId)}`, {
          id: soulId,
          agentId: candidate.agentId,
          key: opts.key,
          value: candidate.claim,
          priority: "standard",
          durability: "persistent",
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });
        if (soulWrite?.error) {
          console.error(`Error writing Soul: ${soulWrite.error}`);
          process.exit(1);
        }
        console.log(`✅ Wrote Soul ${soulId} (key=${opts.key})`);
      }

      // Update the candidate row
      const upd = await api("PUT", `/MemoryCandidate/${encodeURIComponent(candidateId)}`, {
        ...candidate,
        status: "promoted",
        target: opts.to,
        reviewerId,
        reviewRationale: opts.rationale,
        decidedAt,
      });
      if (upd?.error) {
        console.error(`Warning: candidate row update returned: ${upd.error}`);
      }
      console.log(`✅ Candidate ${candidateId} marked promoted → ${opts.to}, reviewer=${reviewerId}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem reject ────────────────────────────────────────────────────────
// Reject a candidate with a required --reason. Per spec § 5, rejected
// candidates retain full decision history so recurring proposals are visible
// via the supersedes chain.

rem
  .command("reject")
  .description("Reject a memory candidate with a required reason")
  .argument("<candidate-id>", "MemoryCandidate id to reject")
  .option("--port <port>", "Harper HTTP port")
  .option("--reason <text>", "Why this candidate is being rejected (required)")
  .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
  .action(async (candidateId, opts) => {
    const validationErr = validateRejectOpts(opts);
    if (validationErr) {
      console.error(`Error: ${validationErr}`);
      process.exit(1);
    }
    const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";

    try {
      const candidate = await api("GET", `/MemoryCandidate/${encodeURIComponent(candidateId)}`);
      const candidateData = (candidate && !candidate.error) ? candidate : null;
      const decision = decideCandidateAction(candidateData, "reject");
      if (!decision.ok) {
        const _d = decision as { ok: false; severity: "error" | "info"; message: string };
        if (_d.severity === "info") {
          console.log(`(candidate ${candidateId} ${_d.message})`);
          return;
        }
        console.error(`Error: candidate ${candidateId} ${_d.message}`);
        process.exit(1);
      }

      const decidedAt = new Date().toISOString();
      const upd = await api("PUT", `/MemoryCandidate/${encodeURIComponent(candidateId)}`, {
        ...candidate,
        status: "rejected",
        reviewerId,
        reviewRationale: opts.reason,
        decidedAt,
      });
      if (upd?.error) {
        console.error(`Error: candidate row update failed: ${upd.error}`);
        process.exit(1);
      }
      console.log(`✅ Candidate ${candidateId} rejected by ${reviewerId}`);
      console.log(`   Reason: ${opts.reason}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem nightly run-once ──────────────────────────────────────────────
// Slice 1 of FLAIR-NIGHTLY-REM § 3. Manually invokes the nightly cycle code
// path — same module the scheduler will call in PR-2. Useful for:
//   - First-time operators verifying the cycle works before turning on the
//     scheduled timer.
//   - The dry-run-first-run guard (spec § 10) when the scheduler isn't yet
//     installed.
//   - Debugging a stale snapshot or audit row.
//
// `nightly enable` / `disable` / `status` land in PR-2 (scheduler templates).

const remNightly = rem.command("nightly").description("Scheduled REM nightly cycle (manual trigger + scheduler management)");

// `enable` / `disable` / `status` — scheduler install/uninstall (slice-1 PR-2).
// macOS: writes ~/Library/LaunchAgents/dev.flair.rem.nightly.plist and bootstraps it.
// Linux: writes ~/.config/systemd/user/flair-rem-nightly.{timer,service} and enables the timer.
// Snapshot data and the audit log are preserved through enable/disable cycles.

remNightly
  .command("enable")
  .description("Install the nightly scheduler (launchd on macOS, systemd timer on Linux)")
  .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
  .option("--at <HH:MM>", "Local time to run nightly (default 03:00)", "03:00")
  .option("--flair-url <url>", "Flair HTTP URL the runner will hit (default http://127.0.0.1:<port>)")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("Error: --agent or FLAIR_AGENT_ID env required");
      process.exit(1);
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec(opts.at);
    if (!match) {
      console.error(`Error: --at must be HH:MM (got: ${opts.at})`);
      process.exit(1);
    }
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);

    const port = readPortFromConfig() ?? DEFAULT_PORT;
    const flairUrl = opts.flairUrl || process.env.FLAIR_URL || `http://127.0.0.1:${port}`;

    const { enableScheduler } = await import("./rem/scheduler.js");
    try {
      const r = enableScheduler({ agentId, flairUrl, hour, minute });
      console.log(`✅ REM nightly scheduler enabled (${r.platform})`);
      console.log(`   Schedule:    ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} local time`);
      console.log(`   Scheduler:   ${r.schedulerPath}`);
      console.log(`   Shim:        ${r.shimPath}`);
      console.log(`   Agent:       ${agentId}`);
      console.log(`   Flair URL:   ${flairUrl}`);
      if (r.loadResult) {
        if (r.loadResult.code === 0) {
          console.log(`   Load:        ${r.loadCommand.join(" ")} → ok`);
        } else {
          console.log(`   Load:        ${r.loadCommand.join(" ")} → code ${r.loadResult.code}`);
          if (r.loadResult.stderr) console.log(`     stderr: ${r.loadResult.stderr.trim()}`);
        }
      }
      console.log(`\nTip: run \`flair rem nightly run-once --dry-run\` to verify the cycle works`);
      console.log(`     before the first scheduled fire. Disable with \`flair rem nightly disable\`.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

remNightly
  .command("disable")
  .description("Remove the nightly scheduler (keeps snapshots + audit log)")
  .option("--remove-shim", "Also delete the ~/.flair/bin/flair-rem-nightly shim")
  .action(async (opts) => {
    const { disableScheduler } = await import("./rem/scheduler.js");
    try {
      const r = disableScheduler({ removeShim: !!opts.removeShim });
      if (r.removed.length === 0) {
        console.log(`(REM nightly scheduler was not installed on ${r.platform})`);
        return;
      }
      console.log(`✅ REM nightly scheduler disabled (${r.platform})`);
      console.log(`   Removed:`);
      for (const p of r.removed) console.log(`     ${p}`);
      if (r.unloadResult && r.unloadResult.code !== 0) {
        console.log(`   Unload:      ${r.unloadCommand.join(" ")} → code ${r.unloadResult.code}`);
        if (r.unloadResult.stderr) console.log(`     stderr: ${r.unloadResult.stderr.trim()}`);
      }
      console.log(`\nSnapshots at ~/.flair/snapshots/ and the audit log at`);
      console.log(`~/.flair/logs/rem-nightly.jsonl are preserved.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

remNightly
  .command("status")
  .description("Show whether the nightly scheduler is installed")
  .action(async () => {
    const { schedulerStatus } = await import("./rem/scheduler.js");
    try {
      const s = schedulerStatus();
      console.log(`REM nightly scheduler (${s.platform}):`);
      console.log(`  Installed:   ${s.installed ? "yes" : "no"}`);
      console.log(`  Scheduler:   ${s.schedulerPath}`);
      console.log(`  Shim:        ${s.shimPath}${s.shimExists ? "" : " (missing)"}`);
      if (!s.installed) {
        console.log(`\nEnable with: flair rem nightly enable --agent <id> [--at HH:MM]`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

remNightly
  .command("run-once")
  .description("Run one nightly cycle now (snapshot + log). Same code path the scheduler will use.")
  .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
  .option("--dry-run", "Log the row but skip the snapshot write")
  .action(async (opts) => {
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("Error: --agent or FLAIR_AGENT_ID env required");
      process.exit(1);
    }
    const { runNightlyCycle } = await import("./rem/runner.js");
    try {
      const result = await runNightlyCycle({
        agentId,
        flairVersion: __pkgVersion,
        apiCall: api,
        dryRun: !!opts.dryRun,
      });
      const row = result.logRow;
      console.log(`-- rem nightly run-once${opts.dryRun ? " (dry-run)" : ""} --`);
      console.log(`Agent:      ${agentId}`);
      console.log(`Status:     ${result.status}`);
      if (result.snapshotPath) {
        console.log(`Snapshot:   ${result.snapshotPath}`);
      }
      console.log(`Memories:   ${row.memoryCount ?? "—"}`);
      console.log(`Souls:      ${row.soulCount ?? "—"}`);
      console.log(`Pending:    ${row.pendingCandidates ?? "—"}`);
      if (typeof row.archived === "number" || typeof row.expired === "number") {
        console.log(`Archived:   ${row.archived ?? "—"}`);
        console.log(`Expired:    ${row.expired ?? "—"}`);
      }
      console.log(`Duration:   ${row.durationMs}ms`);
      if (row.errors.length > 0) {
        console.log(`Errors:`);
        for (const e of row.errors) console.log(`  - ${e}`);
        process.exit(1);
      }
      if (result.status === "paused") {
        console.log(`\nNote: REM is paused (sentinel ~/.flair/rem.paused or FLAIR_REM_PAUSE env).`);
        console.log(`Resume with: flair rem resume`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem snapshot list ─────────────────────────────────────────────────
// Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists snapshot tarballs under
// ~/.flair/snapshots/<agent>/. Snapshot creation lives inside the nightly
// runner (and exposed via `flair rem nightly run-once`) — there is no
// user-facing `rem snapshot create` because that would invite operators to
// create snapshots out of sync with the audit log. The list is the surface.

const remSnapshot = rem.command("snapshot").description("REM nightly snapshots (tar.gz archives of agent memory + soul)");

remSnapshot
  .command("list")
  .description("List REM snapshots for an agent (or all agents)")
  .option("--agent <id>", "Filter to a single agent")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { listSnapshots } = await import("./rem/snapshot.js");
    const rows = listSnapshots(opts.agent);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("(no REM snapshots — ~/.flair/snapshots/ is empty or absent)");
      console.log("\nSnapshots are produced by the nightly cycle. Run `flair rem nightly run-once`");
      console.log("to generate one manually (slice 1).");
      return;
    }
    const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
    const fileW = Math.max(20, ...rows.map((r) => r.file.length));
    console.log(`  ${"agent".padEnd(agentW)}  ${"file".padEnd(fileW)}  size      age`);
    for (const r of rows) {
      console.log(`  ${r.agent.padEnd(agentW)}  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
    }
    console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
  });

// ─── flair rem restore <date> ────────────────────────────────────────────────
// Slice 1 + 2 of FLAIR-NIGHTLY-REM § 9.
//
// Default (no --apply): filesystem-only extract for inspection. Writes
//   memories.jsonl / soul.json / metadata.json to a target directory.
//   Harper state is unchanged.
//
// --apply: live replay. Reads the snapshot contents, takes a pre-restore
//   snapshot of the agent's CURRENT state (so this restore is itself
//   reversible), then DELETEs current memories/souls for the agent and PUTs
//   the snapshot's rows back. Per-row failures are captured per-row; the
//   pre-restore snapshot's path is reported so operator can roll back if
//   something goes wrong mid-flight.
//
// The <date> argument is an ISO-timestamp prefix or date-only prefix; the
// command picks the latest snapshot matching that prefix.

rem
  .command("restore <date>")
  .description("Restore from a REM snapshot (inspect by default; --apply rewinds Harper state)")
  .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
  .option("--target <dir>", "Directory to extract into (default: <snapshot>.restored, only used without --apply)")
  .option("--dry-run", "Plan-only — list contents or planned counts without writing")
  .option("--apply", "Live replay: rewind Harper state to the snapshot (irreversible without the pre-restore snapshot)")
  .action(async (date, opts) => {
    const { listSnapshots, extractSnapshot } = await import("./rem/snapshot.js");
    const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
    if (!agentId) {
      console.error("Error: --agent or FLAIR_AGENT_ID env required");
      process.exit(1);
    }
    let rows;
    try {
      rows = listSnapshots(agentId);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const matches = rows.filter((r) => r.file.startsWith(date));
    if (matches.length === 0) {
      console.error(`Error: no snapshot found for agent '${agentId}' matching date '${date}'`);
      if (rows.length > 0) {
        console.error(`  Available: ${rows.slice(0, 5).map((r) => r.file.replace(/\.tar\.gz$/, "")).join(", ")}`);
      } else {
        console.error(`  No snapshots exist for ${agentId}. Run \`flair rem nightly run-once\` to create one.`);
      }
      process.exit(1);
    }
    // listSnapshots returns descending by mtime, so matches[0] is the newest
    // snapshot for the date prefix.
    const match = matches[0];

    // --apply path: live replay via src/rem/restore.ts
    if (opts.apply) {
      const { applySnapshot } = await import("./rem/restore.js");
      try {
        const result = await applySnapshot({
          agentId,
          snapshotPath: match.path,
          flairVersion: __pkgVersion,
          apiCall: api,
          dryRun: !!opts.dryRun,
        });
        const verb = opts.dryRun ? "(dry-run) would" : "";
        console.log(`${opts.dryRun ? "(dry-run) " : ""}flair rem restore --apply${opts.dryRun ? "" : ""}`);
        console.log(`  Status:       ${result.status}`);
        console.log(`  Snapshot:     ${match.path}`);
        if (result.preRestoreSnapshotPath) {
          console.log(`  Pre-restore:  ${result.preRestoreSnapshotPath}`);
          console.log(`                (rollback: flair rem restore <pre-restore-date> --agent ${agentId} --apply)`);
        }
        console.log(`  Deleted:      ${result.deleted.memories} memories, ${result.deleted.souls} souls`);
        console.log(`  Restored:     ${result.restored.memories} memories, ${result.restored.souls} souls`);
        if (result.errors.length > 0) {
          console.log(`  Errors:`);
          for (const e of result.errors) console.log(`    - ${e}`);
        }
        if (result.status === "failed") process.exit(1);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    // Default: filesystem extract.
    try {
      const result = await extractSnapshot({
        snapshotPath: match.path,
        targetDir: opts.target,
        dryRun: !!opts.dryRun,
      });
      if (opts.dryRun) {
        console.log(`(dry-run) snapshot: ${match.path}`);
        for (const e of result.entries) {
          console.log(`  ${e.path}  (${humanBytes(e.size)})`);
        }
        return;
      }
      console.log(`✅ Extracted: ${match.path}`);
      console.log(`   To:        ${result.targetDir}`);
      for (const e of result.entries) {
        console.log(`     ${e.path}  (${humanBytes(e.size)})`);
      }
      console.log(`\nNote: this is a filesystem extract — Harper state is unchanged.`);
      console.log(`To actually rewind state, re-run with --apply.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair rem pause / resume ────────────────────────────────────────────────
// Slice 1 of FLAIR-NIGHTLY-REM § 9. The pause sentinel is checked by the
// nightly runner before any side effects. Env-var FLAIR_REM_PAUSE=1 is also
// honored — lets ops pause fleet-wide without writing a file.

const REM_PAUSE_FLAG = resolve(homedir(), ".flair", "rem.paused");

rem
  .command("pause")
  .description("Pause nightly REM runs — writes ~/.flair/rem.paused sentinel")
  .action(() => {
    const dir = dirname(REM_PAUSE_FLAG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(REM_PAUSE_FLAG, new Date().toISOString() + "\n", { mode: 0o600 });
    console.log(`✅ REM nightly runs paused (sentinel: ${REM_PAUSE_FLAG})`);
    console.log(`   Resume with: flair rem resume`);
  });

rem
  .command("resume")
  .description("Resume nightly REM runs — removes the pause sentinel")
  .action(() => {
    if (existsSync(REM_PAUSE_FLAG)) {
      rmSync(REM_PAUSE_FLAG);
      console.log(`✅ REM nightly runs resumed (removed ${REM_PAUSE_FLAG})`);
    } else {
      console.log(`(REM was not paused — no sentinel at ${REM_PAUSE_FLAG})`);
    }
    if (process.env.FLAIR_REM_PAUSE === "1") {
      console.log(`\n⚠ FLAIR_REM_PAUSE=1 env var is also set; unset it to fully resume.`);
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

// Common localhost ports a running Flair daemon might be on. Used by
// discoverLocalFlairPort when the configured URL is unreachable, to detect
// config-vs-daemon port drift. Order is ad-hoc — first hit wins.
//
// 9926: original default (long-running early installs predate the bump)
// 19926: current default (DEFAULT_PORT)
// 19925: ops-anvil VM secondary
const LOCAL_FLAIR_PROBE_PORTS = [9926, 19926, 19925];

export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // URL.hostname keeps brackets around IPv6 (e.g. "[::1]") so match both forms.
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]"
    );
  } catch { return false; }
}

/**
 * When a configured-localhost URL is unreachable, probe a small candidate-port
 * set to detect a daemon listening on a different port (config drift). Returns
 * the first responsive port, or null if none. Excludes the original port from
 * the probe set so we don't repeat the failed call.
 *
 * Runs sequentially with a 500ms timeout per probe — typical 3-port sweep
 * completes in <1.5s on a healthy box, faster on an unhealthy one.
 */
export async function discoverLocalFlairPort(originalUrl: string): Promise<number | null> {
  if (!isLocalhostUrl(originalUrl)) return null;
  let originalPort: number | null = null;
  try { originalPort = Number(new URL(originalUrl).port) || null; } catch { /* ignore */ }
  for (const port of LOCAL_FLAIR_PROBE_PORTS) {
    if (port === originalPort) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(500) });
      // Treat 401 (auth required) the same as 200 — the daemon is alive,
      // we just can't see /Health without admin auth. The point is to detect
      // "something is listening" not "we have full access".
      if (res.ok || res.status === 401) return port;
    } catch { /* port not listening, try next */ }
  }
  return null;
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

    // When unreachable on a localhost URL, probe candidate ports to detect
    // config-vs-daemon port drift. Surface the actually-listening
    // port with a fix recipe — better UX than just "unreachable."
    let discoveredPort: number | null = null;
    if (!healthy && isLocalhostUrl(baseUrl)) {
      discoveredPort = await discoverLocalFlairPort(baseUrl);
    }

    // Version-behind check (flair#587) — offline-tolerant + cached, so this
    // never adds meaningful latency or fails `status` when the registry is
    // unreachable. Independent of Harper health; runs either way.
    const versionCheckResult = await checkVersion(__pkgVersion);
    const versionNudge = formatVersionNudge(versionCheckResult);

    if (opts.json) {
      const out: any = { healthy, url: baseUrl, flairVersion: __pkgVersion, ...healthData };
      if (discoveredPort != null) out.discoveredPort = discoveredPort;
      if (versionCheckResult.latest) out.latestVersion = versionCheckResult.latest;
      console.log(JSON.stringify(out, null, 2));
      if (!healthy) process.exit(1);
      return;
    }

    if (!healthy) {
      console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
      console.log(`  URL:  ${baseUrl}`);
      if (discoveredPort != null) {
        const altUrl = `http://127.0.0.1:${discoveredPort}`;
        console.log(`\n  ⚠ Found a Flair daemon listening on port ${discoveredPort} (URL: ${altUrl}).`);
        console.log(`    Your config points at ${baseUrl} — drift detected.`);
        console.log(`\n  Quick fix: FLAIR_URL=${altUrl} flair status`);
        console.log(`  Permanent fix: edit ~/.flair/config.yaml to set port: ${discoveredPort}`);
        console.log(`  Or: flair doctor (when port-drift detection lands there)`);
      } else {
        console.log(`\n  Run: flair start  or  flair doctor`);
      }
      if (versionNudge) {
        const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
        console.log(`\n  ${render.wrap(color, "⚠")} ${render.wrap(color, versionNudge.message)}`);
      }
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
    const headerIcon = hasWarn ? render.icons.warn : render.icons.ok;

    const versionStr = render.wrap(render.c.bold, `Flair v${__pkgVersion}`);
    const runStatus = `${headerIcon} ${render.wrap(render.c.green, "running")}`;
    const pidPart = pid ? render.wrap(render.c.dim, `PID ${pid}`) : "";
    const uptimePart = uptimeStr ? render.wrap(render.c.dim, `uptime ${uptimeStr}`) : "";
    const metaParts = [pidPart, uptimePart].filter(Boolean).join(render.wrap(render.c.dim, " · "));
    console.log(`${versionStr} ${render.wrap(render.c.dim, "—")} ${runStatus}${metaParts ? `  ${metaParts}` : ""}`);
    console.log(render.kv("URL", baseUrl));

    if (versionNudge) {
      const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
      console.log(`\n  ${render.wrap(color, "⚠")} ${render.wrap(color, versionNudge.message)}`);
    }

    if (scopedWarnings.length > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Warnings")}  ${render.wrap(render.c.dim, `(${scopedWarnings.length})`)}`);
      for (const w of scopedWarnings) {
        const icon = w.level === "warn" ? render.icons.warn : render.icons.info;
        console.log(`  ${icon} ${w.message}`);
      }
    }

    if (memories) {
      console.log(`\n${render.wrap(render.c.bold, "Memory")}`);
      const embStr = memories.withEmbeddings > 0 ? `${memories.withEmbeddings} embedded` : "";
      const hashStr = memories.hashFallback > 0 ? `${memories.hashFallback} hash` : "";
      const detail = [embStr, hashStr].filter(Boolean).join(", ");
      console.log(render.kv("Total", `${render.wrap(render.c.bold, String(memories.total))}${detail ? ` ${render.wrap(render.c.dim, `(${detail})`)}` : ""}`));
      if (memories.modelCounts && typeof memories.modelCounts === "object") {
        const entries = Object.entries(memories.modelCounts as Record<string, number>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length > 0) {
          const formatted = entries.map(([k, n]) => `${render.wrap(render.c.cyan, k)}:${n}`).join(render.wrap(render.c.dim, ", "));
          console.log(render.kv("Embeddings", formatted));
        }
      }
      if (memories.byDurability) {
        const d = memories.byDurability;
        const parts = [
          `${render.wrap(render.c.magenta, "permanent")}:${d.permanent ?? 0}`,
          `${render.wrap(render.c.blue, "persistent")}:${d.persistent ?? 0}`,
          `${render.wrap(render.c.cyan, "standard")}:${d.standard ?? 0}`,
          `${render.wrap(render.c.gray, "ephemeral")}:${d.ephemeral ?? 0}`,
        ];
        console.log(render.kv("Durability", parts.join(render.wrap(render.c.dim, " · "))));
      }
      if (typeof memories.archived === "number") console.log(render.kv("Archived", String(memories.archived)));
      if (typeof memories.expired === "number" && memories.expired > 0) {
        console.log(render.kv("Expired", `${render.wrap(render.c.yellow, String(memories.expired))}`));
      }
      if (healthData?.lastWrite) console.log(render.kv("Last write", render.relativeTime(healthData.lastWrite)));
    }

    if (agents && agents.count > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Agents")}`);
      const nameStr = agents.names?.length > 0 ? ` ${render.wrap(render.c.dim, "—")} ${agents.names.join(render.wrap(render.c.dim, ", "))}` : "";
      console.log(render.kv("Total", `${render.wrap(render.c.bold, String(agents.count))}${nameStr}`));
      if (agents.count > 1 && Array.isArray(agents.perAgent) && agents.perAgent.length > 0) {
        const hasDeep = agents.perAgent.some(
          (r: any) => typeof r.hashFallback === "number" || typeof r.writes24h === "number",
        );
        const cols: render.TableColumn[] = hasDeep
          ? [
              { label: "id", key: "id" },
              { label: "memories", key: "memoryCount", align: "right" },
              { label: "hash_fb", key: "hashFallback", align: "right", format: (v) => (typeof v === "number" ? String(v) : "—") },
              { label: "24h", key: "writes24h", align: "right", format: (v) => (typeof v === "number" ? String(v) : "—") },
              { label: "last_write", key: "lastWriteAt", format: (v) => render.relativeTime(v as string | null) },
            ]
          : [
              { label: "id", key: "id" },
              { label: "memories", key: "memoryCount", align: "right" },
              { label: "last_write", key: "lastWriteAt", format: (v) => render.relativeTime(v as string | null) },
            ];
        console.log(render.table(cols, agents.perAgent as Array<Record<string, unknown>>));
      }
    }

    if (healthData?.relationships) {
      const r = healthData.relationships;
      console.log(`\n${render.wrap(render.c.bold, "Relationships")}`);
      console.log(render.kv("Total", `${r.total}  ${render.wrap(render.c.dim, `(${r.active} active)`)}`));
    }

    if (healthData?.soul && healthData.soul.total > 0) {
      const s = healthData.soul;
      console.log(`\n${render.wrap(render.c.bold, "Soul")}`);
      const entries = sortSoulKeyEntries(s.byKey ?? {});
      const parts = entries.map(([k, n]) => `${render.wrap(render.c.cyan, k)}:${n}`);
      const suffix = parts.length > 0
        ? ` ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`
        : "";
      console.log(render.kv("Entries", `${render.wrap(render.c.bold, String(s.total))}${suffix}`));
    } else if (typeof healthData?.soulEntries === "number" && healthData.soulEntries > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Soul")}`);
      console.log(render.kv("Entries", String(healthData.soulEntries)));
    }

    if (healthData?.rem) {
      const r = healthData.rem;
      console.log(`\n${render.wrap(render.c.bold, "REM")}`);
      if (r.lastLightAt) console.log(render.kv("Last light", render.relativeTime(r.lastLightAt)));
      if (r.lastRapidAt) console.log(render.kv("Last rapid", render.relativeTime(r.lastRapidAt)));
      if (r.lastRestorativeAt) console.log(render.kv("Last restorative", render.relativeTime(r.lastRestorativeAt)));
      const nightlyTxt = r.nightlyEnabled === true
        ? render.wrap(render.c.green, "enabled")
        : r.nightlyEnabled === false
          ? render.wrap(render.c.dim, "disabled")
          : render.wrap(render.c.dim, "unknown");
      console.log(render.kv("Nightly", nightlyTxt));
      if (r.nightlyEnabled && r.lastNightlyAt) console.log(render.kv("Last nightly", render.relativeTime(r.lastNightlyAt)));
      if (typeof r.pendingCandidates === "number" && r.pendingCandidates > 0) {
        console.log(render.kv("Pending candidates", render.wrap(render.c.yellow, String(r.pendingCandidates))));
      }
    }

    if (healthData?.federation) {
      const f = healthData.federation;
      console.log(`\n${render.wrap(render.c.bold, "Federation")}`);
      if (f.instance) {
        const statusColor = f.instance.status === "active" ? render.c.green : render.c.yellow;
        console.log(render.kv("Instance", `${f.instance.id}  ${render.wrap(render.c.dim, "(")}${f.instance.role ?? "—"}${render.wrap(render.c.dim, ", ")}${render.wrap(statusColor, f.instance.status ?? "—")}${render.wrap(render.c.dim, ")")}`));
      }
      if (f.peers) {
        const connColor = f.peers.connected > 0 ? render.c.green : render.c.dim;
        const downColor = f.peers.disconnected > 0 ? render.c.yellow : render.c.dim;
        const revColor = f.peers.revoked > 0 ? render.c.red : render.c.dim;
        const parts = [
          `${render.wrap(connColor, `${f.peers.connected} connected`)}`,
          `${render.wrap(downColor, `${f.peers.disconnected} down`)}`,
          `${render.wrap(revColor, `${f.peers.revoked} revoked`)}`,
        ];
        console.log(render.kv("Peers", `${render.wrap(render.c.bold, String(f.peers.total))} ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`));
      }
      if (f.pendingTokens > 0) console.log(render.kv("Pairing", `${render.wrap(render.c.yellow, String(f.pendingTokens))} unconsumed token(s)`));
    } else {
      console.log(`\n${render.wrap(render.c.bold, "Federation")}  ${render.wrap(render.c.dim, "not configured")}`);
    }

    if (healthData?.oauth) {
      const lines = oauthSummaryLines(healthData.oauth);
      // Tweak the "OAuth:" header to bold; downstream lines are aligned k/v which already look fine
      for (const line of lines) {
        if (line.trim() === "OAuth:") console.log(`\n${render.wrap(render.c.bold, "OAuth")}`);
        else console.log(line);
      }
    }

    if (healthData?.bridges) {
      const b = healthData.bridges;
      console.log(`\n${render.wrap(render.c.bold, "Bridges")}`);
      if (Array.isArray(b.installed) && b.installed.length > 0) console.log(render.kv("Installed", b.installed.join(render.wrap(render.c.dim, ", "))));
      if (b.lastImport) console.log(render.kv("Last import", render.relativeTime(b.lastImport)));
      if (b.lastExport) console.log(render.kv("Last export", render.relativeTime(b.lastExport)));
    } else {
      console.log(`\n${render.wrap(render.c.bold, "Bridges")}  ${render.wrap(render.c.dim, "none installed")}`);
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log(`\n${render.wrap(render.c.bold, "Disk")}`);
      console.log(render.kv("Data", `${render.wrap(render.c.dim, d.dataDir)} ${render.wrap(render.c.dim, "—")} ${render.wrap(render.c.bold, render.humanBytes(d.dataBytes ?? 0))}`));
      console.log(render.kv("Snapshots", `${render.wrap(render.c.dim, d.snapshotDir)} ${render.wrap(render.c.dim, "—")} ${render.wrap(render.c.bold, render.humanBytes(d.snapshotBytes ?? 0))}`));
    }

    console.log("");
    if (scopedWarnings.length > 0) {
      console.log(`  ${render.icons.warn} ${render.wrap(render.c.yellow, `${scopedWarnings.length} warning${scopedWarnings.length === 1 ? "" : "s"}`)}`);
    } else {
      console.log(`  ${render.icons.ok} ${render.wrap(render.c.green, "all checks passing")}`);
    }
  });

statusCmd
  .command("rem")
  .description("Show REM (memory hygiene) subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, rem: healthData?.rem ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const r = healthData?.rem;
    if (!r) {
      console.log(`${render.wrap(render.c.bold, "REM")}  ${render.wrap(render.c.dim, "not configured (no log entries or platform timers found)")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "REM"));
    console.log(render.kv("Last light", render.relativeTime(r.lastLightAt), 18));
    console.log(render.kv("Last rapid", render.relativeTime(r.lastRapidAt), 18));
    console.log(render.kv("Last restorative", render.relativeTime(r.lastRestorativeAt), 18));
    const nightlyTxt = r.nightlyEnabled === true
      ? render.wrap(render.c.green, "enabled")
      : r.nightlyEnabled === false
        ? render.wrap(render.c.dim, "disabled")
        : render.wrap(render.c.dim, "unknown");
    console.log(render.kv("Nightly", nightlyTxt, 18));
    if (r.lastNightlyAt) {
      console.log(render.kv("Last nightly", `${render.relativeTime(r.lastNightlyAt)} ${render.wrap(render.c.dim, `(${r.lastNightlyAt})`)}`, 18));
    }
    if (typeof r.pendingCandidates === "number") {
      const pendingColor = r.pendingCandidates > 0 ? render.c.yellow : render.c.dim;
      console.log(render.kv("Pending candidates", render.wrap(pendingColor, String(r.pendingCandidates)), 18));
    } else {
      console.log(render.kv("Pending candidates", render.wrap(render.c.dim, "— (schema not available)"), 18));
    }
  });

statusCmd
  .command("federation")
  .description("Show federation subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, federation: healthData?.federation ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const f = healthData?.federation;
    if (!f) {
      console.log(`${render.wrap(render.c.bold, "Federation")}  ${render.wrap(render.c.dim, "not configured")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "Federation"));
    if (f.instance) {
      const statusColor = f.instance.status === "active" ? render.c.green : render.c.yellow;
      console.log(render.kv("Instance", `${f.instance.id}  ${render.wrap(render.c.dim, "(")}${f.instance.role ?? "—"}${render.wrap(render.c.dim, ", ")}${render.wrap(statusColor, f.instance.status ?? "—")}${render.wrap(render.c.dim, ")")}`));
    } else {
      console.log(render.kv("Instance", render.wrap(render.c.dim, "—")));
    }
    if (f.peers) {
      const connColor = f.peers.connected > 0 ? render.c.green : render.c.dim;
      const downColor = f.peers.disconnected > 0 ? render.c.yellow : render.c.dim;
      const revColor = f.peers.revoked > 0 ? render.c.red : render.c.dim;
      const parts = [
        render.wrap(connColor, `${f.peers.connected} connected`),
        render.wrap(downColor, `${f.peers.disconnected} down`),
        render.wrap(revColor, `${f.peers.revoked} revoked`),
      ];
      console.log(render.kv("Peers", `${render.wrap(render.c.bold, String(f.peers.total))} ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`));
    }
    if (typeof f.pendingTokens === "number" && f.pendingTokens > 0) {
      console.log(render.kv("Pairing", `${render.wrap(render.c.yellow, String(f.pendingTokens))} unconsumed token(s)`));
    }
    if (Array.isArray(f.peerList) && f.peerList.length > 0) {
      console.log();
      const cols: render.TableColumn[] = [
        { label: "peer", key: "id" },
        { label: "role", key: "role", format: (v) => String(v ?? "—") },
        {
          label: "status",
          key: "status",
          format: (v) => {
            const s = String(v ?? "—");
            const color = s === "paired" || s === "connected" ? render.c.green : s === "revoked" ? render.c.red : render.c.yellow;
            return render.wrap(color, s);
          },
        },
        {
          label: "last_sync",
          key: "lastSyncAt",
          format: (v) => {
            const iso = v as string | null;
            if (!iso) return render.wrap(render.c.dim, "never");
            return `${render.relativeTime(iso)} ${render.wrap(render.c.dim, `(${iso})`)}`;
          },
        },
      ];
      console.log(render.table(cols, f.peerList as Array<Record<string, unknown>>));
    }
  });

statusCmd
  .command("auth")
  .description("Show OAuth / IdP subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, oauth: healthData?.oauth ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const o = healthData?.oauth;
    if (!o) {
      console.log(`${render.wrap(render.c.bold, "OAuth")}  ${render.wrap(render.c.dim, "not configured")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "OAuth"));
    console.log(render.kv("Clients", render.wrap(render.c.bold, String(Number(o?.clients ?? 0)))));
    console.log(render.kv("IdP configs", String(Number(o?.idpConfigs ?? 0))));
    const tokenColor = Number(o?.activeTokens ?? 0) > 0 ? render.c.green : render.c.dim;
    console.log(render.kv("Active tokens", render.wrap(tokenColor, String(Number(o?.activeTokens ?? 0)))));
    if (Array.isArray(o?.clientList) && o.clientList.length > 0) {
      console.log(`\n  ${render.wrap(render.c.dim, "Clients")}`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id" },
        { label: "name", key: "name", format: (v) => String(v ?? "—") },
        { label: "registered_by", key: "registeredBy", format: (v) => String(v ?? "—") },
        { label: "created_at", key: "createdAt", format: (v) => String(v ?? "—") },
      ];
      console.log(render.table(cols, o.clientList as Array<Record<string, unknown>>));
    }
    if (Array.isArray(o?.idpList) && o.idpList.length > 0) {
      console.log(`\n  ${render.wrap(render.c.dim, "IdPs")}`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id" },
        { label: "name", key: "name", format: (v) => String(v ?? "—") },
        { label: "issuer", key: "issuer", format: (v) => String(v ?? "—") },
      ];
      console.log(render.table(cols, o.idpList as Array<Record<string, unknown>>));
    }
  });

statusCmd
  .command("bridges")
  .description("Show memory bridges subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, bridges: healthData?.bridges ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const b = healthData?.bridges;
    if (!b) {
      console.log(`${render.wrap(render.c.bold, "Bridges")}  ${render.wrap(render.c.dim, "none installed (no flair-bridge-* packages found)")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "Bridges"));
    if (Array.isArray(b.installed) && b.installed.length > 0) {
      console.log(render.kv("Installed", b.installed.join(render.wrap(render.c.dim, ", "))));
    }
    if (b.lastImport) console.log(render.kv("Last import", render.relativeTime(b.lastImport)));
    if (b.lastExport) console.log(render.kv("Last export", render.relativeTime(b.lastExport)));
  });

// ─── flair status --deep ──────────────────────────────────────────────────────
//
// Deeper observability than the default `flair status` summary — full
// per-section detail with no condensing. Optional --bootstrap measures
// cold-start context bytes per agent (slow; calls /MemoryBootstrap once per
// agent, admin-auth required).
//
// Addresses ops-yph: Nathan's 2026-04-22 ask for "how much storage does my
// memory take, how much context are bootstraps pulling, what's the real usage
// pattern" — questions the default `flair status` summarizes but doesn't
// surface in full. Agents should be able to self-audit via this too.

statusCmd
  .command("deep")
  .description("Verbose status + optional bootstrap context size per agent (ops-yph)")
  .option("--bootstrap", "Also measure bootstrap context bytes per agent (slow; admin auth required)")
  .option("--max-tokens <n>", "Bootstrap maxTokens cap when --bootstrap is set", "4000")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, baseUrl, healthData } = await fetchHealthDetail(opts);

    if (!healthy) {
      if (opts.json) {
        console.log(JSON.stringify({ healthy: false, url: baseUrl, error: "unreachable" }, null, 2));
      } else {
        console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
        console.log(`  URL:  ${baseUrl}`);
        console.log(`\n  Run: flair start  or  flair doctor`);
      }
      process.exit(1);
    }

    // Optional: per-agent bootstrap context bytes. Calls /MemoryBootstrap with
    // admin auth (so we can measure on behalf of any agent without holding
    // their keys). 15s timeout per call — bootstrap can be expensive on cold
    // caches or large memory sets.
    const agentList: string[] =
      (Array.isArray(healthData?.agents?.names) && healthData.agents.names.length > 0
        ? healthData.agents.names
        : Array.isArray(healthData?.agents?.perAgent)
          ? healthData.agents.perAgent.map((r: any) => r.id).filter(Boolean)
          : []) as string[];
    const bootstrapBytes: Record<string, { bytes: number; tokenEstimate?: number; memoriesIncluded?: number; error?: string }> = {};
    if (opts.bootstrap && agentList.length > 0) {
      const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS;
      if (!adminPass) {
        if (!opts.json) {
          console.log("⚠ --bootstrap requires HDB_ADMIN_PASSWORD or FLAIR_ADMIN_PASS env var");
        }
      } else {
        const auth = `Basic ${Buffer.from(`${DEFAULT_ADMIN_USER}:${adminPass}`).toString("base64")}`;
        const maxTokens = Number.parseInt(String(opts.maxTokens ?? "4000"), 10);
        for (const agentId of agentList) {
          try {
            const res = await fetch(`${baseUrl}/BootstrapMemories`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: auth },
              body: JSON.stringify({ agentId, maxTokens }),
              signal: AbortSignal.timeout(15000),
            });
            const text = await res.text();
            const bytes = Buffer.byteLength(text, "utf8");
            let tokenEstimate: number | undefined;
            let memoriesIncluded: number | undefined;
            try {
              const json = JSON.parse(text);
              tokenEstimate = typeof json.tokenEstimate === "number" ? json.tokenEstimate : undefined;
              memoriesIncluded = typeof json.memoriesIncluded === "number" ? json.memoriesIncluded : undefined;
            } catch { /* response wasn't JSON; bytes still valid */ }
            if (!res.ok) {
              bootstrapBytes[agentId] = { bytes, error: `HTTP ${res.status}` };
            } else {
              bootstrapBytes[agentId] = { bytes, tokenEstimate, memoriesIncluded };
            }
          } catch (e: any) {
            bootstrapBytes[agentId] = { bytes: 0, error: e?.message ?? String(e) };
          }
        }
      }
    }

    if (opts.json) {
      const out: Record<string, any> = { healthy, url: baseUrl, flairVersion: __pkgVersion, ...healthData };
      if (opts.bootstrap) out.bootstrapBytes = bootstrapBytes;
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // Human-readable verbose render.
    const uptimeSec = healthData?.uptimeSeconds;
    let uptimeStr = "";
    if (uptimeSec != null) {
      const d = Math.floor(uptimeSec / 86400);
      const h = Math.floor((uptimeSec % 86400) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      uptimeStr = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    const pid = healthData?.pid ?? "?";

    console.log(`Flair v${__pkgVersion} — running (PID ${pid}${uptimeStr ? `, uptime ${uptimeStr}` : ""})`);
    console.log(`URL: ${baseUrl}`);

    const memories = healthData?.memories;
    if (memories) {
      console.log("\n═══ Memory ═══════════════════════════════════════");
      console.log(`Total:        ${memories.total}`);
      console.log(`Breakdown:    ${memories.withEmbeddings ?? 0} embedded, ${memories.hashFallback ?? 0} hash-fallback`);
      if (memories.modelCounts && memories.total > 0) {
        const entries = Object.entries(memories.modelCounts as Record<string, number>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        for (const [k, n] of entries) {
          const pct = ((n / memories.total) * 100).toFixed(1);
          console.log(`  ${k.padEnd(28)} ${String(n).padStart(6)}  (${pct}%)`);
        }
      }
      if (memories.byDurability) {
        const d = memories.byDurability;
        console.log(`Durability:   ${d.permanent ?? 0} permanent / ${d.persistent ?? 0} persistent / ${d.standard ?? 0} standard / ${d.ephemeral ?? 0} ephemeral`);
      }
      console.log(`Archived:     ${memories.archived ?? 0}`);
      console.log(`Expired:      ${memories.expired ?? 0}`);
      if (healthData?.lastWrite) console.log(`Last write:   ${relativeTime(healthData.lastWrite)} (${healthData.lastWrite})`);
    }

    const agents = healthData?.agents;
    if (agents && agents.count > 0) {
      console.log("\n═══ Agents ═══════════════════════════════════════");
      console.log(`Total:        ${agents.count}`);
      if (Array.isArray(agents.names) && agents.names.length > 0) {
        console.log(`Names:        ${agents.names.join(", ")}`);
      }
      if (Array.isArray(agents.perAgent) && agents.perAgent.length > 0) {
        const idW = Math.max(2, ...agents.perAgent.map((r: any) => (r.id ?? "").length));
        console.log(`\n  ${"id".padEnd(idW)}  memories  hash_fb  24h  last_write`);
        for (const r of agents.perAgent) {
          const fb = typeof r.hashFallback === "number" ? String(r.hashFallback) : "—";
          const w24 = typeof r.writes24h === "number" ? String(r.writes24h) : "—";
          console.log(
            `  ${(r.id ?? "").padEnd(idW)}  ${String(r.memoryCount).padStart(8)}  ${fb.padStart(7)}  ${w24.padStart(3)}  ${relativeTime(r.lastWriteAt)}`,
          );
        }
      }
    }

    // Bootstrap context section — always printed so users see how to opt in.
    console.log("\n═══ Bootstrap context ═══════════════════════════");
    if (!opts.bootstrap) {
      console.log("  (not measured — pass --bootstrap to fetch per-agent context bytes)");
    } else if (Object.keys(bootstrapBytes).length === 0) {
      console.log("  (no agents found, or admin pass missing — see HDB_ADMIN_PASSWORD)");
    } else {
      const idW = Math.max(5, ...Object.keys(bootstrapBytes).map((id) => id.length));
      console.log(`  ${"agent".padEnd(idW)}  ${"bytes".padStart(9)}  ${"~tokens".padStart(7)}  ${"mems".padStart(4)}  status`);
      // Sort by bytes desc so heaviest bootstraps surface first.
      const sortedEntries = Object.entries(bootstrapBytes).sort(
        (a, b) => (b[1].bytes ?? 0) - (a[1].bytes ?? 0),
      );
      for (const [agentId, info] of sortedEntries) {
        const bytesStr = info.error ? "error" : humanBytes(info.bytes);
        const tok = info.tokenEstimate != null ? String(info.tokenEstimate) : "—";
        const mems = info.memoriesIncluded != null ? String(info.memoriesIncluded) : "—";
        const status = info.error ? info.error.slice(0, 40) : "ok";
        console.log(`  ${agentId.padEnd(idW)}  ${bytesStr.padStart(9)}  ${tok.padStart(7)}  ${mems.padStart(4)}  ${status}`);
      }
    }

    if (healthData?.relationships) {
      const r = healthData.relationships;
      console.log("\n═══ Relationships ═══════════════════════════════");
      console.log(`Total:        ${r.total} (${r.active} active)`);
    }

    if (healthData?.soul && healthData.soul.total > 0) {
      const s = healthData.soul;
      console.log("\n═══ Soul ═════════════════════════════════════════");
      console.log(`Total:        ${s.total} entries`);
      const entries = sortSoulKeyEntries(s.byKey ?? {});
      if (entries.length > 0) {
        console.log(`Keys:         ${entries.map(([k, n]) => `${n} ${k}`).join(" / ")}`);
      }
    } else if (typeof healthData?.soulEntries === "number" && healthData.soulEntries > 0) {
      console.log("\n═══ Soul ═════════════════════════════════════════");
      console.log(`Total:        ${healthData.soulEntries} entries`);
    }

    if (healthData?.rem) {
      const r = healthData.rem;
      console.log("\n═══ REM ══════════════════════════════════════════");
      console.log(`Last light:        ${relativeTime(r.lastLightAt)}`);
      console.log(`Last rapid:        ${relativeTime(r.lastRapidAt)}`);
      console.log(`Last restorative:  ${relativeTime(r.lastRestorativeAt)}`);
      const nightly = r.nightlyEnabled === true ? "enabled" : r.nightlyEnabled === false ? "disabled" : "unknown";
      console.log(`Nightly:           ${nightly}`);
      if (r.lastNightlyAt) console.log(`Last nightly:      ${relativeTime(r.lastNightlyAt)} (${r.lastNightlyAt})`);
      if (typeof r.pendingCandidates === "number") console.log(`Pending candidates: ${r.pendingCandidates}`);
    }

    if (healthData?.federation) {
      const f = healthData.federation;
      console.log("\n═══ Federation ═══════════════════════════════════");
      if (f.instance) console.log(`Instance:     ${f.instance.id} (${f.instance.role ?? "—"}, ${f.instance.status ?? "—"})`);
      if (f.peers) console.log(`Peers:        ${f.peers.total} total (${f.peers.connected} connected, ${f.peers.disconnected} down, ${f.peers.revoked} revoked)`);
      if (typeof f.pendingTokens === "number" && f.pendingTokens > 0) console.log(`Pairing:      ${f.pendingTokens} unconsumed token(s)`);
      if (Array.isArray(f.peerList) && f.peerList.length > 0) {
        const idW = Math.max(4, ...f.peerList.map((p: any) => (p.id ?? "").length));
        console.log(`\n  ${"peer".padEnd(idW)}  ${"role".padEnd(5)}  ${"status".padEnd(13)}  last_sync`);
        for (const p of f.peerList) {
          console.log(`  ${(p.id ?? "").padEnd(idW)}  ${(p.role ?? "—").padEnd(5)}  ${(p.status ?? "—").padEnd(13)}  ${p.lastSyncAt ? `${relativeTime(p.lastSyncAt)} (${p.lastSyncAt})` : "never"}`);
        }
      }
    } else {
      console.log("\n═══ Federation ═══════════════════════════════════");
      console.log("  not configured");
    }

    if (healthData?.oauth) {
      const o = healthData.oauth;
      console.log("\n═══ OAuth / IdP ══════════════════════════════════");
      console.log(`Clients:       ${o.clients}`);
      console.log(`IdP configs:   ${o.idpConfigs}`);
      console.log(`Active tokens: ${o.activeTokens}`);
      if (Array.isArray(o.clientList) && o.clientList.length > 0) {
        console.log(`\n  Clients:`);
        for (const c of o.clientList) {
          console.log(`    ${c.id}  ${c.name ?? "—"}  ${c.registeredBy ?? "—"}  ${c.createdAt ?? "—"}`);
        }
      }
    }

    if (healthData?.bridges) {
      const b = healthData.bridges;
      console.log("\n═══ Bridges ══════════════════════════════════════");
      if (Array.isArray(b.installed) && b.installed.length > 0) console.log(`Installed:    ${b.installed.join(", ")}`);
      if (b.lastImport) console.log(`Last import:  ${relativeTime(b.lastImport)}`);
      if (b.lastExport) console.log(`Last export:  ${relativeTime(b.lastExport)}`);
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log("\n═══ Disk ═════════════════════════════════════════");
      console.log(`Data:         ${d.dataDir} — ${humanBytes(d.dataBytes ?? 0)}`);
      console.log(`Snapshots:    ${d.snapshotDir} — ${humanBytes(d.snapshotBytes ?? 0)}`);
      console.log(`Total:        ${humanBytes((d.dataBytes ?? 0) + (d.snapshotBytes ?? 0))}`);
    }

    const warnings: Array<{ level: string; message: string }> = Array.isArray(healthData?.warnings) ? healthData.warnings : [];
    if (warnings.length > 0) {
      console.log("\n═══ Warnings ═════════════════════════════════════");
      for (const w of warnings) console.log(`  ${w.level === "warn" ? "⚠" : "ℹ"} ${w.message}`);
    } else {
      console.log("\n✅ no warnings");
    }
  });

// ─── Fabric credential resolution (flair deploy / flair upgrade --target) ──
//
// Both commands accept Fabric admin credentials the same three ways: inline
// flags (--fabric-user/--fabric-password — leak to shell history and `ps`
// for the life of the process), a mode-checked --fabric-password-file
// (mirrors --admin-pass-file's file idiom, see readSecretFileSecure above),
// or the FABRIC_USER/FABRIC_PASSWORD env vars. Centralized here so the two
// call sites (runFabricUpgrade below, and `flair deploy`'s action) can't
// drift on precedence or warning wording.
//
// Password precedence: --fabric-password (inline) > --fabric-password-file
// > FABRIC_PASSWORD env. Both explicit, per-invocation sources (inline
// flag, file flag) outrank env, because an env var can be a stale/ambient
// value left over from an earlier shell session rather than something the
// operator actually intended for THIS invocation. Between the two explicit
// sources, inline wins when both are given — matching this CLI's general
// "flag beats everything" precedent elsewhere (resolveBaseUrl/
// resolveHttpPort: --target/--port always outrank their env equivalents) —
// but a warning is returned so a stray leftover --fabric-password doesn't
// silently shadow a safer --fabric-password-file the operator meant to use
// instead of it.
//
// Username has no file-based option: a username isn't a secret that needs
// disk-permission protection. But inline --fabric-user is still recon — it
// confirms a valid login name to anyone who can read `ps` or shell history —
// so it gets the same inline-only warning as inline --fabric-password.
export interface FabricCredentialResolution {
  fabricUser: string | undefined;
  fabricPassword: string | undefined;
  warnings: string[];
}

export function resolveFabricCredentials(opts: {
  fabricUser?: string;
  fabricPassword?: string;
  fabricPasswordFile?: string;
}): FabricCredentialResolution {
  const warnings: string[] = [];

  if (opts.fabricUser && !process.env.FABRIC_USER) {
    warnings.push(
      "warning: --fabric-user passed inline. Consider FABRIC_USER env — " +
        "a login name in shell history/ps is recon."
    );
  }
  const fabricUser = opts.fabricUser ?? process.env.FABRIC_USER;

  let fabricPassword: string | undefined;
  if (opts.fabricPassword) {
    if (opts.fabricPasswordFile) {
      warnings.push(
        "warning: --fabric-password (inline) takes precedence over --fabric-password-file " +
          "when both are given. Pass --fabric-password-file alone to keep the secret out of shell history."
      );
    }
    if (!process.env.FABRIC_PASSWORD) {
      warnings.push(
        "warning: --fabric-password leaks to shell history. Prefer FABRIC_PASSWORD env or --fabric-password-file."
      );
    }
    fabricPassword = opts.fabricPassword;
  } else if (opts.fabricPasswordFile) {
    fabricPassword = readSecretFileSecure(opts.fabricPasswordFile, "--fabric-password-file");
  } else {
    fabricPassword = process.env.FABRIC_PASSWORD;
  }

  return { fabricUser, fabricPassword, warnings };
}

// ─── flair upgrade --target <fabric> ────────────────────────────────────────
//
// One-command upgrade of a Flair instance DEPLOYED to a Harper Fabric cluster.
// Mirrors `flair deploy`'s credential handling (FABRIC_USER/FABRIC_PASSWORD env
// fallbacks, password-via-flag warning, --fabric-password-file — see
// resolveFabricCredentials above) and NEVER prints credentials. The
// version-resolution + @harperfast/harper pin + reuse of deploy() lives in
// src/fabric-upgrade.ts; this wrapper only does CLI plumbing + the confirm.
async function runFabricUpgrade(opts: any): Promise<void> {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  let fabricUser: string | undefined;
  let fabricPassword: string | undefined;
  let credWarnings: string[] = [];
  try {
    ({ fabricUser, fabricPassword, warnings: credWarnings } = resolveFabricCredentials(opts));
  } catch (err: any) {
    console.error(red(`Error: ${err.message}`));
    process.exit(1);
  }
  const check = opts.check ?? false;

  // Creds are not required for --check (read-only registry + best-effort GET),
  // but ARE required to actually deploy.
  if (!check && !(fabricUser && fabricPassword)) {
    console.error(red("flair upgrade --target: credentials required to deploy"));
    console.error(
      "  set FABRIC_USER + FABRIC_PASSWORD env (safest), or pass --fabric-user + --fabric-password-file <path>",
    );
    console.error(
      "  inline --fabric-user/--fabric-password also work but leak to shell history — avoid on shared/multi-user hosts",
    );
    console.error("  or use --check to preview the plan without credentials");
    process.exit(1);
  }

  // Never log the credential VALUES — only the flag names, via the
  // resolver's own warning strings.
  for (const w of credWarnings) console.error(dim(w));

  const upgradeOpts = {
    target: opts.target as string,
    project: opts.project,
    version: opts.version,
    harperVersion: opts.harperVersion,
    fabricUser,
    fabricPassword,
    check,
    restart: opts.restart !== false,
    replicated: opts.replicated !== false,
  };

  console.log(`${green("→")} Upgrading Fabric Flair at ${upgradeOpts.target}`);
  if (check) console.log(dim("  (--check: plan only, no deploy)"));

  try {
    // For a real (non-check) run, confirm first unless --yes. Building the plan
    // up front would double the registry round-trips; the plan prints inside
    // fabricUpgrade. We confirm BEFORE invoking when interactive and not --yes.
    if (!check && !opts.yes && process.stdin.isTTY) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(
          `Deploy a fresh ${green("@tpsdev-ai/flair")} to ${upgradeOpts.target}? [y/N] `,
          (a) => { rl.close(); res(a); },
        ),
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Aborted.");
        return;
      }
    }

    const result = await fabricUpgrade(upgradeOpts);

    if (check) {
      console.log(
        `\n${green("✓")} check complete — run without --check to deploy.`,
      );
      return;
    }
    if (result.plan.upToDate && !result.deployed) {
      console.log(`\n${green("✓")} already up to date.`);
      return;
    }
    console.log(`\n${green("✓")} Fabric upgrade complete.`);

    // ── Post-upgrade fleet sweep (flair#636) ────────────────────────────────
    // "deploy complete" from harper's own CLI means "origin took it" — this
    // confirms every known federation peer actually converged on the version
    // we just deployed, instead of trusting a single boolean. Skippable with
    // --no-fleet-verify. fabricUser/fabricPassword are guaranteed set here —
    // the !check branch above already required both.
    if (!shouldRunFleetVerify(opts)) {
      console.log(dim("(--no-fleet-verify: skipping post-upgrade fleet sweep)"));
    } else {
      console.log(`\n${green("→")} Fleet verify`);
      const sweep = await sweepFleet({
        target: upgradeOpts.target,
        fabricUser: fabricUser as string,
        fabricPassword: fabricPassword as string,
        expectVersion: result.plan.targetVersion,
      });
      console.log(renderFleetSweepTable(sweep));
      if (sweep.exitCode !== FLEET_EXIT_OK) {
        console.error(red(`\n✗ fleet verify failed (exit ${sweep.exitCode}) — upgrade is NOT fully converged.`));
        process.exit(sweep.exitCode);
      }
    }
  } catch (err: any) {
    console.error(red(`\n✗ fabric upgrade failed: ${err.message}`));
    const hint = err.message?.toLowerCase() ?? "";
    if (hint.includes("401") || hint.includes("unauthoriz")) {
      console.error(dim("  hint: check Fabric Studio → Cluster Settings → Admin for the admin password"));
    }
    process.exit(1);
  }
}

// ─── Pre-upgrade data snapshot (flair#637) ─────────────────────────────────
// `flair upgrade` used to swap @tpsdev-ai/flair's own package with no backup
// of ~/.flair/data — if an upgrade broke something past the package level
// (schema/data, not just code), there was no tested way back. This is cheap
// insurance: a timestamped tar.gz of the whole data directory taken right
// before the package swap, with a keep-last-3 retention policy.
//
// Native-backup alternative considered and rejected: Harper ships a
// `get_backup` operation (@harperfast/harper's dataLayer/getBackup.ts,
// wired in server/serverHelpers/serverUtilities.ts, documented in
// components/mcp/tools/schemas/operationDescriptions.ts) that streams a
// live backup over the running HTTP operations API. It's available in this
// OSS tier (no license/tier gate found in operation_authorization.ts — just
// `requires_su`), but it backs up ONE database/table at a time
// (GetBackupObject requires `schema`/`table`, or defaults to a single "data"
// database) — not the whole `~/.flair/data` tree: no config, no
// users/roles, no keys, no other schemas. Using it here would mean
// enumerating every schema/table and making N authenticated HTTP calls
// against a server this same command is about to take down — for a LESS
// complete result than a plain recursive file copy, and one that can't run
// at all once the server is stopped (it's an operations-API call, not a
// standalone filesystem utility). Rejected in favor of the file-level
// snapshot below. See docs/upgrade.md for the restore procedure this
// produces.
const UPGRADE_SNAPSHOT_ROOT = resolve(homedir(), ".flair", "upgrade-snapshots");
const UPGRADE_SNAPSHOT_RETAIN = 3;

function upgradeSnapshotFileName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `flair-data-${ts}.tar.gz`;
}

/**
 * Snapshot `dataDir` (normally ~/.flair/data) into a timestamped tar.gz
 * under ~/.flair/upgrade-snapshots/.
 *
 * Consistency: the caller is expected to have stopped Flair first (a
 * running Harper's data dir can be mid-write, and a plain file copy of a
 * live database directory isn't guaranteed point-in-time consistent —
 * Harper 5.x's engine is RocksDB, verified from the .sst/WAL/MANIFEST
 * layout under database/*, and a torn WAL/SST set won't open) — this
 * function itself doesn't stop anything, it just archives whatever is on
 * disk right now.
 *
 * Preserves file modes exactly — deliberately NOT using tar's `portable`
 * option (used elsewhere in this file for the deploy tarball and session
 * snapshots), which flattens every entry's mode to a umask-based "reasonable
 * default" and would turn 0600 key/admin-pass files into whatever that
 * default is. Never follows symlinks out of `dataDir`: node-tar already
 * archives symlinks as symlinks by default (no `follow` option set here),
 * and the filter below additionally skips any symlink whose resolved target
 * falls outside `dataDir`, plus any non-regular file (sockets, FIFOs, device
 * nodes — e.g. a stale `operations-server` domain socket left behind by a
 * prior run) that tar can't meaningfully archive anyway.
 *
 * Throws on any failure — `flair upgrade` treats a snapshot failure as
 * abort-the-upgrade by default (safe default; --no-snapshot is the opt-out
 * for hosts that can't spare the time/disk).
 *
 * `snapshotRoot` defaults to UPGRADE_SNAPSHOT_ROOT (~/.flair/upgrade-snapshots)
 * but is an explicit parameter — not read from homedir() internally — so
 * unit tests can point it at a throwaway temp dir instead of this machine's
 * real ~/.flair (test/unit/upgrade-data-snapshot.test.ts).
 */
export async function createDataSnapshot(
  dataDir: string,
  snapshotRoot: string = UPGRADE_SNAPSHOT_ROOT,
): Promise<{ path: string; bytes: number }> {
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotPath = join(snapshotRoot, upgradeSnapshotFileName());
  // realpath, not just resolve() — on macOS (and some Linux distros) the
  // system temp dir itself sits behind a symlink (/tmp -> /private/tmp), so
  // a plain lexical resolve() of `dataDir` would never equal the realpath()
  // of a symlink target genuinely INSIDE it, misclassifying every in-bounds
  // symlink as an escape.
  const resolvedDataDir = realpathSync(resolve(dataDir));

  const filter = (entryPath: string): boolean => {
    // entryPath is relative to `cwd` (dataDir) per tar's create() contract.
    const abs = resolve(resolvedDataDir, entryPath);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false; // vanished between readdir and stat — skip, don't crash the snapshot
    }
    if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) {
      console.error(`  (skipping non-regular file in snapshot: ${entryPath})`);
      return false;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        console.error(`  (skipping broken symlink in snapshot: ${entryPath})`);
        return false;
      }
      const withinDataDir = real === resolvedDataDir || real.startsWith(resolvedDataDir + sep);
      if (!withinDataDir) {
        console.error(`  (skipping symlink pointing outside the data dir: ${entryPath})`);
        return false;
      }
    }
    return true;
  };

  // preservePaths: true — WITHOUT it, node-tar strips the leading `/` off
  // any absolute symlink target it archives (found the hard way: an
  // in-bounds symlink pointing at an absolute path under `dataDir` came
  // back on extraction as a nonsense RELATIVE path, silently broken). Every
  // entry path here is already relative (fileList is `["."]`, cwd is
  // `dataDir`) — this only affects symlink target text, restoring it
  // verbatim, which is exactly what a same-host restore into the original
  // ~/.flair/data path needs.
  await tarCreate({ gzip: true, cwd: resolvedDataDir, file: snapshotPath, filter, preservePaths: true }, ["."]);
  // Owner-only — the archive can contain 0600 key/admin-pass material.
  chmodSync(snapshotPath, 0o600);
  return { path: snapshotPath, bytes: statSync(snapshotPath).size };
}

/**
 * Keep only the newest `retain` upgrade snapshots, deleting older ones.
 * Best-effort: a pruning failure is logged, not thrown — it must never
 * un-succeed an upgrade whose snapshot already landed safely on disk.
 * Returns the paths removed.
 *
 * `snapshotRoot` is explicit for the same testability reason as
 * `createDataSnapshot` above.
 */
export function pruneOldSnapshots(
  retain: number = UPGRADE_SNAPSHOT_RETAIN,
  snapshotRoot: string = UPGRADE_SNAPSHOT_ROOT,
): string[] {
  if (!existsSync(snapshotRoot)) return [];
  const removed: string[] = [];
  try {
    const files = readdirSync(snapshotRoot)
      .filter((f) => f.startsWith("flair-data-") && f.endsWith(".tar.gz"))
      .map((f) => join(snapshotRoot, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const stale of files.slice(retain)) {
      try {
        rmSync(stale, { force: true });
        removed.push(stale);
      } catch (err: any) {
        console.error(`  (could not prune old snapshot ${stale}: ${err.message})`);
      }
    }
  } catch (err: any) {
    console.error(`  (snapshot retention check failed: ${err.message})`);
  }
  return removed;
}

/**
 * Decide what `flair upgrade`'s pre-upgrade snapshot step should do (opt-in
 * rewrite, 2026-07-08). Pure — takes the three booleans the action already
 * computes and returns the branch to take, without performing any I/O. Pulled
 * out of the action itself so the gating logic (default = no snapshot, no
 * abort; --snapshot = same abort-on-failure mechanism as before) is directly
 * unit-testable instead of only reachable via a full `flair upgrade` run
 * (test/unit/upgrade-data-snapshot.test.ts).
 *
 *   - "not-upgrading": @tpsdev-ai/flair isn't one of the packages being
 *     upgraded (or --snapshot wasn't requested and there's no data dir to
 *     nudge about) — nothing to do, no output.
 *   - "nudge": --snapshot wasn't passed (the default) and a data dir exists —
 *     print the non-blocking recommendation, do NOT snapshot, do NOT abort.
 *   - "no-data": --snapshot was passed but there's no data dir yet — nothing
 *     to snapshot.
 *   - "snapshot": --snapshot was passed and there's data — run the real
 *     stop/snapshot/prune/restart flow, aborting the upgrade on failure.
 */
export type UpgradeSnapshotDecision = "not-upgrading" | "nudge" | "no-data" | "snapshot";

export function decideUpgradeSnapshotAction(
  flairIsUpgrading: boolean,
  snapshotRequested: boolean,
  hasDataDir: boolean,
): UpgradeSnapshotDecision {
  if (!flairIsUpgrading) return "not-upgrading";
  if (!snapshotRequested) return hasDataDir ? "nudge" : "not-upgrading";
  return hasDataDir ? "snapshot" : "no-data";
}

/**
 * The exact non-blocking recommendation nudge printed when `flair upgrade`
 * runs without --snapshot (the default) and a data dir exists to snapshot.
 * Exported as a constant — not inlined in two places — so the CLI output and
 * its unit test assertion can't drift apart. Modeled on Harper's own
 * upgrade prompt ("if you have not created a backup of your data, we
 * recommend you cancel and back up before proceeding") but informational,
 * never blocking: this must stay safe for non-interactive/scripted upgrades.
 */
export const UPGRADE_SNAPSHOT_NUDGE_LINES: readonly string[] = [
  "No pre-upgrade snapshot will be taken.",
  "To capture one first: `flair snapshot create` (physical) or `flair backup` (logical export), or re-run with --snapshot.",
];

// ─── flair snapshot ─────────────────────────────────────────────────────────
// Explicit, first-class surface for the physical data-dir snapshot mechanism
// above (createDataSnapshot / pruneOldSnapshots / UPGRADE_SNAPSHOT_ROOT).
// Added alongside the opt-in rewrite of `flair upgrade`'s snapshot trigger
// (2026-07-08) so taking one is a real command, not just a side effect of
// upgrading with --snapshot.
//
// Deliberately NOT named/shaped like `flair backup` / `flair restore`
// (further below) — those are a LOGICAL export/import of Agent/Memory/Soul
// records as JSON over the HTTP API, portable across hosts and versions.
// `flair snapshot` is a PHYSICAL, byte-exact tar.gz of the whole
// ~/.flair/data directory (RocksDB files, keys, config, admin-pass — every
// byte, same host, same version) taken with Flair stopped for consistency.
// Different mechanism, different restore procedure, different failure
// modes — hence its own namespace (`snapshot create|list|restore`) instead
// of overloading the JSON one. Mirrors the `rem snapshot` / `session
// snapshot` subcommand idiom used elsewhere in this file.
const snapshotCmd = program
  .command("snapshot")
  .description("Physical ~/.flair/data snapshots (byte-exact tar.gz, local-only — see `flair backup`/`flair restore` for the logical JSON export/import)");

snapshotCmd
  .command("create")
  .description("Take a physical snapshot of the Flair data directory now (briefly stops Flair for a consistent copy — use `flair backup` for a no-downtime logical export)")
  .option("--data-dir <path>", "Data directory to snapshot (default: ~/.flair/data)")
  .option("--port <port>", "Harper HTTP port (used to quiesce Flair around the snapshot)")
  .action(async (opts) => {
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir();
    const port = resolveHttpPort(opts);
    if (!existsSync(dataDir)) {
      console.error(`Error: data directory does not exist: ${dataDir}`);
      process.exit(1);
    }

    console.log(`Snapshotting ${dataDir}...`);
    console.log("(Flair will be briefly stopped for a point-in-time-consistent copy, then restarted.)");
    // Same consistency requirement as the upgrade path's snapshot step: a
    // live RocksDB directory (WAL/MANIFEST/SST) isn't safe to copy while
    // Flair is running, so this stops Flair, snapshots, and restarts it —
    // same stop/start helpers `flair upgrade`'s snapshot step uses, so a
    // standalone `flair snapshot create` gives the exact same
    // point-in-time-consistent guarantee, not a weaker one.
    let stoppedForSnapshot = false;
    try {
      await stopFlairProcess(port);
      stoppedForSnapshot = true;
      const snapshot = await createDataSnapshot(dataDir);
      const removed = pruneOldSnapshots();
      console.log(`✅ Snapshot: ${snapshot.path} (${humanBytes(snapshot.bytes)})`);
      if (removed.length > 0) {
        console.log(`   Pruned ${removed.length} older snapshot${removed.length > 1 ? "s" : ""} (keeping last ${UPGRADE_SNAPSHOT_RETAIN})`);
      }
    } catch (err: any) {
      console.error(`❌ snapshot failed: ${err.message}`);
      if (stoppedForSnapshot) {
        try { await startFlairProcess(port); } catch { /* best effort — surface the original snapshot error, not this */ }
      }
      process.exit(1);
    }
    try {
      await startFlairProcess(port);
    } catch (err: any) {
      console.error(`❌ the snapshot succeeded but Flair failed to restart: ${err.message}`);
      console.error("   Check: flair doctor");
      process.exit(1);
    }
  });

snapshotCmd
  .command("list")
  .description("List physical data snapshots under ~/.flair/upgrade-snapshots/")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (!existsSync(UPGRADE_SNAPSHOT_ROOT)) {
      if (opts.json) { console.log("[]"); return; }
      console.log(`(no snapshots — ${UPGRADE_SNAPSHOT_ROOT} does not exist yet)`);
      console.log("Run `flair snapshot create` to make one, or `flair upgrade --snapshot` to take one automatically before an upgrade.");
      return;
    }
    const rows = readdirSync(UPGRADE_SNAPSHOT_ROOT)
      .filter((f) => f.startsWith("flair-data-") && f.endsWith(".tar.gz"))
      .map((f) => {
        const p = join(UPGRADE_SNAPSHOT_ROOT, f);
        const s = statSync(p);
        return { file: f, path: p, size: s.size, mtime: s.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));

    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) {
      console.log("(no snapshots)");
      return;
    }
    const fileW = Math.max(20, ...rows.map((r) => r.file.length));
    console.log(`  ${"file".padEnd(fileW)}  size      age`);
    for (const r of rows) {
      console.log(`  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
    }
    console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
  });

snapshotCmd
  .command("restore <path>")
  .description("Restore a physical snapshot: stops Flair, replaces the data directory, restarts")
  .option("--data-dir <path>", "Data directory to replace (default: ~/.flair/data)")
  .option("--port <port>", "Harper HTTP port")
  .option("--yes", "Skip the confirmation prompt (this destroys the current data directory)")
  .action(async (snapshotArg: string, opts) => {
    const snapshotPath = resolve(snapshotArg);
    if (!existsSync(snapshotPath)) {
      console.error(`Error: snapshot does not exist: ${snapshotPath}`);
      process.exit(1);
    }
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir();
    const port = resolveHttpPort(opts);

    console.log("This will STOP Flair, DELETE the current data directory, and replace it with:");
    console.log(`  snapshot: ${snapshotPath}`);
    console.log(`  target:   ${dataDir}`);

    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error("\nError: refusing to destroy the data directory in a non-interactive shell without --yes.");
        process.exit(1);
      }
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(`\nDestroy ${dataDir} and restore from this snapshot? [y/N] `, (a) => { rl.close(); res(a); }),
      );
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Aborted.");
        return;
      }
    }

    try {
      await stopFlairProcess(port);
    } catch (err: any) {
      console.error(`❌ failed to stop Flair: ${err.message}`);
      process.exit(1);
    }

    try {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // preservePaths mirrors createDataSnapshot's own preservePaths: true —
      // restores absolute symlink targets verbatim instead of node-tar's
      // default of stripping the leading "/" on extraction. No `follow`
      // option, so symlinks extract as symlinks (never their targets'
      // contents), and file modes extract exactly as stored — the archive
      // itself already only contains what createDataSnapshot's filter chose
      // to include (in-bounds symlinks, regular files/dirs only), so restore
      // needs no re-filtering of its own.
      await tarExtract({ file: snapshotPath, cwd: dataDir, preservePaths: true });
    } catch (err: any) {
      console.error(`❌ restore failed: ${err.message}`);
      console.error(`   ${dataDir} may be partially restored or empty — do not start Flair until this is resolved.`);
      process.exit(1);
    }

    try {
      await startFlairProcess(port);
    } catch (err: any) {
      console.error(`❌ restore succeeded but Flair failed to restart: ${err.message}`);
      console.error("   Check: flair doctor");
      process.exit(1);
    }

    console.log(`✅ Restored ${dataDir} from ${snapshotPath}`);
    console.log("   Flair restarted. Verify: flair status && flair doctor");
  });

// ─── flair upgrade ────────────────────────────────────────────────────────────

program
  .command("upgrade")
  .description("Upgrade Flair — local packages by default, or a deployed Fabric with --target")
  .option("--check", "Only check for updates / show the plan, don't install or deploy")
  .option("--restart", "[deprecated] no-op — restart now happens automatically after upgrade; use --no-restart to opt out")
  .option("--no-restart", "Skip the restart after upgrade (stage new packages now, restart later)")
  .option("--no-verify", "Skip post-restart health/version/auth verification (default: verify — so a broken upgrade can't report success; see flair#635)")
  .option("--snapshot", "Take a pre-upgrade ~/.flair/data snapshot before the package swap, keep-last-3 retention (default: off — see `flair snapshot create` to take one by hand, or `flair backup` for a logical export; flair#637)")
  .option("--all", "Show transitive packages (e.g. flair-client) in the listing — verbose mode for debugging dep versions")
  // ── Fabric upgrade (--target) ────────────────────────────────────────────
  // When --target is passed, upgrade the Flair component DEPLOYED to that
  // Harper Fabric URL instead of the local npm install. Reuses `flair deploy`
  // under the hood with the @harperfast/harper pin baked in (flair#513).
  .option("--target <url>", "Upgrade the Flair deployed to this Fabric URL (not the local install)")
  .option("--fabric-user <user>", "Fabric admin username — for --target (env: FABRIC_USER preferred; inline leaks to shell history)")
  .option("--fabric-password <pass>", "Fabric admin password — for --target (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
  .option("--fabric-password-file <path>", "Read the Fabric admin password from a file (chmod 600) — for --target")
  .option("--version <semver>", "Flair version to deploy with --target (default: latest published @tpsdev-ai/flair)")
  .option("--harper-version <semver>", "Pin @harperfast/harper to this version for --target (default: registry latest, floored at the flair#513 fix)")
  .option("--project <name>", "Fabric component name for --target", "flair")
  .option("--no-replicated", "Disable cluster-wide replication for --target (default: replicated=true)")
  .option("--yes", "Skip the confirmation prompt for --target")
  .option("--no-fleet-verify", "Skip the automatic post-upgrade fleet convergence sweep for --target (default: sweep runs — see flair#636)")
  .action(async (opts) => {
    // ── Fabric-upgrade branch ───────────────────────────────────────────────
    if (opts.target) {
      await runFabricUpgrade(opts);
      return;
    }

    const { execFileSync } = await import("node:child_process");
    const checkOnly = opts.check ?? false;
    const showAll = opts.all ?? false;

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
    //   - For openclaw plugins: read ~/.openclaw/extensions/<name>/package.json
    //     directly (the OpenClaw plugin install layout — not on $PATH, not in
    //     flair's module graph).
    //
    // Default UI shows the npm-global packages (flair, flair-mcp) plus
    // openclaw-flair WHEN openclaw is installed. On machines without openclaw
    // the openclaw-flair line is suppressed entirely rather than
    // nagging with an install hint for a plugin the user can't use. flair-client
    // is a transitive dep of flair-mcp and showing it as a top-level upgrade
    // item invites a misleading "❔ missing — install with npm install -g"
    // suggestion for users who installed flair without flair-mcp.
    // --all opts in to both flair-client and the suppressed openclaw line.
    type ProbeKind = "bin" | "lib" | "openclaw-plugin";
    const packages: Array<{
      name: string;
      probe: () => string | null;
      kind: ProbeKind;
      transitive?: boolean; // hide from default UI; shown only with --all
    }> = [
      {
        name: "@tpsdev-ai/flair",
        kind: "bin",
        probe: () => probeBinVersion(execFileSync,"flair"),
      },
      {
        name: "@tpsdev-ai/flair-mcp",
        kind: "bin",
        // Older flair-mcp installs (e.g. 0.10.0) either aren't on PATH or
        // don't support `--version`, so the bin probe returns null even when
        // the package IS globally installed. Fall back to the lib
        // probe, which require.resolves the package.json from a sibling global
        // install regardless of PATH or --version support. kind stays "bin" so
        // it remains npm-upgradeable (npm install -g), not the openclaw path.
        probe: () => probeBinVersion(execFileSync, "flair-mcp") ?? probeLibVersion("@tpsdev-ai/flair-mcp"),
      },
      {
        name: "@tpsdev-ai/openclaw-flair",
        kind: "openclaw-plugin",
        probe: () => probeOpenclawPluginVersion("openclaw-flair"),
      },
      {
        name: "@tpsdev-ai/flair-client",
        kind: "lib",
        probe: () => probeLibVersion("@tpsdev-ai/flair-client"),
        transitive: true,
      },
    ];

    // Per-package status — see the UpgradeStatus type for the four states.
    type Status = UpgradeStatus;
    const findings: Array<{ name: string; installed: string | null; latest: string; status: Status; kind: ProbeKind }> = [];

    for (const { name, probe, kind, transitive } of packages) {
      if (transitive && !showAll) continue;
      try {
        const res = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json() as { version?: string };
        const latest = data.version ?? "unknown";

        const installed = probe();
        let status: Status;
        if (installed === null) {
          // openclaw-plugin packages are optional — if openclaw isn't
          // installed, don't surface a misleading "install with npm" advice.
          status = kind === "openclaw-plugin" ? "optional" : "missing";
        } else if (installed === latest) {
          status = "current";
        } else {
          status = "outdated";
        }
        findings.push({ name, installed, latest, status, kind });

        // Suppress the line for openclaw plugins that are optional-because-
        // openclaw-is-absent: on machines without openclaw the
        // "○ … not installed (openclaw not detected) → … (install via …)"
        // line is pure noise. Still print it when openclaw IS installed
        // (current/outdated) or under --all.
        if (!shouldPrintUpgradeLine(status, showAll)) continue;

        const icon = status === "current" ? "✅"
          : status === "outdated" ? "⬆️"
          : status === "optional" ? "○"
          : "❔";
        const installedLabel = installed ?? (status === "optional" ? "not installed (openclaw not detected)" : "not detected");
        const suffix = status === "current" ? " (current)"
          : status === "missing" ? " (run: npm install -g)"
          : status === "optional" ? " (install via: openclaw plugins install @tpsdev-ai/openclaw-flair)"
          : "";
        console.log(`  ${icon} ${name}: ${installedLabel} → ${latest}${suffix}`);
      } catch { /* skip unavailable packages */ }
    }

    // Scope footer: make explicit what `flair upgrade` does and
    // doesn't cover, so "were the others checked?" has a one-line answer.
    console.log("\nScope: npm-global packages (flair, flair-mcp) + openclaw plugins. Other integrations (pi-flair, langgraph-flair, n8n-nodes-flair, hermes-flair) upgrade in their own ecosystems (pi / pip / n8n).");

    const outdated = findings.filter((f) => f.status === "outdated");
    const missing = findings.filter((f) => f.status === "missing");
    // openclaw plugins upgrade through `openclaw plugins install`, not `npm
    // install -g` (npm-installed wouldn't connect to OpenClaw's gateway slot).
    // Split outdated into npm-upgradeable vs openclaw-plugin so we can use
    // the right command for each.
    const npmUpgrades = outdated
      .filter((f) => f.kind !== "openclaw-plugin")
      .map(({ name, installed, latest }) => ({ pkg: name, installed: installed ?? "unknown", latest }));
    const openclawUpgrades = outdated
      .filter((f) => f.kind === "openclaw-plugin")
      .map(({ name, installed, latest }) => ({ pkg: name, installed: installed ?? "unknown", latest }));
    const totalUpgrades = npmUpgrades.length + openclawUpgrades.length;

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

    // Hoisted here (was previously computed after install/restart) — the
    // pre-upgrade snapshot below needs to know the target port AND whether a
    // restart is coming, before any package is touched. Pure function of
    // `opts` — safe to call this early.
    const { restart: shouldRestart, verify: shouldVerify, deprecatedRestartFlagUsed } =
      resolveUpgradeRestartVerify(opts);
    const upgradePort = resolveHttpPort({});

    // ── Pre-upgrade data snapshot (flair#637, opt-in as of the 2026-07-08 rewire) ──
    // Only an @tpsdev-ai/flair package swap touches the code that reads/
    // writes ~/.flair/data — an flair-mcp-only or openclaw-plugin-only
    // upgrade never runs different Harper/Flair code against the data, so
    // there's nothing at risk and nothing to snapshot.
    //
    // Decision (Nathan, 2026-07-08): the physical snapshot used to run
    // automatically on every local upgrade (opt-out via --no-snapshot). That
    // defaulted every upgrade into tarring the entire data dir (can be
    // 800MB+, keep-last-3 retention ~2.5GB) for a failure mode the
    // tested-downgrade guarantee (docs/upgrade.md, test/compat/downgrade-
    // boot.test.ts) already covers — and it diverged from Harper's own
    // upgrade CLI, which recommends a backup before proceeding but never
    // auto-tars the data directory itself. `--snapshot` is now opt-in, off
    // by default; opting out gets a non-blocking recommendation nudge
    // instead of a silent skip. The underlying mechanism (createDataSnapshot
    // / pruneOldSnapshots, the stop-snapshot-restart quiesce dance, and
    // abort-the-upgrade-on-snapshot-failure) is unchanged — only the trigger
    // moved from opt-out to opt-in. `flair snapshot create` (below) exposes
    // the exact same mechanism as a standalone command for anyone who wants
    // one without wrapping it around an upgrade.
    const flairIsUpgrading = npmUpgrades.some((u) => u.pkg === "@tpsdev-ai/flair");
    const snapshotDataDir = defaultDataDir();
    const snapshotDecision = decideUpgradeSnapshotAction(
      flairIsUpgrading,
      !!opts.snapshot,
      existsSync(snapshotDataDir),
    );
    let snapshotPath: string | null = null;
    if (snapshotDecision === "nudge") {
      // Non-blocking nudge only — never prompt/block here, this must stay
      // safe for non-interactive/scripted upgrades. Modeled on Harper's own
      // upgrade prompt ("if you have not created a backup ... we recommend
      // you cancel and back up before proceeding") but informational, not a
      // gate.
      console.log("");
      for (const line of UPGRADE_SNAPSHOT_NUDGE_LINES) console.log(render.wrap(render.c.dim, line));
    } else if (snapshotDecision === "no-data") {
      console.log(`\n(no data directory at ${snapshotDataDir} yet — nothing to snapshot)`);
    } else if (snapshotDecision === "snapshot") {
      console.log("\nSnapshotting data before upgrade...");
      // Consistency: a running Harper's data dir can be mid-write, and a
      // plain file copy of a live database directory isn't guaranteed
      // point-in-time consistent (Harper 5.x = RocksDB: WAL/SST/MANIFEST
      // can tear under a live copy). Stopping first — then immediately
      // restarting the OLD version, before any package changes — gives a
      // quiesced, safe-to-copy directory with only a brief blip, even for
      // --no-restart (the snapshot's correctness doesn't depend on
      // whether the caller wants a restart AFTER the upgrade — those are
      // orthogonal). See docs/upgrade.md for the native-backup alternative
      // considered and rejected (Harper's `get_backup` op backs up one
      // table/schema at a time over the running HTTP API — not the whole
      // data dir — and rejecting it here means this path never depends on
      // the server being up).
      let stoppedForSnapshot = false;
      try {
        await stopFlairProcess(upgradePort);
        stoppedForSnapshot = true;
        const snapshot = await createDataSnapshot(snapshotDataDir);
        snapshotPath = snapshot.path;
        const removed = pruneOldSnapshots();
        console.log(`✅ Snapshot: ${snapshotPath} (${humanBytes(snapshot.bytes)})`);
        console.log(`   Restore: flair snapshot restore "${snapshotPath}"`);
        if (removed.length > 0) {
          console.log(`   Pruned ${removed.length} older snapshot${removed.length > 1 ? "s" : ""} (keeping last ${UPGRADE_SNAPSHOT_RETAIN})`);
        }
      } catch (err: any) {
        console.error(`❌ snapshot failed: ${err.message}`);
        console.error("   Aborting upgrade — no packages were changed. Omit --snapshot to proceed without one (not recommended).");
        if (stoppedForSnapshot) {
          try { await startFlairProcess(upgradePort); } catch { /* best effort — surface the original snapshot error, not this */ }
        }
        process.exit(1);
      }
      try {
        await startFlairProcess(upgradePort);
      } catch (err: any) {
        console.error(`❌ failed to restart Flair after the pre-upgrade snapshot: ${err.message}`);
        console.error(`   The snapshot itself succeeded (${snapshotPath}) — no packages were changed. Check: flair doctor`);
        process.exit(1);
      }
    }

    // Perform upgrade. `latest` comes from the npm registry's HTTP
    // response, so CodeQL (correctly) treats it as untrusted input.
    // Use execFileSync with argv — the spec `<name>@<version>` becomes a
    // single argument to the upgrade command, no shell to inject into.
    console.log(`\nUpgrading ${totalUpgrades} package${totalUpgrades > 1 ? "s" : ""}...\n`);
    // Tracked separately (rather than inferred from findings alone) because the
    // post-restart verify/rollback step below needs to know whether @tpsdev-ai/flair's
    // OWN install actually succeeded — if it failed, the running version is still the
    // OLD one and verification should expect that, not the target we failed to reach.
    let flairInstallFailed = false;
    for (const { pkg, latest } of npmUpgrades) {
      try {
        console.log(`  Installing ${pkg}@${latest}...`);
        execFileSync("npm", ["install", "-g", `${pkg}@${latest}`], { stdio: "pipe" });
        console.log(`  ✅ ${pkg}@${latest} installed`);
      } catch (err: any) {
        console.error(`  ❌ ${pkg} upgrade failed: ${err.message}`);
        if (pkg === "@tpsdev-ai/flair") flairInstallFailed = true;
      }
    }
    for (const { pkg, latest } of openclawUpgrades) {
      // OpenClaw plugins upgrade via `openclaw plugins install --force --pin`.
      // Requires openclaw on PATH; if not, surface the manual recipe instead
      // of a confusing failure.
      try {
        execFileSync("openclaw", ["--version"], { stdio: "pipe", timeout: 2000 });
      } catch {
        console.error(`  ❌ ${pkg} upgrade skipped: openclaw not on PATH. Install manually: openclaw plugins install ${pkg}@${latest} --force --pin`);
        continue;
      }
      try {
        console.log(`  Installing ${pkg}@${latest} via openclaw...`);
        execFileSync("openclaw", ["plugins", "install", `${pkg}@${latest}`, "--force", "--pin"], { stdio: "pipe" });
        console.log(`  ✅ ${pkg}@${latest} installed`);
      } catch (err: any) {
        console.error(`  ❌ ${pkg} upgrade failed: ${err.message}`);
      }
    }

    // ── Restart + verify + rollback (flair#635) ─────────────────────────────
    // Decision (2026-07-08): restart is now the default post-upgrade step —
    // installing new code without restarting leaves the OLD process serving
    // while the version on disk lies about what's actually running.
    // --no-restart opts back out for the "stage now, bounce later" case.
    // --restart is kept as a deprecated no-op for old muscle memory.
    // Upgrade = install → restart → verify → (rollback on failure), one
    // transaction — never report success on a broken restart.
    const flairFinding = findings.find((f) => f.name === "@tpsdev-ai/flair");
    const previousFlairVersion = flairFinding?.installed ?? null;
    const expectedFlairVersion =
      flairFinding?.status === "outdated" && !flairInstallFailed
        ? flairFinding.latest
        : flairFinding?.installed ?? null;

    // shouldRestart/shouldVerify/deprecatedRestartFlagUsed were hoisted above
    // the pre-upgrade snapshot block — it needs to know these before any
    // package is touched.
    if (deprecatedRestartFlagUsed) {
      console.error("warning: --restart is deprecated and is now a no-op — flair upgrade restarts by default. Use --no-restart to skip it.");
    }

    if (!shouldRestart) {
      console.log("\nRun: flair restart to use the new version");
      return;
    }

    console.log("\nRestarting Flair...");
    const port = upgradePort;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await restartFlair(port);
    } catch (err: any) {
      console.error(`❌ restart failed: ${err.message}`);
      console.error("   Flair may be partially down. Check: flair doctor");
      process.exit(1);
    }
    console.log("✅ Flair restarted");

    if (!shouldVerify) {
      console.log("  (--no-verify: skipping post-restart verification)");
      return;
    }

    console.log("\nVerifying...");
    // The authenticated leg dogfoods api()'s local-credential resolution
    // (flair#640: env > agent key > ~/.flair/admin-pass file) — probeInstance
    // itself never resolves credentials, it just calls whatever's handed to it.
    const verify = await probeInstance(baseUrl, {
      expectVersion: expectedFlairVersion ?? undefined,
      timeoutMs: STARTUP_TIMEOUT_MS,
      authedGet: (path) => api("GET", path, undefined, { baseUrl }),
    });

    const verdict = decideAfterVerify(verify, previousFlairVersion);
    if (verdict.kind === "ok") {
      console.log(`✅ verified: healthy, authenticated${verify.version ? `, running ${verify.version}` : ""}`);
      return;
    }

    console.error(`❌ post-restart verification failed: ${verdict.reason}`);

    if (verdict.kind === "cannot-rollback") {
      console.error("   Cannot roll back automatically: the previously-installed @tpsdev-ai/flair version is unknown.");
      console.error("   Check the instance now: flair doctor");
      process.exit(1);
    }

    console.log(`\nRolling back @tpsdev-ai/flair to ${verdict.toVersion}...`);
    try {
      execFileSync("npm", ["install", "-g", `@tpsdev-ai/flair@${verdict.toVersion}`], { stdio: "pipe" });
    } catch (err: any) {
      console.error(`❌ rollback install failed: ${err.message}`);
      console.error(`   Flair is currently running the FAILED version (${expectedFlairVersion ?? "unknown"}). Manual intervention required.`);
      process.exit(1);
    }
    try {
      await restartFlair(port);
    } catch (err: any) {
      console.error(`❌ rollback restart failed: ${err.message}`);
      console.error("   Instance state is UNKNOWN — it may be down entirely. Check: flair doctor");
      process.exit(1);
    }

    const rollbackVerify = await probeInstance(baseUrl, {
      expectVersion: verdict.toVersion,
      timeoutMs: STARTUP_TIMEOUT_MS,
      authedGet: (path) => api("GET", path, undefined, { baseUrl }),
    });
    const rollbackVerdict = decideAfterRollbackVerify(rollbackVerify);
    if (rollbackVerdict.kind === "rolled-back") {
      console.error(`❌ upgrade failed verification and was rolled back to @tpsdev-ai/flair@${verdict.toVersion}.`);
      console.error(`   Original failure: ${verdict.reason}`);
      process.exit(1);
    }

    console.error(`❌❌ ROLLBACK ALSO FAILED VERIFICATION: ${rollbackVerdict.reason}`);
    console.error("   Instance state is UNKNOWN — do not assume data integrity.");
    // This double-failure isn't auto-recoverable yet (flair#637) — but if a
    // pre-upgrade snapshot landed, point at the CONCRETE path instead of
    // just the issue number, so recovery doesn't start with a GitHub search.
    if (snapshotPath) {
      console.error(`   A pre-upgrade snapshot is available: ${snapshotPath}`);
      console.error(`   Restore: flair snapshot restore "${snapshotPath}" (or see docs/upgrade.md#downgrade).`);
    } else {
      console.error("   No pre-upgrade snapshot was taken for this run (snapshot is opt-in — pass --snapshot next time, or ~/.flair/data didn't exist yet).");
      console.error("   Check `flair snapshot list` for a manual one, or restore from a `flair backup` JSON export. See docs/upgrade.md#downgrade.");
    }
    process.exit(1);
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
    const modelsDir = process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ROOTPATH: dataDir,
      // See the matching comment at the install-time spawn site above.
      FLAIR_MODELS_DIR: modelsDir,
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
    // models (flair#504 Phase 1): no env var needed — resources/embeddings-boot.ts
    // self-registers the backend in-process on every boot (flair#694).

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

/**
 * Stop the local Flair (Harper) process — launchd `stop` on darwin when a
 * plist is present (falling back on failure), otherwise a manual SIGTERM by
 * port. Split out of the old monolithic `restartFlair` (flair#637) so the
 * pre-upgrade snapshot can quiesce the data directory between a stop and a
 * start without duplicating this logic — `restartFlair` is now just
 * `stopFlairProcess` followed by `startFlairProcess`.
 *
 * Idempotent-ish: stopping an already-stopped instance is a harmless no-op
 * on both paths (launchctl stop on an unloaded/idle service, or an empty
 * `lsof` match).
 */
async function stopFlairProcess(port: number): Promise<void> {
  if (process.platform === "darwin") {
    const label = "ai.tpsdev.flair";
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (existsSync(plistPath)) {
      try {
        const { execSync } = await import("node:child_process");
        // Ensure the service is loaded (init writes the plist but doesn't load it)
        try { execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" }); } catch {}
        // Capture the current PID *before* stopping so callers that
        // immediately restart can verify exit. Without this, waitForHealth
        // can race against the still-shutting-down old process and return
        // success before KeepAlive brings the new one up.
        const oldPid = readHarperPid(defaultDataDir());
        try { execSync(`launchctl stop ${label}`, { stdio: "pipe" }); } catch {}
        if (oldPid) await waitForProcessExit(oldPid, STARTUP_TIMEOUT_MS);
        return;
      } catch (err: any) {
        console.error(`launchd stop failed, falling back to port-based stop: ${err.message}`);
      }
    }
  }

  // Port-based stop (Linux, or macOS fallback when no launchd plist)
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
}

/**
 * Start the local Flair (Harper) process — launchd `start` on darwin when a
 * plist is present (falling back on failure), otherwise a direct spawn.
 * Counterpart to `stopFlairProcess`; see that function's doc comment.
 */
async function startFlairProcess(port: number): Promise<void> {
  if (process.platform === "darwin") {
    const label = "ai.tpsdev.flair";
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (existsSync(plistPath)) {
      try {
        const { execSync } = await import("node:child_process");
        try { execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" }); } catch {}
        try { execSync(`launchctl start ${label}`, { stdio: "pipe" }); } catch {}
        await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
        return;
      } catch (err: any) {
        console.error(`launchd start failed, falling back to direct start: ${err.message}`);
      }
    }
  }

  console.log("Starting...");
  const bin = harperBin();
  if (!bin) {
    throw new Error("Harper binary not found. Run 'flair init' first.");
  }

  const dataDir = defaultDataDir();
  // Match `flair start`: accept either HDB_ADMIN_PASSWORD or FLAIR_ADMIN_PASS.
  // Without this, `flair init --admin-pass X` (which only exports HDB_*
  // to the initial Harper spawn) followed by `flair restart` would silently
  // drop admin credentials — any subsequent auth'd call returns 401.
  const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS || "";
  const modelsDir = process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ROOTPATH: dataDir,
    // See the matching comment at the install-time spawn site above.
    FLAIR_MODELS_DIR: modelsDir,
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: DEFAULT_ADMIN_USER,
    HTTP_PORT: String(port),
    LOCAL_STUDIO: "false",
  };
  if (adminPass) {
    env.HDB_ADMIN_PASSWORD = adminPass;
  }
  // models (flair#504 Phase 1): no env var needed — resources/embeddings-boot.ts
  // self-registers the backend in-process on every boot (flair#694).

  const proc = spawn(process.execPath, [bin, "run", "."], {
    cwd: flairPackageDir(), env, detached: true, stdio: "ignore",
  });
  proc.unref();

  await waitForHealth(port, DEFAULT_ADMIN_USER, adminPass, STARTUP_TIMEOUT_MS);
}

/**
 * The ONE restart mechanism for a local Flair install. Shared by `flair
 * restart` and `flair upgrade`'s post-install restart step (flair#635) so
 * the two never drift into two different ways to bounce the same process.
 * Composed of `stopFlairProcess` + `startFlairProcess` (flair#637) — the
 * pre-upgrade snapshot step calls those two directly with a snapshot taken
 * in between, instead of going through this wrapper.
 *
 * Throws on failure instead of calling process.exit — callers decide how to
 * react (`flair restart` exits 1; `flair upgrade` treats a failed restart as
 * an upgrade failure and may attempt a rollback).
 */
async function restartFlair(port: number): Promise<void> {
  await stopFlairProcess(port);
  await startFlairProcess(port);
}

program
  .command("restart")
  .description("Restart the Flair (Harper) instance")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    try {
      await restartFlair(port);
      console.log("✅ Flair restarted");
    } catch (err: any) {
      console.error(`❌ Flair failed to restart: ${err?.message ?? err}`);
      process.exit(1);
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

    // flair#504 Phase 2: MUST match resources/embeddings-provider.ts's
    // getModelId() — including THE GATE (EMBEDDING_PREFIXES_ENABLED), not
    // just the suffix. Duplicated as literals, not imported, because
    // src/cli.ts and resources/**.ts are separate build targets —
    // tsconfig.cli.json's rootDir is "src" and only includes src/cli.ts +
    // src/cli-shim.cts, and the published CLI package ships only dist/ built
    // from that config (package.json's "files"), so resources/ isn't
    // reachable from (or bundled into) the CLI binary. THE GATE is now ON
    // (flipped, re-baselined through the ratchet gate — see
    // embeddings-provider.ts's file header and PR #689 for the park history
    // this flip revisits), so `currentModel` here is `<base>+searchprefix` —
    // matching getModelId()'s gate-on return exactly. If
    // EMBEDDING_PREFIXES_ENABLED or EMBEDDING_VARIANT ever changes in
    // embeddings-provider.ts, update this block too — a drift here silently
    // breaks `--stale-only`: it would compare every row's embeddingModel
    // against the WRONG current-model string, so rows would read as already
    // "current" (or as needing re-embed) out of sync with what getModelId()
    // is actually stamping new writes with.
    const EMBEDDING_PREFIXES_ENABLED = true; // MUST mirror resources/embeddings-provider.ts's gate
    const EMBEDDING_VARIANT = "searchprefix";
    const baseModel = process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";
    const currentModel = EMBEDDING_PREFIXES_ENABLED ? `${baseModel}+${EMBEDDING_VARIANT}` : baseModel;

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

      // Fetch every memory via the Harper ops API (search_by_conditions on the
      // Memory table) rather than POST /SemanticSearch. SemanticSearch goes
      // through the HNSW cosine index, which throws "Cosine distance comparison
      // requires an array" against rows whose stored embedding shape is
      // incompatible with the running Harper version (e.g. data written under
      // @harperfast/harper@5.0.1 read under 5.0.9). The ops API bypasses the
      // vector index — exactly what we need when the goal is to replace every
      // embedding with a freshly-computed one. Without this path, `flair
      // reembed` could not recover from the very condition it exists to fix.
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
      // Harper rejects empty-value conditions ("not indexed for nulls"). Use
      // `createdAt > 1970-01-01` as the "select all" pattern: every Memory row
      // has a createdAt, the index is built, and the comparison is total.
      const searchRes = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: opsAuth },
        body: JSON.stringify({
          operation: "search_by_conditions",
          database: "flair",
          table: "Memory",
          operator: "and",
          conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
          get_attributes: ["*"],
          limit: 100000,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories via ops API: ${searchRes.status}`);
        process.exit(1);
      }
      const raw = await searchRes.json() as unknown;
      const allMemories: any[] = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);

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

    // Single-agent path. Same rationale as above: fetch via the ops API
    // (search_by_value on agentId) so the vector index isn't in the read path.
    // This requires admin pass — fall back to the old SemanticSearch fetch only
    // if no admin pass is available, since that path still works on
    // version-matched data and requires only the agent's own key.
    const keysDir = defaultKeysDir();
    const privPath = privKeyPath(agentId, keysDir);
    if (!existsSync(privPath)) {
      console.error(`❌ Key not found: ${privPath}`);
      process.exit(1);
    }

    const adminPassSingle = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
    let allMemories: any[] = [];
    if (adminPassSingle) {
      const opsPort = resolveOpsPort(opts);
      const opsAuth = `Basic ${Buffer.from(`admin:${adminPassSingle}`).toString("base64")}`;
      const searchRes = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: opsAuth },
        body: JSON.stringify({
          operation: "search_by_value",
          database: "flair",
          table: "Memory",
          search_attribute: "agentId",
          search_value: agentId,
          get_attributes: ["*"],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories via ops API: ${searchRes.status}`);
        process.exit(1);
      }
      const raw = await searchRes.json() as unknown;
      allMemories = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);
    } else {
      const searchRes = await authFetch(baseUrl, agentId, privPath, "POST", "/SemanticSearch", {
        agentId, limit: 10000,
      });
      if (!searchRes.ok) {
        console.error(`❌ Failed to fetch memories: ${searchRes.status}`);
        process.exit(1);
      }
      const data = await searchRes.json() as { results?: any[] };
      allMemories = data.results ?? [];
    }

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
    const agentId = opts.agent ?? process.env.FLAIR_AGENT_ID;
    if (!agentId && !process.env.FLAIR_ADMIN_PASS) {
      console.error(`${render.icons.error} ${render.wrap(render.c.red, "set --agent / FLAIR_AGENT_ID or FLAIR_ADMIN_PASS")}`);
      process.exit(1);
    }

    const baseUrl = `http://127.0.0.1:${resolveHttpPort(opts)}`;
    console.log(`\n${render.wrap(render.c.bold, "Flair test")} ${render.wrap(render.c.dim, `(url: ${baseUrl})`)}\n`);

    let passed = 0;
    let failed = 0;
    let memoryId: string | null = null;

    const check = async (name: string, fn: () => Promise<boolean>) => {
      try {
        const ok = await fn();
        if (ok) {
          console.log(`  ${render.icons.ok} ${render.wrap(render.c.green, "PASS")} ${name}`);
          passed++;
        } else {
          console.log(`  ${render.icons.error} ${render.wrap(render.c.red, "FAIL")} ${name}`);
          failed++;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`  ${render.icons.error} ${render.wrap(render.c.red, "FAIL")} ${name}: ${render.wrap(render.c.dim, message?.slice(0, 120))}`);
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

    const passColor = passed > 0 ? render.c.green : render.c.dim;
    const failColor = failed > 0 ? render.c.red : render.c.dim;
    console.log(`\n  ${render.wrap(passColor, `${passed} passed`)} ${render.wrap(render.c.dim, "·")} ${render.wrap(failColor, `${failed} failed`)}`);
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
  .option("--fabric-user <user>", "Fabric admin username (env: FABRIC_USER preferred; inline leaks to shell history)")
  .option("--fabric-password <pass>", "Fabric admin password (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
  .option("--fabric-password-file <path>", "Read the Fabric admin password from a file (chmod 600)")
  .option("--fabric-token <token>", "OAuth bearer token (env: FABRIC_TOKEN) — reserved for future Fabric bearer support")
  .option("--target <url>", "Override the Fabric URL template (https://<cluster>.<org>.harperfabric.com)")
  .option("--project <name>", "Component name in Fabric", "flair")
  .option("--pkg-version <semver>", "Override version label (default: installed package version)")
  .option("--no-replicated", "Disable cluster-wide replication (default: replicated=true)")
  .option("--no-restart", "Do not restart the component after deploy (default: restart=true)")
  .option("--dry-run", "Resolve package, validate args, skip the deploy call")
  .option("--package-root <dir>", "Override package root (mainly for testing)")
  .option("--deployment-timeout <ms>", "Milliseconds harper waits for cluster-wide peer replication (env: FABRIC_DEPLOYMENT_TIMEOUT; default: 600000 — harper's own 120s default is too short for Fabric)")
  .option("--install-timeout <ms>", "Milliseconds harper waits for package install (env: FABRIC_INSTALL_TIMEOUT; default: 600000)")
  .option("--no-verify", "Skip post-deploy served-API verification (default: verify — on by design, so the CLI can't report success on an empty/broken deploy)")
  .option("--verify-timeout <ms>", "Milliseconds to wait for the served API to settle after harper's post-deploy restart before verifying (default: 300000)")
  .option("--verify-resource <name>", "Resource to verify is serving after deploy (repeatable; default: derived from the deployed package's dist/resources)", (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option("--deploy-retries <n>", "Retry the full harper deploy this many times on a detected flaky peer-replication failure ONLY — a normal deploy failure (auth, bad package, ...) never retries (default: 2; 0 disables)", "2")
  .option("--ignore-replication-errors", "If peer replication is still failing once retries are exhausted, treat it as a non-fatal warning and succeed with an origin-only deploy (the peer catches up via federation sync or a later deploy)")
  .option("--no-fleet-verify", "Skip the automatic post-deploy fleet convergence sweep (default: sweep runs — see flair#636)")
  .action(async (opts) => {
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

    let fabricUser: string | undefined;
    let fabricPassword: string | undefined;
    let credWarnings: string[] = [];
    try {
      ({ fabricUser, fabricPassword, warnings: credWarnings } = resolveFabricCredentials(opts));
    } catch (err: any) {
      console.error(red(`Error: ${err.message}`));
      process.exit(1);
    }

    const deployOpts = {
      fabricOrg: opts.fabricOrg ?? process.env.FABRIC_ORG,
      fabricCluster: opts.fabricCluster ?? process.env.FABRIC_CLUSTER,
      fabricUser,
      fabricPassword,
      fabricToken: opts.fabricToken ?? process.env.FABRIC_TOKEN,
      target: opts.target,
      project: opts.project,
      version: opts.pkgVersion,
      replicated: opts.replicated !== false,
      restart: opts.restart !== false,
      dryRun: opts.dryRun ?? false,
      packageRoot: opts.packageRoot,
      deploymentTimeoutMs: Number(opts.deploymentTimeout ?? process.env.FABRIC_DEPLOYMENT_TIMEOUT ?? 600_000),
      installTimeoutMs: Number(opts.installTimeout ?? process.env.FABRIC_INSTALL_TIMEOUT ?? 600_000),
      verify: opts.verify !== false,
      verifyResources: (opts.verifyResource as string[] | undefined)?.length ? opts.verifyResource : undefined,
      verifyTimeoutMs: Number(opts.verifyTimeout ?? 300_000),
      deployRetries: Number(opts.deployRetries ?? 2),
      ignoreReplicationErrors: opts.ignoreReplicationErrors ?? false,
      onProgress: (msg: string) => console.log(dim(`  ${msg}`)),
    };

    const errors = validateDeployOptions(deployOpts);
    if (errors.length) {
      console.error(red("flair deploy: missing required options"));
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }

    // Never log the credential VALUES — only the flag names, via the
    // resolver's own warning strings (see resolveFabricCredentials above).
    for (const w of credWarnings) console.error(dim(w));

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
      if (result.replicationWarning) {
        console.log(`\n${yellow("⚠")} Flair ${result.version} deployed to the ORIGIN NODE ONLY — peer replication did not complete (see warning above). The peer will catch up via federation sync or a later deploy.`);
      } else {
        console.log(`\n${green("✓")} Flair ${result.version} deployed${deployOpts.verify ? " and verified serving" : ""}`);
      }
      console.log(`\n  URL:     ${result.url}`);
      console.log(`  Project: ${result.project}`);

      // ── Post-deploy fleet sweep (flair#636) ─────────────────────────────
      // Harper's own "Successfully deployed" (and the served-API verify
      // above) only confirm the ORIGIN. This sweeps the origin + every known
      // federation peer for actual version/health convergence — the gap that
      // let the 0.21.0 deploy report success while a peer was still throwing
      // 1006s. Skippable with --no-fleet-verify. Needs Basic-auth creds
      // (fabricUser+fabricPassword) — a --fabric-token-only deploy has no way
      // to authenticate the sweep, so it's skipped with a note instead of a
      // silent no-op.
      if (!shouldRunFleetVerify(opts)) {
        console.log(dim("\n(--no-fleet-verify: skipping post-deploy fleet sweep)"));
      } else if (!deployOpts.fabricUser || !deployOpts.fabricPassword) {
        console.log(dim("\n(skipping fleet verify — no --fabric-user/--fabric-password to authenticate the sweep; only --fabric-token was provided)"));
      } else {
        console.log(`\n${green("→")} Fleet verify`);
        const sweep = await sweepFleet({
          target: result.url,
          fabricUser: deployOpts.fabricUser,
          fabricPassword: deployOpts.fabricPassword,
          expectVersion: result.version,
        });
        console.log(renderFleetSweepTable(sweep));
        if (sweep.exitCode !== FLEET_EXIT_OK) {
          console.error(red(`\n✗ fleet verify failed (exit ${sweep.exitCode}) — deploy is NOT fully converged.`));
          process.exit(sweep.exitCode);
        }
      }

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
      if (hint?.includes("component is not serving")) {
        console.error(dim("  hint: harper reported success but the served API disagrees — check the Fabric Studio component logs for the real deploy error, then retry"));
      }
      if (hint?.includes("did not settle")) {
        console.error(dim("  hint: Harper may still be restarting — check Fabric Studio, or retry with a longer --verify-timeout"));
      }
      if (hint?.includes("peer replication failed after")) {
        console.error(dim("  hint: pass --ignore-replication-errors to accept an origin-only deploy, or re-run once the peer link recovers"));
      }
      process.exit(1);
    }
  });

// ─── flair fleet ──────────────────────────────────────────────────────────────
//
// Fabric fleet operations (flair#636). `flair deploy` / `flair upgrade
// --target` already run this sweep automatically post-deploy (skippable
// with --no-fleet-verify) — this is the standalone entry point for running
// it independently, e.g. as a periodic health check or before a rolling
// restart step (see the flair#636 decision comment: this sweep is the gate
// between peers during a rolling restart, not the restart mechanism itself).
const fleet = program.command("fleet").description("Fabric fleet operations (post-deploy convergence verification)");

fleet
  .command("verify")
  .description("Sweep a Fabric origin + its known federation peers for version/health convergence")
  .requiredOption("--target <url>", "Fabric URL to verify (the origin node)")
  .option("--fabric-user <user>", "Fabric admin username (env: FABRIC_USER — preferred; inline leaks to ps/shell history)")
  .option("--fabric-password <pass>", "Fabric admin password (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
  .option("--fabric-password-file <path>", "Read the Fabric admin password from a mode-0600 file (keeps it out of argv and env)")
  .option("--expect-version <semver>", "Version every node must report (default: the origin's own reported version — a self-consistency check)")
  .option("--timeout <ms>", "Per-node /Health poll timeout in ms", "60000")
  .option("--json", "Emit JSON (also: pipe + FLAIR_OUTPUT=json)")
  .addHelpText("after", `
Exit codes:
  0  all nodes verified: healthy, authenticated, and version-matched
  1  origin failed (unreachable, unauthenticated, or wrong version)
  2  origin OK, but a reachable peer is running a DIFFERENT version (skew)
  3  origin OK, no skew among reachable peers, but a peer could not be
     verified at all (unreachable, auth rejected, or no endpoint on file)

"peer" here means a Flair federation peer (GET /FederationPeers on the
origin) — NOT Harper's own cluster-replication nodes, which the OSS
@harperfast/harper build this CLI ships does not expose (cluster_status is
a harper-pro-only operation). A Fabric replica that was never
federation-paired (\`flair federation pair\`) is invisible to this sweep —
see src/fleet-verify.ts's file header for the full caveat.`)
  .action(async (opts) => {
    // Single source of truth for cred resolution + shell-history warnings,
    // shared with `flair upgrade --target` and `flair deploy`.
    const { fabricUser, fabricPassword, warnings } = resolveFabricCredentials(opts);
    for (const w of warnings) console.error(render.wrap(render.c.dim, w));

    if (!fabricUser || !fabricPassword) {
      console.error(render.wrap(render.c.red, "flair fleet verify: credentials required"));
      console.error("  set FABRIC_USER + FABRIC_PASSWORD env, or --fabric-password-file, or (discouraged) --fabric-user/--fabric-password inline");
      process.exit(1);
    }

    const result: FleetSweepResult = await sweepFleet({
      target: opts.target,
      fabricUser,
      fabricPassword,
      expectVersion: opts.expectVersion,
      timeoutMs: Number(opts.timeout ?? 60_000),
    });

    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(result));
    } else {
      console.log(render.wrap(render.c.bold, `Fleet verify — ${result.target}`));
      console.log(renderFleetSweepTable(result));
    }
    process.exit(result.exitCode);
  });

// ─── flair doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Diagnose common Flair problems and suggest fixes")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID to use for the semantic-search round-trip (or FLAIR_AGENT_ID env)")
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

    console.log(`\n${render.wrap(render.c.bold, "🩺 Flair Doctor")}\n`);

    // 0. Version check (flair#587) — offline-tolerant + cached, independent
    // of Harper being up. A gap of ≥2 minor versions (or any major) is
    // treated as loud/red — heuristic for "likely missed a security fix"
    // since we don't have advisory data, only the version gap. A red gap
    // counts as an issue (exit 1); a quieter yellow gap (one minor, or
    // patch-only) is printed but doesn't fail doctor.
    const versionCheckResult = await checkVersion(__pkgVersion);
    const versionNudge = formatVersionNudge(versionCheckResult);
    if (versionNudge) {
      const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
      const icon = versionNudge.severity === "red" ? render.wrap(render.c.red, "✗") : render.icons.warn;
      console.log(`  ${icon} ${render.wrap(color, versionNudge.message)}`);
      if (versionNudge.severity === "red") issues++;
    } else if (versionCheckResult.latest) {
      console.log(`  ${render.icons.ok} flair ${__pkgVersion} is current`);
    }

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
        console.log(`  ${render.icons.warn} PID file contains non-numeric value: ${render.wrap(render.c.dim, pidFile0)} — skipping`);
      }
    }

    if (await probePort(port)) {
      console.log(`  ${render.icons.ok} Harper responding on port ${render.wrap(render.c.bold, String(port))}`);
      harperResponding = true;
    } else {
      // Port didn't respond — but if PID is alive, try to find the real port
      let discoveredPort: number | null = null;
      if (pidAlive) {
        discoveredPort = await discoverPortFromPid(pidValue);
        if (discoveredPort && discoveredPort !== port && await probePort(discoveredPort)) {
          console.log(`  ${render.icons.warn} Harper not on expected port ${port}, but responding on port ${render.wrap(render.c.bold, String(discoveredPort))} ${render.wrap(render.c.dim, `(PID ${pidValue})`)}`);
          console.log(`     ${render.wrap(render.c.dim, `Your config says port ${port} but Harper is actually running on ${discoveredPort}`)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would update config to port")} ${discoveredPort}`);
            } else {
              writeConfig(discoveredPort);
              console.log(`     ${render.icons.ok} Updated config to port ${discoveredPort}`);
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(updates config to match running port)")}`);
          }
          effectivePort = discoveredPort;
          baseUrl = `http://127.0.0.1:${discoveredPort}`;
          harperResponding = true;
          issues++;
        } else {
          console.log(`  ${render.icons.error} Harper process alive (PID ${pidValue}) but not responding on any detected port`);
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          issues++;
        }
      } else {
        // No live PID — Harper genuinely isn't running
        // Check if something else grabbed the port
        try {
          const { execSync } = await import("node:child_process");
          const lsof = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
          if (lsof) {
            console.log(`  ${render.icons.error} Nothing responding on port ${port} ${render.wrap(render.c.dim, `(port occupied by PID ${lsof})`)}`);
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} kill ${lsof} && flair restart`);
          } else {
            console.log(`  ${render.icons.error} Harper is not running`);
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          }
        } catch {
          console.log(`  ${render.icons.error} Harper is not running`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would run:")} flair restart`);
            } else {
              console.log(`     ${render.wrap(render.c.dim, "Attempting restart...")}`);
              try {
                const { execSync } = await import("node:child_process");
                execSync(`${process.argv[0]} ${process.argv[1]} restart --port ${port}`, { stdio: "inherit" });
                console.log(`     ${render.icons.ok} Restart attempted`);
              } catch {
                console.log(`     ${render.icons.error} Restart failed — try: flair init --agent-id <your-agent>`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          }
        }
        issues++;
      }
    }

    // 1a. CLI ↔ running-server version handshake (flair#695 §B) — the
    // version TRIPLE: this CLI's own version (__pkgVersion, checked against
    // npm-latest in step 0 above), and the RUNNING server's reported
    // version (GET /Health — public, no auth needed). A mismatch means the
    // installed package was upgraded but the daemon hasn't restarted onto
    // it yet — exactly the bare-npm trap the global preAction hook (above,
    // every other command) nudges about on stderr; doctor prints the full
    // picture here instead of a one-liner and `--fix` offers the restart.
    let runningVersion: string | null = null;
    if (harperResponding) {
      try {
        const healthRes = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(3000) });
        if (healthRes.ok) {
          const body = (await healthRes.json()) as { version?: unknown };
          runningVersion = typeof body?.version === "string" ? body.version : null;
        }
      } catch { /* leave runningVersion null — reported below as "unknown" */ }

      if (runningVersion && runningVersion !== __pkgVersion) {
        console.log(`  ${render.icons.error} Version mismatch: CLI/installed ${render.wrap(render.c.bold, __pkgVersion)} but server is running ${render.wrap(render.c.bold, runningVersion)}`);
        if (autoFix) {
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would run:")} flair restart`);
          } else {
            try {
              const { execSync } = await import("node:child_process");
              execSync(`${process.argv[0]} ${process.argv[1]} restart --port ${effectivePort}`, { stdio: "inherit" });
              console.log(`     ${render.icons.ok} Restarted onto ${__pkgVersion}`);
            } catch {
              console.log(`     ${render.icons.error} Restart failed — try: flair restart`);
            }
          }
        } else {
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
        }
        issues++;
      } else if (runningVersion) {
        console.log(`  ${render.icons.ok} Server running version matches CLI (${runningVersion})`);
      } else {
        console.log(`  ${render.icons.warn} Could not determine the running server's version`);
      }
    }

    // 2. Keys directory
    const keysDir = defaultKeysDir();
    if (existsSync(keysDir)) {
      const keyFiles = (await import("node:fs")).readdirSync(keysDir).filter((f: string) => f.endsWith(".key"));
      if (keyFiles.length > 0) {
        console.log(`  ${render.icons.ok} Keys found: ${render.wrap(render.c.bold, String(keyFiles.length))} agent(s) in ${render.wrap(render.c.dim, keysDir)}`);
      } else {
        console.log(`  ${render.icons.error} Keys directory exists but no .key files found`);
        console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
        issues++;
      }
    } else {
      console.log(`  ${render.icons.error} Keys directory missing: ${render.wrap(render.c.dim, keysDir)}`);
      console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
      issues++;
    }

    // 3. Config file
    const cfgPath = configPath();
    if (existsSync(cfgPath)) {
      const savedPort = readPortFromConfig();
      console.log(`  ${render.icons.ok} Config: ${render.wrap(render.c.dim, cfgPath)} ${render.wrap(render.c.dim, `(port: ${savedPort ?? "default"})`)}`);
    } else {
      console.log(`  ${render.icons.warn} No config file at ${render.wrap(render.c.dim, cfgPath)} — using defaults`);
    }

    // 4. Embeddings check — REAL semantic round-trip (only if Harper is responding).
    //
    // The dead-simple `{ q: "test" }` probe used to pass even when embeddings were
    // not loaded: SemanticSearch falls back to keyword-only scan, and an
    // unauthenticated probe 401s → "cannot verify" → no issue counted. A clean-VM
    // dogfood found semantic search DEAD out of the box (sudo/root-owned install
    // can't write the models symlink → EACCES) while `flair doctor` reported
    // "no issues found". This now stores a memory with a distinctive phrase and
    // searches for a PARAPHRASE (no shared keywords). If the top result isn't
    // recovered by MEANING, recall-by-meaning is broken and doctor FAILS LOUDLY.
    if (harperResponding) {
      const semanticStatus = await verifySemanticSearch(baseUrl, opts.agent, defaultKeysDir());
      switch (semanticStatus.state) {
        case "ok":
          console.log(`  ${render.icons.ok} Embeddings: semantic search operational ${render.wrap(render.c.dim, `(paraphrase recall verified, score ${semanticStatus.score.toFixed(2)})`)}`);
          break;
        case "degraded":
          // LOUD failure — never report all-clear when recall-by-meaning is dead.
          console.log(`  ${render.icons.error} Semantic search DEGRADED ${render.wrap(render.c.dim, `— ${semanticStatus.detail}`)}`);
          console.log(`     ${render.wrap(render.c.red, "Embeddings are not loaded; recall-by-meaning will NOT work.")}`);
          console.log(`     ${render.wrap(render.c.dim, "Common cause: the embeddings component lacks write access (sudo/root global installs).")}`);
          console.log(`     ${render.wrap(render.c.dim, "See:")} docs/troubleshooting.md ${render.wrap(render.c.dim, "→ \"Semantic search DEGRADED\"")}`);
          issues++;
          break;
        case "skipped":
          // Could not run the round-trip (no agent / no key). Don't claim
          // all-clear — surface that the check was skipped, but don't count it
          // as a hard issue since the user may simply not have an agent yet.
          console.log(`  ${render.icons.warn} Embeddings: not verified ${render.wrap(render.c.dim, `(${semanticStatus.detail})`)}`);
          console.log(`     ${render.wrap(render.c.dim, "Pass --agent <id> (or set FLAIR_AGENT_ID) so doctor can run a real semantic round-trip.")}`);
          break;
      }
    }

    // 5. Stale PID file (skip if already reported in port check)
    const dataDir = defaultDataDir();
    const pidFile = join(dataDir, "hdb.pid");
    if (existsSync(pidFile)) {
      const pidContent = (await import("node:fs")).readFileSync(pidFile, "utf-8").trim();
      try {
        process.kill(Number(pidContent), 0);
        if (harperResponding) {
          console.log(`  ${render.icons.ok} PID file: ${render.wrap(render.c.dim, pidFile)} ${render.wrap(render.c.dim, `(process ${pidContent} is alive)`)}`);
        }
        // If not responding, we already reported the issue in step 1
      } catch {
        console.log(`  ${render.icons.error} Stale PID file: ${render.wrap(render.c.dim, pidFile)} ${render.wrap(render.c.dim, `(process ${pidContent} is dead)`)}`);
        if (autoFix) {
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would remove:")} ${pidFile}`);
          } else {
            (await import("node:fs")).unlinkSync(pidFile);
            console.log(`     ${render.icons.ok} Removed stale PID file`);
          }
        } else {
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} rm ${pidFile} && flair restart`);
        }
        issues++;
      }
    }

    // 6. Data directory
    if (existsSync(dataDir)) {
      console.log(`  ${render.icons.ok} Data directory: ${render.wrap(render.c.dim, dataDir)}`);
    } else {
      // Check ~/harper/ (common alternative)
      const altDir = join(homedir(), "harper");
      if (existsSync(altDir)) {
        console.log(`  ${render.icons.warn} Data at ${render.wrap(render.c.dim, "~/harper/")} (not ${render.wrap(render.c.dim, "~/.flair/data")}) — old install location`);
      } else {
        console.log(`  ${render.icons.error} No data directory found`);
        console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
        issues++;
      }
    }

    // 7. Client integration (flair#588) — the first 6 checks diagnose the
    // SERVER side. This diagnoses whether Flair is actually wired to a real
    // MCP client (Claude Code, Codex, Gemini, Cursor): the MCP block present
    // + reachable + the configured agent genuinely registered (every detected
    // client), plus CLAUDE.md + the SessionStart hook (Claude Code only,
    // since only Claude Code has those mechanisms). Reuses detectClients()
    // rather than reimplementing client detection.
    console.log(`\n  ${render.wrap(render.c.bold, "Client integration")}`);

    // Prompt y/N before a content-editing fix, but only when interactive —
    // in a non-TTY context (CI, scripts) --fix itself is the consent signal,
    // matching how doctor's other --fix branches already behave unprompted.
    // Mirrors the confirm pattern at `flair fabric upgrade` (~line 6258).
    async function confirmFix(question: string): Promise<boolean> {
      if (!process.stdin.isTTY) return true;
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(question, (a) => { rl.close(); res(a); }),
      );
      return /^y(es)?$/i.test(answer.trim());
    }

    const detectedClients = detectClients().filter((c) => c.detected);
    if (detectedClients.length === 0) {
      console.log(`  ${render.icons.info} No MCP client detected — skipping client-integration checks`);
    } else {
      let claudeCodeAgentId: string | undefined;
      let anyKnownAgentId: string | undefined;

      for (const client of detectedClients) {
        const block = readClientMcpBlock(client.id, homedir());
        if (client.id === "claude-code" && block.agentId) claudeCodeAgentId = block.agentId;
        if (block.agentId) anyKnownAgentId = anyKnownAgentId ?? block.agentId;

        if (!block.present) {
          console.log(`  ${render.icons.error} ${client.label}: no Flair MCP server configured in ${render.wrap(render.c.dim, block.configPath)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would wire")} ${client.label} (writes ${block.configPath})`);
            } else {
              const proceed = await confirmFix(`  Wire ${client.label} now? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixAgentId = opts.agent || process.env.FLAIR_AGENT_ID || anyKnownAgentId;
                if (!fixAgentId) {
                  console.log(`     ${render.icons.warn} Cannot auto-wire ${client.label}: no agent id known — pass --agent <id>`);
                } else {
                  const wireEnv = { FLAIR_AGENT_ID: fixAgentId, FLAIR_URL: block.flairUrl || baseUrl };
                  const wireResult =
                    client.id === "claude-code" ? wireClaudeCode(wireEnv) :
                    client.id === "codex" ? wireCodex(wireEnv) :
                    client.id === "gemini" ? wireGemini(wireEnv) :
                    wireCursor(wireEnv);
                  console.log(`     ${wireResult.ok ? render.icons.ok : render.icons.warn} ${wireResult.message}`);
                }
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, `(wires ${client.label} automatically)`)}`);
          }
          issues++;
          continue;
        }

        console.log(`  ${render.icons.ok} ${client.label}: MCP server configured (${render.wrap(render.c.dim, block.configPath)})`);

        const reachable = await probeFlairReachable(block.flairUrl!);
        if (!reachable) {
          console.log(`     ${render.icons.warn} FLAIR_URL ${render.wrap(render.c.dim, block.flairUrl!)} not reachable — cannot verify agent registration`);
          continue;
        }
        console.log(`     ${render.icons.ok} FLAIR_URL ${render.wrap(render.c.dim, block.flairUrl!)} reachable`);

        const reg = await checkAgentRegistered(block.flairUrl!, block.agentId!, defaultKeysDir());
        if (reg.state === "registered") {
          console.log(`     ${render.icons.ok} agent '${block.agentId}' registered`);
        } else if (reg.state === "not-registered") {
          console.log(`     ${render.icons.error} agent '${block.agentId}' is NOT registered on this Flair instance`);
          console.log(`        ${render.wrap(render.c.dim, "Fix:")} flair agent add ${block.agentId}`);
          issues++;
        } else {
          console.log(`     ${render.icons.warn} could not verify agent registration ${render.wrap(render.c.dim, `(${reg.detail})`)}`);
        }
      }

      // Claude-Code-specific: CLAUDE.md + SessionStart hook. Only Claude Code
      // has these mechanisms, so only run them when claude-code was detected.
      if (detectedClients.some((c) => c.id === "claude-code")) {
        const claudeMd = checkClaudeMdBootstrap(process.cwd(), homedir());
        if (claudeMd.present) {
          console.log(`  ${render.icons.ok} CLAUDE.md: bootstrap instruction present (${render.wrap(render.c.dim, claudeMd.path!)})`);
        } else {
          console.log(`  ${render.icons.error} CLAUDE.md: bootstrap instruction not found (checked ${render.wrap(render.c.dim, join(process.cwd(), "CLAUDE.md"))} and ${render.wrap(render.c.dim, join(homedir(), ".claude", "CLAUDE.md"))})`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would append bootstrap instruction to")} ${join(process.cwd(), "CLAUDE.md")}`);
            } else {
              const proceed = await confirmFix(`  Add the Flair bootstrap line to ./CLAUDE.md? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixRes = fixClaudeMdBootstrap(process.cwd());
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(adds the mcp__flair__bootstrap line to ./CLAUDE.md)")}`);
          }
          issues++;
        }

        const hook = checkSessionStartHook(homedir());
        if (hook.present) {
          console.log(`  ${render.icons.ok} SessionStart hook: flair-session-start wired in ${render.wrap(render.c.dim, hook.path)}`);
        } else {
          console.log(`  ${render.icons.error} SessionStart hook: not found in ${render.wrap(render.c.dim, hook.path)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would add SessionStart hook to")} ${hook.path}`);
            } else {
              const proceed = await confirmFix(`  Add the flair-session-start SessionStart hook to ${hook.path}? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixAgentId = claudeCodeAgentId || opts.agent || process.env.FLAIR_AGENT_ID;
                const fixRes = fixSessionStartHook(homedir(), fixAgentId);
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(adds the flair-session-start SessionStart hook)")}`);
          }
          issues++;
        }
      }
    }

    // 8. Fleet presence (flair#639) — known instances via /Presence heartbeats.
    //
    // "Instance" here means each AGENT's heartbeat row — Presence is keyed by
    // agentId (schemas/schema.graphql), not by Flair server — so several rows
    // can (and typically will) share one flairVersion/harperVersion whenever
    // several agents heartbeat through the same Flair. That's still the
    // useful fleet signal: an outlier version on one row means THAT agent's
    // serving instance is behind the rest.
    //
    // SCOPE, verified against runFederationSyncOnce's own table list a few
    // hundred lines up (`const tables = ["Memory", "Soul", "Agent",
    // "Relationship"]`): Presence is NOT one of the tables federation sync
    // replicates. So this section reports only what THIS instance's own
    // Presence table has recorded — every agent whose FLAIR_URL points
    // directly at the Flair `doctor` is talking to. On a hub+spokes
    // deployment where each spoke runs its own separate Flair database, a
    // spoke's locally-recorded heartbeats are invisible from the hub's
    // `doctor` unless those agents also heartbeat straight to the hub. Not
    // fixed here — flair#639's fix list is version-stamping + a doctor
    // listing, not widening federation sync scope.
    if (harperResponding) {
      console.log(`\n  ${render.wrap(render.c.bold, "Fleet presence")}`);
      try {
        // flairVersion/harperVersion are gated to verified readers on the
        // server (resources/Presence.ts, same boundary as currentTask) — sign
        // the GET when we have an agent + key so the fields aren't silently
        // nulled out from under us.
        const fleetAgentId: string | undefined = opts.agent || process.env.FLAIR_AGENT_ID;
        const fleetKeyPath = fleetAgentId ? join(defaultKeysDir(), `${fleetAgentId}.key`) : undefined;
        const canSign = !!(fleetAgentId && fleetKeyPath && existsSync(fleetKeyPath));
        const headers: Record<string, string> = canSign
          ? { Authorization: buildEd25519Auth(fleetAgentId!, "GET", "/Presence", fleetKeyPath!) }
          : {};

        const presRes = await fetch(`${baseUrl}/Presence`, { headers, signal: AbortSignal.timeout(5000) });
        if (!presRes.ok) {
          console.log(`  ${render.icons.warn} Could not fetch presence roster (HTTP ${presRes.status})`);
        } else {
          const roster = (await presRes.json()) as FleetPresenceRow[];
          if (!Array.isArray(roster) || roster.length === 0) {
            console.log(`  ${render.icons.info} No known instances yet — no /Presence heartbeats recorded on this instance`);
          } else {
            const rows = sortOldestVersionFirst(markStale(roster));
            for (const row of rows) {
              const lastSeen = typeof row.lastHeartbeatAt === "number"
                ? render.relativeTime(new Date(row.lastHeartbeatAt).toISOString())
                : "—";
              const versionLabel = !canSign
                ? render.wrap(render.c.dim, "hidden")
                : row.flairVersion
                  ? `v${row.flairVersion}`
                  : render.wrap(render.c.dim, "no version reported");
              const staleNote = row.stale && row.newestVersion
                ? " " + render.wrap(render.c.yellow, `(stale — fleet newest is v${row.newestVersion})`)
                : "";
              const icon = row.stale ? render.icons.warn : render.icons.ok;
              const statusSuffix = row.presenceStatus ? ` (${row.presenceStatus})` : "";
              // Natural-presence: same staleness principle as the version
              // column — a live activity is shown as current, a decayed one as
              // "last-known". `activityFresh === false` (server verdict) plus a
              // known lastActivity → "(was: X)"; a fresh, non-idle activity →
              // "(X)". Skip entirely when there's nothing informative to say
              // (no signal, or idle) so the line stays quiet for the common case.
              const lastActivity = row.lastActivity ?? row.activity;
              const activityNote = row.activityFresh === false
                ? (lastActivity && lastActivity !== "idle"
                    ? " " + render.wrap(render.c.dim, `(was: ${lastActivity})`)
                    : "")
                : (row.activity && row.activity !== "idle"
                    ? " " + render.wrap(render.c.dim, `(${row.activity})`)
                    : "");
              console.log(`  ${icon} ${row.id} — ${versionLabel} — last seen ${lastSeen}${statusSuffix}${activityNote}${staleNote}`);
            }
            if (!canSign) {
              console.log(`     ${render.wrap(render.c.dim, "Pass --agent <id> (with a matching key in ~/.flair/keys) to reveal versions — flairVersion/harperVersion require a verified signature, same as currentTask.")}`);
            }
            console.log(`     ${render.wrap(render.c.dim, "Staleness above is fleet-relative (newest version seen among these instances) — comparing against the latest PUBLISHED flair is the version check at the top of this report, not this section.")}`);
          }
        }
      } catch (err: any) {
        console.log(`  ${render.icons.warn} Fleet presence check failed: ${err?.message ?? err}`);
      }
    }

    // 9. Migration state (flair#695) — pending/in-progress/blocked + last
    // ledger-derived outcome per registered migration, read off the same
    // authenticated /HealthDetail the "Fleet presence" section above
    // already fetches. `--fix` here means the SAME restart offered in step
    // 1a above (a halted migration retries automatically on the next boot —
    // there's no separate "run the migration now" fix; the fix for
    // "blocked" is whatever the halt reason names, e.g. freeing disk).
    if (harperResponding) {
      console.log(`\n  ${render.wrap(render.c.bold, "Migrations")}`);
      try {
        const migAgentId: string | undefined = opts.agent || process.env.FLAIR_AGENT_ID;
        const migKeyPath = migAgentId ? join(defaultKeysDir(), `${migAgentId}.key`) : undefined;
        const migCanSign = !!(migAgentId && migKeyPath && existsSync(migKeyPath));
        if (!migCanSign) {
          console.log(`  ${render.icons.info} Pass --agent <id> (with a matching key in ~/.flair/keys) to see migration state — requires a verified read, same as Fleet presence above.`);
        } else {
          const migHeaders: Record<string, string> = { Authorization: buildEd25519Auth(migAgentId!, "GET", "/HealthDetail", migKeyPath!) };
          const migRes = await fetch(`${baseUrl}/HealthDetail`, { headers: migHeaders, signal: AbortSignal.timeout(5000) });
          if (!migRes.ok) {
            console.log(`  ${render.icons.warn} Could not fetch migration state (HTTP ${migRes.status})`);
          } else {
            const detail = (await migRes.json()) as { migrations?: { cyclePhase?: string; migrations?: Array<{ id: string; state: string; rowsDone: number; rowsRemaining: number; reason?: string }> } };
            const migBlock = detail?.migrations;
            if (!migBlock || !Array.isArray(migBlock.migrations) || migBlock.migrations.length === 0) {
              console.log(`  ${render.icons.info} No migrations registered on this instance`);
            } else {
              if (migBlock.cyclePhase === "pre-hash") {
                console.log(`  ${render.icons.info} Pre-flight integrity check in progress — migrations deferred until it completes`);
              }
              for (const m of migBlock.migrations) {
                if (m.state === "completed") {
                  console.log(`  ${render.icons.ok} ${m.id}: completed`);
                } else if (m.state === "halted" || m.state === "failed") {
                  console.log(`  ${render.icons.error} ${m.id}: ${m.state}${m.reason ? ` — ${m.reason}` : ""}`);
                  issues++;
                } else if (m.state === "running") {
                  console.log(`  ${render.icons.info} ${m.id}: in progress (${m.rowsDone} done, ${m.rowsRemaining} remaining)`);
                } else {
                  console.log(`  ${render.icons.info} ${m.id}: ${m.state}`);
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.log(`  ${render.icons.warn} Migration state check failed: ${err?.message ?? err}`);
      }
    }

    // Summary
    console.log("");
    if (issues === 0) {
      console.log(`  ${render.icons.ok} ${render.wrap(render.c.green, "No issues found")}`);
    } else {
      console.log(`  ${render.icons.error} ${render.wrap(render.c.red, `${issues} issue${issues > 1 ? "s" : ""} found`)} ${render.wrap(render.c.dim, "— see fixes above")}`);
    }
    console.log("");

    if (issues > 0) process.exit(1);
  });

// ─── flair session snapshot ──────────────────────────────────────────────────
// Slice 2 of FLAIR-AGENT-CONTEXT-TIERS-B. Snapshot a
// session jsonl + label metadata into a tar.gz under ~/.flair/snapshots/<agent>/sessions/.
//
// Three subcommands: create | list | restore. Mirrors FLAIR-NIGHTLY-REM's
// snapshot pattern (tar.gz, 600 perms, 30-day retention enforced separately).
//
// Standalone-callable today; harness slices 3+4 will wire it into the
// session-reset pipeline.

const SNAPSHOT_ROOT = resolve(homedir(), ".flair", "snapshots");

function sessionSnapshotDir(agent: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) throw new Error(`invalid agent id: ${agent}`);
  return resolve(SNAPSHOT_ROOT, agent, "sessions");
}

const session = program.command("session").description("Agent session lifecycle (snapshot/restore for FLAIR-AGENT-CONTEXT-TIERS-B)");
const sessionSnapshot = session.command("snapshot").description("Manage session snapshots (tar.gz of session jsonl + metadata)");

sessionSnapshot
  .command("create")
  .description("Create a session snapshot tar.gz")
  .requiredOption("--agent <id>", "Agent the session belongs to")
  .requiredOption("--session-file <path>", "Path to the session jsonl to snapshot (e.g. /tmp/openclaw/openclaw-2026-05-03.log)")
  .option("--label <text>", "Label for the snapshot file (e.g. ops-ID); default: ISO timestamp")
  .action(async (opts) => {
    const sessionFile = resolve(opts.sessionFile);
    if (!existsSync(sessionFile)) {
      console.error(`Error: --session-file does not exist: ${sessionFile}`);
      process.exit(1);
    }
    const dir = sessionSnapshotDir(opts.agent);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = opts.label ? String(opts.label).replace(/[^a-zA-Z0-9._-]/g, "_") : ts;
    const tarballName = opts.label ? `${safeLabel}-${ts}.tar.gz` : `${ts}.tar.gz`;
    const tarballPath = resolve(dir, tarballName);

    // Write a metadata.json into a tmp dir alongside the session file for the
    // tarball, so the snapshot is self-describing.
    const meta = {
      agent: opts.agent,
      label: opts.label ?? null,
      sessionFile,
      sessionFileSize: statSync(sessionFile).size,
      createdAt: new Date().toISOString(),
      flairVersion: __pkgVersion,
    };
    const tmpDir = resolve(dir, `.tmp-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    try {
      const sessionBaseName = sessionFile.split("/").pop() ?? "session.jsonl";
      writeFileSync(resolve(tmpDir, sessionBaseName), readFileSync(sessionFile));
      writeFileSync(resolve(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
      await tarCreate(
        { gzip: true, cwd: tmpDir, file: tarballPath, portable: true },
        [sessionBaseName, "metadata.json"],
      );
      // Tarball perms: 600 (owner-only) — matches FLAIR-NIGHTLY-REM
      chmodSync(tarballPath, 0o600);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    const size = statSync(tarballPath).size;
    console.log(tarballPath);
    console.error(`  agent: ${opts.agent}`);
    console.error(`  label: ${opts.label ?? "(none)"}`);
    console.error(`  size:  ${humanBytes(size)}`);
  });

sessionSnapshot
  .command("list")
  .description("List session snapshots for an agent (or all agents)")
  .option("--agent <id>", "Filter to a single agent")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    if (!existsSync(SNAPSHOT_ROOT)) {
      if (opts.json) { console.log("[]"); return; }
      console.log("(no snapshots — ~/.flair/snapshots/ does not exist yet)");
      return;
    }
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    type Row = { agent: string; file: string; path: string; size: number; mtime: string };
    const rows: Row[] = [];
    const agents = opts.agent ? [opts.agent] : readdirSync(SNAPSHOT_ROOT).filter((d) => {
      try { return statSync(resolve(SNAPSHOT_ROOT, d)).isDirectory(); } catch { return false; }
    });
    for (const a of agents) {
      const dir = resolve(SNAPSHOT_ROOT, a, "sessions");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".tar.gz")) continue;
        const p = resolve(dir, f);
        const s = statSync(p);
        rows.push({ agent: a, file: f, path: p, size: s.size, mtime: s.mtime.toISOString() });
      }
    }
    rows.sort((a, b) => b.mtime.localeCompare(a.mtime));

    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log("(no snapshots)"); return; }

    const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
    const fileW = Math.max(20, ...rows.map((r) => r.file.length));
    console.log(`  ${"agent".padEnd(agentW)}  ${"file".padEnd(fileW)}  size      age`);
    for (const r of rows) {
      console.log(`  ${r.agent.padEnd(agentW)}  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
    }
    console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
  });

sessionSnapshot
  .command("restore")
  .description("Extract a session snapshot to a target directory")
  .requiredOption("--snapshot <path>", "Path to the .tar.gz snapshot")
  .option("--target <dir>", "Directory to extract into (default: <snapshot>.restored next to the snapshot)")
  .option("--dry-run", "List the snapshot's contents without extracting")
  .action(async (opts) => {
    const snapshotPath = resolve(opts.snapshot);
    if (!existsSync(snapshotPath)) {
      console.error(`Error: snapshot does not exist: ${snapshotPath}`);
      process.exit(1);
    }

    if (opts.dryRun) {
      console.log("(dry-run) snapshot contents:");
      const entries: string[] = [];
      await tarList({ file: snapshotPath, onReadEntry: (entry: any) => entries.push(`  ${entry.path}  (${humanBytes(entry.size ?? 0)})`) });
      for (const e of entries) console.log(e);
      return;
    }

    const targetDir = opts.target
      ? resolve(opts.target)
      : `${snapshotPath}.restored`;
    if (existsSync(targetDir)) {
      console.error(`Error: target directory already exists: ${targetDir}`);
      console.error(`  Pass --target <new-path> or remove the existing dir.`);
      process.exit(1);
    }
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    await tarExtract({ file: snapshotPath, cwd: targetDir });
    console.log(targetDir);
    console.error(`  extracted to: ${targetDir}`);
  });

// ─── Memory and Soul commands ────────────────────────────────────────────────

const memory = program.command("memory").description("Manage agent memories");
memory.command("add [content]")
  .description("Write a new memory row for an agent (content via positional arg or --content)")
  .requiredOption("--agent <id>")
  .option("--content <text>", "memory content (alias for positional arg)")
  .option("--durability <d>", "standard").option("--tags <csv>")
  .option("--summary <text>", "agent-set multi-sentence dense compression (3-tier chain: subject → summary → content)")
  .option("--subject <text>", "one-line title / entity this memory is about")
  .option("--derived-from <csv>", "Comma-separated source Memory IDs this memory was distilled/reflected from (sets Memory.derivedFrom; used by the `rem rapid` reflection loop)")
  .option("--visibility <value>", "Writer-controlled sharing intent (sets Memory.visibility): 'private' (owner-only, never visible to any other agent) or 'shared' (visible to owner + every other agent on this instance — open within the org, not gated by a MemoryGrant). Omit to use the server's durability-keyed default: permanent/persistent -> shared, standard/ephemeral -> private (flair#509)")
  .action(async (contentArg, opts) => {
    const content = contentArg ?? opts.content;
    if (!content) { console.error("error: content required (positional arg or --content)"); process.exit(1); }
    const memId = `${opts.agent}-${Date.now()}`;
    const body: any = {
      id: memId, agentId: opts.agent, content, durability: opts.durability || "standard",
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
      type: "memory", createdAt: new Date().toISOString(),
    };
    if (opts.summary) body.summary = opts.summary;
    if (opts.subject) body.subject = opts.subject;
    if (opts.visibility) body.visibility = String(opts.visibility).trim();
    if (opts.derivedFrom) {
      body.derivedFrom = String(opts.derivedFrom).split(",").map((x: string) => x.trim()).filter(Boolean);
    }
    const out = await api("PUT", `/Memory/${memId}`, body);
    console.log(JSON.stringify(out, null, 2));
  });
// ─── flair memory write-task-summary ────────────────────────────────────────
// Slice 1 of FLAIR-AGENT-CONTEXT-TIERS-B. Standalone
// helper that any agent harness (or a manual operator) can invoke at task
// close to capture a structured task summary as a persistent Memory row
// before resetting the session.
//
// The shape of this row matters: tags=['task-summary','auto-on-reset'] +
// subject='task:<beads-id>' + summary populated. Slice 3+4 (harness
// integrations) will call this as part of the reset pipeline; slice 5+6
// (operator surfaces) will surface promote/restore controls. Today, this
// command is independently useful — operator can capture a manual summary
// at any time.
//
// Returns the memory id on stdout (single line, parseable) so the harness
// can plumb it into the next-dispatch system message.

memory.command("write-task-summary")
  .description("Capture a structured task summary as a persistent Memory row (used by session-reset harness; standalone-callable by operators)")
  .requiredOption("--agent <id>", "Agent the summary belongs to")
  .requiredOption("--beads <ops-id>", "Bead/PR/task identifier this summary is about")
  .requiredOption("--outcome <s>", "Outcome of the task: merged | rejected | abandoned")
  .option("--summary <text>", "Multi-sentence dense compression (populates Memory.summary; will be the agent's read-time view)")
  .option("--files-touched <csv>", "Comma-separated list of files touched during the task (becomes part of content)")
  .option("--lessons <text>", "Lessons learned during the task (becomes part of content)")
  .option("--derived-from <csv>", "Comma-separated list of source Memory IDs this summary was distilled from")
  .action(async (opts) => {
    const validOutcomes = new Set(["merged", "rejected", "abandoned"]);
    if (!validOutcomes.has(opts.outcome)) {
      console.error(`Error: --outcome must be one of: merged, rejected, abandoned (got: ${opts.outcome})`);
      process.exit(1);
    }
    if (!opts.summary && !opts.lessons && !opts.filesTouched) {
      console.error("Error: at least one of --summary, --lessons, --files-touched is required (otherwise the summary has no content)");
      process.exit(1);
    }

    // Build the structured content block. Format chosen to be parseable + readable
    // — the agent reads it back on bootstrap of the next session.
    const lines: string[] = [];
    lines.push(`task: ${opts.beads}`);
    lines.push(`outcome: ${opts.outcome}`);
    if (opts.filesTouched) lines.push(`files: ${opts.filesTouched}`);
    if (opts.lessons) {
      lines.push("");
      lines.push("lessons:");
      lines.push(opts.lessons);
    }
    if (opts.summary) {
      lines.push("");
      lines.push("summary:");
      lines.push(opts.summary);
    }
    const content = lines.join("\n");

    const memId = `${opts.agent}-task-${opts.beads}-${Date.now()}`;
    const body: any = {
      id: memId,
      agentId: opts.agent,
      content,
      durability: "persistent",
      tags: ["task-summary", "auto-on-reset"],
      subject: `task:${opts.beads}`,
      type: "task-summary",
      createdAt: new Date().toISOString(),
    };
    if (opts.summary) body.summary = opts.summary;
    if (opts.derivedFrom) {
      body.derivedFrom = String(opts.derivedFrom).split(",").map((x: string) => x.trim()).filter(Boolean);
    }

    const out = await api("PUT", `/Memory/${encodeURIComponent(memId)}`, body);
    if (out?.error) {
      console.error(`Error writing task summary: ${out.error}`);
      process.exit(1);
    }
    // Print just the memory id on stdout so the harness can capture it
    // without parsing a JSON blob.
    console.log(memId);
  });

memory.command("search [query]")
  .description("Semantic search over an agent's memories (query via positional arg or --q)")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--q <query>", "search query (alias for positional arg)")
  .option("--limit <n>", "Max results", "5")
  .option("--tag <tag>")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--port <port>", "Harper HTTP port")
  .action(async (queryArg, opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
      process.exit(2);
    }
    const q = queryArg ?? opts.q;
    if (!q) { console.error("error: query required (positional arg or --q)"); process.exit(1); }
    const body: Record<string, any> = { agentId, q, limit: parseInt(opts.limit, 10) || 5 };
    if (opts.tag) body.tag = opts.tag;
    const baseUrl = resolveBaseUrl(opts);
    const res = await api("POST", "/SemanticSearch", body, { baseUrl });
    console.log(JSON.stringify(res, null, 2));
  });
memory.command("list")
  .description("List an agent's memories (optionally filtered by --tag or embedding-backfill triage)")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--tag <tag>")
  .option("--hash-fallback", "Only memories with missing or hash-fallback embeddings (for backfill triage)")
  .option("--limit <n>", "Max rows when using --hash-fallback", "50")
  .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
      process.exit(2);
    }
    const q = new URLSearchParams({ agentId, ...(opts.tag ? { tag: opts.tag } : {}) }).toString();
    const raw = await api("GET", `/Memory?${q}`);
    const mode = render.resolveOutputMode(opts);

    // hashFallback flag changes the lens: instead of all memories, show
    // only those that need re-embedding. Keep that surface separate.
    if (opts.hashFallback) {
      const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
      const fallback = all.filter((m: any) => !m.embeddingModel || m.embeddingModel === "hash-512d");
      if (mode === "json") {
        console.log(render.asJSON(fallback));
        return;
      }
      if (fallback.length === 0) {
        console.log(`${render.icons.ok} ${render.wrap(render.c.green, "All memories embedded")} ${render.wrap(render.c.dim, `(agent ${agentId})`)}`);
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
      console.log(
        `${render.icons.warn} ${render.wrap(render.c.yellow, String(fallback.length))} hash-fallback memories for agent ${render.wrap(render.c.bold, agentId)} ${render.wrap(render.c.dim, `(showing ${rows.length})`)}\n`,
      );
      const cols: render.TableColumn[] = [
        { label: "id", key: "id" },
        {
          label: "created_at",
          key: "createdAt",
          format: (v) => (v ? String(v).slice(0, 19).replace("T", " ") : "—"),
        },
        {
          label: "preview",
          key: "content",
          format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
        },
      ];
      console.log(render.table(cols, rows as Array<Record<string, unknown>>));
      if (fallback.length > rows.length) {
        console.log(
          `\n${render.wrap(render.c.dim, `... ${fallback.length - rows.length} more (raise with --limit). To backfill:`)} flair reembed --agent ${agentId} --stale-only`,
        );
      } else {
        console.log(`\n${render.wrap(render.c.dim, "To backfill:")} flair reembed --agent ${agentId} --stale-only`);
      }
      return;
    }

    // Default lens: all memories for the agent.
    const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
    if (mode === "json") {
      console.log(render.asJSON(all));
      return;
    }
    if (all.length === 0) {
      console.log(`${render.icons.info} ${render.wrap(render.c.dim, `No memories for agent ${agentId}`)}`);
      return;
    }
    console.log(
      `${render.wrap(render.c.bold, String(all.length))} memories for agent ${render.wrap(render.c.bold, agentId)}${opts.tag ? ` ${render.wrap(render.c.dim, `(tag=${opts.tag})`)}` : ""}\n`,
    );
    const sorted = all
      .slice()
      .sort((a: any, b: any) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
    const durabilityColor = (d: string): string => {
      if (d === "permanent") return render.c.magenta;
      if (d === "persistent") return render.c.blue;
      if (d === "ephemeral") return render.c.gray;
      return render.c.cyan;
    };
    const cols: render.TableColumn[] = [
      {
        label: "created_at",
        key: "createdAt",
        format: (v) => (v ? render.wrap(render.c.dim, String(v).slice(0, 10)) : render.wrap(render.c.dim, "—")),
      },
      {
        label: "durability",
        key: "durability",
        format: (v) => {
          const d = String(v ?? "standard");
          return render.wrap(durabilityColor(d), d);
        },
      },
      {
        label: "preview",
        key: "content",
        format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
      },
    ];
    console.log(render.table(cols, sorted as Array<Record<string, unknown>>));
  });

// ─── flair memory hygiene ────────────────────────────────────────────────────
// Detect + remove junk memory rows that accumulate over time. Surfaced from
// a 2026-05-07 manual cleanup: an instance had 627 records, ~250 of
// them were noise — `*-compact-*` ID fragments from an old pipeline, pangram
// test content ("the quick brown fox..." / "Flair 251 test ..."), and
// near-empty rows (<25 chars). We did the cleanup ad-hoc with raw curl + jq;
// this command bundles those patterns + future ones as an operator tool that
// dry-runs by default.
//
// Three pattern categories, each toggle-able:
//   --pattern compact-id   : ids matching /-compact-/ (legacy pipeline output)
//   --pattern test-content : content matching pangram / known test strings
//   --pattern tiny         : content shorter than 25 chars
//
// Default is all three, dry-run. Flip --apply to actually delete. Always
// requires admin pass to read across agent scopes (uses ops API).
//
// Federation note: this only deletes on the local instance. Federation
// distributed-delete via tombstones is the systemic answer for
// fan-out — until that lands, run `flair memory hygiene` on each peer.

// Exported for unit testing — keeps the predicate logic separable from
// the CLI plumbing, ops-API fetching, and confirmation flow.
export const HYGIENE_TEST_CONTENT_PATTERNS: RegExp[] = [
  /quick brown fox/i,
  /flair\s*251\s*test/i,
  /^upgrade-smoke-(pre|post)-marker$/i,
];

export interface HygieneRow { id: string; content?: string }
export type HygieneCategory = "compact-id" | "test-content" | "tiny";
export interface HygieneOptions { enabled: Set<HygieneCategory>; tinyThreshold: number }

/** Categorize a single memory row against the enabled hygiene patterns.
 *  Returns the list of categories the row matches; empty array means clean.
 *  Pure function — easy to unit test and reason about. */
export function categorizeForHygiene(row: HygieneRow, opts: HygieneOptions): HygieneCategory[] {
  const cats: HygieneCategory[] = [];
  if (opts.enabled.has("compact-id") && typeof row.id === "string" && row.id.includes("-compact-")) {
    cats.push("compact-id");
  }
  if (opts.enabled.has("test-content") && typeof row.content === "string" && HYGIENE_TEST_CONTENT_PATTERNS.some((p) => p.test(row.content!))) {
    cats.push("test-content");
  }
  if (opts.enabled.has("tiny") && typeof row.content === "string" && row.content.length < opts.tinyThreshold) {
    cats.push("tiny");
  }
  return cats;
}

memory.command("hygiene")
  .description("Detect and (with --apply) remove junk memory rows from the local instance")
  .option("--apply", "Actually delete the matched rows (default: dry-run)")
  .option("--pattern <list>", "Comma-separated patterns to match: compact-id,test-content,tiny (default: all)")
  .option("--tiny-threshold <n>", "Char length below which content is 'tiny'", "25")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper ops API port (default: HTTP - 1)")
  .action(async (opts) => {
    const opsPort = resolveOpsPort(opts);
    const adminPass = process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD;
    if (!adminPass) {
      console.error("❌ Admin password required (set FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD).");
      process.exit(1);
    }

    const enabled = new Set(
      (opts.pattern ?? "compact-id,test-content,tiny").split(",").map((s: string) => s.trim()).filter(Boolean),
    );
    const tinyThreshold = Math.max(0, Number(opts.tinyThreshold) || 25);
    const apply: boolean = !!opts.apply;

    const opsAuth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
    async function ops(body: unknown): Promise<unknown> {
      const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: opsAuth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(`ops API failed (${res.status}): ${await res.text().catch(() => "")}`);
      }
      return res.json();
    }

    // Fetch all rows via ops API. Bypasses /SemanticSearch (vector index) the
    // same way `flair reembed` does, so this command works even when the
    // cosine path is broken — exactly the conditions hygiene is most needed.
    console.log("Scanning Memory table...");
    const raw = await ops({
      operation: "search_by_conditions",
      database: "flair",
      table: "Memory",
      operator: "and",
      conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
      get_attributes: ["id", "agentId", "content", "createdAt"],
      limit: 100000,
    });
    const rows: any[] = Array.isArray(raw) ? raw : ((raw as { results?: any[] })?.results ?? []);
    console.log(`  ${rows.length} total memories scanned.`);

    // Match each pattern. Counts by category, single id list for the delete.
    const matched = new Map<HygieneCategory, Set<string>>();
    const allIds = new Set<string>();
    const hygieneOpts: HygieneOptions = { enabled: enabled as Set<HygieneCategory>, tinyThreshold };

    for (const r of rows) {
      const categories = categorizeForHygiene(r, hygieneOpts);
      for (const c of categories) {
        if (!matched.has(c)) matched.set(c, new Set());
        matched.get(c)!.add(r.id);
        allIds.add(r.id);
      }
    }

    console.log("");
    console.log(`Match summary (${apply ? "APPLY" : "dry-run"}):`);
    const allCategories: HygieneCategory[] = ["compact-id", "test-content", "tiny"];
    for (const c of allCategories) {
      const n = matched.get(c)?.size ?? 0;
      const enabledMark = enabled.has(c) ? "✓" : "·";
      console.log(`  ${enabledMark} ${c.padEnd(13)} ${n.toString().padStart(5)} rows`);
    }
    console.log(`  ────────────────────────────`);
    console.log(`    total unique ${allIds.size.toString().padStart(5)} rows`);

    if (allIds.size === 0) {
      console.log("\n✅ Nothing to clean.");
      return;
    }

    if (!apply) {
      console.log("\n(dry-run) — re-run with --apply to delete the matched rows.");
      return;
    }

    // Delete in chunks (Harper accepts batches of hash_values).
    const ids = Array.from(allIds);
    const chunkSize = 200;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const batch = ids.slice(i, i + chunkSize);
      const result = await ops({
        operation: "delete",
        database: "flair",
        table: "Memory",
        hash_values: batch,
      }) as { message?: string };
      const m = /(\d+)\s*of\s*\d+\s*records/.exec(result.message ?? "");
      deleted += m ? Number(m[1]) : batch.length;
      process.stdout.write(`\r  Deleting ${deleted}/${ids.length} (${Math.round((deleted / ids.length) * 100)}%)`);
    }
    console.log(`\n\n✅ Deleted ${deleted} rows.`);
    console.log("");
    console.log("Note: this is a local-instance delete. Federated peers will keep their copies until");
    console.log("tombstone-based distributed delete lands. Until then, run `flair memory");
    console.log("hygiene --apply` on each peer to fan out.");
  });

// ─── flair search (top-level shortcut) ───────────────────────────────────────

// Parse --since / --as-of: accept ISO 8601 OR relative expressions
// ("1h", "7d", "30m"). Returns ISO 8601 string or null if input is empty.
// Returns the original string unchanged if it looks like a date (caller
// passes through to server, which validates).
function parseRelativeOrIso(input: string | undefined): string | null {
  if (!input) return null;
  const m = input.match(/^(\d+)([smhdw])$/);
  if (!m) return input;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  const multMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return new Date(Date.now() - n * (multMs[unit] ?? 0)).toISOString();
}

program
  .command("search <query>")
  .description("Search memories by meaning (shortcut for memory search) — filterable, with --explain ranking")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--limit <n>", "Max results", "5")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--key <path>", "Ed25519 private key path")
  // Server-side filters (forwarded to /SemanticSearch payload)
  .option("--tag <tag>", "Filter to memories carrying this tag")
  .option("--subject <subject>", "Filter to memories carrying this subject (case-insensitive)")
  .option("--subjects <list>", "Comma-separated list of subjects to OR-filter (case-insensitive)")
  .option("--since <iso-or-relative>", "Only memories created after this point (ISO 8601 or '7d'/'24h'/'30m')")
  .option("--as-of <iso>", "Temporal validity: only memories valid at this point (ISO 8601)")
  .option("--include-superseded", "Include memories that have been superseded")
  .option("--scoring <mode>", "Scoring mode: raw (default) uses cosine similarity/BM25 only; composite re-ranks by durability/recency/retrieval (measurably hurts precision as of flair#623 — opt-in only)", "raw")
  .option("--min-score <n>", "Drop results below this score (0..1)", "0")
  // Client-side filters (applied after server response)
  .option("--durability <level>", "Filter to permanent|persistent|standard|ephemeral (client-side)")
  .option("--source <name>", "Filter by source/agentId (client-side)")
  // Output modes
  .option("--explain", "Show score breakdown (composite, raw, durability, age, retrieval) per hit")
  .option("--json", "Output raw JSON array")
  .action(async (query, opts) => {
    try {
      const agentId = resolveAgentIdOrEnv(opts);
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }
      const baseUrl = resolveBaseUrl(opts);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(agentId, "POST", "/SemanticSearch", keyPath);
      }

      // Build payload from CLI options. Server validates types.
      const payload: Record<string, any> = {
        agentId,
        q: query,
        limit: Number.parseInt(opts.limit, 10) || 5,
        scoring: opts.scoring === "composite" ? "composite" : "raw",
      };
      if (opts.tag) payload.tag = opts.tag;
      if (opts.subject) payload.subject = opts.subject;
      if (opts.subjects) payload.subjects = String(opts.subjects).split(",").map((s) => s.trim()).filter(Boolean);
      const since = parseRelativeOrIso(opts.since);
      if (since) payload.since = since;
      if (opts.asOf) payload.asOf = opts.asOf;
      if (opts.includeSuperseded) payload.includeSuperseded = true;
      const minScore = Number.parseFloat(opts.minScore ?? "0");
      if (Number.isFinite(minScore) && minScore > 0) payload.minScore = minScore;

      const res = await fetch(`${baseUrl}/SemanticSearch`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = (await res.json()) as any;
      let results: any[] = result.results || result || [];
      if (!Array.isArray(results)) results = [];

      // Client-side filters: durability + source. Server doesn't expose these
      // as conditions, so we filter after fetch.
      if (opts.durability) {
        const allowed = new Set(String(opts.durability).split(",").map((d) => d.trim()));
        results = results.filter((r) => allowed.has(r.durability ?? "standard"));
      }
      if (opts.source) {
        const allowed = new Set(String(opts.source).split(",").map((s) => s.trim()));
        results = results.filter((r) => allowed.has(r._source ?? r.agentId ?? ""));
      }

      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(results));
        return;
      }

      if (results.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No results found.")}`);
        const filters: string[] = [];
        if (opts.tag) filters.push(`tag=${opts.tag}`);
        if (opts.subject) filters.push(`subject=${opts.subject}`);
        if (opts.subjects) filters.push(`subjects=${opts.subjects}`);
        if (opts.since) filters.push(`since=${opts.since}`);
        if (opts.durability) filters.push(`durability=${opts.durability}`);
        if (opts.source) filters.push(`source=${opts.source}`);
        if (filters.length > 0) {
          console.log(`  ${render.wrap(render.c.dim, "Filters:")} ${filters.join(render.wrap(render.c.dim, " · "))}`);
          console.log(
            `  ${render.icons.arrow} ${render.wrap(render.c.dim, "Try removing a filter or:")} flair search "${query}" --agent ${agentId}`,
          );
        }
        return;
      }

      const durabilityColor = (d: string): string => {
        if (d === "permanent") return render.c.magenta;
        if (d === "persistent") return render.c.blue;
        if (d === "ephemeral") return render.c.gray;
        return render.c.cyan;
      };

      for (const r of results) {
        const date = r.createdAt ? String(r.createdAt).slice(0, 10) : "";
        const scoreVal = typeof r._score === "number" ? r._score : 0;
        const scorePct = typeof r._score === "number" ? `${(scoreVal * 100).toFixed(0)}%` : "";
        const scoreColor = scoreVal >= 0.7 ? render.c.green : scoreVal >= 0.4 ? render.c.yellow : render.c.dim;
        const durability = r.durability ?? "standard";
        const metaParts: string[] = [];
        if (date) metaParts.push(render.wrap(render.c.dim, date));
        metaParts.push(render.wrap(durabilityColor(durability), durability));
        if (scorePct) metaParts.push(render.wrap(scoreColor, scorePct));
        if (r._source) metaParts.push(render.wrap(render.c.cyan, `from:${r._source}`));
        const meta = metaParts.join(render.wrap(render.c.dim, " · "));
        console.log(`  ${r.content}`);
        if (meta) console.log(`  ${render.wrap(render.c.dim, "(")} ${meta} ${render.wrap(render.c.dim, ")")}`);
        if (opts.explain) {
          const parts: string[] = [];
          if (typeof r._rawScore === "number") parts.push(`raw=${r._rawScore.toFixed(3)}`);
          if (typeof r._score === "number") parts.push(`composite=${r._score.toFixed(3)}`);
          if (typeof r.retrievalCount === "number" && r.retrievalCount > 0) parts.push(`retrievals=${r.retrievalCount}`);
          if (r.tags && Array.isArray(r.tags) && r.tags.length > 0) parts.push(`tags=[${r.tags.join(",")}]`);
          if (r.subject) parts.push(`subject=${r.subject}`);
          if (r.supersedes) parts.push(`supersedes=${r.supersedes}`);
          if (parts.length > 0) {
            console.log(
              `    ${render.wrap(render.c.gray, "└─")} ${render.wrap(render.c.dim, parts.join(" · "))}`,
            );
          }
        }
        console.log();
      }

      if (opts.explain) {
        const formula =
          payload.scoring === "composite"
            ? "semantic × durability-weight × recency-decay × retrieval-boost"
            : "cosine similarity only";
        console.log(
          `${render.wrap(render.c.dim, "Scoring:")} ${render.wrap(render.c.bold, payload.scoring)}  ${render.wrap(render.c.dim, `(${formula})`)}`,
        );
      }
    } catch (err: any) {
      console.error(`${render.icons.error} Search failed: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair bootstrap ─────────────────────────────────────────────────────────
//
// `flair bootstrap` prints agent context (soul, memories) and a structured budget
// footer summarizing token usage and memory inclusion/truncation. The footer is
// parseable for downstream agents to react to budget pressure.
//
// Budget footer format (printed to stderr):
//   [budget: <used>/<max> tokens, <included> included, <truncated> truncated]
//
// Fields:
//   - tokens: estimated tokens used / max budget
//   - included: number of memories/soul entries included in context
//   - truncated: number of memories excluded due to token budget
//
// When truncated &gt; 0, the agent should consider asking for more context or reducing scope.

program
  .command("bootstrap")
  .description("Cold-start context: get soul + recent memories as formatted text")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--max-tokens <n>", "Maximum tokens in output", "4000")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--key <path>", "Ed25519 private key path")
  .option("--json", "Emit JSON {context, tokenEstimate, memoriesIncluded, ...} (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
      process.exit(2);
    }
    const baseUrl = resolveBaseUrl(opts);
    const mode = render.resolveOutputMode(opts);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(agentId, "POST", "/BootstrapMemories", keyPath);
      }
      const res = await fetch(`${baseUrl}/BootstrapMemories`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId, maxTokens: parseInt(opts.maxTokens, 10) }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body}`);
      }
      const result = (await res.json()) as any;

      if (mode === "json") {
        // Agent-first: emit the full server response, augmented with the cap
        // that was requested. Includes context, sections, tokenEstimate, etc.
        console.log(render.asJSON({ ...result, maxTokens: parseInt(opts.maxTokens, 10) }));
        return;
      }

      // Human mode: print context to stdout, budget footer to stderr (parseable).
      if (result.context) {
        console.log(result.context);
      } else {
        console.error(`${render.icons.error} No context available.`);
        process.exit(1);
      }
      const tokensUsed = result.tokenEstimate ?? 0;
      const maxTokens = parseInt(opts.maxTokens, 10);
      const included = result.memoriesIncluded ?? 0;
      const truncated = result.memoriesTruncated ?? 0;
      const tokenPct = maxTokens > 0 ? (tokensUsed / maxTokens) * 100 : 0;
      const tokenIcon = tokenPct >= 90 ? render.icons.warn : tokenPct >= 70 ? render.icons.info : render.icons.ok;
      const truncIcon = truncated > 0 ? render.icons.warn : render.icons.ok;
      console.error(
        `${tokenIcon} budget ${tokensUsed}/${maxTokens} tokens (${tokenPct.toFixed(0)}%) ${render.icons.bullet} ${render.icons.ok} ${included} included ${render.icons.bullet} ${truncIcon} ${truncated} truncated`,
      );
    } catch (err: any) {
      console.error(`${render.icons.error} Bootstrap failed: ${err.message}`);
      process.exit(1);
    }
  });

// ─── flair relationship add ──────────────────────────────────────────────────
//
// Ergonomic agent-directed write surface for the Relationship graph
// (relationship-write-path spec): an explicit subject/predicate/object triple
// ("record that <subject> <predicate> <object>"), distinct from a free-text
// Memory. Mirrors `flair memory add`'s shape (--agent required, signed via
// the shared `api()` helper — see api()'s doc above for the Ed25519
// resolution order) rather than hand-rolling a signer, per this repo's
// existing convention (flair orgevent does hand-roll one because OrgEvent.put()
// self-verifies authorId against the signature; Relationship doesn't need that
// — the server stamps agentId from the verdict regardless of what's sent).
//
// PUTs to the CANONICAL id (see canonicalRelationshipId below), not a random
// one — re-running this command with the SAME subject/predicate/object
// UPSERTS the existing row (confidence/validTo/source refresh) instead of
// creating a duplicate. This mirrors flair-client's RelationshipApi.write()
// (packages/flair-client/src/client.ts) BYTE FOR BYTE — the CLI can't import
// that workspace package into the published @tpsdev-ai/flair bundle (same
// reasoning as the existing Memory-id-generation mirroring a few thousand
// lines up), so the algorithm is duplicated here rather than shared. A
// cross-check test (test/unit/cli-relationship-add.test.ts) pins the two
// implementations to identical output so they can't silently drift apart —
// a drift here would mean the CLI and the MCP tool/RelationshipApi land the
// SAME triple at TWO different ids, defeating the whole dedup guarantee.
function canonicalRelationshipId(agentId: string, subject: string, predicate: string, object: string): string {
  const material = [agentId, subject, predicate, object].join("\u0000").toLowerCase();
  return createHash("sha256").update(material, "utf8").digest().subarray(0, 16).toString("base64url");
}

const relationship = program.command("relationship").description("Manage agent relationship triples (knowledge graph)");
relationship.command("add")
  .description(
    "Record that <subject> <predicate> <object> — an explicit entity-to-entity relationship triple. " +
    "Re-asserting the SAME triple (same subject/predicate/object) UPSERTS the existing row rather than " +
    "duplicating it. Predicate is free text; recommended vocabulary: manages, works_on, reviews, depends_on, " +
    "replaces, owns, reports_to, advises. To CONTRADICT a prior relationship: changing the predicate creates " +
    "a SEPARATE row and does NOT auto-close the old one — re-assert the OLD triple with --valid-to set to now " +
    "(or delete it) before/after writing the new one.",
  )
  .requiredOption("--agent <id>")
  .requiredOption("--subject <text>", "Source entity (e.g. 'nathan')")
  .requiredOption("--predicate <text>", "Relationship type, free text (e.g. 'manages')")
  .requiredOption("--object <text>", "Target entity (e.g. 'flair')")
  .option("--confidence <n>", "0.0-1.0, how certain (default 1.0 = explicitly stated)")
  .option("--valid-from <iso>", "ISO timestamp this relationship became true (default: now)")
  .option("--valid-to <iso>", "ISO timestamp this relationship ended (leave unset for an active relationship)")
  .option("--source <text>", "Where this was learned from (a memory ID, conversation, etc.)")
  .action(async (opts) => {
    const id = canonicalRelationshipId(opts.agent, opts.subject, opts.predicate, opts.object);
    const body: Record<string, unknown> = {
      id,
      agentId: opts.agent,
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object,
    };
    if (opts.confidence !== undefined) body.confidence = Number(opts.confidence);
    if (opts.validFrom) body.validFrom = opts.validFrom;
    if (opts.validTo) body.validTo = opts.validTo;
    if (opts.source) body.source = opts.source;
    const out = await api("PUT", `/Relationship/${id}`, body);
    console.log(JSON.stringify(out, null, 2));
  });

const soul = program.command("soul").description("Manage agent soul entries");
soul.command("set")
  .description("Set (upsert) a soul entry for an agent by key")
  .requiredOption("--agent <id>")
  .requiredOption("--key <key>")
  .requiredOption("--value <value>")
  .option("--durability <d>", "permanent")
  .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    // PUT /Soul/{agentId:key} (upsert by id), matching flair-client's soul.set().
    // The Soul table resource has no POST handler, so a collection POST /Soul
    // 405s; the record must be written by its primary key. (#498)
    const id = `${opts.agent}:${opts.key}`;
    const out = await api("PUT", `/Soul/${encodeURIComponent(id)}`, {
      id,
      agentId: opts.agent,
      key: opts.key,
      value: opts.value,
      durability: opts.durability,
      createdAt: new Date().toISOString(),
    });
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(out));
      return;
    }
    console.log(`${render.icons.ok} ${render.wrap(render.c.green, "soul entry set")}`);
    console.log(render.kv("agent", opts.agent));
    console.log(render.kv("key", render.wrap(render.c.bold, opts.key)));
    console.log(render.kv("value", String(opts.value)));
    if (opts.durability) console.log(render.kv("durability", render.wrap(render.c.magenta, opts.durability)));
  });

soul.command("get")
  .description("Fetch a single soul entry by id (agent:key)")
  .argument("<id>")
  .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (id, opts) => {
    const out = await api("GET", `/Soul/${id}`);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(out));
      return;
    }
    if (!out || (typeof out === "object" && !out.id)) {
      console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no entry")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, out.id ?? id));
    if (out.agentId) console.log(render.kv("agent", out.agentId));
    if (out.key) console.log(render.kv("key", out.key));
    if (out.value !== undefined) console.log(render.kv("value", String(out.value)));
    if (out.durability) console.log(render.kv("durability", render.wrap(render.c.magenta, String(out.durability))));
    if (out.priority) console.log(render.kv("priority", String(out.priority)));
    if (out.createdAt) console.log(render.kv("created", `${render.relativeTime(out.createdAt)} ${render.wrap(render.c.dim, `(${out.createdAt})`)}`));
    if (out.updatedAt && out.updatedAt !== out.createdAt) {
      console.log(render.kv("updated", `${render.relativeTime(out.updatedAt)} ${render.wrap(render.c.dim, `(${out.updatedAt})`)}`));
    }
  });

soul.command("list")
  .description("List all soul entries for an agent")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
      process.exit(2);
    }
    const out = await api("GET", `/Soul?agentId=${encodeURIComponent(agentId)}`);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(out));
      return;
    }
    const all: any[] = Array.isArray(out) ? out : (out?.results ?? out?.items ?? []);
    if (all.length === 0) {
      console.log(`${render.icons.info} ${render.wrap(render.c.dim, `no soul entries for agent ${agentId}`)}`);
      return;
    }
    console.log(
      `${render.wrap(render.c.bold, String(all.length))} soul entries for agent ${render.wrap(render.c.bold, agentId)}\n`,
    );
    const priorityColor = (p: string): string => {
      if (p === "critical") return render.c.red;
      if (p === "high") return render.c.yellow;
      if (p === "low") return render.c.gray;
      return render.c.cyan;
    };
    const cols: render.TableColumn[] = [
      { label: "key", key: "key", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
      {
        label: "priority",
        key: "priority",
        format: (v) => {
          const p = String(v ?? "standard");
          return render.wrap(priorityColor(p), p);
        },
      },
      {
        label: "durability",
        key: "durability",
        format: (v) => {
          const d = String(v ?? "—");
          return d === "permanent" ? render.wrap(render.c.magenta, d) : render.wrap(render.c.dim, d);
        },
      },
      {
        label: "value",
        key: "value",
        format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
      },
    ];
    console.log(render.table(cols, all as Array<Record<string, unknown>>));
  });

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
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(found));
      return;
    }
    if (found.length === 0) {
      console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No bridges installed.")}`);
      console.log(`${render.wrap(render.c.dim, "  Add one with:")}     flair bridge scaffold <name> --file`);
      console.log(`${render.wrap(render.c.dim, "  Or install from npm:")} npm install flair-bridge-<name>`);
      return;
    }
    console.log(`${render.wrap(render.c.bold, String(found.length))} bridge${found.length === 1 ? "" : "s"}\n`);
    const cols: render.TableColumn[] = [
      { label: "name", key: "name", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
      {
        label: "kind",
        key: "kind",
        format: (v) => {
          const k = String(v ?? "—");
          return render.wrap(k === "yaml" ? render.c.cyan : k === "api" ? render.c.magenta : render.c.dim, k);
        },
      },
      {
        label: "source",
        key: "source",
        format: (v) => {
          const s = String(v ?? "—");
          return render.wrap(s === "builtin" ? render.c.green : render.c.dim, s);
        },
      },
      { label: "description", key: "description", format: (v) => String(v ?? "") },
    ];
    console.log(render.table(cols, found as unknown as Array<Record<string, unknown>>));
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
  .option("--source <path>", "Source directory (for directory-based imports like markdown)")
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
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(entries));
      return;
    }
    if (entries.length === 0) {
      console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No code-plugin bridges are allow-listed yet.")}`);
      console.log(`${render.wrap(render.c.dim, "  Allow one with:")} flair bridge allow <name>`);
      return;
    }
    console.log(`${render.wrap(render.c.bold, String(entries.length))} allow-listed code-plugin bridge${entries.length === 1 ? "" : "s"}\n`);
    for (const e of entries) {
      console.log(`${render.wrap(render.c.bold, e.name)}  ${render.wrap(render.c.dim, `(${e.version ?? "—"})`)}  ${render.wrap(render.c.green, "✓ allowed")} ${render.wrap(render.c.dim, e.allowedAt)}`);
      console.log(render.kv("location", render.wrap(render.c.dim, e.packageDir)));
      console.log(render.kv("digest", render.wrap(render.c.dim, `sha256:${e.packageJsonSha256.slice(0, 16)}…`)));
      console.log();
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
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env, or use --admin-pass-file)")
  .option("--admin-pass-file <path>", "Read admin password from a file (e.g., ~/.flair/admin-pass). Preferred over --admin-pass for launchd/cron — keeps the secret out of ps and shell history.")
  .action(async (opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    let adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
    if (!adminPass && opts.adminPassFile) {
      // readAdminPassFileSecure refuses world/group readable files (mode 0600
      // recommended). Common gotcha: files generated via
      // `openssl rand -base64 24 > admin-pass` end in a newline; helper trims it.
      try {
        adminPass = readAdminPassFileSecure(opts.adminPassFile);
      } catch (err: any) {
        console.error(`Error reading --admin-pass-file ${opts.adminPassFile}: ${err.message}`);
        process.exit(1);
      }
    }
    const adminUser = DEFAULT_ADMIN_USER;

    if (!adminPass) {
      console.error("Error: --admin-pass, --admin-pass-file, or FLAIR_ADMIN_PASS required for backup");
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

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Backup complete")}`);
    console.log(render.kv("Agents", render.wrap(render.c.bold, String(agents.length))));
    console.log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    console.log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    console.log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
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

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, "Restore complete")}`);
    console.log(render.kv("Agents restored", `${render.wrap(render.c.bold, String(agentCount))}${render.wrap(render.c.dim, `/${agents.length}`)}`));
    console.log(render.kv("Memories restored", `${render.wrap(render.c.bold, String(memoryCount))}${render.wrap(render.c.dim, `/${memories.length}`)}`));
    console.log(render.kv("Souls restored", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${souls.length}`)}`));
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
    const outputPath = resolve(rawOutputPath);
    mkdirSync(join(outputPath, ".."), { recursive: true });
    const fileMode = privateKey ? 0o600 : 0o644;
    writeFileSync(outputPath, JSON.stringify(exportData, null, 2), { mode: fileMode });
    if (privateKey) chmodSync(outputPath, 0o600); // enforce even if umask is permissive

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' exported`)}`);
    console.log(render.kv("Memories", render.wrap(render.c.bold, String(memories.length))));
    console.log(render.kv("Souls", render.wrap(render.c.bold, String(souls.length))));
    console.log(render.kv("Grants", render.wrap(render.c.bold, String(grants.length))));
    const keyText = privateKey
      ? `${render.wrap(render.c.magenta, "included")} ${render.wrap(render.c.red, "(UNENCRYPTED — protect this file)")}`
      : render.wrap(render.c.dim, "not included");
    console.log(render.kv("Key", keyText));
    console.log(render.kv("Mode", `${fileMode.toString(8)} ${render.wrap(render.c.dim, `(${privateKey ? "owner-only" : "standard"})`)}`));
    console.log(render.kv("Output", render.wrap(render.c.dim, outputPath)));
  });

// ─── flair import ────────────────────────────────────────────────────────────

program
  .command("import <path>")
  .description("Import an agent from an export file into this Flair instance")
  .option("--port <port>", "Harper HTTP port")
  .option("--ops-port <port>", "Harper operations API port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--ops-target <url>", "Explicit ops API URL for the Agent seed (env: FLAIR_OPS_TARGET; bypasses port derivation). Use when --url is remote and the ops port isn't HTTP-1.")
  .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
  .option("--keys-dir <dir>", "Keys directory", defaultKeysDir())
  .action(async (importPath, opts) => {
    const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
    const opsPort = resolveOpsPort(opts);
    // Resolve where the Agent record is seeded. The Agent goes through the ops
    // API (the REST surface has no Agent POST handler), so a remote --url import
    // must NOT silently seed on localhost (#514 — split import). Precedence:
    //   1. --ops-target / FLAIR_OPS_TARGET → use directly
    //   2. --url given → derive ops URL from it (port-1 convention)
    //   3. neither → localhost opsPort (preserves local default)
    // The remote REST base (--url) is mapped to `target` for derivation.
    const seedOpsTarget: number | string =
      resolveEffectiveOpsUrl({ target: opts.url, opsTarget: opts.opsTarget }) ?? opsPort;
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

    // Register agent via ops API (remote when --url/--ops-target points off-box)
    await seedAgentViaOpsApi(seedOpsTarget, agentId, pubKeyB64url, DEFAULT_ADMIN_USER, adminPass);
    console.log(
      typeof seedOpsTarget === "string"
        ? `  Agent registered (ops: ${seedOpsTarget})`
        : `  Agent registered`,
    );

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

    console.log(`\n${render.icons.ok} ${render.wrap(render.c.green, `Agent '${agentId}' imported`)}`);
    console.log(render.kv("Memories", `${render.wrap(render.c.bold, String(memCount))}${render.wrap(render.c.dim, `/${(data.memories ?? []).length}`)}`));
    console.log(render.kv("Souls", `${render.wrap(render.c.bold, String(soulCount))}${render.wrap(render.c.dim, `/${(data.souls ?? []).length}`)}`));
    console.log(render.kv("Key", render.wrap(render.c.dim, privPath)));
  });

// ─── flair backup inspect ────────────────────────────────────────────────────

program
  .command("inspect <path>")
  .description("Show contents of a backup or export file")
  .option("--json", "Emit raw JSON of the file (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (filePath, opts) => {
    if (!existsSync(filePath)) {
      console.error(`${render.icons.error} File not found: ${render.wrap(render.c.dim, filePath)}`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(data));
      return;
    }

    console.log(`${render.wrap(render.c.bold, "File:")}    ${render.wrap(render.c.dim, filePath)}`);
    const type = data.type ?? "full-backup";
    const typeColor = type === "agent-export" ? render.c.cyan : render.c.magenta;
    console.log(render.kv("Type", render.wrap(typeColor, type)));
    console.log(render.kv("Created", String(data.createdAt ?? data.exportedAt ?? render.wrap(render.c.dim, "unknown"))));
    console.log(render.kv("Source", String(data.source ?? render.wrap(render.c.dim, "unknown"))));

    if (data.type === "agent-export") {
      console.log(`\n${render.wrap(render.c.bold, "Agent")}: ${render.wrap(render.c.bold, data.agent?.id ?? "unknown")}`);
      console.log(render.kv("Name", String(data.agent?.name ?? data.agent?.id ?? "—")));
      console.log(render.kv("Memories", render.wrap(render.c.bold, String((data.memories ?? []).length))));
      console.log(render.kv("Souls", render.wrap(render.c.bold, String((data.souls ?? []).length))));
      console.log(render.kv("Grants", render.wrap(render.c.bold, String((data.grants ?? []).length))));
      const keyText = data.privateKey ? render.wrap(render.c.magenta, "yes") : render.wrap(render.c.dim, "no");
      console.log(render.kv("Key included", keyText));
    } else {
      const agents = data.agents ?? [];
      console.log(`\n${render.wrap(render.c.bold, "Agents")}: ${render.wrap(render.c.bold, String(agents.length))}`);
      for (const a of agents) {
        console.log(`  ${render.wrap(render.c.dim, "·")} ${render.wrap(render.c.bold, a.id)} ${render.wrap(render.c.dim, `(${a.name ?? a.id})`)}`);
      }
      console.log(render.kv("Memories", render.wrap(render.c.bold, String((data.memories ?? []).length))));
      console.log(render.kv("Souls", render.wrap(render.c.bold, String((data.souls ?? []).length))));
    }
  });

// ─── flair migrate-harness-memory ───────────────────────────────────────────

/** Resolve the memory directory path for a target harness. */
function resolveMemoryDir(target: string, agentId: string): string {
  switch (target) {
    case "claude-code": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".claude", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".claude", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    case "openclaw": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".openclaw", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".openclaw", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    case "pi": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".pi", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".pi", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    default:
      throw new Error(`Unknown target: ${target}. Valid: claude-code, openclaw, pi`);
  }
}

/** Parse a memory file with YAML frontmatter. */
function parseMemoryFile(filePath: string): {
  meta: { name?: string; description?: string; type?: string; tags?: string[] };
  body: string;
} {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  
  if (!lines[0].startsWith("---")) {
    return { meta: {}, body: raw };
  }
  
  let endIdx = 1;
  while (endIdx < lines.length && !lines[endIdx].startsWith("---")) {
    endIdx++;
  }
  
  const frontmatterLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);
  const yamlContent = frontmatterLines.join("\n");
  const meta: any = parseYaml(yamlContent) || {};
  
  return {
    meta: {
      name: meta.name,
      description: meta.description,
      type: meta.type,
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    },
    body: bodyLines.join("\n").trim(),
  };
}

/** Map memory type to durability. */
function mapDurability(type: string): "permanent" | "persistent" | "standard" | "ephemeral" {
  switch (type) {
    case "feedback":
    case "reference":
      return "permanent";
    case "project":
    case "user":
      return "persistent";
    default:
      return "standard";
  }
}

/** Extract keywords from filename for tags. */
function extractKeywordsFromFilename(filename: string): string[] {
  const base = filename.replace(/\.md$/, "");
  const withoutType = base.replace(/^(feedback|project|reference|user)_/, "");
  const parts = withoutType.split(/[_-]+/).map(p => p.toLowerCase());
  const stopwords = new Set(["the", "and", "for", "with", "about", "on", "in", "to", "of", "a", "an"]);
  return parts.filter(p => p.length > 2 && !stopwords.has(p));
}

program
  .command("migrate-harness-memory")
  .description("Migrate harness-local memories to Flair")
  .requiredOption("--target <target>", "Target harness: claude-code, openclaw, pi")
  .requiredOption("--agent <id>", "Agent ID to write memories under")
  .option("--dry-run", "Show what would be migrated without writing")
  .action(async (opts: { target: string; agent: string; dryRun: boolean }) => {
    const target = opts.target;
    const agentId = opts.agent;
    const dryRun = !!opts.dryRun;
    
    let memoryDir: string;
    try {
      memoryDir = resolveMemoryDir(target, agentId);
    } catch (e: any) {
      console.error(`Error resolving memory directory: ${e.message}`);
      process.exit(1);
    }
    
    if (!existsSync(memoryDir)) {
      console.error(`Error: Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }
    
    const migratedDir = join(memoryDir, ".migrated");
    if (!dryRun) {
      mkdirSync(migratedDir, { recursive: true, mode: 0o700 });
    }
    
    console.log(`Migrating memories from ${memoryDir} to Flair (agentId=${agentId})`);
    if (dryRun) console.log("  (DRY RUN - no files will be modified)");
    
    const files = readdirSync(memoryDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith(".md") && d.name !== "MEMORY.md")
      .map(d => d.name)
      .sort();
    
    if (files.length === 0) {
      console.log("No memory files found.");
      return;
    }
    
    console.log(`Found ${files.length} memory file(s) to migrate.`);
    
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;
    
    for (const filename of files) {
      const sourcePath = join(memoryDir, filename);
      const migratedPath = join(migratedDir, filename);
      
      if (existsSync(migratedPath)) {
        console.log(`  ${filename}: already migrated, skipping`);
        skipCount++;
        continue;
      }
      
      console.log(`  Processing: ${filename}...`);
      
      let parsed: {
        meta: { name?: string; description?: string; type?: string; tags?: string[] };
        body: string;
      };
      
      try {
        parsed = parseMemoryFile(sourcePath);
      } catch (e: any) {
        console.error(`    Failed to parse: ${e.message}`);
        failCount++;
        continue;
      }
      
      let type = parsed.meta.type;
      if (!type) {
        if (filename.startsWith("feedback_")) type = "feedback";
        else if (filename.startsWith("project_")) type = "project";
        else if (filename.startsWith("reference_")) type = "reference";
        else type = "session";
      }
      
      const durability = mapDurability(type);
      const tags = [...(parsed.meta.tags || [])];
      const filenameTags = extractKeywordsFromFilename(filename);
      for (const t of filenameTags) {
        if (!tags.includes(t)) tags.push(t);
      }
      tags.push(type);
      
      const content = parsed.body;
      
      console.log(`    Type: ${type}, Durability: ${durability}`);
      console.log(`    Tags: ${tags.join(", ")}`);
      console.log(`    Content preview: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      
      if (!dryRun) {
        console.log(`    Writing to Flair...`);
        try {
          const DEFAULT_PORT = 19926;
          const httpUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
          const agentKeyId = `${agentId}.key`;
          const keysDir = join(homedir(), ".flair", "keys");
          const keyPath = join(keysDir, agentKeyId);
          
          let authSuccess = false;
          if (existsSync(keyPath)) {
            const memoryId = `${agentId}-${randomUUID()}`;
            const body = {
              id: memoryId,
              agentId: agentId,
              content: content,
              type: type as any,
              durability: durability,
              tags: tags,
              createdAt: new Date().toISOString(),
            };
            const memoryPath = `/Memory/${memoryId}`;
            const res = await authFetch(httpUrl, agentId, keyPath, "PUT", memoryPath, body);
            if (res.ok) {
              authSuccess = true;
              console.log(`    Write to Flair successful (Ed25519 auth)`);
            }
          }
          
          if (!authSuccess) {
            const adminPass = process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD || "";
            if (adminPass) {
              const memoryId = `${agentId}-${randomUUID()}`;
              const body = {
                id: memoryId,
                agentId: agentId,
                content: content,
                type: type as any,
                durability: durability,
                tags: tags,
                createdAt: new Date().toISOString(),
              };
              const memoryPath = `/Memory/${memoryId}`;
              const auth = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
              const res = await fetch(`${httpUrl}${memoryPath}`, {
                method: "PUT",
                headers: {
                  Authorization: auth,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
              });
              if (res.ok) {
                console.log(`    Write to Flair successful (Basic auth)`);
              } else {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text}`);
              }
            } else {
              throw new Error("No authentication method available");
            }
          }
          
          renameSync(sourcePath, migratedPath);
          console.log(`    Moved to .migrated/${filename}`);
        } catch (e: any) {
          console.error(`    Failed: ${e.message}`);
          failCount++;
          continue;
        }
      } else {
        console.log(`    [dry-run] Would write to Flair and move to .migrated/${filename}`);
      }
      
      successCount++;
    }
    
    console.log(`\nMigration complete:`);
    console.log(`  Processed: ${files.length}`);
    console.log(`  Successful: ${successCount}`);
    console.log(`  Skipped: ${skipCount}`);
    console.log(`  Failed: ${failCount}`);
    
    if (failCount > 0) {
      process.exit(1);
    }
  });

// ─── flair presence ─────────────────────────────────────────────────────────

const VALID_PRESENCE_ACTIVITIES = ["coding", "reviewing", "planning", "debugging", "idle"] as const;
const MAX_TASK_LENGTH = 120;

const presence = program.command("presence").description("Manage agent presence (The Office Space)");

presence
  .command("set")
  .description("Set your agent's current activity and task (POST /Presence)")
  .option("--activity <activity>", `Activity type (${VALID_PRESENCE_ACTIVITIES.join("|")})`)
  .option("--task <text>", "Short description of what you're working on")
  .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
  .option("--port <port>", "Harper HTTP port")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
      process.exit(1);
    }

    // Validate activity
    if (!opts.activity) {
      console.error("Error: --activity is required.");
      process.exit(1);
    }
    const activity = opts.activity as string;
    if (!VALID_PRESENCE_ACTIVITIES.includes(activity as any)) {
      console.error(`Error: invalid activity '${activity}'. Must be one of: ${VALID_PRESENCE_ACTIVITIES.join(", ")}`);
      process.exit(1);
    }

    // Validate task length
    const task = opts.task ?? undefined;
    if (task && task.length > MAX_TASK_LENGTH) {
      console.error(`Error: --task exceeds ${MAX_TASK_LENGTH} character limit (got ${task.length}).`);
      process.exit(1);
    }

    // Resolve key path
    const keyPath = resolveKeyPath(agentId);
    if (!keyPath) {
      console.error(`Error: private key not found for agent '${agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.`);
      process.exit(1);
    }

    // Build auth + POST
    const baseUrl = resolveBaseUrl(opts).replace(/\/$/, "");
    const auth = buildEd25519Auth(agentId, "POST", "/Presence", keyPath);
    const body: Record<string, string> = { activity };
    if (task) body.currentTask = task;

    const res = await fetch(`${baseUrl}/Presence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: POST /Presence failed (${res.status}): ${text}`);
      process.exit(1);
    }

    const data = await res.json().catch(() => null);
    console.log(`✓ Presence updated for '${agentId}': activity=${activity}${task ? `, task="${task}"` : ""}`);
    if (data?.presenceStatus) {
      console.log(`  Status: ${data.presenceStatus}`);
    }
  });

// ─── flair workspace ─────────────────────────────────────────────────────────
//
// Coordination write surface (Kris #510). `workspace set` writes the
// agent's OWN WorkspaceState via a signed PUT /WorkspaceState/{id}. Identity
// is asserted by including agentId in the body — the server never trusts it
// blindly, it 403s any mismatch against the Ed25519 signature's agentId
// (WorkspaceState.put(), resources/WorkspaceState.ts), so this is a
// self-declaration the server verifies 1:1, not attribution-from-body.
//
// (flair#679, measured against a real spawned Harper): table-backed resources
// only accept writes via PUT /<Table>/<id> — a bare POST /WorkspaceState 405s
// ("does not have a post method implemented to handle HTTP method POST"),
// same restriction documented in resources/Memory.ts and already fixed for
// `soul set` (#498). WorkspaceState.ts DOES define a post() method, but
// Harper's REST layer never routes a real HTTP POST to it — post() is only
// reachable via in-process resource instantiation, never the wire. put(),
// unlike post(), does NOT default createdAt/timestamp/agentId — the CLI
// supplies them all explicitly below.

const MAX_WORKSPACE_FIELD_LENGTH = 2000;

const workspace = program.command("workspace").description("Manage agent workspace state (The Office Space)");

workspace
  .command("set")
  .description("Set your agent's current workspace state (PUT /WorkspaceState/{id})")
  .requiredOption("--ref <ref>", "Workspace ref (branch, worktree, or task ref)")
  .option("--label <text>", "Human-readable label for this workspace")
  .option("--provider <name>", "Provider/runtime (e.g. claude-code, openclaw)", "cli")
  .option("--task <id>", "Task/issue id this workspace is attached to")
  .option("--phase <phase>", "Current phase (e.g. design, implement, review)")
  .option("--summary <text>", "Short summary of current workspace state")
  .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
  .option("--port <port>", "Harper HTTP port")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
      process.exit(1);
    }

    // Validate field lengths (free text → cap to bound the write).
    for (const [name, val] of [["ref", opts.ref], ["label", opts.label], ["summary", opts.summary]] as const) {
      if (val && String(val).length > MAX_WORKSPACE_FIELD_LENGTH) {
        console.error(`Error: --${name} exceeds ${MAX_WORKSPACE_FIELD_LENGTH} character limit (got ${String(val).length}).`);
        process.exit(1);
      }
    }

    const keyPath = resolveKeyPath(agentId);
    if (!keyPath) {
      console.error(`Error: private key not found for agent '${agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.`);
      process.exit(1);
    }

    const baseUrl = resolveBaseUrl(opts).replace(/\/$/, "");
    // Deterministic id (agentId:ref) — re-running `workspace set` for the same
    // ref overwrites the same record, which is intentional (one row per
    // agent+ref, not an append log).
    const id = `${agentId}:${opts.ref}`;
    const auth = buildEd25519Auth(agentId, "PUT", `/WorkspaceState/${id}`, keyPath);

    // agentId IS included in the body now — WorkspaceState.put() (unlike
    // post()) does not auto-attribute from the signature, it 403s any
    // mismatch. This is a self-declaration the server verifies against the
    // signature, not a forgeable claim.
    const now = new Date().toISOString();
    const body: Record<string, unknown> = {
      id,
      agentId,
      ref: opts.ref,
      provider: opts.provider ?? "cli",
      timestamp: now,
      createdAt: now,
    };
    if (opts.label) body.label = opts.label;
    if (opts.task) body.taskId = opts.task;
    if (opts.phase) body.phase = opts.phase;
    if (opts.summary) body.summary = opts.summary;

    const res = await fetch(`${baseUrl}/WorkspaceState/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: PUT /WorkspaceState/${id} failed (${res.status}): ${text}`);
      process.exit(1);
    }

    console.log(`✓ Workspace state updated for '${agentId}': ref=${opts.ref}${opts.phase ? `, phase=${opts.phase}` : ""}`);
  });

// ─── flair orgevent ──────────────────────────────────────────────────────────
//
// Coordination write surface (Kris #510). `orgevent` publishes an
// OrgEvent ATTRIBUTED to the authenticated agent via a signed PUT
// /OrgEvent/{id}. authorId is asserted in the body but self-verified server
// side: OrgEvent.put() (resources/OrgEvent.ts) 403s any authorId that doesn't
// match the Ed25519 signature's agentId, so an agent still cannot forge
// another agent's events — the difference from post() is that put() checks-
// and-rejects a mismatch rather than silently overwriting it.
//
// (flair#679, measured against a real spawned Harper): table-backed resources
// only accept writes via PUT /<Table>/<id> — a bare POST /OrgEvent 405s
// ("does not have a post method implemented to handle HTTP method POST"),
// same restriction documented in resources/Memory.ts and already fixed for
// `soul set` (#498). OrgEvent.ts DOES define a post() method that
// auto-generates id/createdAt, but Harper's REST layer never routes a real
// HTTP POST to it — post() is only reachable via in-process resource
// instantiation, never the wire. put() does NOT default id/createdAt, so the
// CLI generates and supplies them itself (id convention mirrors flair-client's
// Memory.write(): `${agentId}-${randomUUID()}`).

const MAX_ORGEVENT_SUMMARY_LENGTH = 500;
const MAX_ORGEVENT_DETAIL_LENGTH = 8000;

program
  .command("orgevent")
  .description("Publish an org-wide coordination event attributed to your agent (PUT /OrgEvent/{id})")
  .requiredOption("--kind <kind>", "Event kind (e.g. coord.claim, coord.release, status)")
  .requiredOption("--summary <text>", "Short summary of the event")
  .option("--detail <text>", "Longer detail payload")
  .option("--scope <scope>", "Scope of the event (e.g. an agent id, repo, or 'org')")
  .option("--target <agentId>", "Recipient agent id (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .option("--agent <id>", "Agent ID (env: FLAIR_AGENT_ID)")
  .option("--port <port>", "Harper HTTP port")
  .option("--target-url <url>", "Remote Flair URL (env: FLAIR_TARGET)")
  .action(async (opts) => {
    const agentId = resolveAgentIdOrEnv(opts);
    if (!agentId) {
      console.error("Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID environment variable.");
      process.exit(1);
    }

    if (opts.summary && String(opts.summary).length > MAX_ORGEVENT_SUMMARY_LENGTH) {
      console.error(`Error: --summary exceeds ${MAX_ORGEVENT_SUMMARY_LENGTH} character limit (got ${String(opts.summary).length}).`);
      process.exit(1);
    }
    if (opts.detail && String(opts.detail).length > MAX_ORGEVENT_DETAIL_LENGTH) {
      console.error(`Error: --detail exceeds ${MAX_ORGEVENT_DETAIL_LENGTH} character limit (got ${String(opts.detail).length}).`);
      process.exit(1);
    }

    const keyPath = resolveKeyPath(agentId);
    if (!keyPath) {
      console.error(`Error: private key not found for agent '${agentId}'. Check ~/.flair/keys/ or set FLAIR_KEY_DIR.`);
      process.exit(1);
    }

    // orgevent reuses --target for recipients, so the remote-URL override is
    // --target-url here (env FLAIR_TARGET still honored via resolveBaseUrl).
    const baseUrl = resolveBaseUrl({ target: opts.targetUrl, port: opts.port }).replace(/\/$/, "");
    // id generation mirrors flair-client's Memory.write() convention
    // (`${agentId}-${randomUUID()}`) — unique per publish, unlike OrgEvent's
    // own (HTTP-unreachable) post() default of `${authorId}-${isoTimestamp}`,
    // which can collide within the same millisecond.
    const id = `${agentId}-${randomUUID()}`;
    const auth = buildEd25519Auth(agentId, "PUT", `/OrgEvent/${id}`, keyPath);

    // authorId IS included in the body now — OrgEvent.put() (unlike post())
    // does not auto-attribute from the signature, it 403s any mismatch. This
    // is a self-declaration the server verifies against the signature, not a
    // forgeable claim.
    const body: Record<string, unknown> = {
      id,
      authorId: agentId,
      kind: opts.kind,
      summary: opts.summary,
      createdAt: new Date().toISOString(),
    };
    if (opts.detail) body.detail = opts.detail;
    if (opts.scope) body.scope = opts.scope;
    if (Array.isArray(opts.target) && opts.target.length > 0) body.targetIds = opts.target;

    const res = await fetch(`${baseUrl}/OrgEvent/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Error: PUT /OrgEvent/${id} failed (${res.status}): ${text}`);
      process.exit(1);
    }

    const data = await res.json().catch(() => null);
    const targets = Array.isArray(opts.target) && opts.target.length > 0 ? ` → ${opts.target.join(", ")}` : "";
    console.log(`✓ OrgEvent published as '${agentId}': kind=${opts.kind}${targets}`);
    console.log(`  id: ${data?.id ?? id}`);
  });

// ─── flair attention ─────────────────────────────────────────────────────────
//
// Entity-scoped attention query (flair#677). "What's touching entity E in the
// last N days?" — a unified, grouped-by-source view across Memory,
// Relationship, WorkspaceState, Presence, and OrgEvent (POST /AttentionQuery,
// resources/AttentionQuery.ts). Read-only; signed the same way `flair search`
// signs POST /SemanticSearch. Entity must be a vocabulary string (exact
// type:value match — resources/entity-vocab.ts); the server 400s anything
// malformed.

/** Render one attention-result row for its source group — human-readable mode only. */
function describeAttentionRow(source: string, r: any): string {
  const dim = (s: string) => render.wrap(render.c.dim, s);
  const day = (iso: unknown) => (typeof iso === "string" ? iso.slice(0, 10) : "");
  switch (source) {
    case "memory":
      return `${r.content ? String(r.content).replace(/\s+/g, " ").slice(0, 100) : "(no content)"} ${dim(`[${r.agentId} · ${day(r.createdAt)}]`)}`;
    case "relationship":
      return `${r.subject} —${r.predicate}→ ${r.object} ${dim(`[${r.agentId} · ${day(r.createdAt)}]`)}`;
    case "workspaceState":
      return `${r.summary ?? r.ref} ${dim(`[${r.agentId}${r.phase ? ` · ${r.phase}` : ""} · ${String(r.timestamp ?? "").slice(0, 16).replace("T", " ")}]`)}`;
    case "presence":
      return `${r.currentTask} ${dim(`[${r.displayName ?? r.agentId}${r.activity ? ` · ${r.activity}` : ""}]`)}`;
    case "orgEvent":
      return `${r.summary} ${dim(`[${r.authorId} · ${r.kind} · ${day(r.createdAt)}]`)}`;
    default:
      return JSON.stringify(r);
  }
}

program
  .command("attention <entity>")
  .description("What's touching entity E in the last N days? Grouped view across memory/relationship/workspace/presence/orgevent (POST /AttentionQuery)")
  .option("--days <n>", "Window size in days (default 7)")
  .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
  .option("--key <path>", "Ed25519 private key path")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--json", "Output raw JSON")
  .action(async (entity, opts) => {
    try {
      const agentId = resolveAgentIdOrEnv(opts);
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(2);
      }

      const payload: Record<string, unknown> = { entity };
      if (opts.days !== undefined) {
        const n = Number.parseInt(opts.days, 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error("error: --days must be a positive integer");
          process.exit(2);
        }
        payload.days = n;
      }

      const baseUrl = resolveBaseUrl(opts);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const keyPath = opts.key || resolveKeyPath(agentId);
      if (keyPath) {
        headers["authorization"] = buildEd25519Auth(agentId, "POST", "/AttentionQuery", keyPath);
      }

      const res = await fetch(`${baseUrl}/AttentionQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      const result = text ? JSON.parse(text) : {};

      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(result));
        return;
      }

      const groups: Record<string, any[]> = result.groups ?? {};
      const counts: Record<string, number> = result.counts ?? {};
      console.log(
        `${render.icons.info} Attention: ${render.wrap(render.c.bold, result.entity ?? entity)} ` +
        `${render.wrap(render.c.dim, `(last ${result.windowDays ?? payload.days ?? 7}d, since ${result.since ?? "?"})`)}`,
      );
      console.log(render.wrap(render.c.dim, `total: ${counts.total ?? 0}`));
      console.log();

      const sections: Array<{ key: string; label: string }> = [
        { key: "memory", label: "Memory" },
        { key: "relationship", label: "Relationship" },
        { key: "workspaceState", label: "Workspace" },
        { key: "presence", label: "Presence" },
        { key: "orgEvent", label: "OrgEvent" },
      ];

      for (const { key, label } of sections) {
        const rows: any[] = Array.isArray(groups[key]) ? groups[key] : [];
        console.log(`${render.wrap(render.c.bold, label)} ${render.wrap(render.c.dim, `(${rows.length})`)}`);
        if (rows.length === 0) {
          console.log(`  ${render.wrap(render.c.dim, "—")}`);
          console.log();
          continue;
        }
        for (const r of rows) {
          console.log(`  ${describeAttentionRow(key, r)}`);
        }
        console.log();
      }
    } catch (err: any) {
      console.error(`${render.icons.error} Attention query failed: ${err.message}`);
      process.exit(1);
    }
  });

// Parse argv and run the CLI. Exported so the CommonJS preflight shim
// (cli-shim.cts → dist/cli-shim.cjs, the real bin entry) can invoke it after
// its Node-version check passes. The shim imports this module, so import.meta.main
// is false there — without this explicit entry point the CLI would load but never run.
async function runCli(): Promise<void> {
  await program.parseAsync();
}

// Run CLI directly when this file is the entry point — covers `node dist/cli.js`,
// `bun src/cli.ts`, and the test harness (which spawns src/cli.ts under bun).
// The packaged bin goes through cli-shim.cjs → runCli() instead.
if (import.meta.main) {
  await runCli();
}

// ─── Exported for testing ─────────────────────────────────────────────────────
export {
  runCli,
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
  VALID_PRESENCE_ACTIVITIES,
  MAX_TASK_LENGTH,
  MAX_WORKSPACE_FIELD_LENGTH,
  MAX_ORGEVENT_SUMMARY_LENGTH,
  MAX_ORGEVENT_DETAIL_LENGTH,

  isLocalBase,
  isLikelyRealSecret,
  shouldShowInlineSecretWarning,
  parseTokenFromFile,
  resolveLocalAdminPass,
};
