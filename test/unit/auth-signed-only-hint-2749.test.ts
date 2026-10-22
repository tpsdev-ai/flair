/**
 * auth-signed-only-hint-2749.test.ts — flair#2749, the hint on a credential-less
 * 403 (src/lib/auth-resolve.ts `sendJsonRequest`, reached through
 * `authedRequest`).
 *
 * When a `signedOnly` request goes out with no Authorization header, the
 * instance answers 403, and the agent-key fallback gets no successful answer,
 * the error's hint names where the agent key goes instead of FLAIR_ADMIN_PASS.
 * The other hints are unchanged. Every case runs twice: against a 403 with a
 * JSON body and against a zero-length 403. A local listener answers 403 to a
 * request with no Authorization header, 200 to a `TPS-Ed25519` request while
 * `acceptSigned` is set, and 401 otherwise. Each test runs in its own HOME,
 * which holds no admin-pass file and a key only where a test writes one.
 * `0.0.0.0` is not a loopback host to `isLocalBase`, and on Linux and macOS a
 * connection to it reaches the listener on 127.0.0.1, so it serves as the
 * remote target.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import nacl from "tweetnacl";
import { ApiHttpError, authedRequest } from "../../src/lib/auth-resolve.js";
import { tempDir } from "../helpers/temp-dir.ts";

const ENV_KEYS = ["HOME", "FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_AGENT_ID", "FLAIR_KEY_DIR"] as const;
const SIGNED_ONLY = "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. ";
const saved: Record<string, string | undefined> = {};
let server: Server;
let port: number;
let headers: Array<string | undefined> = [];
let home: string;
let emptyBody = false;
let acceptSigned = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    const auth = req.headers.authorization;
    if (!auth) {
      if (emptyBody) {
        res.writeHead(403, { "Content-Length": "0" });
        res.end();
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
      }
      return;
    }
    if (acceptSigned && auth.startsWith("TPS-Ed25519 ")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"answeredBy":"signed"}');
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"unauthorized"}');
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
  acceptSigned = false;
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

/** A raw 32-byte seed, the form `flair init` writes, in `dir/<agentId>.key`. */
function writeKey(dir: string, agentId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.key`), Buffer.from(nacl.sign.keyPair().secretKey.slice(0, 32)), { mode: 0o600 });
}

describe.each([
  ["a 403 with a body", false],
  ["a zero-length 403", true],
] as const)("flair#2749 — the credential-less 403 hint, %s", (_shape, empty) => {
  beforeEach(() => {
    emptyBody = empty;
  });

  test("a signed-only request to a remote target with no agent key names the keys directory, not FLAIR_ADMIN_PASS", async () => {
    process.env.FLAIR_ADMIN_PASS = "env-admin-pass-not-a-secret";
    const keysDir = join(home, "no-keys");
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://0.0.0.0:${port}`, keysDir, signedOnly: true }),
    );
    expect(err.message).toBe(`${SIGNED_ONLY}Provide the key of an agent registered on the target instance at ${keysDir}/<agent-id>.key.`);
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
      `${SIGNED_ONLY}Provide the key of agent 'agent-a' at ${home}/.flair/keys/agent-a.key (or set FLAIR_KEY_DIR to a directory containing agent-a.key).`,
    );
    expect(err.message).not.toContain("FLAIR_ADMIN_PASS");
    expect(headers).toEqual([undefined]);
  });

  test("a signed-only request to a local target gets the signed-only hint too", async () => {
    const keysDir = join(home, "no-keys");
    const err = await noCredentialsError(
      authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://127.0.0.1:${port}`, keysDir, signedOnly: true }),
    );
    expect(err.message).toBe(`${SIGNED_ONLY}Provide the key of an agent registered on the target instance at ${keysDir}/<agent-id>.key.`);
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

  test("a signed-only request falls back to a key in the keys directory and returns its answer", async () => {
    acceptSigned = true;
    const keysDir = join(home, "keys");
    writeKey(keysDir, "agent-b");
    const result = await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://0.0.0.0:${port}`, keysDir, signedOnly: true });
    expect(result).toEqual({ answeredBy: "signed" });
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBeUndefined();
    expect(headers[1]).toStartWith("TPS-Ed25519 agent-b:");
  });

  test("a request without signedOnly falls back to a key in the keys directory and returns its answer", async () => {
    acceptSigned = true;
    const keysDir = join(home, "keys");
    writeKey(keysDir, "agent-b");
    const result = await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: `http://127.0.0.1:${port}`, keysDir });
    expect(result).toEqual({ answeredBy: "signed" });
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBeUndefined();
    expect(headers[1]).toStartWith("TPS-Ed25519 agent-b:");
  });
});
