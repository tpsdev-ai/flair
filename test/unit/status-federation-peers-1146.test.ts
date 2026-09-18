/**
 * status-federation-peers-1146.test.ts — flair#1146.
 *
 * `flair status --json` must not tell the operator that a healthy spoke has
 * `peers.connected: 0` while the hub reports the same peer connected.
 *
 * Diagnosis (what the count measures): `/HealthDetail` (and therefore
 * `status --json`) does not probe a live socket and does not count
 * `Peer.status === "connected"`. It runs `summarizePeerLiveness` — peers
 * whose `lastSyncAt` is a parseable stamp within 24h. Pairing writes the
 * spoke's hub row as `status: "paired"` with no stamp; the hub writes
 * `lastSyncAt` on every FederationSync receive. A missing stamp is
 * `unknown`, which leaves `connected: 0` and reads as an outage.
 *
 * These tests drive the real `status` command (subprocess + mock
 * `/HealthDetail`) and assert the emitted JSON. They are not a helper-only
 * suite — the bug is what the command TELLS the operator.
 *
 * Fails on today's code: HealthDetail's peers block has no `measuredBy`,
 * and a spoke-shaped row that HAS a recent lastSyncAt must still appear as
 * `connected: 1` in the command output (the #1499 arithmetic). Hub-shaped
 * rows must not regress. A paired row with no lastSyncAt plus a fresh
 * memory `lastWrite` must stay `connected: 0` — do not infer from data
 * freshness.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";
import { summarizePeerLiveness } from "../../resources/federation-peer-liveness.ts";

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

const NOW_MS = Date.parse("2026-09-18T20:00:00.000Z");
const MINUTE_AGO = new Date(NOW_MS - 60_000).toISOString();

function peersBlock(peers: Array<{ status?: string | null; lastSyncAt?: unknown }>) {
  const summary = summarizePeerLiveness(peers, NOW_MS);
  return {
    total: summary.total,
    connected: summary.connected,
    disconnected: summary.disconnected,
    revoked: summary.revoked,
    unknown: summary.unknown,
    measuredBy: "lastSyncAt" as const,
  };
}

describe("flair status --json federation.peers (flair#1146)", () => {
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

  test("spoke-shaped peer (status=paired, lastSyncAt a minute ago) emits connected: 1", async () => {
    const peers = peersBlock([{ status: "paired", lastSyncAt: MINUTE_AGO }]);
    const out = await statusJson({
      federation: {
        instance: { id: "flair_spoke", role: "spoke", status: "active" },
        peers,
        pendingTokens: 0,
      },
    });
    expect(out.federation.instance.role).toBe("spoke");
    expect(out.federation.peers.total).toBe(1);
    expect(out.federation.peers.connected).toBe(1);
    expect(out.federation.peers.disconnected).toBe(0);
    expect(out.federation.peers.revoked).toBe(0);
    expect(out.federation.peers.unknown).toBe(0);
    expect(out.federation.peers.measuredBy).toBe("lastSyncAt");
  });

  test("hub-shaped peer (status=connected, lastSyncAt a minute ago) does not regress", async () => {
    const peers = peersBlock([{ status: "connected", lastSyncAt: MINUTE_AGO }]);
    const out = await statusJson({
      federation: {
        instance: { id: "flair_hub", role: "hub", status: "active" },
        peers,
        pendingTokens: 0,
      },
    });
    expect(out.federation.instance.role).toBe("hub");
    expect(out.federation.peers.total).toBe(1);
    expect(out.federation.peers.connected).toBe(1);
    expect(out.federation.peers.disconnected).toBe(0);
    expect(out.federation.peers.revoked).toBe(0);
    expect(out.federation.peers.measuredBy).toBe("lastSyncAt");
  });

  test("hazard: paired + no lastSyncAt + recent memory lastWrite is NOT connected", async () => {
    const peers = peersBlock([{ status: "paired", lastSyncAt: null }]);
    const out = await statusJson({
      federation: {
        instance: { id: "flair_spoke", role: "spoke", status: "active" },
        peers,
        pendingTokens: 0,
      },
      agents: {
        count: 1,
        perAgent: [{ id: "agent-1", memoryCount: 1, lastWriteAt: MINUTE_AGO }],
      },
    });
    expect(out.federation.peers.total).toBe(1);
    expect(out.federation.peers.connected).toBe(0);
    expect(out.federation.peers.disconnected).toBe(0);
    expect(out.federation.peers.unknown).toBe(1);
    expect(out.agents.perAgent[0].lastWriteAt).toBe(MINUTE_AGO);
    expect(out.federation.peers.measuredBy).toBe("lastSyncAt");
  });
});
