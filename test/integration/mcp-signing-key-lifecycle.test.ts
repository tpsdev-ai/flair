/**
 * mcp-signing-key-lifecycle.test.ts — flair#2194: with the shipped config no
 * longer declaring `mcp.signingKeyPem`, prove a token still verifies across a
 * restart, and that a pinned-key install keeps verifying after the pin is
 * removed.
 *
 * ── What can and cannot be driven live, stated ─────────────────────────────
 * A token is minted here the way this repo's MCP suites mint one (see
 * mcp-audience-binding-igmt.test.ts, mcp-principal-status.test.ts): a keypair
 * WE control is seeded into `oauth.harper_oauth_mcp_keys` — the table
 * withMCPAuth's `getAllPublicKeys` reads — and the token is hand-signed with
 * `jose`. The component's OWN mint endpoint (/oauth/mcp/token) cannot be
 * driven in an ephemeral, network-isolated instance: its CIMD client
 * resolution enforces an unconditional SSRF gate (https-only, no loopback
 * exception), which the live e2e suite documents at length. So "mints a
 * token" here means: a token signed by the key the component's key store
 * holds verifies against the running component. The property under test is
 * that the key store survives a restart and an unpin, which is what keeps
 * previously-minted tokens valid.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, copyFileSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, importPKCS8 } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");
const ISSUER = "https://signing-key-lifecycle.flair.test";
const RESOURCE = `${ISSUER}/mcp`;
const KID = "lifecycle-test-key";

const ENV_KEYS = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_MCP_SIGNING_KEY_PEM", "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_REDIRECT_URI"] as const;

let privateKeyPem: string;
let publicKeyPem: string;
const instances: HarperInstance[] = [];
const tempDirs: string[] = [];

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = privateKey;
  publicKeyPem = publicKey;
});

afterAll(async () => {
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

/** A temp app dir carrying the shipped config (or a mutated copy) + node_modules/dist symlinks. */
function makeWorkDir(prefix: string, mutate?: (shipped: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(dir, "dist"));
  if (mutate) writeFileSync(join(dir, "config.yaml"), mutate(readFileSync(SHIPPED_CONFIG, "utf-8")), "utf-8");
  else copyFileSync(SHIPPED_CONFIG, join(dir, "config.yaml"));
  return dir;
}

/** MCP on, issuer + a CONFIGURED github provider, and (optionally) a staged pin. */
function setEnableEnv(pin?: string): void {
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = ISSUER;
  process.env.OAUTH_GITHUB_CLIENT_ID = "lifecycle-client-id";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "lifecycle-client-secret";
  process.env.OAUTH_GITHUB_REDIRECT_URI = `${ISSUER}/oauth`;
  if (pin === undefined) delete process.env.FLAIR_MCP_SIGNING_KEY_PEM;
  else process.env.FLAIR_MCP_SIGNING_KEY_PEM = pin;
}

function basicHeader(h: HarperInstance): string {
  return "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");
}

async function seedKey(h: HarperInstance): Promise<void> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader(h) },
    body: JSON.stringify({
      operation: "insert",
      database: "oauth",
      table: "harper_oauth_mcp_keys",
      records: [{ kid: KID, alg: "RS256", public_key_pem: publicKeyPem, private_key_pem: privateKeyPem, created_at: Math.floor(Date.now() / 1000) }],
    }),
  });
  expect(res.status).toBe(200);
}

async function signToken(): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  return new SignJWT({ client_id: "lifecycle-client", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("lifecycle-agent")
    .setExpirationTime("30m")
    .sign(key);
}

async function postMcp(h: HarperInstance, token: string): Promise<number> {
  const res = await fetch(`${h.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  return res.status;
}

describe("flair#2194 signing-key lifecycle: no pin, token verifies across a restart", () => {
  let workDir: string;
  let harper: HarperInstance;

  test(
    "MCP on + issuer + provider, NO signing-key variable or field: the component loads and a token signs+verifies",
    async () => {
      setEnableEnv(undefined);
      workDir = makeWorkDir("flair-lifecycle-nopin-");
      harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // Clean boot — the component loaded (no refused signingKeyPem pin).
      const ops = await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) });
      expect(ops.status).toBe(200);
      expect(harper.getLog?.() ?? "").not.toContain("mcp.signingKeyPem is the unresolved env placeholder");

      await seedKey(harper);
      expect(await postMcp(harper, await signToken())).toBe(200);
    },
    180_000,
  );

  test(
    "the same token still verifies after a restart (the key store persists)",
    async () => {
      const installDir = harper.installDir;
      const token = await signToken();
      expect(await postMcp(harper, token)).toBe(200);

      await stopHarper(harper, { keepInstallDir: true });
      harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT, installDir });
      instances.push(harper);

      expect(await postMcp(harper, token)).toBe(200);
    },
    180_000,
  );
});

describe("flair#2194 signing-key lifecycle: pinned then unpinned (upgrade path)", () => {
  test(
    "a token minted while a pin is set keeps verifying after the pin is removed",
    async () => {
      // Boot WITH the pin declared and staged.
      setEnableEnv(privateKeyPem);
      const pinnedDir = makeWorkDir("flair-lifecycle-pinned-", (shipped) =>
        shipped.replace("    enabled: ${FLAIR_MCP_OAUTH}", "    enabled: ${FLAIR_MCP_OAUTH}\n    signingKeyPem: ${FLAIR_MCP_SIGNING_KEY_PEM}"),
      );
      let harper = await startHarper({ cwd: pinnedDir, harperBinDir: REPO_ROOT });
      instances.push(harper);
      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);

      // The pin is a valid PEM, so this boot is clean; seed the key the store
      // would hold and mint (sign) a token.
      await seedKey(harper);
      const token = await signToken();
      expect(await postMcp(harper, token)).toBe(200);

      // Remove the pin (shipped config, no signing-key env) and restart on the
      // SAME data dir: the key stays in the store, so the token still verifies.
      const installDir = harper.installDir;
      await stopHarper(harper, { keepInstallDir: true });
      setEnableEnv(undefined);
      const shippedDir = makeWorkDir("flair-lifecycle-unpinned-");
      harper = await startHarper({ cwd: shippedDir, harperBinDir: REPO_ROOT, installDir });
      instances.push(harper);

      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
      expect(await postMcp(harper, token)).toBe(200);
    },
    240_000,
  );
});
