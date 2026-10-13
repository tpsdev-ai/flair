// federation-retry-storage-2455.test.ts — flair#2455 slice 1 storage, gating,
// inbound isolation and the operator query, driven against REAL Harper.
//
//  - the FederationRetry table refuses GET, PUT, PATCH, DELETE and POST from an
//    anonymous caller AND from an authenticated non-admin agent, and none of
//    those requests changes or creates a row;
//  - the table is sealed: a write carrying a field the schema does not declare
//    is refused on REST PUT/PATCH/POST and on an operations-API upsert, and the
//    field is never persisted;
//  - the admin-only /FederationRetries reader returns the rows;
//  - an inbound sync naming FederationRetry is refused (unknown_table) and
//    lands nothing;
//  - `flair federation status` renders the retry rows with a peer, with no
//    peer configured, and when the peer read fails.
//
// Runs against a composed copy of the built component (test/helpers/
// federation-retry-probe-component.ts) whose test-only module fails GET
// /FederationPeers while a marker file is present. Nothing under resources/
// ships that switch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { retryEntryKey } from "../../resources/federation-retry-lib.js";
import { componentWithRetryProbe, type RetryProbeComponent } from "../helpers/federation-retry-probe-component";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const PEER = `retry-peer-${sfx}`;
const peerKp = nacl.sign.keyPair();
const now = () => new Date().toISOString();
const CONTENT = `RETRY-ROW-CONTENT-${sfx}`;

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
const nonAdmin = mkAgent(`retry-nonadmin-${sfx}`);

/** TPS-Ed25519 over `<id>:<ts>:<nonce>:<METHOD>:<pathname><search>` (resources/agent-auth.ts). */
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
let component: RetryProbeComponent;
let pauseDir: string;
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

