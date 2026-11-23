/**
 * in-process-api-shapes-3068.test.ts — flair#3068, against a REAL Harper.
 *
 * The public facade's read methods (`Flair` in resources/in-process-api.ts) are
 * exercised through the inproc-app fixture, which loads Flair as a sub-component
 * and calls it from application code inside the Harper process. Each assertion
 * is on what the method RESOLVES TO:
 *   (a) `recall()` resolves to an array of hits;
 *   (b) `memory.get(id)` resolves to the stored row, and to `null` for an
 *       absent id;
 *   (c) `memory.search({ limit })` resolves to at most `limit` rows when more
 *       match.
 *
 * Build prerequisite: dist/resources/*.js (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let appDir = "";

const AGENT = "facade-shapes-agent";
const sfx = Date.now().toString(36);
const TOPIC = `deploy schedule ${sfx}`;
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error(`refusing to run against ${url}`);
    if (u.port === "9925" || u.port === "9926") throw new Error(`refusing to run against ${url}: not this test's own Harper`);
  }
  if (!h.process?.pid) throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `AgentFleet ${op} answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const envelope = JSON.parse(text);
  expect(envelope.ok, `the ${op} op failed: ${text.slice(0, 300)}`).toBe(true);
  return envelope.value;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = mkdtempSync(join(tmpdir(), "flair-3068-shapes-app-"));
  await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(process.cwd(), join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
  assertOwnInstance(harper);
  const registered = await fleet("register", { id: AGENT });
  expect(registered).toBe(AGENT);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#3068 — the facade's read methods return what they document", () => {
  test("(a) recall() resolves to an array of hits", async () => {
    const written = await fleet("remember", { agentId: AGENT, content: `own the ${TOPIC}`, visibility: "private" });
    expect(written.written).toBe(true);

    const hits = await fleet("facadeRecall", { agentId: AGENT, q: TOPIC, limit: 5 });
    expect(Array.isArray(hits), `recall() resolved to ${JSON.stringify(hits)?.slice(0, 300)}`).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h: any) => h.content).join(" ")).toContain(TOPIC);
  }, 120_000);

  test("(b) memory.get() resolves to the stored row, and null for an absent id", async () => {
    const written = await fleet("remember", { agentId: AGENT, content: `get target ${sfx}`, visibility: "private" });
    expect(written.written).toBe(true);

    const got = await fleet("facadeGet", { agentId: AGENT, id: written.id });
    expect(got.kind, `memory.get() resolved to ${JSON.stringify(got)}`).toBe("row");
    expect(got.id).toBe(written.id);
    expect(got.content).toBe(`get target ${sfx}`);

    const missing = await fleet("facadeGet", { agentId: AGENT, id: MISSING_ID });
    expect(missing.kind, `memory.get() of an absent id resolved to ${JSON.stringify(missing)}`).toBe("null");

    // The admin handle reads through the same by-id path.
    const adminGot = await fleet("facadeGet", { agentId: "facade-admin-reader", id: written.id, asAdmin: true });
    expect(adminGot.kind, `admin.memory.get() resolved to ${JSON.stringify(adminGot)}`).toBe("row");
    expect(adminGot.id).toBe(written.id);

    const adminMissing = await fleet("facadeGet", { agentId: "facade-admin-reader", id: MISSING_ID, asAdmin: true });
    expect(adminMissing.kind, `admin.memory.get() of an absent id resolved to ${JSON.stringify(adminMissing)}`).toBe("null");
  }, 120_000);

  test("(c) memory.search() resolves to at most `limit` rows when more match", async () => {
    for (const n of [1, 2, 3]) {
      const written = await fleet("remember", { agentId: AGENT, content: `search ${n} ${sfx}` });
      expect(written.written).toBe(true);
    }

    const all = await fleet("facadeSearch", { agentId: AGENT, opts: {} });
    expect(all.count).toBeGreaterThan(2);

    const page = await fleet("facadeSearch", { agentId: AGENT, opts: { limit: 2 } });
    expect(page.kind).toBe("array");
    expect(page.count, `memory.search({ limit: 2 }) returned ${page.count} rows: ${JSON.stringify(page.ids)}`).toBe(2);
  }, 120_000);
});
