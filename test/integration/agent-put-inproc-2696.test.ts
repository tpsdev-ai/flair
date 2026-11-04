/**
 * agent-put-inproc-2696.test.ts — flair#2696, against a REAL Harper.
 *
 * An Agent PUT called in-process, the way an embedding application's
 * provisioning code calls it: through Flair's Agent RESOURCE (not the raw
 * table), bound to a trusted internal context (`internalContext()`), as a
 * collection resource with NO URL target. With no URL target, the body `id`
 * names the row the PUT updates (resources/Agent.ts's writeTargetId and
 * resources/originator-instance.ts's resolveStoredRow).
 *
 * The call runs inside the Harper process through the inproc-app fixture
 * (test/fixtures/inproc-app/resources/AgentFleet.js, op `putAgent`), which
 * loads Flair as a sub-component exactly as an embedding app does. Each case
 * reads the committed row through an operations search_by_id in a separate
 * request:
 *   (a) an existing body id: the update lands; the stored createdAt,
 *       publicKey, originatorInstanceId and receiver federation fields
 *       (_originatorInstanceId, _syncedFrom, _syncedAt) are carried although
 *       the body supplies other values; updatedAt is set by the handler, not
 *       taken from the body;
 *   (b) a body id with no stored row: refused with 404
 *       `agent_put_requires_existing`, and no row is written.
 *
 * Build prerequisite: dist/resources/*.js (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

const STORED = {
  createdAt: "2026-01-02T03:04:05.000Z",
  publicKey: "stored-inproc-key",
  originatorInstanceId: "inst-home-inproc-2696",
  _originatorInstanceId: "peer-origin-inproc-2696",
  _syncedFrom: "peer-origin-inproc-2696",
  _syncedAt: "2026-01-03T04:05:06.000Z",
};
const BODY_UPDATED_AT = "1999-01-01T00:00:00.000Z";

let harper: HarperInstance;
let appDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error(`refusing to run against ${url}`);
    if (u.port === "9925" || u.port === "9926") throw new Error(`refusing to run against ${url}: not this test's own Harper`);
  }
  if (!h.process?.pid) throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function rowIn(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Drive the fixture's in-process `putAgent` op; returns its run() envelope. */
async function putInProcess(record: Record<string, unknown>): Promise<{ ok: boolean; status?: number; body?: string; value?: unknown; error?: string }> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op: "putAgent", record }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `AgentFleet answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = mkdtempSync(join(tmpdir(), "flair-2696-inproc-app-"));
  await cp(join(process.cwd(), "test/fixtures/inproc-app"), appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules/@tpsdev-ai"), { recursive: true });
  await symlink(process.cwd(), join(appDir, "node_modules/@tpsdev-ai/flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd() });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2696 — an in-process Agent PUT with no URL target names its row by the body id", () => {
  test("(a) an existing body id: the update lands and the stored fields are carried", async () => {
    const id = `inproc2696-${randomUUID().slice(0, 8)}`;
    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id, name: id, role: "agent", admin: false, status: "active", displayName: "stored-name", ...STORED }],
    });
    const before = await rowIn(id);
    for (const [field, value] of Object.entries(STORED)) expect(before?.[field], `seeded ${field}`).toBe(value);
    const startedAt = Date.now();

    const result = await putInProcess({
      id, name: id, role: "agent", status: "active", displayName: "inproc-put",
      // Deliberately different values for every carried field.
      createdAt: "1999-01-01T00:00:00.000Z", publicKey: "client-supplied-key",
      originatorInstanceId: "inst-forged", _originatorInstanceId: "forged", _syncedFrom: "forged", _syncedAt: "1999-01-01T00:00:00.000Z",
      updatedAt: BODY_UPDATED_AT,
    });

    expect(result.ok, `the in-process PUT did not succeed: ${JSON.stringify(result)}`).toBe(true);
    const after = await rowIn(id);
    expect(after?.displayName, "the PUT's displayName was not stored").toBe("inproc-put");
    for (const [field, value] of Object.entries(STORED)) {
      expect(after?.[field], `the PUT replaced the stored ${field}`).toBe(value);
    }
    expect(after?.updatedAt, "updatedAt was taken from the body").not.toBe(BODY_UPDATED_AT);
    expect(Date.parse(after?.updatedAt), "updatedAt was not set by this PUT").toBeGreaterThanOrEqual(startedAt - 5_000);
  }, 60_000);

  test("(b) a body id with no stored row: refused 404 agent_put_requires_existing, and no row is written", async () => {
    const id = `inproc2696-missing-${randomUUID().slice(0, 8)}`;
    expect(await rowIn(id)).toBeNull();

    const result = await putInProcess({
      id, name: id, role: "agent", displayName: "inproc-create", publicKey: "new-key", createdAt: "2026-02-03T04:05:06.000Z",
    });

    expect(result.ok, `the in-process PUT to a missing row succeeded: ${JSON.stringify(result)}`).toBe(false);
    expect(result.status, `the in-process PUT answered ${JSON.stringify(result)}`).toBe(404);
    expect(JSON.parse(String(result.body)).error).toBe("agent_put_requires_existing");
    expect(await rowIn(id), "a refused in-process PUT wrote a row").toBeNull();
  }, 60_000);
});
