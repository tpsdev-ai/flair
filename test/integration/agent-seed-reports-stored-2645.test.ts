/**
 * agent-seed-reports-stored-2645.test.ts — real-Harper interleavings for
 * POST /AgentSeed (flair#2645).
 *
 * Harper can resolve a seed transaction's commit while dropping a create that
 * lost to a newer write of the same predictable id, and still answer 200. The
 * seed holds its Agent create (or a Soul create) at a test-only pause point,
 * a competing create of the same id commits through the lock-bypassing
 * operations API, and the released seed reports the row that is actually
 * stored: `created: false` / `alreadyExisted: true` for the Agent, and the key
 * in `soulAlreadyExisted` for a Soul entry. The uncontended seed still reports
 * `created: true`.
 *
 * Real Harper, ephemeral instance; every URL is asserted to be this test's own
 * instance before the first call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

let harper: HarperInstance;
let pauseDir = "";
const sfx = Date.now().toString(36);
let seq = 0;
const nextId = (label: string) => `asr-${label}-${sfx}-${++seq}`;

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
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function seed(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harper.httpURL}/AgentSeed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
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

/** Arm `point`, start the seed, run `compete` once it is paused, release, await it. */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, released, paused };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2645e-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2645 — an AgentSeed response reports the stored rows", () => {
  it("Agent: a competing create of the same id keeps its row and the seed reports it as already existing", async () => {
    const agentId = nextId("agent");
    const competing = {
      id: agentId,
      name: "competing-name",
      role: "agent",
      admin: false,
      publicKey: "competing-public-key",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { response, paused, released } = await withPaused(
      "agentseed-agent-write",
      () => seed({ agentId, displayName: "seed-name" }),
      async () => {
        await ops({ operation: "insert", table: "Agent", records: [competing] });
        expect((await rowIn("Agent", agentId))?.publicKey, "the competing create is not visible while the seed is paused").toBe(competing.publicKey);
      },
    );
    expect(paused, "the AgentSeed Agent create was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    const stored = await rowIn("Agent", agentId);
    expect(stored?.publicKey, "the competing row was overwritten").toBe(competing.publicKey);
    expect(body.created, JSON.stringify(body)).toBe(false);
    expect(body.alreadyExisted, JSON.stringify(body)).toBe(true);
    expect(body.agent.name, "the response is not the stored row").toBe(stored?.name);
    expect(body.agent.publicKey, "the response is not the stored row").toBe(stored?.publicKey);
  }, 120_000);

  it("Soul key: a competing create of the same predictable id keeps its row and the seed reports the stored value", async () => {
    const agentId = nextId("soul");
    const soulId = `${agentId}:name`;
    const competing = {
      id: soulId,
      agentId,
      key: "name",
      value: "competing-soul-value",
      provenance: "competing",
      durability: "permanent",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { response, paused, released } = await withPaused(
      "agentseed-soul-write",
      () => seed({ agentId, displayName: "seed-soul-value" }),
      async () => {
        await ops({ operation: "insert", table: "Soul", records: [competing] });
        expect((await rowIn("Soul", soulId))?.value, "the competing Soul create is not visible while the seed is paused").toBe(competing.value);
      },
    );
    expect(paused, "the AgentSeed Soul create was not paused after staging its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    const stored = await rowIn("Soul", soulId);
    expect(stored?.value, "the competing Soul row was overwritten").toBe(competing.value);
    expect(body.soulAlreadyExisted, JSON.stringify(body)).toContain("name");
    expect(body.soulCreated, JSON.stringify(body)).not.toContain("name");
    const reported = body.soulEntries.find((entry: any) => entry.key === "name");
    expect(reported?.value, "the response is not the stored Soul row").toBe(stored?.value);
    expect(reported?.createdAt, "the response is not the stored Soul row").toBe(stored?.createdAt);
  }, 120_000);

  it("uncontended seed: the response still reports the created Agent and every seeded Soul key as created", async () => {
    const agentId = nextId("fresh");
    const res = await seed({ agentId, displayName: "fresh-name", soulTemplate: { motto: "fresh-motto" } });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const body = JSON.parse(text);
    expect(body.created, JSON.stringify(body)).toBe(true);
    expect(body.alreadyExisted, JSON.stringify(body)).toBe(false);
    expect(body.soulAlreadyExisted, JSON.stringify(body)).toEqual([]);
    expect(body.soulCreated.sort(), JSON.stringify(body)).toEqual(body.soulEntries.map((entry: any) => entry.key).sort());
    expect((await rowIn("Agent", agentId))?.name).toBe("fresh-name");
    const soul = await rowIn("Soul", `${agentId}:motto`);
    expect(soul?.value).toBe("fresh-motto");
    expect(body.soulEntries.find((entry: any) => entry.key === "motto")?.value).toBe("fresh-motto");
  }, 120_000);
});