async function opsRaw(operation: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await opsRaw(operation);
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

async function peerCount(): Promise<number> {
  const rows = await ops({ operation: "sql", sql: "SELECT id FROM flair.Peer" });
  return (rows as any[]).length;
}

describe("flair#2455 — FederationRetry storage, gating and the operator query (real Harper)", () => {
  const pendingKey = retryEntryKey(PEER, "Memory", `pending-${sfx}`);
  const terminalKey = retryEntryKey(PEER, "Soul", `terminal-${sfx}`);

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2455-storage-pause-"));
    const saved = process.env.FLAIR_TEST_PAUSE_DIR;
    process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
    try {
      component = componentWithRetryProbe();
      harper = await startHarper({ cwd: component.dir });
    } finally {
      if (saved === undefined) delete process.env.FLAIR_TEST_PAUSE_DIR;
      else process.env.FLAIR_TEST_PAUSE_DIR = saved;
    }
    assertOwnInstance(harper);
    tmpHome = join(tmpdir(), `flair-2455-home-${sfx}`);
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });

    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: nonAdmin.id, name: nonAdmin.id, role: "agent", publicKey: nonAdmin.publicKey, createdAt: now() }],
    });
    await ops({
      operation: "upsert", database: "flair", table: "FederationRetry",
      records: [
        retryRow(pendingKey, { table: "Memory", recordId: `pending-${sfx}`, state: "pending", attempts: 2, lastReason: "merge_target_changed" }),
        retryRow(terminalKey, { table: "Soul", recordId: `terminal-${sfx}`, state: "terminal", attempts: 5, lastReason: "merge_error", resolution: "retry_exhausted", bound: "attempts", completedAt: now() }),
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (component) component.cleanup();
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Every verb on the table and the reader, as `who`; returns each status by label. */
  async function everyVerb(who: (method: string, path: string, body?: unknown) => Promise<Response>, newKey: string) {
    const rowPath = `/FederationRetry/${encodeURIComponent(pendingKey)}`;
    return {
      "GET row": (await who("GET", rowPath)).status,
      "PUT row": (await who("PUT", rowPath, retryRow(pendingKey, { attempts: 9 }))).status,
      "PATCH row": (await who("PATCH", rowPath, { attempts: 9 })).status,
      "DELETE row": (await who("DELETE", rowPath)).status,
      "POST collection": (await who("POST", "/FederationRetry/", retryRow(newKey))).status,
      "PUT new row": (await who("PUT", `/FederationRetry/${encodeURIComponent(newKey)}`, retryRow(newKey))).status,
      "GET /FederationRetries": (await who("GET", "/FederationRetries")).status,
    };
  }

  test("an anonymous caller is refused on every verb, and nothing changes", async () => {
    const before = await readRetryRow(pendingKey);
    const newKey = retryEntryKey(PEER, "Memory", `anon-${sfx}`);
    const statuses = await everyVerb((method, path, body) =>
      fetch(`${harper.httpURL}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      }), newKey);
    for (const [label, status] of Object.entries(statuses)) {
      expect([401, 403], `anonymous ${label} returned ${status}`).toContain(status);
    }
    expect(await readRetryRow(pendingKey)).toEqual(before);
    expect(await readRetryRow(newKey)).toBeNull();
  });

  test("an authenticated non-admin agent is refused on every verb, and nothing changes", async () => {
    const before = await readRetryRow(pendingKey);
    const newKey = retryEntryKey(PEER, "Memory", `nonadmin-${sfx}`);
    const statuses = await everyVerb((method, path, body) =>
      fetch(`${harper.httpURL}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(nonAdmin, method, path) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      }), newKey);
    for (const [label, status] of Object.entries(statuses)) {
      expect(status, `non-admin ${label} returned ${status}`).toBe(403);
    }
    expect(await readRetryRow(pendingKey)).toEqual(before);
    expect(await readRetryRow(newKey)).toBeNull();
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

  test("the table is sealed: an undeclared field is refused on REST PUT, PATCH and POST and on an operations-API upsert, and never persisted", async () => {
    const before = await readRetryRow(pendingKey);
    const rowPath = `/FederationRetry/${encodeURIComponent(pendingKey)}`;
    const putKey = retryEntryKey(PEER, "Memory", `sealed-put-${sfx}`);
    const postKey = retryEntryKey(PEER, "Memory", `sealed-post-${sfx}`);
    const opsKey = retryEntryKey(PEER, "Memory", `sealed-ops-${sfx}`);

    const refused: Record<string, Response> = {
      "admin PUT existing row": await adminFetch(rowPath, "PUT", { ...before, content: CONTENT }),
      "admin PATCH existing row": await adminFetch(rowPath, "PATCH", { content: CONTENT }),
      "admin PUT new row": await adminFetch(`/FederationRetry/${encodeURIComponent(putKey)}`, "PUT", { ...retryRow(putKey), content: CONTENT }),
      "admin POST new row": await adminFetch("/FederationRetry/", "POST", { ...retryRow(postKey), content: CONTENT }),
      "operations-API upsert": await opsRaw({
        operation: "upsert", database: "flair", table: "FederationRetry",
        records: [{ ...retryRow(opsKey), content: CONTENT }],
      }),
    };
    // Each is refused by the sealed schema's validation (400, naming the field),
    // not by some other failure.
    for (const [label, res] of Object.entries(refused)) {
      const text = await res.text();
      expect(res.status, `${label} returned ${res.status}: ${text.slice(0, 300)}`).toBe(400);
      expect(text, label).toContain("Property content is not allowed");
    }

    // The existing row is unchanged, and no new row exists.
    const after = await readRetryRow(pendingKey);
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain("content");
    for (const key of [putKey, postKey, opsKey]) expect(await readRetryRow(key)).toBeNull();
    // No row anywhere in the table carries the field.
    const all = await ops({ operation: "sql", sql: "SELECT * FROM flair.FederationRetry" });
    expect(JSON.stringify(all)).not.toContain(CONTENT);

    // Positive control: the same admin write with declared fields only is accepted.
    const okKey = retryEntryKey(PEER, "Memory", `sealed-ok-${sfx}`);
    const ok = await adminFetch(`/FederationRetry/${encodeURIComponent(okKey)}`, "PUT", retryRow(okKey, { recordId: `sealed-ok-${sfx}` }));
    expect([200, 204], `declared-only PUT returned ${ok.status}`).toContain(ok.status);
    expect((await readRetryRow(okKey))?.state).toBe("pending");
    await ops({ operation: "delete", database: "flair", table: "FederationRetry", hash_values: [okKey] });
  });

  test("`flair federation status` renders the retry rows when no peer is configured", async () => {
    expect(await peerCount(), "precondition: this case runs before any Peer row exists").toBe(0);

    const plain = await runCli(["federation", "status", "--target", harper.httpURL], { ...cliEnv(), FLAIR_OUTPUT: "human" });
    expect(plain.exitCode, `stderr: ${plain.stderr}`).toBe(0);
    expect(plain.stdout).toContain("No peers configured");
    expect(plain.stdout).toContain("Federation retries");
    expect(plain.stdout).toContain(`pending-${sfx}`);
    expect(plain.stdout).toContain(`terminal-${sfx}`);
    expect(plain.stdout).toContain("retry_exhausted");
  }, 30_000);

  test("`flair federation status` renders the retry rows when the peer read fails", async () => {
    const arm = join(pauseDir, "arm.peers-read-fail");
    writeFileSync(arm, "");
    try {
      // Positive control: the armed module really fails the peer read.
      expect((await adminFetch("/FederationPeers")).status).toBe(500);

      const plain = await runCli(["federation", "status", "--target", harper.httpURL], { ...cliEnv(), FLAIR_OUTPUT: "human" });
      expect(plain.exitCode, `stderr: ${plain.stderr}`).toBe(0);
      expect(plain.stdout).toContain("Peers unverifiable");
      expect(plain.stdout).toContain("Federation retries");
      expect(plain.stdout).toContain(`pending-${sfx}`);
      expect(plain.stdout).toContain(`terminal-${sfx}`);

      const json = await runCli(["federation", "status", "--target", harper.httpURL, "--json"], cliEnv());
      expect(json.exitCode, `stderr: ${json.stderr}`).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.peers).toBeNull();
      expect(parsed.unverifiable?.peers).toBeDefined();
      expect(parsed.retries.pending.some((r: any) => r.id === `pending-${sfx}`)).toBe(true);
    } finally {
      rmSync(arm, { force: true });
    }
  }, 30_000);

  test("an inbound sync naming FederationRetry is refused as unknown_table and lands nothing", async () => {
    // A peer so POST /FederationSync accepts a batch.
    await ops({
      operation: "upsert", database: "flair", table: "Peer",
      records: [{ id: PEER, publicKey: Buffer.from(peerKp.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now() }],
    });
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

  test("`flair federation status` shows the pending and terminal retry rows beside the peer table", async () => {
    expect(await peerCount(), "precondition: the inbound-sync case added a peer").toBeGreaterThan(0);

    const json = await runCli(["federation", "status", "--target", harper.httpURL, "--json"], cliEnv());
    expect(json.exitCode, `stderr: ${json.stderr}`).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.retries.pending.some((r: any) => r.id === `pending-${sfx}`)).toBe(true);
    expect(parsed.retries.terminal.some((r: any) => r.id === `terminal-${sfx}`)).toBe(true);

    const plain = await runCli(["federation", "status", "--target", harper.httpURL], { ...cliEnv(), FLAIR_OUTPUT: "human" });
    expect(plain.exitCode, `stderr: ${plain.stderr}`).toBe(0);
    expect(plain.stdout).toContain(PEER);
    expect(plain.stdout).toContain("Federation retries");
    expect(plain.stdout).toContain(`pending-${sfx}`);
    expect(plain.stdout).toContain("merge_target_changed");
    expect(plain.stdout).toContain("retry_exhausted");
  }, 30_000);
});
