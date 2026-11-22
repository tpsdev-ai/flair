/**
 * federation-memory-merge-confirm-2475.test.ts — flair#2475 (real Harper).
 *
 * The FederationSync merge of a Memory row built its write from the row read
 * BEFORE the merge's own transaction opened (`local`) and accepted that write
 * on an identity-only comparison (id, agentId, instanceToken, contentHash,
 * createdAt). A field-only change committed in that window is not one of those
 * identity fields, so it passed the check and the merge's full-row put wrote
 * back the pre-change value of the changed field.
 *
 * The Memory merge now compares the WHOLE stored row against the row its plan
 * read before writing, as the other synced tables already do (flair#2450). A
 * change committed at `federation-merge-pre` — after the merge's read and
 * before its in-transaction read — skips the record by name
 * (merge_target_changed), so the changed field keeps the competitor's value.
 *
 * Test-only pause points (resources/txn-pause-point.ts) hold the merge while
 * this test commits the competitor through the real HTTP route.
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
let pauseDir: string;

const owner = mkAgent("fmm-owner");
const peerKeys = nacl.sign.keyPair();
const PEER = "fmm-peer";

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}
async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", database: "flair", table, records: [row] });
}

/** One signed FederationSync push of a single record from PEER. */
async function federatedPush(record: Record<string, unknown>): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: PEER, records: [{ originatorInstanceId: PEER, ...record }], lamportClock: Date.now() },
    peerKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** An owner PATCH over the real HTTP route, signed as `owner`. */
function ownerPatch(id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(owner, "PATCH", path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
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
 * Arm `point`, start `trigger`, run `compete` once the trigger is paused inside
 * that point, release, and await the trigger.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2475-pause-"));
  harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir } });
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await insertRow("Agent", { id: owner.id, name: owner.id, role: "agent", publicKey: owner.publicKey, createdAt: now });
  await insertRow("Peer", {
    id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"),
    role: "spoke", status: "paired", createdAt: now,
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

const seed = (id: string) => ({
  id,
  agentId: owner.id,
  content: `original ${id}`,
  contentHash: `hash-original-${id}`,
  instanceToken: randomUUID(),
  durability: "persistent",
  visibility: "shared",
  archived: false,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
});

/** A push that changes content/contentHash and carries no visibility, so the merge keeps the stored value. */
const push = (id: string) => federatedPush({
  table: "Memory",
  id,
  updatedAt: new Date().toISOString(),
  data: { id, agentId: owner.id, content: `merged ${id}`, contentHash: `hash-merged-${id}`, durability: "persistent" },
});

describe("flair#2475 — the Memory merge confirms the stored row (real Harper)", () => {
  it("a field-only change committed at federation-merge-pre is not reverted and the record is skipped by name", async () => {
    const id = `fmm-pre-${Date.now()}`;
    await insertRow("Memory", seed(id));

    // The competitor writes through the operations API, which takes no per-id
    // lock: an owner HTTP PATCH would be refused `memory_busy` while the merge
    // holds the lock (covered by federation-reindex-lock-2478.test.ts). This
    // case keeps the whole-row skip coverage for a lock-bypassing writer.
    const { response, released, paused } = await withPaused("federation-merge-pre", () => push(id), async () => {
      await ops({ operation: "update", database: "flair", table: "Memory", records: [{ id, visibility: "private" }] });
    });

    // Behaviour first: a run that never reached the pre-window pause still
    // reports the merge outcome, not the missing pause.
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);

    const row = await readRow("Memory", id);
    expect(row?.visibility, "the field-only change was reverted by the stale merge").toBe("private");
    expect(row?.content, "the skipped merge still landed its content").toBe(`original ${id}`);
    expect(body.merged, JSON.stringify(body)).toBe(0);
    expect(body.skippedReasons?.merge_target_changed, JSON.stringify(body)).toBe(1);

    expect(paused, "(diagnostic) the pre-window pause was not hit").toBe(true);
    expect(released).toBe("go");
  }, 60_000);

  it("CONTROL: with no competitor the merge lands", async () => {
    const id = `fmm-ok-${Date.now()}`;
    await insertRow("Memory", seed(id));
    const body = await (await push(id)).json() as any;
    expect(body.merged, JSON.stringify(body)).toBe(1);
    const row = await readRow("Memory", id);
    expect(row?.content, "the ordinary Memory merge did not land").toBe(`merged ${id}`);
    expect(row?.visibility, "the merge changed the untouched stored visibility").toBe("shared");
  }, 60_000);
});
