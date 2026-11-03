/**
 * agent-key-floor-final-answers-2955.test.ts — flair#2955.
 *
 * Tier 5 of src/lib/auth-resolve.ts (`tryAgentKeyFloor`) must move to the next
 * candidate key file ONLY when the server refused the ED25519 CREDENTIAL itself
 * (the 401 codes the Ed25519 authentication middleware in
 * resources/auth-middleware.ts returns), or when an attempt that does not
 * follow redirects fails in the connect phase. Every other response — 500, 409,
 * a policy 403, a refused redirect, a 404 on a GET — is FINAL and rethrows as
 * itself: a failed HTTP response whose body was read carries its status and
 * the error code its body names, and a refused redirect carries its status. The
 * floor never replays it signed as a different agent, nor hides it behind the
 * caller's original "no credentials sent".
 *
 * A real local HTTP server answers the anonymous probe (403, which is what
 * makes tier 5 engage) and then each signed attempt, so the tests assert both
 * the number of signed attempts and which key signed each one. HOME points at
 * a scratch directory so tier 4's ~/.flair/admin-pass file cannot sign first.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import nacl from "tweetnacl";
import { authedRequest, ApiHttpError, apiErrorRawBody, CREDENTIAL_REJECTION_CODES, tryAgentKeyFloor } from "../../src/lib/auth-resolve.ts";

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

/** An undecodable key file: not a 32-byte seed, not base64 of one, not DER or PEM. */
function writeCorruptKey(keysDir: string, fileName: string): void {
  mkdirSync(keysDir, { recursive: true });
  const path = join(keysDir, fileName);
  writeFileSync(path, Buffer.from("not a private key ".repeat(4)));
  chmodSync(path, 0o600);
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
   * Reproduce the defect for one answered response: the request was sent once
   * per key before the fix, and the surfaced error is the caller's "no
   * credentials sent". After the fix: exactly one signed request (by the first
   * key) and the server's status (plus its error code when the body carries
   * one) surface.
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

  test("a redirect on a floor attempt is refused, not followed: one signed POST reaches the server, no second key sends it, and the 3xx surfaces", async () => {
    // A port with nothing listening, as the redirect's destination: following
    // the 307 would fail there in the connect phase and, before the fix, move
    // the floor on to the second key.
    const closed = createServer(() => {});
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const bound = closed.address();
    const closedPort = typeof bound === "object" && bound ? bound.port : 0;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const server = await startFloorServer(() => ({
      status: 307,
      location: `http://127.0.0.1:${closedPort}/elsewhere`,
    }));
    try {
      let caught: unknown;
      try {
        // The caller passes no refuseRedirects: the floor must refuse on its own.
        await authedRequest("POST", "/Memory", { agentId: "agent-first", content: "hello" }, {
          baseUrl: server.url,
          keysDir,
        });
        throw new Error("expected the floor to surface the redirect");
      } catch (err) {
        caught = err;
      }

      expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first"]);
      expect(server.requests).toHaveLength(2); // the anonymous probe + one signed POST
      expect(caught).toBeInstanceOf(ApiHttpError);
      const httpError = caught as ApiHttpError;
      expect(httpError.status).toBe(307);
      expect(httpError.noCredentials).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("a corrupt first key file is skipped before anything is sent, and the next key signs once", async () => {
    const onlyCorruptFirst = makeTmpDir("flair-2955-corrupt-first");
    try {
      writeCorruptKey(onlyCorruptFirst, "a-corrupt.key");
      writeAgentKey(onlyCorruptFirst, "agent-second");
      const server = await startFloorServer(() => ({ status: 200, body: { ok: true, via: "second" } }));
      try {
        const result = await authedRequest("POST", "/Memory", { agentId: "agent-second", content: "hello" }, {
          baseUrl: server.url,
          keysDir: onlyCorruptFirst,
        });
        expect(result).toEqual({ ok: true, via: "second" });
        expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-second"]);
        expect(server.requests).toHaveLength(2); // the anonymous probe + one signed attempt
      } finally {
        await server.close();
      }
    } finally {
      rmSync(onlyCorruptFirst, { recursive: true, force: true });
    }
  });

  test("only a corrupt key file: the caller's no-credentials hint, no signed request, no raw OpenSSL text", async () => {
    const onlyCorrupt = makeTmpDir("flair-2955-corrupt-only");
    try {
      writeCorruptKey(onlyCorrupt, "a-corrupt.key");
      const server = await startFloorServer(() => ({ status: 200, body: { ok: true } }));
      try {
        let caught: unknown;
        try {
          await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: server.url, keysDir: onlyCorrupt });
        } catch (err) {
          caught = err;
        }
        expect(signedRequests(server)).toHaveLength(0);
        expect(server.requests).toHaveLength(1); // the anonymous probe only
        expect(caught).toBeInstanceOf(ApiHttpError);
        const httpError = caught as ApiHttpError;
        expect(httpError.status).toBe(403);
        expect(httpError.noCredentials).toBe(true);
        expect(httpError.message).toMatch(/no credentials sent/);
        expect(httpError.message).not.toMatch(/OPENSSL|PEM routines|ASN\.?1|error:\d/i);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(onlyCorrupt, { recursive: true, force: true });
    }
  });

  test("a request-target failure is thrown before any key is tried, not skipped per candidate", async () => {
    const origFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("fetch must not run");
    }) as unknown as typeof fetch;
    try {
      const url = {
        origin: "http://127.0.0.1:9",
        get pathname(): string {
          throw new Error("unrenderable request target");
        },
      } as unknown as URL;
      await expect(tryAgentKeyFloor(url, "POST", { content: "hello" }, keysDir)).rejects.toThrow("unrenderable request target");
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
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

  // Every code the middleware can return for a refused credential is pinned by
  // name, so removing one from the client set fails a per-code case as well as
  // the drift check below.
  const CREDENTIAL_REJECTION_CODES_PINNED = [
    "invalid_authorization_header",
    "timestamp_out_of_window",
    "unknown_agent",
    "principal_deactivated",
    "invalid_signature",
    "signature_verification_failed",
  ] as const;

  for (const code of CREDENTIAL_REJECTION_CODES_PINNED) {
    test(`a 401 ${code} credential rejection moves to the next key, which succeeds`, async () => {
      const server = await startFloorServer((signedIndex) =>
        signedIndex === 0
          ? { status: 401, body: { error: code } }
          : { status: 200, body: { ok: true, via: code } },
      );
      try {
        const result = await authedRequest("POST", "/Memory", { agentId: "agent-second", content: "hello" }, {
          baseUrl: server.url,
          keysDir,
        });
        expect(result).toEqual({ ok: true, via: code });
        expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first", "agent-second"]);
      } finally {
        await server.close();
      }
    });
  }

  // Answers about the request or the server, not about the credential: these
  // stay final even though they are 401s.
  const FINAL_401_CODES = ["nonce_replay_detected", "authentication required", "replay_store_unavailable"] as const;

  for (const code of FINAL_401_CODES) {
    test(`a 401 ${code} is final — exactly one signed request`, async () => {
      const server = await startFloorServer(() => ({ status: 401, body: { error: code } }));
      try {
        let caught: unknown;
        try {
          await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: server.url, keysDir });
        } catch (err) {
          caught = err;
        }
        expect(signedRequests(server).map((r) => agentOf(r.authorization))).toEqual(["agent-first"]);
        expect(caught).toBeInstanceOf(ApiHttpError);
        const httpError = caught as ApiHttpError;
        expect(httpError.status).toBe(401);
        expect(httpError.noCredentials).toBe(false);
        expect(errorCodeOf(httpError)).toBe(code);
      } finally {
        await server.close();
      }
    });
  }

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

describe("flair#2955 — the client's credential-rejection set tracks the middleware", () => {
  /** The `error` string literals of the 401 responses built in the Ed25519 middleware. */
  function middleware401ErrorCodes(): Set<string> {
    const source = readFileSync(join(import.meta.dir, "../../resources/auth-middleware.ts"), "utf8");
    const codes = new Set<string>();
    const re = /new Response\(\s*JSON\.stringify\(\{\s*error:\s*"([^"]+)"/g;
    for (const match of source.matchAll(re)) {
      const start = match.index ?? 0;
      const end = source.indexOf(");", start);
      const call = end === -1 ? source.slice(start) : source.slice(start, end + 2);
      if (/status:\s*401\b/.test(call)) codes.add(match[1]);
    }
    return codes;
  }

  test("the set equals the middleware's 401 error literals minus the documented exclusion", () => {
    const middleware = middleware401ErrorCodes();
    // The exclusion is documented on CREDENTIAL_REJECTION_CODES: a reused nonce
    // is an answer about the request, not about the credential.
    expect(middleware.has("nonce_replay_detected")).toBe(true);
    const expected = new Set([...middleware].filter((code) => code !== "nonce_replay_detected"));
    expect([...CREDENTIAL_REJECTION_CODES].sort()).toEqual([...expected].sort());
  });
});
