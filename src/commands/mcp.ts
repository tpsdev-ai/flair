/**
 * mcp.ts — `flair mcp` command group (flair#1625 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration, its action handlers, and the group-specific
 * helpers (the CIMD machine-client manifest + grant/revoke orchestration, and
 * the enable/disable/status readline helpers). Shared CLI helpers
 * (resolveOpsPort, key-path naming, b64url) stay in cli.ts and are bound
 * before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import * as render from "../render.js";
import { defaultKeysDir, resolveAdminUser, resolveLocalAdminPass } from "../lib/auth-resolve.js";
import {
  resolveAgentKeyPath,
  loadEd25519PrivateKeyFromFile,
  signClientAssertion,
  buildTokenRequestForm,
  getMcpAccessToken,
  McpTokenRequestError,
  defaultMcpClientId,
  defaultMcpTokenEndpoint,
  defaultMcpResource,
  defaultMcpIssuer,
  MAX_ASSERTION_LIFETIME_SECONDS,
} from "../mcp-client-assertion.js";
import {
  enableMcp,
  disableMcp,
  mcpStatus,
  checkLocalOriginRefusal,
  selfVerifyMcpMetadata,
  type EnableMcpResult,
  type SecretsMechanism,
} from "../lib/mcp-enable.js";

export type McpCli = {
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  privKeyPath: (agentId: string, keysDir: string) => string;
  pubKeyPath: (agentId: string, keysDir: string) => string;
  b64url: (bytes: Uint8Array) => string;
};

let cli: McpCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: McpCli): void {
  cli = fns;
}

function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}
function privKeyPath(agentId: string, keysDir: string): string {
  return cli.privKeyPath(agentId, keysDir);
}
function pubKeyPath(agentId: string, keysDir: string): string {
  return cli.pubKeyPath(agentId, keysDir);
}
function b64url(bytes: Uint8Array): string {
  return cli.b64url(bytes);
}


// ─── flair mcp grant / revoke / list ───────────────────────────────────────
// flair#746 — named, individually-revocable machine clients for the Model-2
// `/mcp` OAuth surface, completing the #663 client_credentials consumer arc
// with a paved provisioning path ("I have an agent" → "it has credentials
// and an mcp config block").
//
// GROUND TRUTH: the #719/#746 design round described `grant` as minting a
// client via the gated DCR endpoint's client_credentials grant. The
// published plugin does not support that — DCR only registers
// authorization_code/refresh_token clients, and client_credentials tokens
// are minted ONLY for CIMD-resolved clients ("A stored (DCR) record must
// never mint here" — token.js). CIMD (oauth#161, already shipped, consumed
// here via #663's src/mcp-client-assertion.ts) is the machine-client
// registration path that REPLACED DCR for this exact use case — a flair
// Agent + Ed25519 keypair IS the registration; resources/MCPClientMetadata.ts
// serves its CIMD document live, statelessly, on every fetch. `grantMcpClient`
// below therefore provisions an Agent (mirrors `agent add`'s
// seedAgentViaOpsApi shape), not a DCR client.
//
// flair#756 (CIMD-only, DCR removed entirely): `grant`/`revoke`'s workflow
// gate used to require the local presence of a DCR gate token as proof
// `flair mcp enable` had run. That token — and `src/lib/dcr-client.ts`, the
// module that owned it — no longer exist: a CIMD-only instance legitimately
// has no such token, so presence-of-a-file was never the right proof. The
// gate is now a LIVE probe of the target instance's OAuth metadata endpoint
// (`selfVerifyMcpMetadata`, reused from `./lib/mcp-enable.js` — the exact
// same check `enable`'s own self-verify step and `flair mcp status` use),
// layered on top of Harper's own admin-pass boundary exactly as Sherlock's
// #719 verdict asked for, just pointed at a mechanism that actually proves
// the surface is live instead of a local artifact that can go stale or
// simply not exist.
//
// Local bookkeeping (the manifest below) is the ONLY place "named machine
// clients" are enumerable at all: CIMD is deliberately stateless (no
// server-side registration row exists to list — see MCPClientMetadata.ts's
// own header), so `flair mcp list` reads local state by construction, not
// by convenience. `flair mcp revoke`'s actual credential-kill IS server-side
// (DELETE the backing Agent record via the admin-authenticated ops API,
// requiring the server's ack), matching Sherlock's binding condition: local
// key-file cleanup happens ONLY after that ack succeeds, never before, and
// never at all if the server call fails.

export interface McpClientManifestEntry {
  name: string;
  /** Same as `name` today — the Agent id this machine client's identity is
   *  rooted in. Kept as a separate field so a future re-keying scheme
   *  doesn't have to renegotiate the manifest shape. */
  agentId: string;
  /** The CIMD URL: `${issuer}/MCPClientMetadata/${name}` — this IS the
   *  client_id an AS resolves for the client_credentials grant. */
  clientId: string;
  keyFile: string;
  pubKeyFile: string;
  issuer: string;
  createdAt: string;
  status: "active";
}

