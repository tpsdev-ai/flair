// federation-retry-storage-2455.test.ts — flair#2455 slice 1 storage, gating,
// inbound isolation and the operator query, driven against REAL Harper.
//
//  - the FederationRetry table refuses a non-admin read/write on every verb;
//  - the admin-only /FederationRetries reader returns the rows;
//  - an inbound sync naming FederationRetry is refused (unknown_table) and
//    lands nothing;
//  - `flair federation status` renders the pending and terminal rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { retryEntryKey } from "../../resources/federation-retry-lib.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const PEER = `retry-peer-${sfx}`;
const peerKp = nacl.sign.keyPair();
const now = () => new Date().toISOString();

let harper: HarperInstance;
let tmpHome: string;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${h.installDir} is not a temp tree`);
}

function adminAuth(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readRetryRow(key: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_hash", database: "flair", table: "FederationRetry",
    hash_values: [key], get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}

function retryRow(key: string, over: Record<string, unknown> = {}) {
  return {
    id: key,
    peerId: PEER,
    table: "Memory",
    recordId: `row-${sfx}`,
    state: "pending",
    firstRefusedAt: now(),
    attempts: 1,
    createdAt: now(),
    ...over,
  };
}

async function adminFetch(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { timeout: 20_000, env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function cliEnv(): Record<string, string | undefined> {
  return {
    HOME: tmpHome,
    FLAIR_ADMIN_PASS: harper.admin.password,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_URL: undefined,
    FLAIR_OPS_TARGET: undefined,
    FLAIR_OUTPUT: undefined,
  };
}

describe("flair#2455 — FederationRetry storage, gating and the operator query (real Harper)", () => {
  const pendingKey = retryEntryKey(PEER, "Memory", `pending-${sfx}`);
  const terminalKey = retryEntryKey(PEER, "Soul", `terminal-${sfx}`);

  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    tmpHome = join(tmpdir(), `flair-2455-home-${sfx}`);
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });

    // A peer so POST /FederationSync accepts a batch.
    await ops({
      operation: "upsert", database: "flair", table: "Peer",
      records: [{ id: PEER, publicKey: Buffer.from(peerKp.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now() }],
    });
    await ops({
      operation: "upsert", database: "flair", table: "FederationRetry",
      records: [
        retryRow(pendingKey, { table: "Memory", recordId: `pending-${sfx}`, state: "pending", attempts: 2, lastReason: "merge_target_changed" }),
        retryRow(terminalKey, { table: "Soul", recordId: `terminal-${sfx}`, state: "terminal", attempts: 5, lastReason: "merge_error", resolution: "retry_exhausted", bound: "attempts", completedAt: now() }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("the FederationRetry table refuses every non-admin operation", async () => {
    const path = `/FederationRetry/${encodeURIComponent(pendingKey)}`;
    const anon = (method: string, body?: unknown) =>
      fetch(`${harper.httpURL}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    expect([401, 403], "anon GET").toContain((await anon("GET")).status);
    expect([401, 403], "anon PUT").toContain((await anon("PUT", retryRow(`anon-${sfx}`))).status);
    expect([401, 403], "anon PATCH").toContain((await anon("PATCH", { attempts: 9 })).status);
    expect([401, 403], "anon DELETE").toContain((await anon("DELETE")).status);
    expect([401, 403], "anon /FederationRetries").toContain(
      (await fetch(`${harper.httpURL}/FederationRetries`, { signal: AbortSignal.timeout(30_000) })).status,
    );
  });

  test("the admin reader returns the row; /FederationRetries returns pending and terminal", async () => {
    const one = await adminFetch(`/FederationRetry/${encodeURIComponent(pendingKey)}`);
    expect(one.status, await one.clone().text()).toBe(200);

    const res = await adminFetch("/FederationRetries");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const pending = body.pending.find((r: any) => r.id === `pending-${sfx}`);
    const terminal = body.terminal.find((r: any) => r.id === `terminal-${sfx}`);
    expect(pending, JSON.stringify(body)).toBeDefined();
    expect(pending.reason).toBe("merge_target_changed");
    expect(pending.attempts).toBe(2);
    expect(terminal).toBeDefined();
    expect(terminal.resolution).toBe("retry_exhausted");
    expect(terminal.bound).toBe("attempts");
  });

  test("an inbound sync naming FederationRetry is refused as unknown_table and lands nothing", async () => {
    const target = retryEntryKey(PEER, "Memory", `inbound-${sfx}`);
    const body = signBodyFresh({
      instanceId: PEER,
      records: [{
        table: "FederationRetry",
        id: target,
        data: { id: target, peerId: PEER, table: "Memory", recordId: `inbound-${sfx}`, state: "terminal", resolution: "merged" },
        updatedAt: now(),
        originatorInstanceId: PEER,
      }],
      lamportClock: Date.now(),
    }, peerKp.secretKey);
    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const out = await res.json() as any;
    expect(out.merged).toBe(0);
    expect(out.skippedReasons.unknown_table).toBeGreaterThanOrEqual(1);
    expect(await readRetryRow(target)).toBeNull();
  });

  test("`flair federation status` shows the pending and terminal retry rows", async () => {
    const json = await runCli(["federation", "status", "--target", harper.httpURL, "--json"], cliEnv());
    expect(json.exitCode, `stderr: ${json.stderr}`).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.retries.pending.some((r: any) => r.id === `pending-${sfx}`)).toBe(true);
    expect(parsed.retries.terminal.some((r: any) => r.id === `terminal-${sfx}`)).toBe(true);

    const plain = await runCli(["federation", "status", "--target", harper.httpURL], { ...cliEnv(), FLAIR_OUTPUT: "human" });
    expect(plain.exitCode, `stderr: ${plain.stderr}`).toBe(0);
    expect(plain.stdout).toContain("Federation retries");
    expect(plain.stdout).toContain(`pending-${sfx}`);
    expect(plain.stdout).toContain("merge_target_changed");
    expect(plain.stdout).toContain("retry_exhausted");
  }, 30_000);
});
