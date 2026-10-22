/**
 * auth-signed-only-hint-2749.test.ts — flair#2749, the hint on a credential-less
 * 403 (src/lib/auth-resolve.ts `sendJsonRequest`, reached through
 * `authedRequest`).
 *
 * A `signedOnly` request never sends the admin password, so its hint names the
 * agent key it can sign with instead of FLAIR_ADMIN_PASS. The other hints are
 * unchanged. A local listener answers 403 to a request with no Authorization
 * header, and each test runs in its own HOME holding no key and no admin-pass
 * file. `0.0.0.0` is not a loopback host to `isLocalBase`, and on Linux and
 * macOS a connection to it reaches the listener on 127.0.0.1, so it serves as
 * the remote target.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ApiHttpError, authedRequest } from "../../src/lib/auth-resolve.js";
import { tempDir } from "../helpers/temp-dir.ts";

const ENV_KEYS = ["HOME", "FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_AGENT_ID", "FLAIR_KEY_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let port: number;
let headers: Array<string | undefined> = [];
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    res.writeHead(req.headers.authorization ? 401 : 403, { "Content-Type": "application/json" });
    res.end('{"error":"forbidden"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  home = tempDir("flair-2749-home-");
  process.env.HOME = home;
  headers = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function noCredentialsError(promise: Promise<unknown>): Promise<ApiHttpError> {
  const err = await promise.then(
    () => { throw new Error("expected the request to be refused"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiHttpError);
  const httpErr = err as ApiHttpError;
  expect(httpErr.status).toBe(403);
  expect(httpErr.noCredentials).toBe(true);
  return httpErr;
}

describe("flair#2749 — the credential-less 403 hint", () => {
  test("a signed-only request to a remote target with no agent key names the key it can sign with, not FLAIR_ADMIN_PASS", async () => {
    process.env.FLAIR_ADMIN_PASS = "env-admin-pass-not-a-secret";
    const keysDir = join(home, "no-keys");
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://0.0.0.0:${port}`, keysDir, signedOnly: true }),
    );
    expect(err.message).toBe(
      "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. " +
        `Provide the key of an agent registered on the target instance at ${keysDir}/<agent-id>.key.`,
    );
    expect(err.message).not.toContain("FLAIR_ADMIN_PASS");
    expect(headers).toEqual([undefined]);
  });

  test("a signed-only request that names an agent with no key names that agent's key path", async () => {
    const err = await noCredentialsError(
      authedRequest("GET", "/Memory?agentId=agent-a", undefined, {
        baseUrl: `http://0.0.0.0:${port}`,
        keysDir: join(home, "no-keys"),
        agentId: "agent-a",
        agentIdSource: "env",
        signedOnly: true,
      }),
    );
    expect(err.message).toBe(
      "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. " +
        `Provide the key of agent 'agent-a' at ${home}/.flair/keys/agent-a.key (or set FLAIR_KEY_DIR to a directory containing agent-a.key).`,
    );
    expect(err.message).not.toContain("FLAIR_ADMIN_PASS");
    expect(headers).toEqual([undefined]);
  });

  test("a signed-only request to a local target gets the signed-only hint too", async () => {
    const keysDir = join(home, "no-keys");
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://127.0.0.1:${port}`, keysDir, signedOnly: true }),
    );
    expect(err.message).toBe(
      "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. " +
        `Provide the key of an agent registered on the target instance at ${keysDir}/<agent-id>.key.`,
    );
  });

  test("a remote request without signedOnly keeps the FLAIR_ADMIN_PASS hint", async () => {
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://0.0.0.0:${port}`, keysDir: join(home, "no-keys") }),
    );
    expect(err.message).toBe("HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS (remote targets have no local admin-pass fallback).");
    expect(headers).toEqual([undefined]);
  });

  test("a local request without signedOnly keeps the local hint", async () => {
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://127.0.0.1:${port}`, keysDir: join(home, "no-keys") }),
    );
    expect(err.message).toBe(
      "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key.",
    );
    expect(headers).toEqual([undefined]);
  });
});
