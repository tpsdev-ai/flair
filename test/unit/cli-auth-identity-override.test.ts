/**
 * cli-auth-identity-override.test.ts — flair#1500: a named identity is never
 * silently outranked by a different (usually more privileged) credential.
 *
 * flair#1504 fixed the loud half: a flag-pinned `--agent X` signs as X before
 * an ambient admin credential, and hard-errors if X has no key. Two
 * substitutions in the same class stayed silent on main:
 *
 *   • `FLAIR_AGENT_ID=X` (env-pinned) + `FLAIR_ADMIN_PASS` → admin signs and
 *     the operator is told nothing;
 *   • explicit `--admin-pass` + flag-pinned `--agent X` (#1506) → admin signs
 *     and the operator is told nothing.
 *
 * This file asserts the DISPATCH LAYER: which Authorization header actually
 * leaves the CLI (captured by a local mock server), and whether the resolver
 * says so when the named identity did not sign. It covers the full matrix —
 * (a) flag only, (b) ambient env only, (c) both, (d) neither — plus the two
 * override cases above. The override cases FAIL on the pre-fix code (no
 * notice) and pass once the resolver reports the substitution.
 *
 * Precedence itself is deliberately unchanged (flair#1504/#1507): an env-pinned
 * identity still loses to ambient admin, and explicit `--admin-pass` still
 * signs as admin on behalf of a named row owner. Only the silence is removed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

import {
  describeIdentityOverride,
  emitIdentityOverrideNotice,
  resetIdentityOverrideNotices,
} from "../../src/lib/auth-resolve.ts";

// ─── Layer 1: the pure predicate — signer IS the named identity, or not? ─────

describe("describeIdentityOverride — names the substitution, or null when the named identity signed (flair#1500)", () => {
  test("the named identity signed → null (flag-pinned, env-pinned, explicit key)", () => {
    expect(describeIdentityOverride({ agentId: "alpha", namedSource: "flag", credentialSource: "flag-agent" })).toBeNull();
    expect(describeIdentityOverride({ agentId: "alpha", namedSource: "env", credentialSource: "pinned-agent" })).toBeNull();
    expect(describeIdentityOverride({ agentId: "alpha", namedSource: "flag", credentialSource: "explicit-key" })).toBeNull();
  });

  test("explicit --admin-pass outranks the named identity → names both and the remedy", () => {
    const msg = describeIdentityOverride({ agentId: "alpha", namedSource: "flag", credentialSource: "explicit-admin" });
    expect(msg).toContain("--agent 'alpha'");
    expect(msg).toContain("--admin-pass");
    expect(msg).toContain("Drop --admin-pass");
  });

  test("env admin outranks an env-pinned identity → names the env var and the remedy", () => {
    const msg = describeIdentityOverride({
      agentId: "bravo", namedSource: "env", credentialSource: "env-admin", adminPassEnvVar: "FLAIR_ADMIN_PASS",
    });
    expect(msg).toContain("FLAIR_AGENT_ID='bravo'");
    expect(msg).toContain("FLAIR_ADMIN_PASS");
    expect(msg).toContain("signing as admin");
  });

  test("FLAIR_TOKEN and the local admin-pass file are named too", () => {
    expect(describeIdentityOverride({ agentId: "bravo", namedSource: "env", credentialSource: "env-token" })).toContain("FLAIR_TOKEN");
    expect(describeIdentityOverride({ agentId: "bravo", namedSource: "env", credentialSource: "local-admin-file" })).toContain("admin-pass");
  });

  test("notice is emitted once per process, and reset makes it emittable again", () => {
    const lines: string[] = [];
    const write = (s: string) => { lines.push(s); };
    resetIdentityOverrideNotices();
    emitIdentityOverrideNotice("Warning: test notice", write);
    emitIdentityOverrideNotice("Warning: test notice", write);
    expect(lines).toHaveLength(1);
    resetIdentityOverrideNotices();
    emitIdentityOverrideNotice("Warning: test notice", write);
    expect(lines).toHaveLength(2);
  });
});

// ─── Layer 2: end-to-end — which Authorization header actually leaves? ────────

interface CapturedRequest { method: string; path: string; authorization: string | undefined }

function startMockFlairServer(): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
      if (req.url === "/Health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, context: "cold-start", tokenEstimate: 1,
        memoriesIncluded: 0, memoriesTruncated: 0,
      }));
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

/** The Authorization header of the authenticated call, if any. */
function authOfAuthenticatedCall(requests: CapturedRequest[]): string | undefined {
  const authed = requests.find((r) => r.path === "/HealthDetail" || r.path.startsWith("/Memory"));
  return authed?.authorization;
}

