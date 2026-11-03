/**
 * agent-key-floor-final-answers-2955.test.ts — flair#2955.
 *
 * Tier 5 of src/lib/auth-resolve.ts (`tryAgentKeyFloor`) must move to the next
 * registered key ONLY when the server refused the ED25519 CREDENTIAL itself
 * (the 401 codes resources/auth-middleware.ts returns from its signature
 * check), or when the request provably never left this host (a connect-phase
 * failure). Every other answer — 500, 409, a policy 403, a refused redirect, a
 * 404 on a GET — is FINAL: the floor rethrows it as itself, with the server's
 * status and error code, instead of replaying the same request signed as a
 * different agent and then letting the caller report its original
 * "no credentials sent".
 *
 * A real local HTTP server answers the anonymous probe (403, which is what
 * makes tier 5 engage) and then each signed attempt, so the tests assert both
 * the number of signed attempts and which key signed each one. HOME points at
 * a scratch directory so tier 4's ~/.flair/admin-pass file cannot sign first.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import nacl from "tweetnacl";
import { authedRequest, ApiHttpError, apiErrorRawBody } from "../../src/lib/auth-resolve.ts";

const ED25519_PREFIX = "TPS-Ed25519 ";

function writeAgentKey(keysDir: string, agentId: string): void {
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  const path = join(keysDir, `${agentId}.key`);
  writeFileSync(path, Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(path, 0o600);
}

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function agentOf(authorization: string | undefined): string | undefined {
  if (typeof authorization !== "string" || !authorization.startsWith(ED25519_PREFIX)) return undefined;
  return authorization.slice(ED25519_PREFIX.length).split(":")[0];
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

interface Reply {
  status: number;
  body?: unknown;
  location?: string;
}

interface FloorServer {
  url: string;
  /** One entry per request the server received, in order. */
  requests: Array<{ authorization: string | undefined }>;
  close: () => Promise<void>;
}

/**
 * Start a local server that refuses the anonymous probe with 403 (the signal
 * that engages the floor) and answers the Nth signed attempt with
 * `replies(signedIndex)`.
 */
