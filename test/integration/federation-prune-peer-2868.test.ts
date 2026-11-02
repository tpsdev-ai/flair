/**
 * federation-prune-peer-2868.test.ts — `flair federation prune --apply`
 * deletes the `flair.Peer` row and confirms it is gone (flair#2868).
 *
 * Runs the built CLI against REAL Harper. The admin view `GET
 * /FederationPeers` projects rows from `flair.Peer`; the projected `id` is the
 * Peer row's primary key (`resources/Federation.ts`, `FederationPeers.get`:
 * `id: p.id`). The deletion therefore goes to `/Peer/{id}`, the admin-deletable
 * resource (`resources/Peer.ts`, `allowDelete() = allowAdmin`).
 *
 * Three rows are seeded as admin: a stale spoke, a fresh spoke and a stale hub.
 * `prune --apply` must remove only the stale spoke, report exactly one
 * deletion, keep the other two rows and exit 0. A non-admin credential is
 * refused by the admin-only peer read: exit 1, the rows survive, and the
 * refusal names its status.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const CLI_PATH = join(ROOT, "dist", "cli.js");
const sfx = Date.now().toString(36);
const PREFIX = `prune-2868-${sfx}-`;
const STALE_SPOKE = `${PREFIX}stale-spoke`;
const FRESH_SPOKE = `${PREFIX}fresh-spoke`;
const STALE_HUB = `${PREFIX}stale-hub`;
const NON_ADMIN = `${PREFIX}non-admin-agent`;

let harper: HarperInstance;
let home: string;
let nonAdminKeyPair: nacl.SignKeyPair;

function adminAuth(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${h.installDir} is not a temp tree`);
}

async function ops(operation: Record<string, unknown>): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${operation.operation} ${operation.table} failed ${res.status}: ${text.slice(0, 300)}`);
}

async function adminGet(path: string): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: adminAuth() },
    signal: AbortSignal.timeout(30_000),
  });
}

function cliEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("FLAIR_") && !key.startsWith("HDB_")) env[key] = value;
  }
  env.HOME = home;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin({ env, cwd: home }), [CLI_PATH, ...args], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`CLI overran its 30s deadline: ${args.join(" ")}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function peerRow(id: string): Promise<any | null> {
  const res = await adminGet(`/Peer/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  const text = await res.text();
  if (res.status !== 200) throw new Error(`GET /Peer/${id} returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function peerIds(): Promise<string[]> {
  const res = await adminGet("/FederationPeers");
  const text = await res.text();
  if (res.status !== 200) throw new Error(`GET /FederationPeers returned ${res.status}: ${text.slice(0, 300)}`);
  return ((JSON.parse(text).peers ?? []) as any[]).map((p) => String(p.id));
}

/** A local listener for the outcome branches a real Harper cannot reach: a
 *  2xx DELETE whose row survives, a read-back that fails, and a refused
 *  DELETE. It answers the peer list as admin and ignores credentials. */
