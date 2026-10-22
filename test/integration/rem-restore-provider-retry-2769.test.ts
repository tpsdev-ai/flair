/**
 * rem-restore-provider-retry-2769.test.ts — `flair rem restore --apply`
 * against a real Harper whose embedding provider stalls on the first call for
 * the restored memory (flair#2769).
 *
 * The instance declares a short memory-write-lock provider bound and a
 * test-only provider delay above that bound, both under the fault-injection
 * gate. The delay matches only the snapshot row's text, so the first PUT is
 * refused `503 memory_provider_timeout` with nothing written; the restore
 * retries it once, the second call is not delayed, and the row is restored
 * and reported as retried. The post-restore verification compares ids only
 * (expected and unexpected); the test reads the row's content separately.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "agent-a";
const MEMORY_ID = "m-restored";
const SOUL_ID = `soul-${AGENT_ID}`;
const RESTORED_TEXT = "restored after a provider stall";
const PROVIDER_BOUND_MS = 300;
const PROVIDER_DELAY_MS = 900;

const SERVER_ENV = {
  FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
  FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS: String(PROVIDER_BOUND_MS),
  FLAIR_TEST_EMBED_PROVIDER_DELAY_MS: String(PROVIDER_DELAY_MS),
  FLAIR_TEST_EMBED_PROVIDER_DELAY_MATCH: RESTORED_TEXT,
};

let harper: HarperInstance;
let home: string;
let passDir: string;
let snapshotStem: string;

const createdAt = new Date().toISOString();

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

async function agentMemories(h: HarperInstance): Promise<any[]> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`),
    },
    body: JSON.stringify({
      operation: "search_by_conditions",
      database: "flair",
      table: "Memory",
      operator: "and",
      conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
      get_attributes: ["id", "content"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops search returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

function runRestore(): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    FLAIR_URL: harper.httpURL,
    FLAIR_OPS_PORT: new URL(harper.opsURL).port,
    FLAIR_OPS_TARGET: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_ADMIN_PASS: undefined,
    FLAIR_ADMIN_USER: undefined,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    NO_COLOR: "1",
  };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const child = Bun.spawn(
    [
      nodeBin({ env: childEnv as Record<string, string> }),
      CLI,
      "rem",
      "restore",
      snapshotStem,
      "--agent",
      AGENT_ID,
      "--apply",
      "--admin-pass-file",
      join(passDir, "restore-admin-pass"),
    ],
    { env: childEnv as Record<string, string>, timeout: 90_000, stdout: "pipe", stderr: "pipe" },
  );
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
}

beforeAll(async () => {
  harper = await startHarper({ serverEnv: { ...SERVER_ENV } });
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-2769-real-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  // The admin password lives OUTSIDE the test HOME, read only through --admin-pass-file.
  passDir = mkdtempSync(join(tmpdir(), "flair-2769-pass-"));
  writeFileSync(join(passDir, "restore-admin-pass"), harper.admin.password, { mode: 0o600 });
  const created = await createSnapshot({
    agentId: AGENT_ID,
    flairVersion: "0.0.0-test",
    memories: [{ id: MEMORY_ID, agentId: AGENT_ID, content: RESTORED_TEXT, durability: "persistent", createdAt }],
    soul: { id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "restored soul", createdAt },
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
  });
  snapshotStem = basename(created.path).replace(/\.tar\.gz$/, "");
}, 300_000);

afterAll(async () => {
  try {
    await stopHarpers([harper]);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    if (passDir) rmSync(passDir, { recursive: true, force: true });
    if (harper?.installDir?.startsWith(tmpdir())) rmSync(harper.installDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#2769 — rem restore retries a provider-timeout refusal once", () => {
  test("a memory write stalled above the provider bound on its first call is retried once and restored", async () => {
    expect(existsSync(join(home, ".flair", "admin-pass"))).toBe(false);

    const result = await runRestore();

    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toContain("Restored:     1 memories, 1 souls");
    expect(result.stdout).toContain(`Retried:      1 memories (${MEMORY_ID})`);
    expect(result.stdout).not.toContain("Errors:");
    expect(await agentMemories(harper)).toEqual([{ id: MEMORY_ID, content: RESTORED_TEXT }]);
  }, 120_000);
});
