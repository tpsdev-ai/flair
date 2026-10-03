/**
 * mcp-signing-key-lifecycle.test.ts — flair#2194: with the shipped config no
 * longer declaring `mcp.signingKeyPem`, prove the INSTALLED @harperfast/oauth
 * generates and persists a signing key through its OWN mint path.
 *
 * ── The mint is the plugin's real one, over HTTP ───────────────────────────
 * The test seeds the fields needed for exchange, modeled on a stored client
 * and a callback-generated code. The live /oauth/mcp/token endpoint mints the
 * token without a seeded signing key.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, copyFileSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");
const ISSUER = "https://signing-key-lifecycle.flair.test";
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT_ID = "lifecycle-dcr-client";
const REDIRECT_URI = `${ISSUER}/callback`;

const ENV_KEYS = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_MCP_SIGNING_KEY_PEM", "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_REDIRECT_URI"] as const;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> | undefined;

let pinPrivatePem: string;
let pinPublicPem: string;
const instances: HarperInstance[] = [];
const tempDirs: string[] = [];

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  pinPrivatePem = privateKey;
  pinPublicPem = publicKey;
});

afterAll(async () => {
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (originalEnv) {
    for (const k of ENV_KEYS) {
      const value = originalEnv[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
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
  originalEnv ??= Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;
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

async function adminOp(h: HarperInstance, op: Record<string, unknown>): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader(h) },
    body: JSON.stringify(op),
  });
}

/** A PKCE S256 verifier/challenge pair (43-char unreserved verifier). */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function seedClientAndCode(h: HarperInstance, code: string, challenge: string): Promise<void> {
  const clientRes = await adminOp(h, {
    operation: "insert",
    database: "oauth",
    table: "harper_oauth_mcp_clients",
    records: [{
      client_id: CLIENT_ID,
      grant_types: JSON.stringify(["authorization_code"]),
      response_types: JSON.stringify(["code"]),
      redirect_uris: JSON.stringify([REDIRECT_URI]),
      token_endpoint_auth_method: "none",
    }],
  });
  expect(clientRes.status).toBe(200);
  const codeRes = await adminOp(h, {
    operation: "insert",
    database: "oauth",
    table: "mcp_auth_codes",
    records: [{
      code,
      client_id: CLIENT_ID,
      user: "lifecycle-agent",
      resource: RESOURCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: REDIRECT_URI,
      scope: "",
      client_auth_method: "none",
    }],
  });
  expect(codeRes.status).toBe(200);
}

/** Exchange the seeded code at the live token endpoint — the plugin's real mint. */
async function mint(h: HarperInstance, code: string, verifier: string): Promise<string> {
  const res = await fetch(`${h.httpURL}/oauth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const text = await res.text();
  expect(res.status, `token endpoint → ${res.status}: ${text.slice(0, 400)}`).toBe(200);
  const json = JSON.parse(text) as { access_token?: unknown };
  expect(typeof json.access_token).toBe("string");
  return json.access_token as string;
}

/** The persisted signing-key rows the component's verifier reads. */
async function readKeyRows(h: HarperInstance): Promise<any[]> {
  const res = await adminOp(h, {
    operation: "search_by_value",
    database: "oauth",
    table: "harper_oauth_mcp_keys",
    search_attribute: "kid",
    search_value: "*",
    get_attributes: ["kid", "alg", "public_key_pem", "created_at"],
  });
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

function jwtHeader(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
}

async function postMcp(h: HarperInstance, token: string): Promise<number> {
  const res = await fetch(`${h.httpURL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  return res.status;
}

describe("flair#2194 signing-key lifecycle: no pin, the library's own mint persists a key", () => {
  let workDir: string;
  let harper: HarperInstance;

  test(
    "no pin: persists a key and /mcp returns 200 across restart",
    async () => {
      setEnableEnv(undefined);
      workDir = makeWorkDir("flair-lifecycle-nopin-");
      harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // Clean boot — the component loaded (no refused signingKeyPem pin).
      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
      expect(harper.getLog?.() ?? "").not.toContain("mcp.signingKeyPem is the unresolved env placeholder");

      // NO seeded key: the store is empty before the first mint.
      expect(await readKeyRows(harper)).toEqual([]);

      const { verifier, challenge } = pkcePair();
      await seedClientAndCode(harper, "nopin-code", challenge);
      const token = await mint(harper, "nopin-code", verifier);
      const kid = jwtHeader(token).kid;

      // The library generated AND persisted the key row — nothing here seeded one.
      const rows = await readKeyRows(harper);
      expect(rows.map((r) => r.kid)).toEqual([kid]);
      expect(typeof rows[0].public_key_pem).toBe("string");
      expect(rows[0].public_key_pem).toContain("BEGIN PUBLIC KEY");

      expect(await postMcp(harper, token)).toBe(200);

      const installDir = harper.installDir;
      await stopHarper(harper, { keepInstallDir: true });
      harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT, installDir });
      instances.push(harper);
      expect(await postMcp(harper, token)).toBe(200);
    },
    300_000,
  );
});

describe("flair#2194 signing-key lifecycle: pinned then unpinned (upgrade path)", () => {
  test(
    "pin removed: /mcp returns 200 for existing and freshly minted tokens",
    async () => {
      // Boot WITH the pin declared and staged.
      setEnableEnv(pinPrivatePem);
      const pinnedDir = makeWorkDir("flair-lifecycle-pinned-", (shipped) =>
        shipped.replace("    enabled: ${FLAIR_MCP_OAUTH}", "    enabled: ${FLAIR_MCP_OAUTH}\n    signingKeyPem: ${FLAIR_MCP_SIGNING_KEY_PEM}"),
      );
      let harper = await startHarper({ cwd: pinnedDir, harperBinDir: REPO_ROOT });
      instances.push(harper);
      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);

      const { verifier, challenge } = pkcePair();
      await seedClientAndCode(harper, "pinned-code", challenge);
      const token = await mint(harper, "pinned-code", verifier);

      // The pin wins the signer selection and the library persisted it.
      const rows = await readKeyRows(harper);
      expect(rows).toHaveLength(1);
      expect(rows[0].kid).toBe("rs256-default");
      expect(String(rows[0].public_key_pem).trim()).toBe(pinPublicPem.trim());
      expect(jwtHeader(token).kid).toBe("rs256-default");
      expect(await postMcp(harper, token)).toBe(200);

      // Remove the pin and restart on the same data directory.
      const installDir = harper.installDir;
      await stopHarper(harper, { keepInstallDir: true });
      setEnableEnv(undefined);
      const shippedDir = makeWorkDir("flair-lifecycle-unpinned-");
      harper = await startHarper({ cwd: shippedDir, harperBinDir: REPO_ROOT, installDir });
      instances.push(harper);
      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
      expect(await postMcp(harper, token)).toBe(200);

      const freshPkce = pkcePair();
      await seedClientAndCode(harper, "unpinned-code", freshPkce.challenge);
      const freshToken = await mint(harper, "unpinned-code", freshPkce.verifier);
      expect(jwtHeader(freshToken).kid).toBe(rows[0].kid);
      expect(await postMcp(harper, freshToken)).toBe(200);
      expect((await readKeyRows(harper)).map((r) => r.kid)).toEqual([rows[0].kid]);
    },
    360_000,
  );
});
