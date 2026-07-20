/**
 * cli-auth-floor.test.ts — Unit tests for flair#747: the shared CLI
 * auth-resolution helper (src/lib/auth-resolve.ts) and its adoption across
 * `api()` (and therefore every command already built on it — memory
 * search/list, relationship add, soul/workspace/presence writes, etc.),
 * `verifyAuthedGet` (flair#741/#742's upgrade verification), `flair
 * status`'s `fetchHealthDetail`, and `flair bootstrap`.
 *
 * Coverage maps directly to flair#747's acceptance criteria:
 *   - A machine with ONLY an agent key (no admin-pass) authenticates via
 *     the signed floor request on every adopted surface.
 *   - A machine with admin-pass keeps using it (additive, not replaced).
 *   - Explicit --key / env still take precedence over the floor.
 *   - No auth material at all → a clear, honest error (not a false
 *     "instance down" — the flair#741 defect-3 lesson, applied CLI-wide).
 *   - Structural: none of the adopted commands retain their own inlined
 *     admin-pass-only chain — there is exactly one resolver.
 *
 * Two techniques, matching test/unit/local-no-auth.test.ts's established
 * split:
 *   1. In-process mocked fetch for `authedRequest`'s tier ordering — using
 *      an explicit `keysDir` (never the real ~/.flair/keys) and a
 *      non-local baseUrl (skips the HOME-dependent admin-pass-file leg)
 *      wherever the admin-pass FILE tier isn't the thing under test.
 *   2. Subprocess spawn with an isolated HOME + a real local HTTP mock
 *      server for the admin-pass-file leg and full command-level
 *      (`flair status` / `flair bootstrap`) end-to-end behavior — Bun's
 *      os.homedir() doesn't re-read a live process.env.HOME mutation
 *      mid-process, so in-process HOME isolation doesn't work (see
 *      local-no-auth.test.ts's header for the full explanation).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";
import { authedRequest, ApiHttpError } from "../../src/lib/auth-resolve.ts";

// ─── Shared key-writing helper ──────────────────────────────────────────────

async function writeAgentKey(keysDir: string, agentId: string): Promise<void> {
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(join(keysDir, `${agentId}.key`), 0o600);
}

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── authedRequest — tier ordering (in-process, mocked fetch) ──────────────

const REMOTE_BASE = "https://auth-floor-test.invalid:19926";

describe("authedRequest — tier ordering (flair#747)", () => {
  let origFetch: typeof globalThis.fetch;
  let keysDir: string;
  const envKeys = ["FLAIR_TOKEN", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    keysDir = mkdtempSync(join(tmpdir(), "flair-747-authedrequest-keys-"));
    origEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    for (const k of envKeys) {
      const v = origEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(keysDir, { recursive: true, force: true });
  });

  function authHeaderOf(opts: any): string | undefined {
    const h = opts?.headers ?? {};
    return h.authorization ?? h.Authorization;
  }

  test("tier 1: explicitAdminPass wins over env, pinned agent key, and the floor", async () => {
    process.env.FLAIR_ADMIN_PASS = "env-pass-should-lose";
    await writeAgentKey(keysDir, "agent-a");
    globalThis.fetch = (async (_url: any, opts: any) => {
      expect(authHeaderOf(opts)).toBe(`Basic ${Buffer.from("admin:explicit-pass").toString("base64")}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await authedRequest("GET", "/HealthDetail", undefined, {
      baseUrl: REMOTE_BASE, explicitAdminPass: "explicit-pass", agentId: "agent-a", keysDir,
    });
  });

  test("tier 1: explicitKeyPath (+ agentId) wins over env admin-pass", async () => {
    process.env.FLAIR_ADMIN_PASS = "env-pass-should-lose";
    const explicitDir = mkdtempSync(join(tmpdir(), "flair-747-explicit-key-"));
    await writeAgentKey(explicitDir, "explicit-agent");
    const explicitKeyPath = join(explicitDir, "explicit-agent.key");
    let sawEd25519 = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      sawEd25519 = typeof auth === "string" && auth.startsWith("TPS-Ed25519 explicit-agent:");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await authedRequest("GET", "/HealthDetail", undefined, {
      baseUrl: REMOTE_BASE, explicitKeyPath, agentId: "explicit-agent", keysDir,
    });
    expect(sawEd25519).toBe(true);
    rmSync(explicitDir, { recursive: true, force: true });
  });

  test("tier 2: FLAIR_TOKEN (Bearer) wins over FLAIR_ADMIN_PASS", async () => {
    process.env.FLAIR_TOKEN = "a-bearer-token";
    process.env.FLAIR_ADMIN_PASS = "should-lose";
    globalThis.fetch = (async (_url: any, opts: any) => {
      expect(authHeaderOf(opts)).toBe("Bearer a-bearer-token");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: REMOTE_BASE, keysDir });
  });

  test("tier 2: FLAIR_ADMIN_PASS / HDB_ADMIN_PASSWORD env wins over a pinned agent key", async () => {
    process.env.FLAIR_ADMIN_PASS = "env-admin-pass";
    await writeAgentKey(keysDir, "agent-b");
    globalThis.fetch = (async (_url: any, opts: any) => {
      expect(authHeaderOf(opts)).toBe(`Basic ${Buffer.from("admin:env-admin-pass").toString("base64")}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: REMOTE_BASE, agentId: "agent-b", keysDir });
  });

  test("tier 3: a pinned agentId signs with its own key via resolveKeyPath (FLAIR_KEY_DIR)", async () => {
    process.env.FLAIR_KEY_DIR = keysDir;
    await writeAgentKey(keysDir, "pinned-agent");
    let sawEd25519 = false;
    try {
      globalThis.fetch = (async (_url: any, opts: any) => {
        const auth = authHeaderOf(opts);
        sawEd25519 = typeof auth === "string" && auth.startsWith("TPS-Ed25519 pinned-agent:");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: REMOTE_BASE, agentId: "pinned-agent", keysDir });
      expect(sawEd25519).toBe(true);
    } finally {
      delete process.env.FLAIR_KEY_DIR;
    }
  });

  test("tier 5 (the floor): no explicit/env/pinned material — tries every key in keysDir, sorted, first-to-authenticate wins, for a NON-GET method (generalizing flair#742's GET-only fallback)", async () => {
    await writeAgentKey(keysDir, "a-unregistered");
    await writeAgentKey(keysDir, "z-registered");
    const attempted: string[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (typeof auth !== "string" || !auth.startsWith("TPS-Ed25519 ")) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      }
      const agentId = auth.slice("TPS-Ed25519 ".length).split(":")[0];
      attempted.push(agentId);
      if (agentId === "z-registered") {
        return new Response(JSON.stringify({ ok: true, via: "floor" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });
    }) as unknown as typeof fetch;

    const result = await authedRequest("POST", "/SemanticSearch", { q: "test" }, { baseUrl: REMOTE_BASE, keysDir });
    expect(attempted).toEqual(["a-unregistered", "z-registered"]);
    expect(result.via).toBe("floor");
  });

  test("no auth material at all: clear, honest ApiHttpError — noCredentials, names the remedies, not a generic failure", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await authedRequest("GET", "/HealthDetail", undefined, { baseUrl: REMOTE_BASE, keysDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiHttpError);
    expect((caught as ApiHttpError).noCredentials).toBe(true);
    expect((caught as ApiHttpError).message).toMatch(/FLAIR_ADMIN_PASS/);
  });

  test("a rejected credential (wrong admin pass) does NOT engage the floor — server's own error surfaces", async () => {
    process.env.FLAIR_ADMIN_PASS = "wrong-pass";
    await writeAgentKey(keysDir, "should-never-be-tried");
    let keyAttempted = false;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const auth = authHeaderOf(opts);
      if (typeof auth === "string" && auth.startsWith("TPS-Ed25519 ")) keyAttempted = true;
      return new Response("Forbidden: bad admin credentials", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(authedRequest("GET", "/HealthDetail", undefined, { baseUrl: REMOTE_BASE, keysDir }))
      .rejects.toThrow(/Forbidden: bad admin credentials/);
    expect(keyAttempted).toBe(false);
  });
});

// ─── End-to-end: flair status / flair bootstrap, subprocess + mock server ──

interface CapturedRequest { method: string; path: string; authorization: string | undefined }

function startMockFlairServer(): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
      const auth = req.headers.authorization;

      if (req.url === "/Health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // /HealthDetail and /BootstrapMemories both require SOME credential —
      // echo back which tier the server received so the test can assert on
      // it via the CLI's own --json output, never by re-deriving from the
      // request log alone.
      let authTier: string | null = null;
      if (typeof auth === "string" && auth.startsWith("TPS-Ed25519 ")) authTier = "agent-key";
      else if (typeof auth === "string" && auth.startsWith("Basic ")) authTier = "admin";

      if (!authTier) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, authTier, context: "cold-start context", tokenEstimate: 1, memoriesIncluded: 0, memoriesTruncated: 0 }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname ?? __dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("flair status / flair bootstrap — floor adoption (flair#747, subprocess + isolated HOME)", () => {
  let tmpHome: string;
  let server: Server;
  let serverUrl: string;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    tmpHome = makeTmpDir("flair-747-home");
    const started = await startMockFlairServer();
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  function homeKeysDir(): string {
    return join(tmpHome, ".flair", "keys");
  }

  async function writeHomeAgentKey(agentId: string): Promise<void> {
    mkdirSync(homeKeysDir(), { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(homeKeysDir(), `${agentId}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
    chmodSync(join(homeKeysDir(), `${agentId}.key`), 0o600);
  }

  function writeHomeAdminPassFile(content: string): void {
    const flairDir = join(tmpHome, ".flair");
    mkdirSync(flairDir, { recursive: true });
    writeFileSync(join(flairDir, "admin-pass"), content, "utf-8");
    chmodSync(join(flairDir, "admin-pass"), 0o600);
  }

  const CLEAR_AUTH_ENV = { FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined, FLAIR_TOKEN: undefined };

  test("flair status --agent <id>: machine with ONLY an agent key authenticates HealthDetail via the signed floor/pinned path", async () => {
    await writeHomeAgentKey("floor-agent");
    const { exitCode, stdout } = await runCli(
      ["status", "--target", serverUrl, "--agent", "floor-agent", "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("agent-key");
  });

  test("flair status (no --agent at all): machine with ONLY an agent key still authenticates HealthDetail — the floor tries every registered key (the flair#741 scenario, generalized to `status`)", async () => {
    await writeHomeAgentKey("only-key-on-this-machine");
    const { exitCode, stdout } = await runCli(
      ["status", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("agent-key");
  });

  test("flair status: machine with admin-pass file (no agent key) is unchanged — still authenticates via Basic admin auth", async () => {
    writeHomeAdminPassFile("file-secret-pass\n");
    const { exitCode, stdout } = await runCli(
      ["status", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("admin");
  });

  test("flair status: FLAIR_ADMIN_PASS env still wins over a pinned agent key (explicit/env precedence preserved)", async () => {
    await writeHomeAgentKey("agent-that-should-lose");
    const { exitCode, stdout } = await runCli(
      ["status", "--target", serverUrl, "--agent", "agent-that-should-lose", "--json"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "env-wins", HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("admin");
  });

  test("flair status: no auth material at all → healthy:true (the /Health liveness probe succeeded) but no authenticated detail — never a false 'unreachable'", async () => {
    const { exitCode, stdout } = await runCli(
      ["status", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    // /Health has no auth requirement in this mock, so status reports the
    // instance as healthy — the flair#741 defect-3 contract: a credential
    // failure on the verified-read must never be reported as instance-down.
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.healthy).toBe(true);
    expect(out.authTier).toBeUndefined();
  });

  test("flair bootstrap --agent <id>: machine with ONLY that agent's key authenticates via the signed request (unchanged happy path)", async () => {
    await writeHomeAgentKey("bootstrap-agent");
    const { exitCode, stdout } = await runCli(
      ["bootstrap", "--agent", "bootstrap-agent", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("agent-key");
  });

  test("flair bootstrap --agent <id>: NEW capability — a machine with ONLY admin-pass (no key for that agent) now authenticates via Basic admin auth instead of failing", async () => {
    writeHomeAdminPassFile("file-secret-pass\n");
    const { exitCode, stdout } = await runCli(
      ["bootstrap", "--agent", "agent-with-no-local-key", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("admin");
  });

  test("flair bootstrap --key <path>: an explicit key path still wins (tier 1), even with FLAIR_ADMIN_PASS set in env", async () => {
    const explicitDir = makeTmpDir("flair-747-bootstrap-explicit-key");
    const kp = nacl.sign.keyPair();
    const explicitKeyPath = join(explicitDir, "explicit.key");
    writeFileSync(explicitKeyPath, Buffer.from(kp.secretKey.slice(0, 32)));
    chmodSync(explicitKeyPath, 0o600);

    const { exitCode, stdout } = await runCli(
      ["bootstrap", "--agent", "explicit-key-agent", "--key", explicitKeyPath, "--target", serverUrl, "--json"],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "should-lose-to-explicit-key", HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.authTier).toBe("agent-key");
    expect(requests[requests.length - 1].authorization).toStartWith("TPS-Ed25519 explicit-key-agent:");
    rmSync(explicitDir, { recursive: true, force: true });
  });

  test("flair bootstrap: no auth material at all → a clear, honest error naming the remedy, not a stack trace and not a generic failure", async () => {
    const { exitCode, stderr } = await runCli(
      ["bootstrap", "--agent", "nobody", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR_AUTH_ENV },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/FLAIR_ADMIN_PASS|flair init/);
    expect(stderr).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });
});

// ─── Structural: no adopted command retains its own inlined admin-pass-only
// chain — assert every one delegates to the single shared resolver ─────────

describe("structural: adopted commands consolidate onto authedRequest, not their own chains (flair#747)", () => {
  const cliSource = readFileSync(join(import.meta.dirname ?? __dirname, "..", "..", "src", "cli.ts"), "utf-8");

  /**
   * Extract a function/command body: locate `functionMarker` (disambiguates
   * WHERE in the file to look — several `bodyAnchor` snippets below aren't
   * globally unique on their own, e.g. every `--agent`-requiring command
   * repeats `const agentId = resolveAgentIdOrEnv(opts);`), then find
   * `bodyAnchor` (a snippet from the FIRST real statement of the target
   * body) searching forward from there. The body's opening `{` is the
   * nearest `{` preceding that anchor — reliable because both this file's
   * multi-line return-type annotations (e.g. fetchHealthDetail's `Promise<{
   * ... }>`) and parameter-type object literals (e.g. api()'s `options?: {
   * baseUrl?: string; keysDir?: string }`) necessarily CLOSE their own
   * braces before the real body opens, so the nearest preceding `{` is
   * never one of theirs. From there, brace-match forward, skipping over
   * string/template literals (which may contain stray `{`/`}`, e.g.
   * bootstrap's `--json` option text literally contains
   * "...{context, tokenEstimate, ...}...").
   */
  function skipString(i: number): number {
    // cliSource[i] is an opening quote char; returns the index AFTER its
    // closing quote. Deliberately naive about `${...}` interpolation inside
    // template literals — it treats the WHOLE backtick-to-backtick span as
    // opaque, which is fine here: we only need to know where the string
    // ENDS, never what's inside it.
    const quote = cliSource[i];
    let escaped = false;
    for (let j = i + 1; j < cliSource.length; j++) {
      const c = cliSource[j];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === quote) return j + 1;
    }
    throw new Error(`unterminated string literal starting at index ${i}`);
  }

  function extractBody(functionMarker: string, bodyAnchor: string): string {
    const markerStart = cliSource.indexOf(functionMarker);
    if (markerStart === -1) throw new Error(`function marker not found in src/cli.ts: ${functionMarker}`);
    const anchorIndex = cliSource.indexOf(bodyAnchor, markerStart);
    if (anchorIndex === -1) throw new Error(`body anchor not found after marker in src/cli.ts: ${bodyAnchor}`);

    // The body's opening brace is the LAST *real* (not inside a string/
    // template literal — e.g. a `${port}` interpolation between the
    // signature and the anchor would otherwise be mistaken for it) `{`
    // between the function marker and the anchor.
    let braceStart = -1;
    let i = markerStart;
    while (i < anchorIndex) {
      const c = cliSource[i];
      if (c === '"' || c === "'" || c === "`") { i = skipString(i); continue; }
      if (c === "{") braceStart = i;
      i++;
    }
    if (braceStart === -1) throw new Error(`no preceding brace found for anchor: ${bodyAnchor}`);

    let depth = 0;
    i = braceStart;
    while (i < cliSource.length) {
      const c = cliSource[i];
      if (c === '"' || c === "'" || c === "`") { i = skipString(i); continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return cliSource.slice(braceStart, i + 1);
      }
      i++;
    }
    throw new Error(`unbalanced braces extracting body for anchor: ${bodyAnchor}`);
  }

  test("api() delegates to authedRequest — no inline admin-pass/token chain of its own", () => {
    const body = extractBody(
      "async function api(method: string, path: string, body?: any, options?",
      "const savedPort = readPortFromConfig();",
    );
    expect(body).toContain("authedRequest(");
    // The OLD inline chain read these env vars directly inside api(); now
    // that logic lives ONLY in authedRequest (src/lib/auth-resolve.ts).
    expect(body).not.toContain("process.env.FLAIR_ADMIN_PASS");
    expect(body).not.toContain("process.env.HDB_ADMIN_PASSWORD");
    expect(body).not.toContain("resolveLocalAdminPass(");
  });

  test("verifyAuthedGet is a thin one-line delegation to api() — no standalone keysDir scan of its own", () => {
    const body = extractBody(
      "export async function verifyAuthedGet(baseUrl: string, path: string, keysDir: string)",
      'return api("GET", path, undefined, { baseUrl, keysDir });',
    );
    expect(body).toContain("api(");
    expect(body).not.toContain("readdirSync(");
    expect(body).not.toContain("authFetch(");
  });

  test("fetchHealthDetail's verified-read step delegates to authedRequest — no second inlined admin-pass-only HealthDetail chain", () => {
    const body = extractBody(
      "async function fetchHealthDetail(opts:",
      "let healthy = false;",
    );
    expect(body).toContain("authedRequest(");
    // The OLD code built TWO separate raw `fetch(`${baseUrl}/HealthDetail`...)`
    // calls (agent-key-first, then admin-env-only) — both gone.
    expect(body).not.toContain("buildEd25519Auth(");
    const healthDetailFetches = (body.match(/fetch\(`\$\{baseUrl\}\/HealthDetail`/g) ?? []).length;
    expect(healthDetailFetches).toBe(0);
  });

  test("`flair bootstrap`'s action delegates to authedRequest — no inline header-building / raw fetch of its own", () => {
    const body = extractBody(
      '.command("bootstrap")',
      "const agentId = resolveAgentIdOrEnv(opts);",
    );
    expect(body).toContain("authedRequest(");
    expect(body).not.toContain("buildEd25519Auth(");
    expect(body).not.toContain("fetch(`${baseUrl}/BootstrapMemories`");
  });

  test("the low-level Ed25519 primitives (buildEd25519Auth, resolveKeyPath, authFetch, ApiHttpError, resolveLocalAdminPass) are defined exactly once, in src/lib/auth-resolve.ts — cli.ts only imports them", () => {
    expect(cliSource).not.toMatch(/^function buildEd25519Auth\(/m);
    expect(cliSource).not.toMatch(/^function resolveKeyPath\(/m);
    expect(cliSource).not.toMatch(/^async function authFetch\(/m);
    expect(cliSource).not.toMatch(/^class ApiHttpError/m);
    expect(cliSource).not.toMatch(/^function resolveLocalAdminPass\(/m);
    expect(cliSource).toContain('from "./lib/auth-resolve.js"');
  });
});