/** Default manifest path: `~/.flair/mcp-clients.json`, sibling to
 *  admin-pass/config.yaml — independent of --keys-dir (a custom keys dir
 *  doesn't imply a custom manifest location, and vice versa). */
export function defaultMcpClientManifestPath(): string {
  return join(homedir(), ".flair", "mcp-clients.json");
}

/** Read the manifest; a missing file is "no clients granted yet", not an
 *  error. Malformed JSON is also treated as empty (defensive — a corrupt
 *  manifest must never crash `list`), never partially parsed. */
export function readMcpClientManifest(manifestPath: string): McpClientManifestEntry[] {
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write the manifest, 0600 — it names every granted machine client's
 *  key-file path, which is operationally sensitive even though it carries
 *  no key material itself. */
function writeMcpClientManifest(manifestPath: string, entries: McpClientManifestEntry[]): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
}

/** Machine-readable "ready-to-paste" MCP config block for `grant`'s output.
 *  Pure — no I/O — so it's independently unit-testable. Mirrors the
 *  `mcpServers` top-level key src/install/clients.ts's jsonSnippet already
 *  established as this codebase's paste-target convention, pointed at the
 *  Model-2 OAuth `/mcp` HTTP surface (not that stdio-bridge path).
 *
 *  The Authorization header CANNOT be a static, working value: a
 *  client_credentials access token is short-lived (default 300s TTL,
 *  server-side — see token.js's DEFAULT_CLIENT_CREDENTIALS_TTL) and this
 *  grant issues no refresh token by design. Printing a real-looking-but-
 *  dead token would be actively misleading, so the placeholder says exactly
 *  what to run instead — never a fabricated "it just works" static header.
 */
export function buildMcpGrantConfig(params: {
  name: string;
  resource: string;
  keyFile: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [params.name]: {
        type: "http",
        url: params.resource,
        headers: {
          Authorization:
            `Bearer <mint before each session: ` +
            `flair mcp token --agent-id ${params.name} --json — copy .access_token here; ` +
            `expires in minutes, not a long-lived credential>`,
        },
      },
    },
    note:
      `Key material lives at ${params.keyFile} (0600, never printed). ` +
      `The Bearer token above is a placeholder — mint a fresh one with ` +
      `\`flair mcp token --agent-id ${params.name}\` at connection time.`,
  };
}

export class McpClientNameExistsError extends Error {
  constructor(name: string) {
    super(`Machine client '${name}' already exists — use \`flair mcp revoke ${name}\` first or pick a different name.`);
    this.name = "McpClientNameExistsError";
  }
}

export class McpClientAgentIdCollisionError extends Error {
  constructor(name: string) {
    super(
      `An agent named '${name}' already exists in Flair but is not an mcp-granted machine client ` +
        `— pick a different name (or \`flair agent remove ${name}\` first if that's intentional).`,
    );
    this.name = "McpClientAgentIdCollisionError";
  }
}

export class McpClientNotFoundError extends Error {
  constructor(name: string) {
    super(`No granted machine client named '${name}' (see \`flair mcp list\`).`);
    this.name = "McpClientNotFoundError";
  }
}

const MCP_CLIENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface McpGrantParams {
  name: string;
  keysDir: string;
  manifestPath: string;
  issuer: string;
  opsPortOrUrl: number | string;
  adminUser: string;
  adminPass: string;
}

export interface McpGrantDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
  /** Injectable Ed25519 keypair generator (tests only; defaults to tweetnacl). */
  generateKeyPair?: () => { publicKey: Uint8Array; secretKey: Uint8Array };
}

export interface McpGrantResult {
  entry: McpClientManifestEntry;
  config: Record<string, unknown>;
}

/**
 * Core, testable `flair mcp grant` orchestration — no process.exit, no
 * console output, so it's directly unit-testable with a mocked fetch and a
 * temp dir (same split as classifyKeysDir/applyKeyPrune above). Throws
 * typed errors; the CLI action below catches and formats them.
 */
