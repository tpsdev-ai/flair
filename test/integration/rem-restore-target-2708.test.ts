/**
 * rem-restore-target-2708.test.ts — `flair rem restore` against one real
 * Harper (flair#2708).
 *
 * The candidate listing and the writes must reach the same instance. This
 * exercises the normal path with a real Harper: FLAIR_URL names the instance
 * and FLAIR_OPS_PORT names its operations port, and the restore lists and
 * rewinds the rows there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "agent-a";
const MEMORY_ID = "m-restored";
const SOUL_ID = `soul-${AGENT_ID}`;

let harper: HarperInstance;
let home: string;

function assertOwnInstance(h: HarperInstance): void {
  for (const raw of [h.httpURL, h.opsURL]) {
    const u = new URL(raw);
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} is not an instance this test started`);
  }
}

async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ ...body, database: "flair" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-2708-real-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(join(home, ".flair", "admin-pass"), harper.admin.password, { mode: 0o600 });
  chmodSync(join(home, ".flair", "admin-pass"), 0o600);
}, 300_000);

afterAll(async () => {
  try {
    await stopHarper(harper);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    if (harper?.installDir?.startsWith(tmpdir())) rmSync(harper.installDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS);

describe("flair#2708 — rem restore on a real instance", () => {
  test("lists and restores on the FLAIR_URL instance with an explicit ops port", async () => {
    const now = new Date();
    const createdAt = now.toISOString();
    const memory = { id: MEMORY_ID, agentId: AGENT_ID, content: "restored memory", durability: "persistent", createdAt };
    const soul = { id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "restored soul", createdAt };
    await ops({ operation: "insert", table: "Memory", records: [memory] });
    await ops({ operation: "insert", table: "Soul", records: [soul] });

    await createSnapshot({
      agentId: AGENT_ID,
      flairVersion: "0.0.0-test",
      memories: [memory],
      soul,
      pendingCandidateCount: null,
      rootOverride: join(home, ".flair", "snapshots"),
      nowOverride: now,
    });

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      FLAIR_URL: harper.httpURL,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_TOKEN: undefined,
      FLAIR_ADMIN_PASS: undefined,
      FLAIR_AGENT_ID: undefined,
      NO_COLOR: "1",
    };
    const child = Bun.spawn(
      [
        nodeBin({ env: env as Record<string, string> }),
        CLI,
        "rem", "restore", now.toISOString().slice(0, 10),
        "--agent", AGENT_ID,
        "--apply",
        "--admin-pass", harper.admin.password,
      ],
      { env: env as Record<string, string>, timeout: 60_000, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;

    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    expect(stdout).toContain("Status:       completed");

    const memories = await ops({ operation: "search_by_id", table: "Memory", ids: [MEMORY_ID], get_attributes: ["id", "content"] });
    expect(memories).toEqual([{ id: MEMORY_ID, content: "restored memory" }]);
    const souls = await ops({ operation: "search_by_id", table: "Soul", ids: [SOUL_ID], get_attributes: ["id", "agentId", "key", "value"] });
    expect(souls).toHaveLength(1);
    expect(souls[0].value).toBe("restored soul");
  }, 120_000);
});