async function startStub(opts: { deleteStatus: number; readBack: "present" | "fail" }): Promise<{ url: string; id: string; close: () => Promise<void> }> {
  const id = `stub-spoke-2868-${sfx}`;
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "/";
      if (req.method === "GET" && path === "/FederationPeers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ peers: [{ id, role: "spoke", lastSyncAt: stale }] }));
        return;
      }
      if (req.method === "DELETE" && path === `/Peer/${encodeURIComponent(id)}`) {
        res.writeHead(opts.deleteStatus, { "Content-Type": "application/json" });
        res.end(opts.deleteStatus === 403 ? JSON.stringify({ error: "forbidden" }) : "{}");
        return;
      }
      if (req.method === "GET" && path === `/Peer/${encodeURIComponent(id)}`) {
        if (opts.readBack === "fail") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "read-back failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, role: "spoke" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, id, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

beforeAll(async () => {
  ensureCliBuild();
  harper = await startHarper();
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-2868-home-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });

  nonAdminKeyPair = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${NON_ADMIN}.key`), Buffer.from(nonAdminKeyPair.secretKey.slice(0, 32)), { mode: 0o600 });

  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const publicKey = Buffer.from(nacl.sign.keyPair().publicKey).toString("base64");
  await ops({
    operation: "insert", database: "flair", table: "Peer",
    records: [
      { id: STALE_SPOKE, publicKey, role: "spoke", status: "paired", lastSyncAt: stale, pairedAt: stale, createdAt: stale },
      { id: FRESH_SPOKE, publicKey, role: "spoke", status: "paired", lastSyncAt: now, pairedAt: now, createdAt: now },
      { id: STALE_HUB, publicKey, role: "hub", status: "paired", lastSyncAt: stale, pairedAt: stale, createdAt: stale },
    ],
  });
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{
      id: NON_ADMIN, name: NON_ADMIN, role: "agent",
      publicKey: Buffer.from(nonAdminKeyPair.publicKey).toString("base64"), createdAt: now,
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2868 — federation prune --apply deletes and confirms the Peer row", () => {
  test("deletes the stale spoke, keeps the fresh spoke and the hub, reports one deletion and exits 0", async () => {
    expect(await peerRow(STALE_SPOKE), "precondition: the stale spoke exists").not.toBeNull();
    expect(await peerRow(FRESH_SPOKE), "precondition: the fresh spoke exists").not.toBeNull();
    expect(await peerRow(STALE_HUB), "precondition: the stale hub exists").not.toBeNull();

    const res = await runCli(
      ["federation", "prune", "--older-than", "1h", "--include", PREFIX, "--apply", "--target", harper.httpURL],
      cliEnv({ FLAIR_ADMIN_PASS: harper.admin.password, FLAIR_OUTPUT: "human" }),
    );

    expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain(`Deleted ${STALE_SPOKE}`);
    expect(res.stdout).toContain("1 peer(s) deleted; 0 error(s); 0 unknown outcome(s).");

    // The deletion is confirmed by the table itself, not by the CLI's output.
    expect(await peerRow(STALE_SPOKE), "the stale spoke row is gone").toBeNull();
    expect(await peerRow(FRESH_SPOKE), "the fresh spoke survives").not.toBeNull();
    expect(await peerRow(STALE_HUB), "the hub survives").not.toBeNull();

    const ids = await peerIds();
    expect(ids).toContain(FRESH_SPOKE);
    expect(ids).toContain(STALE_HUB);
    expect(ids).not.toContain(STALE_SPOKE);
  }, 90_000);

  test("a non-admin credential is refused: exit 1, the stale row survives and the output names the refusal", async () => {
    // Recreate the stale spoke if the deletion case removed it, so this case
    // has a row it must not touch and does not depend on test order.
    if (await peerRow(STALE_SPOKE) === null) {
      const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await ops({
        operation: "insert", database: "flair", table: "Peer",
        records: [{
          id: STALE_SPOKE, publicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"),
          role: "spoke", status: "paired", lastSyncAt: stale, pairedAt: stale, createdAt: stale,
        }],
      });
    }

    const res = await runCli(
      ["federation", "prune", "--older-than", "1h", "--include", PREFIX, "--apply", "--target", harper.httpURL],
      cliEnv({ FLAIR_AGENT_ID: NON_ADMIN, FLAIR_OUTPUT: "human", FLAIR_ADMIN_PASS: undefined }),
    );

    expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain("403");
    expect(await peerRow(STALE_SPOKE), "the refused row survives").not.toBeNull();
  }, 180_000);

  test("a 2xx DELETE whose row is still readable counts as failed, not deleted", async () => {
    const stub = await startStub({ deleteStatus: 200, readBack: "present" });
    try {
      const res = await runCli(
        ["federation", "prune", "--older-than", "1h", "--include", `stub-spoke-2868-${sfx}`, "--apply", "--target", stub.url],
        cliEnv({ FLAIR_ADMIN_PASS: "stub-not-checked", FLAIR_OUTPUT: "human" }),
      );
      expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
      expect(res.stdout).toContain(`Failed to delete ${stub.id}: the row is still present after the DELETE.`);
      expect(res.stdout).toContain("0 peer(s) deleted; 1 error(s); 0 unknown outcome(s).");
      expect(res.stdout).not.toContain("Deleted stub-spoke");
    } finally {
      await stub.close();
    }
  }, 60_000);

  test("a failed read-back after the DELETE is unknown (exit 3), never deleted", async () => {
    const stub = await startStub({ deleteStatus: 200, readBack: "fail" });
    try {
      const res = await runCli(
        ["federation", "prune", "--older-than", "1h", "--include", `stub-spoke-2868-${sfx}`, "--apply", "--target", stub.url],
        cliEnv({ FLAIR_ADMIN_PASS: "stub-not-checked", FLAIR_OUTPUT: "human" }),
      );
      expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(3);
      expect(res.stdout).toContain(`Unknown outcome for ${stub.id}: the delete returned, but reading the row back failed:`);
      expect(res.stdout).toContain("0 peer(s) deleted; 0 error(s); 1 unknown outcome(s).");
    } finally {
      await stub.close();
    }
  }, 60_000);

  test("a refused DELETE names its status and counts as failed", async () => {
    const stub = await startStub({ deleteStatus: 403, readBack: "present" });
    try {
      const res = await runCli(
        ["federation", "prune", "--older-than", "1h", "--include", `stub-spoke-2868-${sfx}`, "--apply", "--target", stub.url],
        cliEnv({ FLAIR_ADMIN_PASS: "stub-not-checked", FLAIR_OUTPUT: "human" }),
      );
      expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
      expect(res.stdout).toContain(`Failed to delete ${stub.id}: HTTP 403`);
      expect(res.stdout).toContain("0 peer(s) deleted; 1 error(s); 0 unknown outcome(s).");
    } finally {
      await stub.close();
    }
  }, 60_000);
});
