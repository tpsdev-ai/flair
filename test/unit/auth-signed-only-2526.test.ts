/**
 * auth-signed-only-2526.test.ts — flair#2526, the shared resolver's
 * `signedOnly` transport (src/lib/auth-resolve.ts `authedRequest`).
 *
 * `flair doctor` sends its requests to a probed HTTP port whose instance is not
 * proven (the listener-only fallback) with `signedOnly`: no Basic and no Bearer
 * header may go out from any source, and an Ed25519 agent signature still may
 * (the flair#2270 `doctor --agent` path). A local listener records each
 * request's Authorization header. Every ambient shared secret is present at
 * once (FLAIR_TOKEN, FLAIR_ADMIN_PASS, HDB_ADMIN_PASSWORD and a 0600
 * ~/.flair/admin-pass in the sandbox HOME), so a tier that is not skipped
 * shows up as a header.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import nacl from "tweetnacl";
import { authedRequest, defaultAdminPassPath } from "../../src/lib/auth-resolve.js";

const ENV_KEYS = ["FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_AGENT_ID", "FLAIR_KEY_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let baseUrl: string;
let headers: Array<string | undefined> = [];
let keysDir: string;
const AGENT = "signed-only-agent";

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = process.env.HOME!;
  keysDir = join(home, "signed-only-keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${AGENT}.key`), Buffer.from(nacl.sign.keyPair().secretKey.slice(0, 32)), { mode: 0o600 });
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(defaultAdminPassPath(), "file-admin-pass-not-a-secret\n", { mode: 0o600 });
  chmodSync(defaultAdminPassPath(), 0o600);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(defaultAdminPassPath(), { force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => {
  headers = [];
  for (const k of ENV_KEYS) delete process.env[k];
});

function ambientSecrets(): void {
  process.env.FLAIR_TOKEN = "bearer-token-not-a-secret";
  process.env.FLAIR_ADMIN_PASS = "env-admin-pass-not-a-secret";
  process.env.HDB_ADMIN_PASSWORD = "hdb-admin-pass-not-a-secret";
}

describe("authedRequest — signedOnly sends no Basic and no Bearer header, from any source", () => {
  test("with every ambient shared secret present and no agent key, the request goes out with no Authorization header", async () => {
    ambientSecrets();
    await authedRequest("GET", "/HealthDetail", undefined, { baseUrl, keysDir: join(keysDir, "none"), signedOnly: true });
    expect(headers).toEqual([undefined]);
  });

  test("FLAIR_TOKEN alone is not sent as Bearer", async () => {
    process.env.FLAIR_TOKEN = "bearer-token-not-a-secret";
    await authedRequest("GET", "/FederationPeers", undefined, { baseUrl, keysDir: join(keysDir, "none"), signedOnly: true });
    expect(headers).toEqual([undefined]);
  });

  test("HDB_ADMIN_PASSWORD alone is not sent as Basic", async () => {
    process.env.HDB_ADMIN_PASSWORD = "hdb-admin-pass-not-a-secret";
    await authedRequest("GET", "/FederationPeers", undefined, { baseUrl, keysDir: join(keysDir, "none"), signedOnly: true });
    expect(headers).toEqual([undefined]);
  });

  test("the ~/.flair/admin-pass file alone is not sent as Basic", async () => {
    await authedRequest("GET", "/FederationPeers", undefined, { baseUrl, keysDir: join(keysDir, "none"), signedOnly: true });
    expect(headers).toEqual([undefined]);
  });

  test("a flag-pinned agent still signs (the flair#2270 path), with every ambient shared secret present", async () => {
    ambientSecrets();
    process.env.FLAIR_KEY_DIR = keysDir;
    await authedRequest("GET", "/HealthDetail", undefined, { baseUrl, keysDir, agentId: AGENT, agentIdSource: "flag", signedOnly: true });
    expect(headers).toHaveLength(1);
    expect(headers[0]).toStartWith(`TPS-Ed25519 ${AGENT}:`);
  });

  test("an explicit admin pass is refused before anything is sent", async () => {
    await expect(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl, explicitAdminPass: "explicit-not-a-secret", signedOnly: true }),
    ).rejects.toThrow("refusing to send an admin password");
    expect(headers).toEqual([]);
  });

  test("without signedOnly the same ambient secrets are sent (the control)", async () => {
    ambientSecrets();
    await authedRequest("GET", "/HealthDetail", undefined, { baseUrl, keysDir: join(keysDir, "none") });
    expect(headers).toHaveLength(1);
    expect(headers[0]).toStartWith("Bearer ");
  });
});