function signedAgentIdOf(requests: CapturedRequest[]): string | null {
  for (const r of requests) {
    const a = r.authorization;
    if (typeof a === "string" && a.startsWith("TPS-Ed25519 ")) return a.slice("TPS-Ed25519 ".length).split(":")[0] ?? null;
  }
  return null;
}

describe("named identity vs ambient credential — the dispatch matrix (flair#1500)", () => {
  let tmpHome: string;
  let server: Server;
  let serverUrl: string;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `flair-1500-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });
    const started = await startMockFlairServer();
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  function writeHomeAgentKey(agentId: string): void {
    const kp = nacl.sign.keyPair();
    const p = join(tmpHome, ".flair", "keys", `${agentId}.key`);
    writeFileSync(p, Buffer.from(kp.secretKey.slice(0, 32)));
    chmodSync(p, 0o600);
  }

  // The subprocess sees ONLY what each test sets; keys resolve from the
  // isolated HOME's ~/.flair/keys.
  const CLEAR = {
    FLAIR_AGENT_ID: undefined, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined,
    FLAIR_TOKEN: undefined, FLAIR_KEY_DIR: undefined, FLAIR_URL: undefined, FLAIR_TARGET: undefined,
  };

  test("(a) --agent only → the request is signed as that agent (Ed25519)", async () => {
    writeHomeAgentKey("alpha");
    const { exitCode } = await runCli(["status", "--target", serverUrl, "--agent", "alpha", "--json"], { HOME: tmpHome, ...CLEAR });
    expect(exitCode).toBe(0);
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  test("(b) ambient env only → the request carries Basic admin auth", async () => {
    const { exitCode } = await runCli(["status", "--target", serverUrl, "--json"], { HOME: tmpHome, ...CLEAR, FLAIR_ADMIN_PASS: "sekret" });
    expect(exitCode).toBe(0);
    const auth = authOfAuthenticatedCall(requests);
    expect(auth).toBe(`Basic ${Buffer.from("admin:sekret").toString("base64")}`);
  });

  test("(c) BOTH --agent + ambient admin → the explicit agent wins, never Basic (the #1504 guarantee)", async () => {
    writeHomeAgentKey("alpha");
    const { exitCode } = await runCli(
      ["status", "--target", serverUrl, "--agent", "alpha", "--json"],
      { HOME: tmpHome, ...CLEAR, FLAIR_ADMIN_PASS: "must-not-win" },
    );
    expect(exitCode).toBe(0);
    expect(signedAgentIdOf(requests)).toBe("alpha");
    const auth = authOfAuthenticatedCall(requests);
    expect(auth?.startsWith("Basic ")).toBe(false);
  });

  test("(c-env) FLAIR_AGENT_ID + ambient admin → admin signs AND the override is announced, never silent", async () => {
    writeHomeAgentKey("bravo");
    const { exitCode, stderr } = await runCli(
      ["status", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo", FLAIR_ADMIN_PASS: "ambient" },
    );
    expect(exitCode).toBe(0);
    // Precedence unchanged: ambient admin still signs.
    expect(authOfAuthenticatedCall(requests)).toBe(`Basic ${Buffer.from("admin:ambient").toString("base64")}`);
    // ...but not silently. This is the assertion that fails on pre-fix code.
    expect(stderr).toContain("FLAIR_AGENT_ID='bravo'");
    expect(stderr).toContain("FLAIR_ADMIN_PASS");
    expect(stderr).toContain("signing as admin");
  });

  test("(c-explicit) --agent + --admin-pass both explicit → admin signs AND the conflict is announced, never silent", async () => {
    writeHomeAgentKey("alpha");
    const { exitCode, stderr } = await runCli(
      ["memory", "add", "conflict probe", "--agent", "alpha", "--admin-pass", "explicit"],
      { HOME: tmpHome, ...CLEAR, FLAIR_URL: serverUrl },
    );
    expect(exitCode).toBe(0);
    // The documented admin-on-behalf-of-row-owner path is preserved...
    expect(authOfAuthenticatedCall(requests)).toBe(`Basic ${Buffer.from("admin:explicit").toString("base64")}`);
    // ...and the two-explicit-flags conflict is reported (fails on pre-fix code).
    expect(stderr).toContain("--agent 'alpha'");
    expect(stderr).toContain("--admin-pass");
  });

  test("(d) neither → no credential is sent at all (no false signing as someone else)", async () => {
    const { exitCode } = await runCli(["status", "--target", serverUrl, "--json"], { HOME: tmpHome, ...CLEAR });
    expect(exitCode).toBe(0);
    expect(signedAgentIdOf(requests)).toBeNull();
    if (authOfAuthenticatedCall(requests) !== undefined) {
      expect(authOfAuthenticatedCall(requests)?.startsWith("Basic ")).toBe(false);
    }
  });
});
