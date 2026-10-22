/**
 * rem-run-once-read-counts-2684.test.ts — a real-Harper `rem nightly run-once`
 * with seeded Memory and Soul rows prints the exact counts (flair#2684).
 *
 * The instance is ephemeral and every HTTP/ops target is asserted to be this
 * test's own instance before the first call.
 */
import nacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "rem-counts-fixture";

let harper: HarperInstance;
let home: string;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function opsInsert(records: Record<string, unknown>[], table: string): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ operation: "insert", database: "flair", table, records }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`seed ${table} failed ${res.status}: ${await res.text()}`);
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-rem-2684-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });

  await opsInsert([{
    id: AGENT_ID,
    name: AGENT_ID,
    role: "agent",
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    createdAt: new Date().toISOString(),
  }], "Agent");

  const createdAt = new Date().toISOString();
  await opsInsert([
    { id: "rem-counts-m1", agentId: AGENT_ID, content: "first seeded note", durability: "persistent", tags: ["note"], visibility: "shared", archived: false, createdAt, updatedAt: createdAt },
    { id: "rem-counts-m2", agentId: AGENT_ID, content: "second seeded note", durability: "persistent", tags: ["note"], visibility: "shared", archived: false, createdAt, updatedAt: createdAt },
  ], "Memory");
  await opsInsert([{ id: `${AGENT_ID}:style`, agentId: AGENT_ID, key: "style", value: "seeded soul", createdAt }], "Soul");
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (home) rmSync(home, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2684 — run-once counts on a real instance", () => {
  test("prints the exact Memory and Soul counts from seeded rows", async () => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: home,
      FLAIR_URL: harper.httpURL,
      FLAIR_AGENT_ID: AGENT_ID,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
    };
    delete env.FLAIR_ADMIN_PASS;
    delete env.HDB_ADMIN_PASSWORD;
    delete env.FLAIR_TOKEN;
    delete env.FLAIR_KEY_DIR;
    const proc = Bun.spawn([nodeBin(), CLI, "rem", "nightly", "run-once", "--agent", AGENT_ID, "--dry-run"], {
      env,
      cwd: process.cwd(),
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const text = stdout + stderr;
    expect(exitCode, text).toBe(0);
    expect(text).toContain("Memories:   2");
    expect(text).toContain("Souls:      1");
    expect(text).not.toContain("Memories:   unknown");
    expect(text).not.toContain("Souls:      unknown");
    expect(text).not.toContain("Errors:");
  }, 180_000);
});
