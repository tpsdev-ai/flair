/**
 * rem-restore-deadline-2789.test.ts — `flair rem restore --apply` against a
 * real Harper whose write is held past the client's whole-request deadline
 * (flair#2789).
 *
 * The instance runs with the test fault-injection gate and the file pause hook.
 * The test arms the `memory-put` pause point, which the Memory PUT reaches
 * after its reads and before it stages the row, starts the CLI with a short
 * `FLAIR_REQUEST_TIMEOUT_MS`, waits for the pause, waits for the CLI to give
 * up at its deadline, then releases the write. Harper aborts the request when
 * the client's socket closes, so the released write does not commit: the final
 * row is absent. The CLI cannot know that, so its report must say unknown
 * (status `unresolved`, exit 3), never failed or completed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "agent-a";
const MEMORY_ID = "m-restored";
const RESTORED_TEXT = "restored after the client gave up";
const CLIENT_DEADLINE_MS = 2_000;
const PAUSE_POINT = "memory-put";

let harper: HarperInstance;
let home: string;
let passDir: string;
let pauseDir: string;
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

function adminAuth(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

async function opsSearch(h: HarperInstance, body: Record<string, unknown>): Promise<any[]> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
    body: JSON.stringify({ database: "flair", table: "Memory", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops search returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

async function agentMemories(h: HarperInstance): Promise<any[]> {
  return opsSearch(h, {
    operation: "search_by_conditions",
    operator: "and",
    conditions: [{ search_attribute: "agentId", search_type: "equals", search_value: AGENT_ID }],
    get_attributes: ["id", "content"],
  });
}

/** Load the embedding model before the restore, so the paused write does not
 *  spend its time on a first-call model download. */
async function warmEmbeddingModel(h: HarperInstance): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = `warm-up-${attempt}`;
    const res = await fetch(`${h.httpURL}/Memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
      body: JSON.stringify({
        id,
        agentId: "agent-warmup",
        content: `warm-up ${attempt}`,
        durability: "standard",
        createdAt,
      }),
      signal: AbortSignal.timeout(100_000),
    });
    if (!res.ok) throw new Error(`warm-up POST returned ${res.status}: ${await res.text()}`);
    const [row] = await opsSearch(h, { operation: "search_by_id", ids: [id], get_attributes: ["id", "embedding"] });
    if (Array.isArray(row?.embedding) && row.embedding.length > 0) return;
  }
  throw new Error("the embedding model did not load: three warm-up rows were stored without a vector");
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function armPoint(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}

function releasePoint(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}

function runRestore(): { child: ReturnType<typeof Bun.spawn>; done: Promise<{ code: number; stdout: string; stderr: string }> } {
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
    FLAIR_REQUEST_TIMEOUT_MS: String(CLIENT_DEADLINE_MS),
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
    { env: childEnv as Record<string, string>, timeout: 60_000, stdout: "pipe", stderr: "pipe" },
  );
  const done = (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stdout, stderr };
  })();
  return { child, done };
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2789-pause-"));
  harper = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(harper);
  await warmEmbeddingModel(harper);
  home = mkdtempSync(join(tmpdir(), "flair-2789-real-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  // The admin password lives OUTSIDE the test HOME, read only through --admin-pass-file.
  passDir = mkdtempSync(join(tmpdir(), "flair-2789-pass-"));
  writeFileSync(join(passDir, "restore-admin-pass"), harper.admin.password, { mode: 0o600 });
  const created = await createSnapshot({
    agentId: AGENT_ID,
    flairVersion: "0.0.0-test",
    memories: [{ id: MEMORY_ID, agentId: AGENT_ID, content: RESTORED_TEXT, durability: "persistent", createdAt }],
    soul: null,
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
  });
  snapshotStem = basename(created.path).replace(/\.tar\.gz$/, "");
}, 420_000);

afterAll(async () => {
  try {
    await stopHarpers([harper]);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    if (passDir) rmSync(passDir, { recursive: true, force: true });
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
    if (harper?.installDir?.startsWith(tmpdir())) rmSync(harper.installDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#2789 — a restore write held past the client deadline", () => {
  test("the CLI reports unknown (exit 3) and the released write leaves no row", async () => {
    armPoint(PAUSE_POINT);
    const { done } = runRestore();
    const paused = await waitFor(join(pauseDir, `paused.${PAUSE_POINT}`), 30_000);
    expect(paused, "the restore's Memory PUT never reached the pause point").toBe(true);

    // The CLI abandons the request at its own deadline while the write is held.
    const result = await done;
    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(3);
    expect(result.stdout).toContain("Status:       unresolved");
    expect(result.stdout).not.toContain("Status:       completed");
    expect(result.stdout).not.toContain("Status:       failed");
    expect(result.stdout).toContain("Unknown:");
    expect(result.stdout).toContain("may or may not have taken effect");
    expect(result.stdout).toContain("Re-run once the server has settled");

    releasePoint(PAUSE_POINT);
    // The released marker file is created at pause time and written when the
    // pause ends, so wait for its content.
    let released = "";
    const releaseDeadline = Date.now() + 20_000;
    while (Date.now() < releaseDeadline && !released) {
      const path = join(pauseDir, `released.${PAUSE_POINT}`);
      if (existsSync(path)) released = readFileSync(path, "utf8");
      if (!released) await new Promise((r) => setTimeout(r, 25));
    }
    expect(released, "the pause ended without this test's release").toBe("go");

    // The write the client stopped waiting for: Harper aborts it when the
    // client's socket closes, so the row stays absent. The CLI still reports
    // unknown, because it cannot tell an aborted write from a committed one.
    let memories: any[] = [];
    const rowDeadline = Date.now() + 5_000;
    while (Date.now() < rowDeadline) {
      memories = await agentMemories(harper);
      if (memories.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(memories, "the aborted write left a row behind").toEqual([]);
  }, 120_000);
});