export async function grantMcpClient(params: McpGrantParams, deps: McpGrantDeps = {}): Promise<McpGrantResult> {
  const { name, keysDir, manifestPath, issuer, opsPortOrUrl, adminUser, adminPass } = params;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const generateKeyPair = deps.generateKeyPair ?? (() => nacl.sign.keyPair());

  if (!MCP_CLIENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid machine client name '${name}' — must be 1-64 chars, start alphanumeric, ` +
        `and contain only letters, digits, '_', '-' (it becomes an Agent id, a key filename, and a URL path segment).`,
    );
  }

  const manifest = readMcpClientManifest(manifestPath);
  if (manifest.some((e) => e.name === name)) {
    throw new McpClientNameExistsError(name);
  }

  // Defense-in-depth: refuse to silently reuse/clobber an unrelated
  // pre-existing Agent id (e.g. a human-run principal sharing this name).
  const opsUrl = typeof opsPortOrUrl === "number" ? `http://127.0.0.1:${opsPortOrUrl}/` : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
  const existingRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "search_by_value",
      database: "flair",
      table: "Agent",
      search_attribute: "id",
      search_value: name,
      get_attributes: ["id"],
    }),
  });
  if (existingRes.ok) {
    const existing = await existingRes.json().catch(() => []);
    if (Array.isArray(existing) && existing.length > 0) {
      throw new McpClientAgentIdCollisionError(name);
    }
  }

  mkdirSync(keysDir, { recursive: true });
  const privPath = privKeyPath(name, keysDir);
  const pubPath = pubKeyPath(name, keysDir);
  const kp = generateKeyPair();
  const seed = kp.secretKey.slice(0, 32);
  const pubKeyB64url = b64url(kp.publicKey);

  writeFileSync(privPath, Buffer.from(seed), { mode: 0o600 });
  chmodSync(privPath, 0o600);
  writeFileSync(pubPath, Buffer.from(kp.publicKey));

  const nowIso = now();
  const insertRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id: name,
        name,
        type: "agent",
        kind: "agent",
        status: "active",
        displayName: name,
        admin: false,
        defaultTrustTier: "unverified",
        runtime: "headless",
        publicKey: pubKeyB64url,
        createdAt: nowIso,
        updatedAt: nowIso,
      }],
    }),
  });
  if (!insertRes.ok) {
    // Roll back the key files we just wrote — nothing left behind locally
    // on a failed grant.
    for (const p of [privPath, pubPath]) {
      try { const { unlinkSync } = await import("node:fs"); unlinkSync(p); } catch { /* best effort */ }
    }
    const text = await insertRes.text().catch(() => "");
    throw new Error(`Failed to create Agent '${name}' via operations API (${insertRes.status}): ${text}`);
  }

  const clientId = `${issuer.replace(/\/+$/, "")}/MCPClientMetadata/${name}`;
  const entry: McpClientManifestEntry = {
    name,
    agentId: name,
    clientId,
    keyFile: privPath,
    pubKeyFile: pubPath,
    issuer,
    createdAt: nowIso,
    status: "active",
  };
  writeMcpClientManifest(manifestPath, [...manifest, entry]);

  const resource = `${issuer.replace(/\/+$/, "")}/mcp`;
  const config = buildMcpGrantConfig({ name, resource, keyFile: privPath });
  return { entry, config };
}

export interface McpRevokeParams {
  name: string;
  manifestPath: string;
  opsPortOrUrl: number | string;
  adminUser: string;
  adminPass: string;
  keepKeys?: boolean;
}

export interface McpRevokeDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Core, testable `flair mcp revoke` orchestration. SERVER-SIDE ack is
 * mandatory before any local mutation: the Agent record backing this
 * client's CIMD identity is DELETEd via the admin-authenticated ops API
 * first; only a 2xx response ("ack") triggers local key-file deletion and
 * manifest cleanup. A network error or non-2xx leaves everything local
 * untouched and throws — the caller (CLI action) reports a clear failure
 * and exits non-zero. This mirrors `agent remove`'s existing
 * delete-then-cleanup ordering.
 */
export async function revokeMcpClient(params: McpRevokeParams, deps: McpRevokeDeps = {}): Promise<McpClientManifestEntry> {
  const { name, manifestPath, opsPortOrUrl, adminUser, adminPass, keepKeys } = params;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const manifest = readMcpClientManifest(manifestPath);
  const entry = manifest.find((e) => e.name === name);
  if (!entry) {
    throw new McpClientNotFoundError(name);
  }

  const opsUrl = typeof opsPortOrUrl === "number" ? `http://127.0.0.1:${opsPortOrUrl}/` : `${opsPortOrUrl.replace(/\/$/, "")}/`;
  const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

  let delRes: Response;
  try {
    delRes = await fetchImpl(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ operation: "delete", database: "flair", table: "Agent", ids: [entry.agentId] }),
    });
  } catch (err: any) {
    throw new Error(
      `Server-side revoke failed: could not reach the operations API to delete Agent '${entry.agentId}' ` +
        `(${err?.message ?? err}). Nothing was deleted locally — retry once the instance is reachable.`,
    );
  }
  if (!delRes.ok) {
    const text = await delRes.text().catch(() => "");
    throw new Error(
      `Server-side revoke failed (HTTP ${delRes.status}) deleting Agent '${entry.agentId}': ${text}. ` +
        `Nothing was deleted locally.`,
    );
  }

  // Server ack received — now safe to clean up locally.
  if (!keepKeys) {
    const { unlinkSync } = await import("node:fs");
    for (const p of [entry.keyFile, entry.pubKeyFile]) {
      if (p && existsSync(p)) {
        try { unlinkSync(p); } catch { /* best effort */ }
      }
    }
  }
  writeMcpClientManifest(manifestPath, manifest.filter((e) => e.name !== name));

  return entry;
}

