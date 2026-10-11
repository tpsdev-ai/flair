/**
 * decision-races-2333.test.ts — real Harper (flair#2333 slice 3).
 *
 * A read that decides a SEPARATE later action must still hold when that action
 * runs. Three such check-and-write paths, each driven against real Harper with
 * the shared transaction pause points:
 *
 *   H6 relay send (resources/relay-ops.ts). A send reads the store (is this id
 *      free; the thread's last seq; the inbox count) and then writes. Two sends
 *      that interleave between the read and the write must not both pass an id,
 *      a seq or a cap on state the other is about to change.
 *   H7 usage ledger (resources/usage-recording.ts). RecordUsage reads the
 *      (agentId, memoryId) ledger, writes it, then bumps Memory.usageCount. Two
 *      contributions for one agent and memory must not both see no row and both
 *      bump.
 *   H8 XAA JIT provisioning (resources/XAA.ts). A jwt-bearer grant looks up the
 *      IdP subject, and provisions a principal when none exists. Two grants for
 *      one new subject must not both provision.
 *
 * Each case holds the first request between its read and its write (the pause
 * points below), runs the competing request to completion, then releases it: the
 * stored state must be the safe one. A CONTROL case per group runs the same path
 * with no competitor (the ordinary path is unchanged). The pause points are
 * resources/txn-pause-point.ts, armed through
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR set for this file's
 * Harper only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { sealMessage, type MessageEnvelope } from "../../resources/relay-lib.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

// A production Flair's HTTP and ops API ports: this test must never target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

let harper: HarperInstance;
let pauseDir: string;
let orgScope = "local";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
const byId: Record<string, TestAgent> = {};

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  const a = { id, publicKey: Buffer.from(kp.publicKey).toString("base64url"), secretKey: kp.secretKey };
  byId[id] = a;
  return a;
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || FORBIDDEN_PORTS.has(port)) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} on ${op.table}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function searchByValue(table: string, attribute: string, value: string, attrs: string[] = ["*"]): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table,
    search_attribute: attribute, search_type: "equals", search_value: value, get_attributes: attrs,
  });
  return Array.isArray(rows) ? rows : [];
}

async function searchById(table: string, id: string, attrs: string[] = ["*"]): Promise<any[]> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: attrs });
  return Array.isArray(rows) ? rows : [];
}

async function registerAgent(agent: TestAgent): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
}

// ─── relay send ─────────────────────────────────────────────────────────────

async function sendAs(fromId: string, toId: string, seq: number, over: Partial<MessageEnvelope> = {}): Promise<{ status: number; body: any; id: string }> {
  const sender = byId[fromId];
  const base: MessageEnvelope = {
    id: over.id ?? `${fromId}-${toId}-${seq}-${randomUUID().slice(0, 8)}`,
    orgScope,
    from: fromId,
    to: toId,
    threadId: over.threadId ?? `${fromId}:${toId}:thread`,
    seq,
    kind: "message",
    body: over.body ?? `hello ${seq}`,
    createdAt: over.createdAt ?? new Date().toISOString(),
    senderModel: "opus",
    senderProvider: "anthropic",
    senderRunId: "run-1",
    ...over,
  };
  const sealed = sealMessage(base, sender.secretKey);
  const path = "/Message";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(sender, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(sealed),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, id: sealed.id! };
}

const accepted = (r: { status: number }): boolean => r.status >= 200 && r.status < 300;

async function messagesInThread(threadId: string): Promise<any[]> {
  return searchByValue("Message", "threadId", threadId, ["id", "from", "threadId", "seq"]);
}

async function messagesTo(toId: string): Promise<any[]> {
  return searchByValue("Message", "to", toId, ["id", "from", "to", "state"]);
}

// ─── usage recording ─────────────────────────────────────────────────────────

async function putMemory(agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status, `PUT /Memory/${id} returned ${res.status}`).toBe(200);
}

async function recordUsage(agent: TestAgent, memoryIds: string[]): Promise<Response> {
  const path = "/RecordUsage";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ memoryIds }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function memoryUsageCount(id: string): Promise<number> {
  const rows = await searchByValue("Memory", "id", id);
  return rows[0]?.usageCount ?? 0;
}

// ─── XAA jwt-bearer ──────────────────────────────────────────────────────────

const IDP_ISSUER = "https://idp.decision-races-2333.invalid";
const IDP_ID = "idp-decision-races-2333";
const IDP_CLIENT = "decision-races-2333-client";
let jwksServer: Server;
let signingKey: any;
let kid: string;

async function jwtBearerAssertion(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(IDP_ISSUER)
    .setSubject(subject)
    .setAudience(harper.httpURL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey);
}

function grantJwtBearer(assertion: string): Promise<Response> {
  return fetch(`${harper.httpURL}/OAuthToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(60_000),
  });
}

// ─── pause-point driving (resources/txn-pause-point.ts) ──────────────────────

function pointPaths(point: string) {
  return {
    arm: join(pauseDir, `arm.${point}`),
    paused: join(pauseDir, `paused.${point}`),
    released: join(pauseDir, `released.${point}`),
    go: join(pauseDir, `go.${point}`),
  };
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm `point`, start `trigger`, once it is paused run `compete`, release it and
 * await the trigger. `released` is "go" only when the pause armed and this test
 * released it, so a case cannot pass without the pause actually having fired.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  const p = pointPaths(point);
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(p.arm, "");
  const pending = trigger();
  const paused = await waitFor(p.paused, 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(p.go, "");
  }
  const response = await pending;
  const released = paused ? readFileSync(p.released, "utf8") : "never paused";
  return { response, competed, released, paused };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2333-s3-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
    FLAIR_RELAY_PER_SENDER_CAP: process.env.FLAIR_RELAY_PER_SENDER_CAP,
    FLAIR_RELAY_INBOX_CAP: process.env.FLAIR_RELAY_INBOX_CAP,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  process.env.FLAIR_RELAY_PER_SENDER_CAP = "1";
  process.env.FLAIR_RELAY_INBOX_CAP = "10";
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);

  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);

  for (const id of ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"]) mkAgent(id);
  for (const a of Object.values(byId)) await registerAgent(a);

  // Sign the orgScope the server will resolve (relaySend enforces it inside the
  // signed body): the sole Instance row's id, or the "local" sentinel.
  const inst = await fetch(`${harper.httpURL}/Instance/`, {
    headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
  });
  if (inst.ok) {
    const rows = await inst.json().catch(() => null);
    if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) orgScope = String(rows[0].id);
  }

  // A test IdP: an ephemeral loopback JWKS server and an IdpConfig row pointing
  // at it, so the jwt-bearer grant validates (JIT provisioning on).
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  signingKey = privateKey;
  kid = `k-${randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const body = JSON.stringify({ keys: [jwk] });
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", () => resolve());
  });
  jwksServer.unref();
  const addr = jwksServer.address();
  if (addr === null || typeof addr === "string" || addr.address !== "127.0.0.1" || FORBIDDEN_PORTS.has(addr.port)) {
    throw new Error(`JWKS server bound ${JSON.stringify(addr)}, not an ephemeral loopback port`);
  }
  await ops({
    operation: "insert", database: "flair", table: "IdpConfig",
    records: [{
      id: IDP_ID, name: "decision-races-2333", issuer: IDP_ISSUER,
      jwksUri: `http://127.0.0.1:${addr.port}/jwks`, clientId: IDP_CLIENT,
      jitProvision: true, defaultTrustTier: "unverified", enabled: true,
      createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (jwksServer) jwksServer.close();
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2333 slice 3 — a read that decides a later write holds when the write runs (real Harper)", () => {
  // ── H6 relay send ──────────────────────────────────────────────────────────

  it("CONTROL: an uncontended send is delivered", async () => {
    const r = await sendAs("agent-a", "agent-f", 0, { threadId: "control:a:f" });
    expect(r.status, `send returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`).toBeLessThan(300);
    expect((await messagesInThread("control:a:f")).length).toBe(1);
  }, 60_000);

  it("H6 seq: two concurrent sends in one thread do not both take the same seq", async () => {
    const thread = "seq:a:b";
    const { response, competed, released } = await withPaused(
      "relay-send-write",
      () => sendAs("agent-a", "agent-b", 1, { id: `seq-1-${randomUUID().slice(0, 8)}`, threadId: thread, body: "one" }).then((r) => new Response(JSON.stringify(r.body), { status: r.status })),
      () => sendAs("agent-a", "agent-b", 1, { id: `seq-2-${randomUUID().slice(0, 8)}`, threadId: thread, body: "two" }),
    );
    expect(released, "the send was not paused and released by this test").toBe("go");
    void response;
    void competed;
    const rows = await messagesInThread(thread);
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs, "the (from, threadId) sequence must stay strictly increasing").toEqual([...new Set(seqs)]);
  }, 60_000);

  it("H6 cap: two concurrent sends from one sender do not both pass the per-sender cap", async () => {
    const { competed, released } = await withPaused(
      "relay-send-write",
      () => sendAs("agent-a", "agent-c", 0, { id: `cap-1-${randomUUID().slice(0, 8)}`, threadId: "cap:a:c:1" }).then((r) => new Response(JSON.stringify(r.body), { status: r.status })),
      () => sendAs("agent-a", "agent-c", 0, { id: `cap-2-${randomUUID().slice(0, 8)}`, threadId: "cap:a:c:2" }),
    );
    expect(released, "the send was not paused and released by this test").toBe("go");
    void competed;
    const rows = (await messagesTo("agent-c")).filter((r) => r.from === "agent-a");
    expect(rows.length, "the per-sender cap (1) must hold").toBeLessThanOrEqual(1);
  }, 60_000);

  it("H6 id: two senders reusing one message id — exactly one is accepted and the id keeps one owner", async () => {
    const sharedId = `shared-${randomUUID().slice(0, 8)}`;
    const { response, competed, released } = await withPaused(
      "relay-send-write",
      () => sendAs("agent-d", "agent-e", 0, { id: sharedId, threadId: "id:d:e", body: "from-d" }).then((r) => new Response(JSON.stringify(r.body), { status: r.status })),
      () => sendAs("agent-e", "agent-d", 0, { id: sharedId, threadId: "id:e:d", body: "from-e" }),
    );
    expect(released, "the send was not paused and released by this test").toBe("go");
    const a = { status: response.status };
    const b = competed as { status: number; body: any };
    const acceptedCount = [a, b].filter(accepted).length;
    expect(acceptedCount, `exactly one sender may claim the id (a=${a.status}, b=${b.status})`).toBe(1);
    const stored = await searchByValue("Message", "id", sharedId);
    expect(stored.length, "the id names exactly one stored message").toBe(1);
  }, 60_000);

  // ── H7 usage ledger ────────────────────────────────────────────────────────

  it("CONTROL: one RecordUsage bumps usageCount once", async () => {
    const memId = `ctl-mem-${randomUUID().slice(0, 8)}`;
    await putMemory(byId["agent-a"], memId, { agentId: "agent-a", content: "control memory, long enough for the dedup gate.", durability: "standard", visibility: "shared" });
    const res = await recordUsage(byId["agent-a"], [memId]);
    expect(res.status, `RecordUsage returned ${res.status}`).toBe(200);
    expect(await memoryUsageCount(memId)).toBe(1);
  }, 60_000);

  it("H7: two concurrent RecordUsage calls for one (agent, memory) bump the count once", async () => {
    const memId = `race-mem-${randomUUID().slice(0, 8)}`;
    await putMemory(byId["agent-a"], memId, { agentId: "agent-a", content: "contended memory, long enough for the dedup gate.", durability: "standard", visibility: "shared" });
    const { response, competed, released } = await withPaused(
      "usage-contribution-claim",
      () => recordUsage(byId["agent-a"], [memId]),
      () => recordUsage(byId["agent-a"], [memId]).then((r) => r.status),
    );
    expect(released, "the contribution was not paused and released by this test").toBe("go");
    expect(response.status, `RecordUsage returned ${response.status}`).toBe(200);
    void competed;
    expect(await memoryUsageCount(memId), "the ledger dedups one (agent, memory) contribution").toBe(1);
  }, 60_000);

  // ─── H8 XAA JIT provisioning ───────────────────────────────────────────────

  it("CONTROL: an uncontended grant for a new subject provisions exactly one principal", async () => {
    const subject = `ctl-${randomUUID()}`;
    const res = await grantJwtBearer(await jwtBearerAssertion(subject));
    expect(res.status, `grant returned ${res.status}: ${(await res.text()).slice(0, 200)}`).toBe(200);
    const creds = await searchByValue("Credential", "idpSubject", subject, ["id", "principalId"]);
    expect(creds.length).toBe(1);
  }, 60_000);

  it("H8: two concurrent grants for one new subject provision exactly one principal", async () => {
    const subject = `race-${randomUUID()}`;
    const assertionA = await jwtBearerAssertion(subject);
    const assertionB = await jwtBearerAssertion(subject);
    const { response, competed, released } = await withPaused(
      "xaa-principal-provision",
      () => grantJwtBearer(assertionA),
      () => grantJwtBearer(assertionB).then((r) => r.status),
    );
    expect(released, "the provisioning was not paused and released by this test").toBe("go");
    void response;
    void competed;
    const creds = await searchByValue("Credential", "idpSubject", subject, ["id", "principalId"]);
    const principals = new Set(creds.map((c) => c.principalId));
    expect(principals.size, `one subject must resolve to one principal (got ${creds.length} credential(s))`).toBe(1);
  }, 60_000);

  // ── N1: an ordinary Agent update must not wipe the stored public key ───────

  it("N1: an ordinary Agent update keeps the stored public key", async () => {
    const agent = byId["agent-f"];
    const before = await searchById("Agent", agent.id, ["id", "publicKey"]);
    expect(before[0]?.publicKey).toBe(agent.publicKey);
    const path = `/Agent/${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", runtime: "local" }),
      signal: AbortSignal.timeout(60_000),
    });
    const after = await searchById("Agent", agent.id, ["id", "publicKey"]);
    console.log(`N1 Agent PUT status: ${res.status}`);
    expect(after[0]?.publicKey, `PUT returned ${res.status}`).toBe(agent.publicKey);
  }, 60_000);
});
