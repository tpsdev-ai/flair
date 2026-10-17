/**
 * memory-post-object-body-2612.test.ts — real Harper.
 *
 * A verified non-admin `POST /Memory` whose body is not a single JSON object —
 * an array, `null`, a string or a number — is refused with a named 400
 * `body_must_be_object` before any write path runs, and stores nothing. Before
 * this guard, an array body reached Harper's collection create and answered an
 * unnamed 500 ("Can not create a record without an object").
 *
 * The guard admits only one JSON object, so an array body is refused for every
 * caller, the Basic administrator included; no caller POSTs an array of
 * memories today. A single-object POST from an agent and from an administrator
 * keeps its behaviour and stores. Each refusal is pinned by counting the
 * Memory rows before and after (equal) and by the named error and status.
 *
 * Mutation: remove the `guardObjectBody` call at the top of `Memory.post()` and
 * the refusal cases below fail on the status/error.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFUSAL = "body_must_be_object";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
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
const agent = mkAgent("obj2612-agent");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}
const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify(op),
  });
}
async function sendHttp(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function send(agentAuth: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return sendHttp(method, path, { Authorization: ed25519Header(agentAuth, method, path), "Content-Type": "application/json" }, body);
}
/** The number of Memory rows in the instance, read through the ops surface. */
async function memoryRowCount(): Promise<number> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "id", search_value: "*", get_attributes: ["id"] });
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(200);
  return (JSON.parse(text) as any[]).length;
}

beforeAll(async () => {
  harper = await startHarper({ cwd: ROOT });
  assertOwnInstance(harper);
  const seed = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(seed.status).toBe(200);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2612 — a Memory POST body that is not a single JSON object is refused with the named 400 and stores nothing", () => {
  /**
   * A refused body answers 400 `body_must_be_object` and leaves the Memory
   * count unchanged.
   */
  async function expectRefused(label: string, body: unknown, fromAdmin = false): Promise<void> {
    const before = await memoryRowCount();
    const res = fromAdmin
      ? await sendHttp("POST", "/Memory", { "Content-Type": "application/json", Authorization: basic() }, body)
      : await send(agent, "POST", "/Memory", body);
    const text = await res.text();
    expect(res.status, `${label} → ${res.status}: ${text.slice(0, 300)}`).toBe(400);
    expect(JSON.parse(text).error, `${label} error name: ${text.slice(0, 300)}`).toBe(REFUSAL);
    const after = await memoryRowCount();
    expect(after, `${label} stored a row (before ${before}, after ${after})`).toBe(before);
  }

  it("an array body is refused with the named 400 and stores nothing", async () => {
    await expectRefused("array", [{ id: `obj2612-arr-a-${randomUUID()}`, agentId: agent.id, content: "obj2612 array a" }, { id: `obj2612-arr-b-${randomUUID()}`, agentId: agent.id, content: "obj2612 array b" }]);
  }, 60_000);

  it("a null body is refused with the named 400 and stores nothing", async () => {
    await expectRefused("null", null);
  }, 60_000);

  it("a string body is refused with the named 400 and stores nothing", async () => {
    await expectRefused("string", "obj2612 not an object");
  }, 60_000);

  it("a number body is refused with the named 400 and stores nothing", async () => {
    await expectRefused("number", 42);
  }, 60_000);

  it("the administrator's array body is refused with the same named 400", async () => {
    await expectRefused("admin array", [{ id: `obj2612-adm-${randomUUID()}`, agentId: agent.id, content: "obj2612 admin array" }], true);
  }, 60_000);

  it("a single-object POST from an agent still stores", async () => {
    const id = `obj2612-one-${randomUUID()}`;
    const before = await memoryRowCount();
    const res = await send(agent, "POST", "/Memory", { id, agentId: agent.id, content: "obj2612 one object" });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBeLessThan(300);
    const after = await memoryRowCount();
    expect(after, `single-object POST stored no row (before ${before}, after ${after})`).toBe(before + 1);
  }, 60_000);

  it("a single-object POST from the administrator still stores", async () => {
    const id = `obj2612-adm-one-${randomUUID()}`;
    const before = await memoryRowCount();
    const res = await sendHttp("POST", "/Memory", { "Content-Type": "application/json", Authorization: basic() }, { id, agentId: agent.id, content: "obj2612 admin one object" });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBeLessThan(300);
    const after = await memoryRowCount();
    expect(after, `admin single-object POST stored no row (before ${before}, after ${after})`).toBe(before + 1);
  }, 60_000);
});