// ─── flair mcp enable / disable / status ────────────────────────────────────
// flair#719 — the last piece of the paved-paths command family. Automates
// docs/notes/mcp-oauth-model2.md's 8-step operator checklist into one
// command, per the design record + K&S verdicts on #719's thread (see
// src/lib/mcp-enable.ts's module header for the full binding design record,
// including the scenario addendum: `enable` targets the HOSTED shape only —
// it runs on the OPERATOR's machine, against a REMOTE instance, and refuses
// honestly against a local-origin instance rather than walking eight steps
// toward a connector that can never connect).

/** Simple y/N confirmation over readline — TTY-only, mirrors the existing
 *  restore-confirmation pattern (`flair snapshot restore`) above. */
async function confirmYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) =>
    rl.question(`${question} [y/N] `, (a) => { rl.close(); res(a); }),
  );
  return /^y(es)?$/i.test(answer.trim());
}

/** Plain-text readline prompt (tests never exercise this — CLI-only). Used
 *  for --idp-client-id/--idp-client-secret/--idp-subject when a flag is
 *  omitted and stdin is a TTY. */
async function promptText(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((res) =>
    rl.question(question, (a) => { rl.close(); res(a); }),
  );
  return answer.trim();
}

function printEnableSteps(result: EnableMcpResult): void {
  console.log(`\n${render.wrap(render.c.bold, "flair mcp enable")}${result.dryRun ? render.wrap(render.c.dim, " (dry run)") : ""}\n`);
  for (const s of result.steps) {
    console.log(`  ${s.ok ? render.icons.ok : render.icons.error} ${render.wrap(render.c.dim, s.step)}`);
    console.log(`     ${s.detail}`);
  }
  console.log("");
}

