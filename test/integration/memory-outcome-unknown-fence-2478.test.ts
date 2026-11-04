import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithFailingMemoryRead, type FailingComponent } from "../helpers/host-pointer-failing-component";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const owner: TestAgent = { id: "fence-owner", ...nacl.sign.keyPair() };

let harper: HarperInstance;
let component: FailingComponent;
let pauseDir: string;
let home: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}
async function readRow(id: string): Promise<any> {
  const rows = await opsCall({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
function signed(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${owner.id}:${ts}:${nonce}:${method}:${path}`), owner.secretKey);
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `TPS-Ed25519 ${owner.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
function arm(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
async function releaseAndConfirm(point: string): Promise<void> {
  writeFileSync(join(pauseDir, `go.${point}`), "");
  const path = join(pauseDir, `released.${point}`);
  const deadline = Date.now() + 30_000;
  let released = "";
  while (Date.now() < deadline && !released) {
    if (existsSync(path)) released = readFileSync(path, "utf8");
    if (!released) await new Promise((r) => setTimeout(r, 25));
  }
  expect(released, "the pause ended by timeout, not by this test").toBe("go");
}
const isClosed = (row: any) => typeof row?.validTo === "string" && row.validTo.length > 0;

async function staleSkillLineage(): Promise<{ staleId: string; headId: string }> {
  const staleId = `fence-skill-${randomUUID()}`;
  const body = (content: string) => ({
    id: staleId, agentId: owner.id, content, trigger: `when to ${content}`, tags: ["skill"], durability: "persistent",
  });
  const created = await signed("PUT", `/Memory/${staleId}`, body("first skill version"));
  expect(created.status, await created.clone().text()).toBeLessThan(300);
  const updated = await signed("PUT", `/Memory/${staleId}`, body("second skill version"));
  const text = await updated.text();
  expect(updated.status, text).toBeLessThan(300);
  const headId = String(JSON.parse(text).id);
  expect(headId).not.toBe(staleId);
  expect(isClosed(await readRow(staleId)), "the created skill row was not closed").toBe(true);
  return { staleId, headId };
}

async function markOutcomeUnknown(id: string): Promise<void> {
  const point = "memory-patch-verify";
  arm(point);
  const held = signed("PATCH", `/Memory/${id}`, { embedding: null, embeddingModel: null });
  expect(await waitFor(join(pauseDir, `paused.${point}`), 60_000), "the re-embed PATCH never reached its pre-verification pause").toBe(true);
  writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), "");
  await releaseAndConfirm(point);
  const res = await held;
  const body = await res.json() as any;
  expect(res.status, JSON.stringify(body)).toBe(503);
  expect(body.error).toBe("write_outcome_unknown");
  expect(existsSync(join(pauseDir, `arm.memory-get-fail.${id}`)), "the verification read was not the read that failed").toBe(false);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-fence-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-fence-pause-"));
  component = componentWithFailingMemoryRead();
  harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir }, homeDir: home, cwd: component.dir });
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  for (const url of [new URL(harper.httpURL), new URL(harper.opsURL)]) {
    if (url.hostname !== "127.0.0.1" || !(Number(url.port) > 0) || url.port === "9925" || url.port === "9926") {
      throw new Error(`refusing to run against ${url.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: owner.id, name: owner.id, role: "agent", publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (component) component.cleanup();
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2478 — the outcome-unknown fence (real Harper)", () => {
  it("a DELETE addressed to a stale skill id is refused when the live head it would close is outcome-unknown, and the head stays open", async () => {
    const { staleId, headId } = await staleSkillLineage();
    await markOutcomeUnknown(headId);
    const before = await readRow(headId);

    const res = await signed("DELETE", `/Memory/${staleId}`);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("write_outcome_unknown");
    const head = await readRow(headId);
    expect(head).toEqual(before);
    expect(head, "the live head is gone").not.toBeNull();
    expect(isClosed(head), "the stale-id DELETE closed the outcome-unknown live head").toBe(false);
  }, 180_000);

  it("a DELETE, a PUT and a PATCH addressed to the outcome-unknown id itself are refused", async () => {
    const { headId } = await staleSkillLineage();
    await markOutcomeUnknown(headId);
    for (const [method, body] of [
      ["DELETE", undefined],
      ["PUT", { id: headId, agentId: owner.id, content: "a write after the unknown outcome", tags: ["skill"], durability: "persistent" }],
      ["PATCH", { embedding: null, embeddingModel: null }],
    ] as const) {
      const res = await signed(method, `/Memory/${headId}`, body as any);
      const text = await res.text();
      expect(res.status, `${method}: ${text}`).toBe(503);
      expect(JSON.parse(text).error, method).toBe("write_outcome_unknown");
    }
    expect(isClosed(await readRow(headId)), "a refused write closed the head").toBe(false);
  }, 180_000);
});
