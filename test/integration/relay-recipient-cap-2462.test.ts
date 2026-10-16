/**
 * relay-recipient-cap-2462.test.ts — real Harper (flair#2462).
 *
 * Within one Harper process, a relay send serializes the recipient-wide inbox
 * cap's read-and-insert per recipient, with the same per-key lock the per-sender
 * cap and the per-thread sequence already use (flair#2461). This drives N>K
 * different senders at one recipient concurrently: the first send is paused
 * between its count read and its insert (txnPausePoint, armed through
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR for this file's Harper
 * only), the remaining N-1 are started while it is paused, and then it is
 * released. Exactly K sends are accepted, every other is refused with the named
 * recipient-scope inbox cap error, and the stored count never exceeds K.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { sealMessage, type MessageEnvelope } from "../../resources/relay-lib.js";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

// A production Flair's HTTP and ops API ports: this test must never target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);
// The recipient-wide cap this case exercises, and the number of senders (N>K).
const RECIPIENT_CAP = 3;
const SENDERS = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
const RECIPIENT = "agent-z";
// The pause point (resources/txn-pause-point.ts) between the count read and the
// store, shared with test/integration/decision-races-2333.test.ts.
const PAUSE_POINT = "relay-send-write";

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

async function registerAgent(agent: TestAgent): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
}

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

async function storedTo(toId: string): Promise<any[]> {
  return searchByValue("Message", "to", toId, ["id", "from", "to", "state"]);
}

const accepted = (r: { status: number }): boolean => r.status >= 200 && r.status < 300;

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
 * Wait until the recipient has accumulated at least `target` stored rows or
 * `deadlineMs` elapses. Used only to give the non-paused senders a window to
 * read the pre-insert count on a build without the recipient lock; the release
 * then happens well inside the pause/lock retry budgets so a with-lock build
 * still answers every send from the cap rather than from that budget.
 */
async function waitForRows(toId: string, target: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if ((await storedTo(toId)).length >= target) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2462-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
    FLAIR_RELAY_INBOX_CAP: process.env.FLAIR_RELAY_INBOX_CAP,
    FLAIR_RELAY_PER_SENDER_CAP: process.env.FLAIR_RELAY_PER_SENDER_CAP,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  process.env.FLAIR_RELAY_INBOX_CAP = String(RECIPIENT_CAP);
  // Far above each sender's single message, so the refusal under test is the
  // recipient-wide cap, never the per-sender sub-cap.
  process.env.FLAIR_RELAY_PER_SENDER_CAP = "100";
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

  for (const id of [...SENDERS, RECIPIENT]) mkAgent(id);
  for (const id of SENDERS) await registerAgent(byId[id]);

  // Sign the orgScope the server will resolve (relaySend enforces it inside the
  // signed body): the sole Instance row's id, or the "local" sentinel.
  const inst = await fetch(`${harper.httpURL}/Instance/`, {
    headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
  });
  if (inst.ok) {
    const rows = await inst.json().catch(() => null);
    if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) orgScope = String(rows[0].id);
  }
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2462 — the recipient-wide inbox cap holds under concurrent senders (real Harper)", () => {
  it("CONTROL: an uncontended send to the recipient is delivered", async () => {
    const r = await sendAs(SENDERS[0], RECIPIENT, 0, { threadId: "rc:control" });
    expect(r.status, `send returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`).toBeLessThan(300);
    expect((await storedTo(RECIPIENT)).length).toBe(1);
  }, 60_000);

  it("N>K different senders delivering to one recipient concurrently never exceed the recipient-wide cap", async () => {
    // Fresh recipient so the count starts at zero regardless of the control.
    const recipient = `${RECIPIENT}-${randomUUID().slice(0, 8)}`;
    await registerAgent(mkAgent(recipient));
    const senders = SENDERS.slice(0, RECIPIENT_CAP + 2); // N = cap + 2 > cap

    const p = pointPaths(PAUSE_POINT);
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PAUSE_POINT}`), { force: true });
    writeFileSync(p.arm, "");

    // The first send is the one the pause holds, between its count read and its
    // store, while it holds the recipient lock.
    const first = sendAs(senders[0], recipient, 0, { threadId: `rc:${senders[0]}` });
    const paused = await waitFor(p.paused, 20_000);
    expect(paused, "the first send did not reach the pause point").toBe(true);

    // With the pause held, start every other sender. On a build with the
    // recipient lock they block on it; without it they read the pre-insert count.
    const competing = senders.slice(1).map((from, i) =>
      sendAs(from, recipient, 0, { threadId: `rc:${from}:${i}` }));
    // Give a lock-free build time to read the pre-insert count, then release the
    // paused send. The wait is far inside the 200x10ms lock retry budget.
    await waitForRows(recipient, senders.length - 1, 1_000);

    writeFileSync(p.go, "");
    const results = [await first, ...(await Promise.all(competing))];
    const released = readFileSync(p.released, "utf8");
    expect(released, "the paused send was not released by this test").toBe("go");

    const acceptedResults = results.filter(accepted);
    const refusedResults = results.filter((r) => !accepted(r));
    const rows = await storedTo(recipient);

    // The behaviour assertion: the recipient-wide cap always holds.
    expect(rows.length, `the stored count must never exceed the recipient cap (${RECIPIENT_CAP})`).toBeLessThanOrEqual(RECIPIENT_CAP);
    expect(acceptedResults.length, "exactly the cap's worth of sends are accepted").toBe(RECIPIENT_CAP);
    expect(refusedResults.length, "every other send is refused").toBe(senders.length - RECIPIENT_CAP);
    // Every refusal names the recipient-wide inbox cap, not a lock miss.
    for (const r of refusedResults) {
      expect(r.status, `refusal status: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(429);
      expect(r.body.reason).toBe("inbox_full");
      expect(r.body.scope).toBe("recipient");
    }
  }, 120_000);
});
