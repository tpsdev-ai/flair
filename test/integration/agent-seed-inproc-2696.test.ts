/**
 * agent-seed-inproc-2696.test.ts — flair#2696, against a REAL Harper.
 *
 * `AgentSeed.post()` called in-process, the way the embedding guide describes
 * (docs/embedding-in-a-harper-app.md): through Flair's AgentSeed RESOURCE,
 * bound as a collection resource with `collectionResource()`. AgentSeed writes
 * the agent's Soul, so its post() admits only a Soul-write source
 * (authorizeSoulWrite in resources/soul-write-policy.ts); in-process that is a
 * deliberate trusted internal call made with `internalContext()`.
 *
 * The call runs inside the Harper process through the inproc-app fixture
 * (test/fixtures/inproc-app/resources/AgentFleet.js, op `seedAgent`), which
 * loads Flair as a sub-component exactly as an embedding app does. Each case
 * reads the committed rows through an operations search_by_id in a separate
 * request:
 *   (a) `internalContext()`: the seed creates the Agent row and the Soul row
 *       its template names, and the Soul row's provenance records the
 *       `internal` source class;
 *   (b) an explicit context that lacks the internal marker: refused 403
 *       `soul_write_requires_operator`, and neither row is written.
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

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Drive the fixture's in-process `seedAgent` op; returns its run() envelope. */
async function seedInProcess(marker: boolean, seed: Record<string, unknown>): Promise<{ ok: boolean; status?: number; body?: string; value?: unknown; error?: string }> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ op: "seedAgent", marker, seed }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `AgentFleet answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  appDir = mkdtempSync(join(tmpdir(), "flair-2696-seed-app-"));
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

describe("flair#2696 — AgentSeed called in-process through a collection resource", () => {
  test("(a) with internalContext(), the seed creates the Agent row and its Soul row", async () => {
    const agentId = `seed2696-${randomUUID().slice(0, 8)}`;
    expect(await rowIn("Agent", agentId)).toBeNull();

    const result = await seedInProcess(true, { agentId, displayName: "In-process seed", soulTemplate: { role: "In-process seeded role" } });

    expect(result.ok, `the in-process seed did not succeed: ${JSON.stringify(result)}`).toBe(true);
    const agent = await rowIn("Agent", agentId);
    expect(agent, "the seed wrote no Agent row").not.toBeNull();
    expect(agent?.name).toBe("In-process seed");
    expect(agent?.publicKey).toBe("pending");
    const soul = await rowIn("Soul", `${agentId}:role`);
    expect(soul, "the seed wrote no Soul row").not.toBeNull();
    expect(soul?.agentId).toBe(agentId);
    expect(soul?.value).toBe("In-process seeded role");
    expect(JSON.parse(String(soul?.provenance)).verified?.sourceClass, "the Soul row's source class").toBe("internal");
  }, 60_000);

  test("(b) with an explicit context lacking the internal marker, the seed is refused 403 and writes no row", async () => {
    const agentId = `seed2696-nomarker-${randomUUID().slice(0, 8)}`;

    const result = await seedInProcess(false, { agentId, displayName: "No marker", soulTemplate: { role: "Never written" } });

    expect(result.ok, `the seed without the internal marker succeeded: ${JSON.stringify(result)}`).toBe(false);
    expect(result.status, `the seed answered ${JSON.stringify(result)}`).toBe(403);
    expect(String(JSON.parse(String(result.body)).error)).toContain("soul_write_requires_operator");
    expect(await rowIn("Agent", agentId), "a refused seed wrote an Agent row").toBeNull();
    expect(await rowIn("Soul", `${agentId}:role`), "a refused seed wrote a Soul row").toBeNull();
  }, 60_000);
});