function startFloorServer(replies: (signedIndex: number) => Reply): Promise<FloorServer> {
  const requests: Array<{ authorization: string | undefined }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const authorization = req.headers.authorization;
    requests.push({ authorization });
    // Drain any request body so the connection is not left half-read.
    req.resume();
    if (authorization === undefined) {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    const signedIndex = requests.filter((r) => r.authorization !== undefined).length - 1;
    const reply = replies(signedIndex);
    if (reply.location !== undefined) res.setHeader("Location", reply.location);
    writeJson(res, reply.status, reply.body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function signedRequests(server: FloorServer): Array<{ authorization: string | undefined }> {
  return server.requests.filter((r) => r.authorization !== undefined);
}

function errorCodeOf(err: unknown): string | undefined {
  const raw = apiErrorRawBody(err);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

const ENV_KEYS = ["FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_KEY_DIR"] as const;

describe("flair#2955 — the agent-key floor moves on only for credential refusals and connect failures", () => {
  let keysDir: string;
  let homeDir: string;
  let savedEnv: Record<string, string | undefined>;
  let savedHome: string | undefined;

  beforeEach(() => {
    keysDir = makeTmpDir("flair-2955-keys");
    homeDir = makeTmpDir("flair-2955-home");
    savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    writeAgentKey(keysDir, "agent-first");
    writeAgentKey(keysDir, "agent-second");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const value = savedEnv[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(keysDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  /**
   * Reproduce the defect for one answered response: the request is sent once
   * per key today, and the surfaced error is the caller's "no credentials
   * sent". After the fix: exactly one signed request (by the first key) and
   * the server's status (plus its error code when the body carries one) surface.
   */
  async function expectFinalAnswer(reply: Reply, expectedStatus: number, expectedCode?: string): Promise<void> {
    const server = await startFloorServer(() => reply);
    try {
      let caught: unknown;
      try {
        await authedRequest("POST", "/Memory", { agentId: "agent-first", content: "hello" }, {
          baseUrl: server.url,
          keysDir,
          ...(reply.status >= 300 && reply.status < 400 ? { refuseRedirects: true } : {}),
        });
        throw new Error("expected the floor to surface the server's answer");
      } catch (err) {
        caught = err;
      }

      const signed = signedRequests(server);
      expect(signed.map((r) => agentOf(r.authorization))).toEqual(["agent-first"]);
      expect(server.requests).toHaveLength(2); // the anonymous probe + one signed attempt
      expect(caught).toBeInstanceOf(ApiHttpError);
      const httpError = caught as ApiHttpError;
      expect(httpError.noCredentials).toBe(false);
      expect(httpError.status).toBe(expectedStatus);
      if (expectedCode !== undefined) expect(errorCodeOf(httpError)).toBe(expectedCode);
    } finally {
      await server.close();
    }
  }

  test("(a) a 500 is final — one signed attempt, the server's 500 surfaces", async () => {
    await expectFinalAnswer({ status: 500, body: { error: "internal_error" } }, 500, "internal_error");
  });

  test("(b) a 409 is final — one signed attempt, the server's 409 surfaces", async () => {
    await expectFinalAnswer({ status: 409, body: { error: "conflict" } }, 409, "conflict");
  });

  test("(c) a policy 403 with a non-credential code is final — one signed attempt, that 403 surfaces", async () => {
    await expectFinalAnswer({ status: 403, body: { error: "forbidden: cannot write memory owned by another agent" } }, 403, "forbidden: cannot write memory owned by another agent");
  });

  test("(d) a refused 302 is final — one signed attempt, the redirect status surfaces", async () => {
    await expectFinalAnswer({ status: 302, location: "http://elsewhere.invalid/" }, 302);
  });

  test("a read-only GET answered 404 is final — the answer, not a key failure", async () => {
    const server = await startFloorServer(() => ({ status: 404, body: { error: "not_found" } }));
    try {
      let caught: unknown;
      try {
        await authedRequest("GET", "/Memory/lookup", undefined, { baseUrl: server.url, keysDir });
      } catch (err) {
        caught = err;
      }
      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first"]);
      expect(caught).toBeInstanceOf(ApiHttpError);
      expect((caught as ApiHttpError).status).toBe(404);
      expect(errorCodeOf(caught)).toBe("not_found");
    } finally {
      await server.close();
    }
  });

  test("the server's credential rejection (401 unknown_agent) still moves to the second key, which succeeds", async () => {
    const server = await startFloorServer((signedIndex) =>
      signedIndex === 0
        ? { status: 401, body: { error: "unknown_agent" } }
        : { status: 200, body: { ok: true, via: "floor" } },
    );
    try {
      const result = await authedRequest("POST", "/Memory", { agentId: "agent-second", content: "hello" }, {
        baseUrl: server.url,
        keysDir,
      });
      expect(result).toEqual({ ok: true, via: "floor" });
      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first", "agent-second"]);
    } finally {
      await server.close();
    }
  });

  test("an invalid_signature rejection also moves to the second key", async () => {
    const server = await startFloorServer((signedIndex) =>
      signedIndex === 0
        ? { status: 401, body: { error: "invalid_signature" } }
        : { status: 200, body: { ok: true } },
    );
    try {
      const result = await authedRequest("POST", "/Memory", { agentId: "agent-second", content: "hello" }, {
        baseUrl: server.url,
        keysDir,
      });
      expect(result).toEqual({ ok: true });
      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first", "agent-second"]);
    } finally {
      await server.close();
    }
  });

  test("every key refused as a credential returns undefined, so the caller's original no-credentials hint surfaces", async () => {
    const server = await startFloorServer(() => ({ status: 401, body: { error: "unknown_agent" } }));
    try {
      let caught: unknown;
      try {
        await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: server.url, keysDir });
      } catch (err) {
        caught = err;
      }
      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first", "agent-second"]);
      expect(caught).toBeInstanceOf(ApiHttpError);
      const httpError = caught as ApiHttpError;
      expect(httpError.status).toBe(403);
      expect(httpError.noCredentials).toBe(true);
      expect(httpError.message).toMatch(/no credentials sent/);
    } finally {
      await server.close();
    }
  });

  test("a credential rejection followed by a final answer from the next key throws that answer", async () => {
    const server = await startFloorServer((signedIndex) =>
      signedIndex === 0
        ? { status: 401, body: { error: "unknown_agent" } }
        : { status: 500, body: { error: "internal_error" } },
    );
    try {
      let caught: unknown;
      try {
        await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: server.url, keysDir });
      } catch (err) {
        caught = err;
      }
      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first", "agent-second"]);
      expect(caught).toBeInstanceOf(ApiHttpError);
      expect((caught as ApiHttpError).status).toBe(500);
      expect((caught as ApiHttpError).noCredentials).toBe(false);
      expect(errorCodeOf(caught)).toBe("internal_error");
    } finally {
      await server.close();
    }
  });

  test("a connect-phase transport failure moves to the next key", async () => {
    const origFetch = globalThis.fetch;
    const attempted: string[] = [];
    globalThis.fetch = (async (_url: unknown, opts: { headers?: Record<string, string> }) => {
      const authorization = opts?.headers?.authorization;
      if (authorization === undefined) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      }
      const agent = agentOf(authorization);
      attempted.push(agent ?? "unknown");
      if (agent === "agent-first") {
        const failure = new TypeError("fetch failed");
        (failure as unknown as { code: string }).code = "ECONNREFUSED";
        throw failure;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await authedRequest("POST", "/Memory", { agentId: "agent-second", content: "hello" }, {
        baseUrl: "https://floor-test.invalid:19926",
        keysDir,
      });
      expect(result).toEqual({ ok: true });
      expect(attempted).toEqual(["agent-first", "agent-second"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
