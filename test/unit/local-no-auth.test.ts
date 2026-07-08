/**
 * local-no-auth.test.ts — Unit tests for api()'s local-target auth behavior,
 * including the flair#634 credential fallback.
 *
 * Historically, targeting localhost with no admin pass meant api() sent no
 * Authorization header at all, relying on Harper's authorizeLocal to forge a
 * super_user for credential-less loopback requests. flair#632 gated
 * FederationInstance/FederationPeers behind allowAdmin (a real permission
 * check, not the authorizeLocal escalation), so that forged passthrough no
 * longer satisfies those resources — a credential-less local call now gets a
 * real 403.
 *
 * flair#634 teaches api() to send real credentials for local targets too, in
 * precedence order: FLAIR_TOKEN > FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD env >
 * FLAIR_AGENT_ID + key (Ed25519) > the secure ~/.flair/admin-pass file
 * `flair init` writes (#593, via the same resolveLocalAdminPass convenience
 * `agent add`/`principal add` use, #590) > no auth as a last resort.
 *
 * TWO TEST TECHNIQUES ARE USED HERE, DELIBERATELY:
 *
 *  1. In-process mocked-fetch, for env-var-only precedence (FLAIR_TOKEN,
 *     FLAIR_ADMIN_PASS/HDB_ADMIN_PASSWORD, and the remote-target guard).
 *     These never reach the ~/.flair/admin-pass file at all — an env var
 *     wins before the file leg runs, and resolveLocalAdminPass's
 *     `isRemoteTarget` check short-circuits BEFORE any existsSync/file-read
 *     when the target isn't local — so home-directory isolation isn't
 *     needed for these cases.
 *
 *  2. Subprocess spawn (matching agent-add-adminpass-fallback.test.ts's
 *     established pattern), for every case that exercises the admin-pass
 *     FILE leg. This is required, not stylistic: Bun's `os.homedir()` does
 *     NOT re-read a live `process.env.HOME` mutation mid-process (verified
 *     empirically while writing this file — unlike Node, a runtime
 *     `process.env.HOME = ...` assignment has no effect on subsequent
 *     `homedir()` calls in the SAME Bun process). An in-process test that
 *     tries to isolate HOME by mutating the env var therefore silently
 *     falls through to THIS machine's real `~/.flair/admin-pass` file —
 *     exactly the file this task must never read. Spawning a subprocess
 *     with HOME set in its OWN startup environment (via Bun.spawn's `env`
 *     option) works correctly, because the child resolves `homedir()` from
 *     its real process environment at its own startup, not from a live
 *     mutation. All admin-pass fixture files used below live under a fresh
 *     tmpdir HOME, never under the real one.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { api } from "../../src/cli.js";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── In-process tests: env-var precedence + remote-target guard ───────────────
// Safe without HOME isolation — see file header for why.

describe("api() local auth behavior — env-var precedence (in-process)", () => {
  let origFetch: typeof globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedHeaders = undefined;
    capturedUrl = undefined;
    globalThis.fetch = async (url: any, opts: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedHeaders = opts?.headers ?? {};
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_TOKEN;
    delete process.env.FLAIR_AGENT_ID;
  });

  test("remote call with admin pass sends Basic auth header", async () => {
    process.env.FLAIR_ADMIN_PASS = "secret123";

    await api("GET", "/Agent", undefined, { baseUrl: "https://remote.example.com:19926" });

    expect(capturedUrl).toBe("https://remote.example.com:19926/Agent");
    expect(capturedHeaders?.authorization).toStartWith("Basic ");
  });

  test("flair#634: local call with FLAIR_ADMIN_PASS env set now sends Basic auth (explicit env wins on local too)", async () => {
    process.env.FLAIR_ADMIN_PASS = "secret123";

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedUrl).toBe("http://127.0.0.1:19926/Agent");
    expect(capturedHeaders?.authorization).toBe(`Basic ${Buffer.from("admin:secret123").toString("base64")}`);
  });

  test("flair#634: local call with HDB_ADMIN_PASSWORD env set sends Basic auth", async () => {
    process.env.HDB_ADMIN_PASSWORD = "secret456";

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedHeaders?.authorization).toBe(`Basic ${Buffer.from("admin:secret456").toString("base64")}`);
  });

  test("Bearer token still sent on local when FLAIR_TOKEN is set", async () => {
    process.env.FLAIR_TOKEN = "mytoken";

    await api("GET", "/Agent", undefined, { baseUrl: "http://127.0.0.1:19926" });

    expect(capturedHeaders?.authorization).toBe("Bearer mytoken");
  });

  test("SECURITY GUARD: a remote target's request is never sent an Authorization header when no env auth is configured (structural — resolveLocalAdminPass's isRemoteTarget check short-circuits before any local file is ever consulted, on THIS real machine's actual HOME)", async () => {
    delete process.env.FLAIR_ADMIN_PASS;
    delete process.env.HDB_ADMIN_PASSWORD;
    delete process.env.FLAIR_TOKEN;
    delete process.env.FLAIR_AGENT_ID;

    await api("GET", "/FederationInstance", undefined, { baseUrl: "https://remote.example.com:19926" });

    expect(capturedHeaders?.authorization).toBeUndefined();
  });
});

// ─── Subprocess tests: admin-pass FILE leg (requires real HOME isolation) ─────

interface CapturedRequest { method: string; path: string; authorization: string | undefined }

function startMockFederationServer(
  opts: { instanceStatus?: number; peersStatus?: number } = {},
): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
      const status = req.url?.startsWith("/FederationPeers") ? (opts.peersStatus ?? 200) : (opts.instanceStatus ?? 200);
      res.writeHead(status, { "Content-Type": "application/json" });
      if (status !== 200) {
        res.end(JSON.stringify({ error: "forbidden" }));
      } else if (req.url?.startsWith("/FederationPeers")) {
        res.end(JSON.stringify({ peers: [] }));
      } else {
        res.end(JSON.stringify({ id: "flair_test", publicKey: "test-pubkey", role: "spoke", status: "active" }));
      }
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

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname ?? __dirname, "..", "..", "src", "cli.ts");
  // Merge onto a copy of the real env, but explicitly DELETE any key passed
  // as undefined — guarantees isolation even if the host shell already has
  // FLAIR_ADMIN_PASS/etc set (must not leak into the "no creds" cases).
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

describe("api() local auth behavior — admin-pass file fallback (subprocess, isolated HOME)", () => {
  let tmpHome: string;
  let server: Server;
  let serverUrl: string;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    tmpHome = makeTmpDir("flair-634-adminpass-home");
    const started = await startMockFederationServer();
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  function writeAdminPassFile(content: string, mode = 0o600): void {
    const flairDir = join(tmpHome, ".flair");
    mkdirSync(flairDir, { recursive: true });
    const p = join(flairDir, "admin-pass");
    writeFileSync(p, content, "utf-8");
    chmodSync(p, mode);
  }

  async function writeAgentKey(agentId: string): Promise<void> {
    const keysDir = join(tmpHome, ".flair", "keys");
    mkdirSync(keysDir, { recursive: true });
    const nacl = (await import("tweetnacl")).default;
    const kp = nacl.sign.keyPair();
    const seed = kp.secretKey.slice(0, 32);
    writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(seed));
    chmodSync(join(keysDir, `${agentId}.key`), 0o600);
  }

  test("no admin-pass file, no env: local call sends no Authorization header", async () => {
    const { exitCode } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined, FLAIR_TOKEN: undefined },
    );

    expect(exitCode).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].authorization).toBeUndefined();
  });

  test("flair#634: falls back to the ~/.flair/admin-pass file when no env/agent key is set", async () => {
    writeAdminPassFile("file-secret-pass\n");

    const { exitCode } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(0);
    expect(requests[0].authorization).toBe(`Basic ${Buffer.from("admin:file-secret-pass").toString("base64")}`);
  });

  test("precedence: FLAIR_ADMIN_PASS env wins over the admin-pass file", async () => {
    writeAdminPassFile("file-secret-pass\n");

    const { exitCode } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "env-secret-pass", HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(0);
    expect(requests[0].authorization).toBe(`Basic ${Buffer.from("admin:env-secret-pass").toString("base64")}`);
  });

  test("precedence: a resolved FLAIR_AGENT_ID + real key wins over the admin-pass file", async () => {
    await writeAgentKey("test-agent-634");
    writeAdminPassFile("file-secret-pass\n");

    const { exitCode } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: "test-agent-634" },
    );

    expect(exitCode).toBe(0);
    expect(requests[0].authorization).toStartWith("TPS-Ed25519 ");
  });

  test("precedence: file beats nothing — falls back to the file when Ed25519 resolution fails (no key on disk for the agent)", async () => {
    writeAdminPassFile("file-secret-pass\n");

    const { exitCode } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: "no-such-agent" },
    );

    expect(exitCode).toBe(0);
    expect(requests[0].authorization).toBe(`Basic ${Buffer.from("admin:file-secret-pass").toString("base64")}`);
  });

  test("missing admin-pass file (no ~/.flair dir at all) falls through cleanly to no auth, no crash", async () => {
    // tmpHome has no .flair dir — existsSync() guard inside resolveLocalAdminPass
    // short-circuits before readAdminPassFileSecure would throw "does not exist".
    const { exitCode, stderr } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("does not exist");
    expect(requests[0].authorization).toBeUndefined();
  });

  test("unreadable/unsafe-permission admin-pass file falls through to no auth (warns, never crashes, never echoes the secret)", async () => {
    writeAdminPassFile("file-secret-pass\n", 0o644);

    const { exitCode, stderr } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(0);
    expect(requests[0].authorization).toBeUndefined();
    expect(stderr).toContain("permissions 644 are too open");
    // Never echo the credential value itself, even in a warning.
    expect(stderr).not.toContain("file-secret-pass");
  });

  test("flair#634: 403 with no credentials available prints a clear actionable message, not a stack trace", async () => {
    await stopServer(server);
    const started = await startMockFederationServer({ instanceStatus: 403 });
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;

    const { exitCode, stderr } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/flair init|FLAIR_ADMIN_PASS/);
    // Not a raw stack trace: no "at <anonymous>" / source-file frame lines.
    expect(stderr).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });

  test("403 with credentials already sent (wrong password) surfaces the server's own error, not the no-creds hint", async () => {
    await stopServer(server);
    const started = await startMockFederationServer({ instanceStatus: 403 });
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;

    const { exitCode, stderr } = await runCli(
      ["federation", "status", "--target", serverUrl],
      { HOME: tmpHome, FLAIR_ADMIN_PASS: "wrong-pass", HDB_ADMIN_PASSWORD: undefined, FLAIR_AGENT_ID: undefined },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("forbidden");
    expect(stderr).not.toContain("no credentials sent");
  });
});
