/**
 * agent-key-floor-signing-failure-2955.test.ts — flair#2955.
 *
 * The tier-5 floor skips a candidate only when its KEY FILE cannot be read or
 * decoded as an Ed25519 key. A failure after the key is loaded — here the
 * signing step — is not this key file's problem: it is thrown as itself, and no
 * later key is sent.
 *
 * Isolated: this file owns its `node:crypto` mock (`sign` throws; every other
 * export is the real one), because the signing seam is inside
 * src/lib/auth-resolve.ts's header builder.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import nacl from "tweetnacl";

const realCrypto = require("node:crypto") as typeof import("node:crypto");
const SIGNING_FAILURE = "signing backend unavailable";

mock.module("node:crypto", () => ({
  ...realCrypto,
  sign: () => {
    throw new Error(SIGNING_FAILURE);
  },
}));

const { authedRequest, ApiHttpError } = await import("../../src/lib/auth-resolve.ts");

afterEach(() => {
  mock.restore();
});

function writeAgentKey(keysDir: string, agentId: string): void {
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  const path = join(keysDir, `${agentId}.key`);
  writeFileSync(path, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(path, 0o600);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

const ENV_KEYS = ["FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_KEY_DIR"] as const;

describe("flair#2955 — a signing failure after a key is loaded is final", () => {
  test("the signing error surfaces as itself and no later key sends", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "flair-2955-sign-keys-"));
    const homeDir = mkdtempSync(join(tmpdir(), "flair-2955-sign-home-"));
    const savedHome = process.env.HOME;
    const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.HOME = homeDir;
    for (const k of ENV_KEYS) delete process.env[k];

    const requests: Array<string | undefined> = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push(req.headers.authorization);
      req.resume();
      writeJson(res, 403, { error: "forbidden" });
    });
    try {
      writeAgentKey(keysDir, "agent-first");
      writeAgentKey(keysDir, "agent-second");
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      });

      let caught: unknown;
      try {
        await authedRequest("GET", "/HealthDetail", undefined, {
          baseUrl: `http://127.0.0.1:${port}`,
          keysDir,
        });
        throw new Error("expected the signing failure to surface");
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeInstanceOf(ApiHttpError);
      expect((caught as Error).message).toBe(SIGNING_FAILURE);
      // The anonymous probe only: the first candidate's signing threw before
      // its request, and no later candidate was tried.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      for (const k of ENV_KEYS) {
        const value = savedEnv[k];
        if (value === undefined) delete process.env[k];
        else process.env[k] = value;
      }
      rmSync(keysDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
