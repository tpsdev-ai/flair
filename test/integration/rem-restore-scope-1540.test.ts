/**
 * rem-restore-scope-1540.test.ts — `flair rem restore --apply` against a real
 * Harper, with a snapshot holding one Soul row that supplies a non-empty
 * `scopeTag` and one ordinary Soul row (flair#1540).
 *
 * REM replay is a third writer next to `flair restore` and `flair import`. It
 * sends each snapshot row back whole, and the live Soul rows it would delete
 * can carry those fields themselves. Since flair#2931 the CLI checks the
 * snapshot rows and every live row captured in the pre-restore snapshot before
 * any delete: a refused row stops the run with its id, sends no target DELETE
 * or PUT, and leaves every live Soul row in place. A snapshot with no refused
 * row still restores.
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

let harper: HarperInstance;
let home: string;
let passDir: string;
let snapshotStem: string;

const createdAt = new Date().toISOString();

/** Create a snapshot for `agent` in the test HOME and return its date stem. */
async function makeSnapshot(agent: string, souls: any[]): Promise<string> {
  const created = await createSnapshot({
    agentId: agent,
    flairVersion: "0.0.0-test",
    memories: [],
    soul: souls as any,
    pendingCandidateCount: null,
    rootOverride: join(home, ".flair", "snapshots"),
  });
  return basename(created.path).replace(/\.tar\.gz$/, "");
}

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

function runRestore(stem: string = snapshotStem, agent = AGENT_ID): Promise<{ code: number; stdout: string; stderr: string }> {
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
      stem,
      "--agent",
      agent,
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

describe("flair#1540 — rem restore refuses a scoped Soul row before deleting anything", () => {
  test("case (3): the preflight names the row, the run fails, and every live Soul row is unchanged", async () => {
    const liveRows = [
      { id: `${AGENT_ID}:live-a`, agentId: AGENT_ID, key: "live-a", value: "live row A", durability: "permanent", createdAt },
      { id: `${AGENT_ID}:live-b`, agentId: AGENT_ID, key: "live-b", value: "live row B", durability: "permanent", createdAt },
    ];
    await op(harper, { operation: "upsert", database: "flair", table: "Soul", records: liveRows });
    const before = await Promise.all(liveRows.map((row) => soulRow(harper, row.id)));

    const result = await runRestore();
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    for (const [index, row] of liveRows.entries()) {
      expect(await soulRow(harper, row.id), output).toEqual(before[index]);
    }
    expect(result.code, output).toBe(1);
    expect(result.stdout).toContain("Status:       failed");
    expect(result.stdout).toContain(`soul-scope-preflight: Soul ${SCOPED_ID}`);
    expect(result.stdout).toContain("Deleted:      0 memories, 0 souls");
    expect(result.stdout).toContain("Restored:     0 memories, 0 souls");

    expect(await soulRow(harper, ORDINARY_ID)).toBeUndefined();
    expect(await soulRow(harper, SCOPED_ID)).toBeUndefined();
  }, 300_000);

  test("a live Soul row supplying scope fields stops a clean snapshot's replay before any delete", async () => {
    const agent = "rem-live-tag-agent";
    const snapshotId = `${agent}:identity`;
    const taggedId = `${agent}:tagged`;
    const plainId = `${agent}:plain`;
    const stem = await makeSnapshot(agent, [
      { id: snapshotId, agentId: agent, key: "identity", value: "snapshot content", durability: "permanent", createdAt },
    ]);
    await op(harper, {
      operation: "upsert", database: "flair", table: "Soul",
      records: [
        { id: taggedId, agentId: agent, key: "tagged", value: "live tagged", durability: "permanent", createdAt, tags: ["team-alpha"] },
        { id: plainId, agentId: agent, key: "plain", value: "live plain", durability: "permanent", createdAt },
      ],
    });
    const beforeTagged = await soulRow(harper, taggedId);
    const beforePlain = await soulRow(harper, plainId);

    const result = await runRestore(stem, agent);
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(await soulRow(harper, taggedId)).toEqual(beforeTagged);
    expect(await soulRow(harper, plainId)).toEqual(beforePlain);
    expect(result.code, output).toBe(1);
    expect(result.stdout).toContain("Status:       failed");
    expect(result.stdout).toContain(`soul-scope-preflight: Soul ${taggedId}`);
    expect(result.stdout).toContain("Deleted:      0 memories, 0 souls");
    expect(await soulRow(harper, snapshotId)).toBeUndefined();
  }, 300_000);

  test("a snapshot with no refused Soul row still restores as before", async () => {
    const agent = "rem-clean-agent";
    const snapshotId = `${agent}:identity`;
    const stem = await makeSnapshot(agent, [
      { id: snapshotId, agentId: agent, key: "identity", value: "snapshot content", durability: "permanent", createdAt },
    ]);
    await op(harper, {
      operation: "upsert", database: "flair", table: "Soul",
      records: [
        { id: `${agent}:old-a`, agentId: agent, key: "old-a", value: "old A", durability: "permanent", createdAt },
        { id: `${agent}:old-b`, agentId: agent, key: "old-b", value: "old B", durability: "permanent", createdAt },
      ],
    });

    const result = await runRestore(stem, agent);
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.code, output).toBe(0);
    expect(result.stdout).toContain("Status:       completed");
    expect(result.stdout).toContain("Deleted:      0 memories, 2 souls");
    expect(result.stdout).toContain("Restored:     0 memories, 1 souls");
    expect(await soulRow(harper, `${agent}:old-a`)).toBeUndefined();
    expect(await soulRow(harper, `${agent}:old-b`)).toBeUndefined();
    expect(await soulRow(harper, snapshotId)).toMatchObject({ agentId: agent, value: "snapshot content" });
  }, 300_000);
});
