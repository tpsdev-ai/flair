/**
 * status-federation-peers-1146.test.ts — flair#1146.
 *
 * `flair status --json` is a pass-through of `/HealthDetail`. This file pins
 * that the command does not recompute, drop, or invent `federation.peers`
 * from some other signal (including `agents.perAgent.lastWriteAt`).
 *
 * Fixtures are hand-written. This suite does NOT import
 * `summarizePeerLiveness` — a test that feeds the classifier its own output
 * and asserts the echo is tautological and passed on main.
 *
 * The fails-first assertion that HealthDetail *emits* `measuredBy` lives in
 * `test/integration/status-federation-spoke-peers-1146.test.ts` (real Harper).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startMockFlairServer(healthDetail: Record<string, unknown>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/Health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.0.0" }));
        return;
      }
      if (req.url === "/HealthDetail") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthDetail));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
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

function installedVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname ?? __dirname, "..", "..", "package.json"), "utf-8"));
  return String(pkg.version);
}

describe("flair status --json federation.peers pass-through (flair#1146)", () => {
  let tmpHome: string;
  let server: Server | undefined;

  beforeEach(() => {
    tmpHome = makeTmpDir("flair-1146-status");
    mkdirSync(join(tmpHome, ".flair", "data"), { recursive: true });
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(tmpHome, ".flair", "keys", "status-agent.key"), Buffer.from(kp.secretKey.slice(0, 32)));
    writeFileSync(
      join(tmpHome, ".flair", ".version-check-cache.json"),
      JSON.stringify({ latest: installedVersion(), checkedAt: Date.now() }),
    );
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = undefined;
    }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const CLEAR_ENV = {
    FLAIR_ADMIN_PASS: undefined,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_URL: undefined,
    FLAIR_TARGET: undefined,
  };

  async function statusJson(healthDetail: Record<string, unknown>): Promise<any> {
    const started = await startMockFlairServer(healthDetail);
    server = started.server;
    const { stdout, stderr, exitCode } = await runCli(
      ["status", "--target", started.url, "--json"],
      { HOME: tmpHome, ...CLEAR_ENV },
    );
    expect(exitCode, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
    return JSON.parse(stdout);
  }

  test("emits HealthDetail.federation.peers unchanged, including measuredBy", async () => {
    const peers = {
      total: 1,
      connected: 1,
      disconnected: 0,
      revoked: 0,
      unknown: 0,
      measuredBy: "lastSyncAt",
    };
    const out = await statusJson({
      federation: {
        instance: { id: "flair_spoke", role: "spoke", status: "active" },
        peers,
        pendingTokens: 0,
      },
    });
    expect(out.federation.peers).toEqual(peers);
  });

  test("does not invent measuredBy when HealthDetail omitted it", async () => {
    const peers = { total: 1, connected: 0, disconnected: 0, revoked: 0, unknown: 1 };
    const out = await statusJson({
      federation: {
        instance: { id: "flair_spoke", role: "spoke", status: "active" },
        peers,
        pendingTokens: 0,
      },
    });
    expect(out.federation.peers.measuredBy).toBeUndefined();
    expect(out.federation.peers.connected).toBe(0);
    expect(out.federation.peers.unknown).toBe(1);
  });

  test("does not raise connected from agents.perAgent.lastWriteAt", async () => {
    const out = await statusJson({
      federation: {
        instance: { id: "flair_spoke", role: "spoke", status: "active" },
        peers: { total: 1, connected: 0, disconnected: 0, revoked: 0, unknown: 1, measuredBy: "lastSyncAt" },
        pendingTokens: 0,
      },
      agents: {
        count: 1,
        perAgent: [{ id: "agent-1", memoryCount: 1, lastWriteAt: "2026-09-18T19:59:00.000Z" }],
      },
    });
    expect(out.federation.peers.connected).toBe(0);
    expect(out.federation.peers.unknown).toBe(1);
    expect(out.agents.perAgent[0].lastWriteAt).toBe("2026-09-18T19:59:00.000Z");
  });
});
