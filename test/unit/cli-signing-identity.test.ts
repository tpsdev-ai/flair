/**
 * cli-signing-identity.test.ts — flair#1183: ONE canonical signing-identity
 * resolver, one documented precedence, honored by EVERY command family.
 *
 * Precedence under test (src/lib/signing-identity.ts + the CLI seam
 * resolveSigningAgentId): --agent flag > FLAIR_AGENT_ID env > config profile.
 *
 * Two layers, mirroring cli-auth-floor.test.ts's established split:
 *   1. Pure-resolver unit tests — the precedence contract in isolation, no
 *      filesystem or process state (a/b/c/d + the debug line).
 *   2. End-to-end subprocess tests — spawn the real CLI against a local mock
 *      Flair server that captures the Authorization header, and assert which
 *      agent each command family actually SIGNED as. This is what proves the
 *      fix end-to-end: before flair#1183, api()-routed commands (memory
 *      search, soul set) re-derived the signer as FLAIR_AGENT_ID-first, so
 *      `--agent X` with FLAIR_AGENT_ID=Y exported signed as Y — the exact
 *      unknown_agent report the issue is about.
 *
 * HOME is isolated per test (never ~/.flair, PRODUCTION's data dir), and every
 * auth-bearing env var is cleared before each run.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

import {
  resolveSigningIdentity,
  formatSigningIdentityDebug,
  emitSigningIdentityDebug,
  describeSigningIdentitySource,
} from "../../src/lib/signing-identity.ts";

// ─── Layer 1: the pure resolver — precedence contract ─────────────────────────

describe("resolveSigningIdentity — precedence flag > env > config (flair#1183)", () => {
  test("(a) explicit --agent flag WINS over FLAIR_AGENT_ID env and config profile", () => {
    const r = resolveSigningIdentity(
      { agent: "flag-agent" },
      "config-agent",
      { FLAIR_AGENT_ID: "env-agent" },
    );
    expect(r).toEqual({ agentId: "flag-agent", source: "flag" });
  });

  test("(b) FLAIR_AGENT_ID env WINS over the config profile when no flag", () => {
    const r = resolveSigningIdentity(
      {},
      "config-agent",
      { FLAIR_AGENT_ID: "env-agent" },
    );
    expect(r).toEqual({ agentId: "env-agent", source: "env" });
  });

  test("(c) the config profile is the FALLBACK when neither flag nor env is set", () => {
    const r = resolveSigningIdentity({}, "config-agent", { FLAIR_AGENT_ID: undefined });
    expect(r).toEqual({ agentId: "config-agent", source: "config" });
  });

  test("(d) nothing set → { agentId: null, source: 'none' } (caller decides if fatal)", () => {
    const r = resolveSigningIdentity({}, undefined, { FLAIR_AGENT_ID: undefined });
    expect(r).toEqual({ agentId: null, source: "none" });
  });

  test("an empty-string flag/env does NOT win (falsy) — precedence falls through", () => {
    // A defensive property: `--agent ""` or `FLAIR_AGENT_ID=` must not pin an
    // empty identity ahead of a real config profile.
    expect(resolveSigningIdentity({ agent: "" }, "config-agent", { FLAIR_AGENT_ID: "" }))
      .toEqual({ agentId: "config-agent", source: "config" });
  });
});

describe("signing-identity debug line (FLAIR_DEBUG)", () => {
  test("formats agentId + winning source, once, on stderr", () => {
    expect(formatSigningIdentityDebug({ agentId: "alpha", source: "flag" }, "soul set"))
      .toBe("[flair] signing identity for 'soul set': alpha (source: --agent flag)");
    expect(formatSigningIdentityDebug({ agentId: "beta", source: "env" }))
      .toBe("[flair] signing identity: beta (source: FLAIR_AGENT_ID env)");
  });

  test("names <none> honestly when nothing resolved", () => {
    expect(formatSigningIdentityDebug({ agentId: null, source: "none" }, "search"))
      .toContain("<none>");
  });

  test("emit is GATED behind FLAIR_DEBUG: silent when unset, writes when set", () => {
    const lines: string[] = [];
    const write = (s: string) => { lines.push(s); };

    emitSigningIdentityDebug({ agentId: "alpha", source: "flag" }, "search", {}, write);
    expect(lines).toEqual([]); // no FLAIR_DEBUG → nothing written

    emitSigningIdentityDebug({ agentId: "alpha", source: "flag" }, "search", { FLAIR_DEBUG: "1" }, write);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[flair] signing identity for 'search': alpha (source: --agent flag)\n");
  });

  test("every source has a human label", () => {
    for (const s of ["flag", "env", "config", "none"] as const) {
      expect(describeSigningIdentitySource(s).length).toBeGreaterThan(0);
    }
  });
});

// ─── Layer 2: end-to-end — which agent did the command actually SIGN as? ──────

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
      // A shape broad enough to satisfy every command family we exercise:
      // search (results), bootstrap (context), memory search (any), the writes (ok).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, results: [], context: "cold-start", tokenEstimate: 1,
        memoriesIncluded: 0, memoriesTruncated: 0, presenceStatus: "active",
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

/** The agentId a TPS-Ed25519 header signed as: `TPS-Ed25519 <agentId>:<ts>:...`. */
function signedAgentIdOf(requests: CapturedRequest[]): string | null {
  for (const r of requests) {
    const a = r.authorization;
    if (typeof a === "string" && a.startsWith("TPS-Ed25519 ")) {
      return a.slice("TPS-Ed25519 ".length).split(":")[0] ?? null;
    }
  }
  return null;
}