export function register(program: Command): void {
  const mcp = program.command("mcp").description("MCP client-credentials agent-auth (RFC 7523 private_key_jwt)");

  mcp
    .command("token")
    .description(
      "Build + sign an RFC 7523 client_assertion and request an MCP client_credentials " +
        "access token. Caches the minted token (in-process) and reuses it until " +
        "near-expiry — use --force-refresh to mint unconditionally.",
    )
    .requiredOption("--agent-id <id>", "Agent id — becomes the client_id (iss/sub claims)")
    .option(
      "--client-id <url>",
      "Client ID Metadata Document URL for this agent (defaults to this instance's " +
        "MCPClientMetadata URL, derived from FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL)",
    )
    .option(
      "--token-endpoint <url>",
      "Token-endpoint URL — becomes the `aud` claim (defaults to this instance's " +
        "own oauth token endpoint, same env vars)",
    )
    .option(
      "--resource <url>",
      "RFC 8707 resource indicator for the token request (defaults to this instance's canonical /mcp URI)",
    )
    .option("--keys-dir <dir>", "Directory to look for <agentId>.key (else FLAIR_KEY_DIR, ~/.flair/keys, ~/.tps/secrets/flair)")
    .option("--expires-in <seconds>", `Assertion exp - iat window, seconds (default + hard cap: ${MAX_ASSERTION_LIFETIME_SECONDS})`)
    .option("--dry-run", "Sign the assertion and print what would be sent, but do not call the token endpoint")
    .option("--force-refresh", "Mint a fresh token even if a cached, not-near-expiry one exists")
    .option("--json", "Print machine-readable JSON instead of a human summary")
    .action(async (opts) => {
      const agentId: string = opts.agentId;
      const keyPath = resolveAgentKeyPath(agentId, opts.keysDir);
      if (!keyPath) {
        console.error(
          `Error: no private key found for agent '${agentId}'. Checked --keys-dir, FLAIR_KEY_DIR, ` +
            `~/.flair/keys, and ~/.tps/secrets/flair.`,
        );
        process.exit(1);
      }

      const clientId: string | undefined = opts.clientId ?? defaultMcpClientId(agentId);
      if (!clientId) {
        console.error(
          "Error: --client-id is required (or set FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL to derive it from " +
            "this instance's MCPClientMetadata URL).",
        );
        process.exit(1);
      }

      const tokenEndpoint: string | undefined = opts.tokenEndpoint ?? defaultMcpTokenEndpoint();
      if (!tokenEndpoint) {
        console.error(
          "Error: --token-endpoint is required (or set FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL to derive " +
            "this instance's own oauth token endpoint).",
        );
        process.exit(1);
      }

      const resource: string | undefined = opts.resource ?? defaultMcpResource();
      const expiresIn = opts.expiresIn ? Number(opts.expiresIn) : undefined;

      let privateKey;
      try {
        privateKey = loadEd25519PrivateKeyFromFile(keyPath);
      } catch (err: any) {
        console.error(`Error: failed to load private key at ${keyPath}: ${err?.message ?? err}`);
        process.exit(1);
      }

      if (opts.dryRun) {
        const { assertion, claims } = signClientAssertion({
          clientId,
          tokenEndpoint,
          privateKey,
          expiresInSeconds: expiresIn,
        });
        const form = buildTokenRequestForm({ clientId, assertion, resource });
        if (opts.json) {
          console.log(JSON.stringify({ assertion, claims, wouldSendForm: form, tokenEndpoint }, null, 2));
          return;
        }
        console.log(`client_assertion (RFC 7523, EdDSA):\n\n${assertion}\n`);
        console.log(`claims: iss=sub=${claims.iss}  aud=${claims.aud}  exp-iat=${claims.exp - claims.iat}s  jti=${claims.jti}`);
        console.log(
          `\n--dry-run: NOT sent. This assertion is the client_assertion value for:\n` +
            `  POST ${tokenEndpoint}\n  ${JSON.stringify(form, null, 2).split("\n").join("\n  ")}`,
        );
        return;
      }

      try {
        const token = await getMcpAccessToken({
          clientId,
          tokenEndpoint,
          privateKey,
          resource,
          expiresInSeconds: expiresIn,
          forceRefresh: Boolean(opts.forceRefresh),
        });
        if (opts.json) {
          console.log(JSON.stringify(token, null, 2));
          return;
        }
        console.log(`access_token minted (${token.tokenType}, expires_in=${token.expiresIn}s):\n\n${token.accessToken}`);
        if (token.scope) console.log(`\nscope: ${token.scope}`);
      } catch (err: any) {
        if (err instanceof McpTokenRequestError) {
          console.error(`Error: token request failed (HTTP ${err.status}${err.error ? ` ${err.error}` : ""}): ${err.message}`);
        } else {
          console.error(`Error: token request failed: ${err?.message ?? err}`);
        }
        process.exit(1);
      }
    });

  mcp
    .command("grant <name>")
    .description(
      "Provision a named, individually-revocable machine client for the /mcp OAuth surface " +
        "(flair Agent + Ed25519 keypair; the existing CIMD path — see `flair mcp token` — makes it usable).",
    )
    .option("--issuer <url>", "Public origin for the CIMD client_id (defaults to FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL)")
    .option("--keys-dir <dir>", "Directory to write the new key pair into (else FLAIR_KEY_DIR, ~/.flair/keys)")
    .option("--manifest <path>", "Path to the local machine-client manifest (else ~/.flair/mcp-clients.json)")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--json", "Print machine-readable JSON instead of a human summary")
    .action(async (name: string, opts) => {
      const issuer: string | undefined = opts.issuer ?? defaultMcpIssuer();
      if (!issuer) {
        console.error(
          "Error: --issuer is required (or set FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL) — the CIMD client_id " +
            "must be a stable, publicly-resolvable URL.",
        );
        process.exit(1);
      }

      // Workflow gate: proof `flair mcp enable` has actually run against this
      // instance — a live probe of the OAuth metadata endpoint (flair#756;
      // replaces the old DCR-gate-token presence check, which a CIMD-only
      // instance legitimately can't satisfy).
      const gate = await selfVerifyMcpMetadata(issuer);
      if (!gate.ok) {
        console.error(`Error: the /mcp OAuth surface isn't answering at ${issuer} (${gate.detail}). Run \`flair mcp enable\` first.`);
        process.exit(1);
      }

      const adminPass = resolveLocalAdminPass(opts.adminPass);
      if (!adminPass) {
        console.error(
          "Error: --admin-pass or FLAIR_ADMIN_PASS required for `flair mcp grant` (needed to insert into the Agent table). " +
            "Set FLAIR_ADMIN_PASS, or make sure ~/.flair/admin-pass exists (created by `flair init`).",
        );
        process.exit(1);
      }

      const keysDir: string = opts.keysDir ?? defaultKeysDir();
      const manifestPath: string = opts.manifest ?? defaultMcpClientManifestPath();
      const opsPort = resolveOpsPort(opts);

      try {
        const { entry, config } = await grantMcpClient({
          name,
          keysDir,
          manifestPath,
          issuer,
          opsPortOrUrl: opsPort,
          adminUser: resolveAdminUser(opts.adminUser),
          adminPass,
        });

        if (opts.json) {
          console.log(render.asJSON({ entry, config }));
          return;
        }

        console.log(`\n${render.wrap(render.c.bold, `✅ Machine client '${name}' granted`)}\n`);
        console.log(render.kv("client_id", entry.clientId));
        console.log(render.kv("key file", render.wrap(render.c.dim, entry.keyFile)));
        console.log(render.kv("issuer", entry.issuer));
        console.log(`\n${render.wrap(render.c.dim, "Ready-to-paste MCP config (references the key file, never inline key material):")}\n`);
        console.log(render.asJSON(config));
        console.log("");
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  mcp
    .command("revoke <name>")
    .description("Server-side revoke a granted machine client (deletes its backing Agent record), then clean up locally.")
    .option("--manifest <path>", "Path to the local machine-client manifest (else ~/.flair/mcp-clients.json)")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--issuer <url>", "Public origin of the /mcp OAuth surface — used only for the enable-gate probe (defaults to FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--port <port>", "Harper HTTP port")
    .option("--keep-keys", "Do not delete local key files after a successful server-side revoke")
    .action(async (name: string, opts) => {
      const issuer: string | undefined = opts.issuer ?? defaultMcpIssuer();
      if (!issuer) {
        console.error("Error: --issuer is required (or set FLAIR_MCP_ISSUER/FLAIR_PUBLIC_URL) to verify the /mcp OAuth surface before revoking.");
        process.exit(1);
      }

      // Workflow gate — see the matching comment on `grant` above.
      const gate = await selfVerifyMcpMetadata(issuer);
      if (!gate.ok) {
        console.error(`Error: the /mcp OAuth surface isn't answering at ${issuer} (${gate.detail}). Run \`flair mcp enable\` first.`);
        process.exit(1);
      }

      const adminPass = resolveLocalAdminPass(opts.adminPass);
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for `flair mcp revoke`.");
        process.exit(1);
      }

      const manifestPath: string = opts.manifest ?? defaultMcpClientManifestPath();
      const opsPort = resolveOpsPort(opts);

      try {
        await revokeMcpClient({
          name,
          manifestPath,
          opsPortOrUrl: opsPort,
          adminUser: resolveAdminUser(opts.adminUser),
          adminPass,
          keepKeys: !!opts.keepKeys,
        });
        console.log(`${render.icons.ok} Machine client '${name}' revoked (server-side Agent record deleted${opts.keepKeys ? "; local keys kept" : " and local keys removed"}).`);
      } catch (err: any) {
        console.error(`${render.icons.error} ${err.message}`);
        process.exit(1);
      }
    });

  mcp
    .command("list")
    .description("List granted machine clients (name, client_id, status, created).")
    .option("--manifest <path>", "Path to the local machine-client manifest (else ~/.flair/mcp-clients.json)")
    .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
    .action((opts) => {
      const manifestPath: string = opts.manifest ?? defaultMcpClientManifestPath();
      const entries = readMcpClientManifest(manifestPath);
      const mode = render.resolveOutputMode(opts);

      if (mode === "json") {
        console.log(render.asJSON(entries));
        return;
      }
      if (entries.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no machine clients granted (see `flair mcp grant <name>`)")}`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(entries.length))} machine client(s)\n`);
      const cols: render.TableColumn[] = [
        { label: "name", key: "name", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
        { label: "client_id", key: "clientId", format: (v) => render.wrap(render.c.dim, String(v ?? "—")) },
        { label: "status", key: "status", format: (v) => (v === "active" ? render.wrap(render.c.green, String(v)) : String(v ?? "—")) },
        { label: "created", key: "createdAt", format: (v) => render.relativeTime(v as string) },
      ];
      console.log(render.table(cols, entries as unknown as Array<Record<string, unknown>>));
    });

  mcp
    .command("enable")
    .description(
      "One-command hosted-shape enablement of the OAuth /mcp surface for claude.ai — automates the " +
        "docs/notes/mcp-oauth-model2.md checklist. Targets a REMOTE instance with a public HTTPS origin; " +
        "refuses honestly against a local-origin instance.",
    )
    .option("--instance <url>", "Remote flair instance to enable against (else FLAIR_URL)")
    .option("--issuer <url>", "Public origin claude.ai will use (else --instance)")
    .option("--idp-provider <name>", "Upstream IdP provider", "github")
    .option("--idp-client-id <id>", "IdP OAuth app client id (else prompted interactively)")
    .option("--idp-client-secret <secret>", "IdP OAuth app client secret (else prompted interactively — prefer the prompt; an inline flag leaks to shell history)")
    .option("--idp-subject <value>", "Your expected `sub`/login at the IdP (GitHub: your username; else prompted interactively)")
    .option("--principal <id>", "Principal (Agent) to map your IdP identity to — personal-shape default", "self")
    .option("--principal-kind <human|agent>", "Kind for a newly-created principal", "human")
    .option("--secrets-mechanism <fabric-env-secrets|env-file>", "Override the shape-aware secrets mechanism (else auto-detected from --instance)")
    .option("--secrets-path <path>", "Override the secrets staging file path")
    .option("--cimd-allowed-hosts <hosts>", "Comma-separated clientIdMetadataDocuments.allowedHosts override (else claude.ai,claude.com)")
    .option("--signing-key-file <path>", "RS256 signing key PEM file (else ~/.flair/mcp-signing-key.pem)")
    .option("--admin-pass <pass>", "Admin password for the TARGET instance. Required explicitly for a remote target — FLAIR_ADMIN_PASS and ~/.flair/admin-pass are this machine's local credentials and are never sent to a remote instance")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--confirm-secrets-applied", "Confirm the staged secrets are already live on the target instance's environment (skips the interactive confirm)")
    .option("--dry-run", "Generate keys/tokens/config and validate inputs; skip every remote call")
    .option("--json", "Print machine-readable JSON instead of a human summary")
    .action(async (opts) => {
      const instance: string | undefined = opts.instance ?? process.env.FLAIR_URL;
      if (!instance) {
        console.error("Error: --instance is required (or set FLAIR_URL) — `flair mcp enable` targets a specific remote instance.");
        process.exit(1);
      }

      // Local-origin refusal short-circuits before we ask for anything else —
      // never walk the operator through IdP app creation for a connector that
      // can never connect.
      const localCheck = checkLocalOriginRefusal(instance);
      if (localCheck.refused) {
        console.error(`${render.icons.error} ${localCheck.message}`);
        process.exit(1);
      }

      const dryRun = Boolean(opts.dryRun);
      // --instance is ALWAYS remote for this command (local is refused above)
      // — isRemoteTarget=true so a missing --admin-pass/FLAIR_ADMIN_PASS never
      // silently falls back to THIS machine's local ~/.flair/admin-pass file
      // against someone else's instance (see resolveLocalAdminPass's doc comment).
      const adminPass = dryRun ? (opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "") : resolveLocalAdminPass(opts.adminPass, /* isRemoteTarget */ true);
      if (!dryRun && !adminPass) {
        console.error(
          "Error: --admin-pass <pass> or --admin-pass-file <path> is required for a REMOTE target " +
            "(the operations API on the target instance needs it for identity mapping + restart).\n" +
            "  FLAIR_ADMIN_PASS and ~/.flair/admin-pass are deliberately NOT used here: they are THIS machine's " +
            "local admin credentials, and sending them to another instance is how a local secret ends up on someone " +
            "else's Harper. Pass the target's own admin password explicitly.",
        );
        process.exit(1);
      }

      let idpClientId: string | undefined = opts.idpClientId;
      let idpClientSecret: string | undefined = opts.idpClientSecret;
      let idpSubject: string | undefined = opts.idpSubject;
      if (!dryRun && process.stdin.isTTY) {
        if (!idpClientId) idpClientId = await promptText(`${opts.idpProvider} OAuth app client id: `);
        if (!idpClientSecret) idpClientSecret = await promptText(`${opts.idpProvider} OAuth app client secret: `);
        if (!idpSubject) idpSubject = await promptText(`Your expected ${opts.idpProvider} login/sub: `);
      }

      const secretsMechanism = opts.secretsMechanism as SecretsMechanism | undefined;
      if (secretsMechanism && secretsMechanism !== "fabric-env-secrets" && secretsMechanism !== "env-file") {
        console.error(`Error: --secrets-mechanism must be "fabric-env-secrets" or "env-file", got "${secretsMechanism}"`);
        process.exit(1);
      }

      const cimdAllowedHosts: string[] | undefined = opts.cimdAllowedHosts
        ? String(opts.cimdAllowedHosts).split(",").map((h: string) => h.trim()).filter(Boolean)
        : undefined;

      const result = await enableMcp(
        {
          instance,
          issuer: opts.issuer,
          idpProvider: opts.idpProvider,
          idpClientId,
          idpClientSecret,
          idpSubject,
          principal: opts.principal,
          principalKind: opts.principalKind,
          adminUser: resolveAdminUser(opts.adminUser),
          adminPass,
          signingKeyFilePath: opts.signingKeyFile,
          secretsMechanism,
          secretsStagingPath: opts.secretsPath,
          cimdAllowedHosts,
          dryRun,
          confirmSecretsApplied: Boolean(opts.confirmSecretsApplied),
        },
        { confirmPrompt: dryRun ? undefined : confirmYesNo },
      );

      if (opts.json) {
        console.log(render.asJSON(result));
        if (!result.ok) process.exit(1);
        return;
      }

      printEnableSteps(result);
      if (result.refused) {
        process.exit(1);
      }
      if (!result.ok) {
        if (result.failedStep === "fabric-operator-deploy") {
          // flair#1136: Fabric deployments require the operator to deploy the
          // config change — we can't write to harperdb-config.yaml (Fabric
          // regenerates it on every container restart).
          console.error(
            `\n${render.icons.info} ${render.wrap(render.c.bold, "Fabric deployment detected.")}`,
          );
          console.error(
            `   The @harperfast/oauth block ships in your component config.yaml with mcp.enabled: false.`,
          );
          console.error(
            `   To activate: set mcp.enabled: true (literal boolean) in your deployed component`,
          );
          console.error(
            `   config.yaml, ensure the staged secrets are live in the instance's process`,
          );
          console.error(
            `   environment, and redeploy. Then re-run \`flair mcp enable\` — earlier steps`,
          );
          console.error(`   are idempotent and will be reused.\n`);
        } else {
          console.error(`${render.icons.error} enable failed at step "${result.failedStep}" — see detail above for the exact fix, then re-run \`flair mcp enable\` (earlier steps are idempotent and will be reused).`);
        }
        process.exit(1);
      }
      if (result.dryRun) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "dry-run: no remote calls were made.")}`);
        return;
      }

      console.log(`${render.icons.ok} ${render.wrap(render.c.bold, "claude.ai can now connect.")}\n`);
      console.log(result.pasteBlock ?? "");
      console.log("");
    });

  mcp
    .command("disable")
    .description("Flag off + restart = byte-identical boot (Model-2 contract) — removes the /mcp OAuth surface.")
    .option("--instance <url>", "Remote flair instance to disable against (else FLAIR_URL)")
    .option("--admin-pass <pass>", "Admin password for the target instance (or FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--confirm-flag-off", "Confirm FLAIR_MCP_OAUTH is already unset on the target instance's environment (skips the interactive confirm)")
    .option("--json", "Print machine-readable JSON instead of a human summary")
    .action(async (opts) => {
      const instance: string | undefined = opts.instance ?? process.env.FLAIR_URL;
      if (!instance) {
        console.error("Error: --instance is required (or set FLAIR_URL).");
        process.exit(1);
      }
      // --instance is always remote for this command — see the matching
      // comment in `mcp enable` above.
      const adminPass = resolveLocalAdminPass(opts.adminPass, /* isRemoteTarget */ true);
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required.");
        process.exit(1);
      }

      const result = await disableMcp(
        { instance, adminUser: resolveAdminUser(opts.adminUser), adminPass, confirmFlagOff: Boolean(opts.confirmFlagOff) },
        { confirmPrompt: confirmYesNo },
      );

      if (opts.json) {
        console.log(render.asJSON(result));
        if (!result.ok) process.exit(1);
        return;
      }
      console.log(`${result.ok ? render.icons.ok : render.icons.error} ${result.detail}`);
      if (!result.ok) process.exit(1);
    });

  mcp
    .command("status")
    .description("Surface the /mcp OAuth surface's live state: enabled? CIMD advertised? granted machine-client count.")
    .option("--instance <url>", "Remote flair instance to check (else FLAIR_URL)")
    .option("--manifest <path>", "Path to the local machine-client manifest (else ~/.flair/mcp-clients.json)")
    .option("--json", "Print machine-readable JSON instead of a human summary")
    .action(async (opts) => {
      const instance: string | undefined = opts.instance ?? process.env.FLAIR_URL;
      if (!instance) {
        console.error("Error: --instance is required (or set FLAIR_URL).");
        process.exit(1);
      }
      const manifestPath: string = opts.manifest ?? defaultMcpClientManifestPath();

      const result = await mcpStatus(
        { instance },
        { countMachineClients: () => readMcpClientManifest(manifestPath).length },
      );

      if (opts.json) {
        console.log(render.asJSON(result));
        return;
      }

      console.log(`\n${render.wrap(render.c.bold, "flair mcp status")}\n`);
      console.log(render.kv("instance", result.instance));
      console.log(render.kv("enabled", result.enabled ? render.wrap(render.c.green, "yes") : render.wrap(render.c.yellow, "no")));
      console.log(render.kv("metadata", result.detail));
      // flair#756: CIMD is the only supported client-registration path — this
      // reflects clientIdMetadataDocuments config presence on the target
      // instance, the only signal `status` can see without admin credentials.
      console.log(render.kv("CIMD", result.cimdSupported ? render.wrap(render.c.green, "advertised") : render.wrap(render.c.yellow, "not advertised")));
      console.log(render.kv("machine clients", String(result.machineClientCount ?? 0)));
      console.log("");
    });
}
