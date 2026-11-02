/**
 * rem-restore-scope-1540.test.ts — `flair rem restore --apply` against a real
 * Harper, with a snapshot holding one Soul row that supplies a non-empty
 * `scopeTag` and one ordinary Soul row (flair#1540).
 *
 * REM replay is a third writer next to `flair restore` and `flair import`. It
 * sends each snapshot row back whole, so the scoped row reaches the server's
 * scope-field refusal through REM's own `api()` call. The CLI must name the row
 * and the refusal in its diagnostic, report a failed run, leave that Soul out
 * of the restored count, and still restore the ordinary row.
 *
 * Real snapshot file, isolated Harper, throwaway HOME, numeric ports.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { nodeBin } from "../helpers/node-runtime";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "rem-scope-agent";
const SCOPED_ID = `${AGENT_ID}:scoped`;
const ORDINARY_ID = `${AGENT_ID}:identity`;
const ORDINARY_VALUE = "the ordinary Soul row";
const REFUSAL = "soul_scope_fields_not_writable";

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

function adminAuth(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

async function op(h: HarperInstance, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth(h) },
    body: JSON.stringify({ database: "flair", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ops ${body.operation} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

async function soulRow(h: HarperInstance, id: string): Promise<any> {
  const rows = await op(h, { operation: "search_by_id", table: "Soul", ids: [id], get_attributes: ["*"] });
  return (rows as any[])[0];
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
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  assertOwnInstance(harper);
  home = mkdtempSync(join(tmpdir(), "flair-1540-rem-home-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  // The admin password lives OUTSIDE the test HOME, read only through --admin-pass-file.
  passDir = mkdtempSync(join(tmpdir(), "flair-1540-rem-pass-"));
  writeFileSync(join(passDir, "restore-admin-pass"), harper.admin.password, { mode: 0o600 });
  const created = await createSnapshot({
    agentId: AGENT_ID,
    flairVersion: "0.0.0-test",
    memories: [],
    soul: [
      { id: SCOPED_ID, agentId: AGENT_ID, key: "scoped", value: "Content with a per-user scope", durability: "permanent", createdAt, scopeTag: "team:alpha" },
      { id: ORDINARY_ID, agentId: AGENT_ID, key: "identity", value: ORDINARY_VALUE, durability: "permanent", createdAt },
    ] as any,
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
    if (harper?.installDir?.startsWith(tmpdir())) rmSync(harper.installDir, { recursive: true, force: true });
  }
}, HARPER_STOP_BUDGET_MS * 2);

describe("flair#1540 — rem restore refuses a scoped Soul row and restores the ordinary row", () => {
  test("the diagnostic names the row and the refusal, the run fails, and only the ordinary Soul is restored", async () => {
    const result = await runRestore();
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.code, output).toBe(1);
    expect(result.stdout).toContain("Status:       failed");
    expect(result.stdout).toContain(`put-soul ${SCOPED_ID}: HTTP 403: ${REFUSAL}`);
    expect(result.stdout).toContain("Restored:     0 memories, 1 souls");
    expect(result.stdout).toContain(`post-restore-verify: 1 soul rows missing (e.g. ${SCOPED_ID})`);

    expect(await soulRow(harper, ORDINARY_ID)).toMatchObject({ agentId: AGENT_ID, value: ORDINARY_VALUE });
    expect(await soulRow(harper, SCOPED_ID)).toBeUndefined();
  }, 180_000);
});