describe("signing identity honored end-to-end across command families (flair#1183)", () => {
  let tmpHome: string;
  let server: Server;
  let serverUrl: string;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `flair-1183-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });
    // Two registered identities on this machine, both with a usable key.
    for (const id of ["alpha", "bravo"]) writeHomeAgentKey(id);
    const started = await startMockFlairServer();
    server = started.server;
    serverUrl = started.url;
    requests = started.requests;
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function writeHomeAgentKey(agentId: string): void {
    const kp = nacl.sign.keyPair();
    const p = join(tmpHome, ".flair", "keys", `${agentId}.key`);
    writeFileSync(p, Buffer.from(kp.secretKey.slice(0, 32)));
    chmodSync(p, 0o600);
  }

  // Clear every ambient auth/identity/key signal — the subprocess sees ONLY
  // what each test sets, and resolves keys from the isolated HOME's ~/.flair/keys.
  const CLEAR = {
    FLAIR_AGENT_ID: undefined, FLAIR_ADMIN_PASS: undefined, HDB_ADMIN_PASSWORD: undefined,
    FLAIR_TOKEN: undefined, FLAIR_KEY_DIR: undefined, FLAIR_URL: undefined, FLAIR_TARGET: undefined,
  };

  // ── (a) explicit flag WINS over FLAIR_AGENT_ID env — for every family ──

  test("top-level `search`: --agent alpha signs as alpha even with FLAIR_AGENT_ID=bravo", async () => {
    await runCli(["search", "hello", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  test("api()-routed `memory search`: --agent alpha signs as alpha even with FLAIR_AGENT_ID=bravo (the core inversion)", async () => {
    await runCli(["memory", "search", "hello", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    // Pre-fix: api() re-derived the signer as FLAIR_AGENT_ID → signed bravo.
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  test("soul family (the worst rung): `soul set --agent alpha` signs as alpha even with FLAIR_AGENT_ID=bravo", async () => {
    // soul set has no --target option; it routes through api(), which reads the
    // base URL from FLAIR_URL. (FLAIR_AGENT_ID is still bravo here.)
    await runCli(["soul", "set", "--agent", "alpha", "--key", "role", "--value", "lead"],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo", FLAIR_URL: serverUrl });
    // Pre-fix: soul set leaned entirely on api()'s env-first extraction → bravo.
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  test("`presence set --agent alpha` signs as alpha even with FLAIR_AGENT_ID=bravo", async () => {
    await runCli(["presence", "set", "--activity", "coding", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  test("`status --agent alpha` signs its HealthDetail read as alpha even with FLAIR_AGENT_ID=bravo", async () => {
    await runCli(["status", "--agent", "alpha", "--target", serverUrl, "--json"],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("alpha");
  });

  // ── flair#1500: a flag-pinned agent signs BEFORE env admin ──

  test("flag-pinned agent signs BEFORE env admin: --agent alpha + FLAIR_ADMIN_PASS → Ed25519, not Basic (flair#1500)", async () => {
    await runCli(["memory", "search", "hello", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_ADMIN_PASS: "sekret" });
    // Pre-fix: env admin (FLAIR_ADMIN_PASS) won over the pinned agent → Basic.
    expect(signedAgentIdOf(requests)).toBe("alpha");
    // And it must NOT have fallen back to Basic admin auth.
    expect(requests.some((r) => (r.authorization ?? "").startsWith("Basic "))).toBe(false);
  });

  // ── (b) FLAIR_AGENT_ID env is honored when no flag — signs as x ──

  test("`FLAIR_AGENT_ID=bravo flair search` (no --agent) signs as bravo", async () => {
    await runCli(["search", "hello", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("bravo");
  });

  test("`FLAIR_AGENT_ID=bravo flair bootstrap` (no --agent) signs as bravo", async () => {
    await runCli(["bootstrap", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("bravo");
  });

  test("`FLAIR_AGENT_ID=bravo flair memory search` (no --agent) signs as bravo", async () => {
    await runCli(["memory", "search", "hello", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(signedAgentIdOf(requests)).toBe("bravo");
  });

  // ── the debug line, end-to-end ──

  test("FLAIR_DEBUG names the resolved identity + source on stderr; silent without it", async () => {
    const withDebug = await runCli(["search", "hi", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo", FLAIR_DEBUG: "1" });
    expect(withDebug.stderr).toContain("[flair] signing identity for 'search': alpha (source: --agent flag)");

    const noDebug = await runCli(["search", "hi", "--agent", "alpha", "--target", serverUrl],
      { HOME: tmpHome, ...CLEAR, FLAIR_AGENT_ID: "bravo" });
    expect(noDebug.stderr).not.toContain("[flair] signing identity");
  });
});
