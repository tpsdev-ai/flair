/**
 * doctor-skill-tombstone-2662.test.ts — flair#2662 against a REAL Harper and
 * the REAL built CLI.
 *
 * The "Skill tombstones" doctor section reports each skill subject whose newest
 * InstructionVersion is a `delete` tombstone while the skill's Memory row is
 * still live. It lists every subject (more than ten included), and a check that
 * cannot run is a counted issue rather than a pass.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass
const PASS_LINE = "No delete tombstone is the newest version of a skill with a live Memory row.";

let harper: HarperInstance;
let cliHome: string;

interface RunResult { code: number | null; stdout: string; stderr: string }

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

function runDoctor(adminPass: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = ["doctor", "--port", new URL(harper.httpURL).port];
    const startedAt = Date.now();
    const env = {
      ...process.env,
      HOME: cliHome,
      FLAIR_URL: harper.httpURL,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_TOKEN: "",
      FLAIR_ADMIN_PASS: adminPass,
      NO_COLOR: "1",
    };
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 20_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function issueCount(stdout: string): number {
  if (/No issues found/.test(stdout)) return 0;
  const m = stdout.match(/(\d+) issues? found/);
  if (!m) throw new Error(`no summary line in doctor output:\n${stdout}`);
  return Number(m[1]);
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

interface Planted {
  subjectId: string;
  tombstoneId: string;
  rowId: string;
}

async function plantTombstone(index: number): Promise<Planted> {
  const suffix = randomUUID();
  const subjectId = `skill-${index}-${suffix}`;
  const rowId = `row-${index}-${suffix}`;
  const tombstoneId = `skill:${subjectId}:1`;
  const now = new Date().toISOString();
  await ops({
    operation: "insert",
    table: "Memory",
    records: [{
      id: rowId,
      agentId: "agent-a",
      content: `a skill ${index}`,
      createdAt: now,
      skillSubjectId: subjectId,
      tags: ["skill"],
      visibility: "shared",
      durability: "persistent",
    }],
  });
  await ops({
    operation: "insert",
    table: "InstructionVersion",
    records: [{
      id: tombstoneId,
      subjectType: "skill",
      subjectId,
      agentId: "agent-a",
      key: null,
      version: 1,
      kind: "delete",
      rowId,
      valueHash: null,
      previousVersionHash: null,
      recordHash: "hash",
      soulSnapshot: null,
      memoryId: null,
      visibility: "shared",
      actorKind: "internal",
      actorId: null,
      sourceClass: "internal",
      createdAt: now,
      guarded: false,
      expectedVersion: null,
    }],
  });
  return { subjectId, tombstoneId, rowId };
}

async function closeMemoryRow(rowId: string): Promise<void> {
  await ops({
    operation: "update",
    table: "Memory",
    records: [{ id: rowId, validTo: new Date().toISOString() }],
  });
}

async function remove(table: "Memory" | "InstructionVersion", ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await ops({ operation: "delete", table, hash_values: ids });
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-2662-doctor-home-"));
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("flair doctor — Skill tombstones section (flair#2662, real CLI + real spawned Harper)", () => {
  test("passes on a clean store, names a planted tombstone over a live head, and passes after the row is closed", async () => {
    const clean = await runDoctor(ADMIN_PASS);
    expect(clean.stderr, clean.stderr).toBe("");
    expect(clean.stdout).toContain(PASS_LINE);
    const baseCount = issueCount(clean.stdout);

    const planted = await plantTombstone(0);
    try {
      const reported = await runDoctor(ADMIN_PASS);
      expect(reported.stdout).toContain(planted.subjectId);
      expect(reported.stdout).toContain(`tombstone ${planted.tombstoneId}`);
      expect(reported.stdout).toContain(`live row ${planted.rowId}`);
      expect(reported.stdout).not.toContain(PASS_LINE);
      expect(issueCount(reported.stdout), "the reported tombstone did not move the summary").toBe(baseCount + 1);

      await closeMemoryRow(planted.rowId);
      const closed = await runDoctor(ADMIN_PASS);
      expect(closed.stdout).toContain(PASS_LINE);
      expect(issueCount(closed.stdout), "a closed row left the check counted").toBe(baseCount);
    } finally {
      await remove("InstructionVersion", [planted.tombstoneId]);
      await remove("Memory", [planted.rowId]);
    }
  }, 120_000);

  test("lists every subject when more than ten tombstones are over live rows", async () => {
    const base = await runDoctor(ADMIN_PASS);
    const baseCount = issueCount(base.stdout);
    const planted: Planted[] = [];
    try {
      for (let i = 0; i < 12; i++) planted.push(await plantTombstone(i));
      const reported = await runDoctor(ADMIN_PASS);
      expect(reported.stdout).toContain("12 skill subjects");
      for (const p of planted) {
        expect(reported.stdout, p.subjectId).toContain(p.subjectId);
        expect(reported.stdout, p.tombstoneId).toContain(`tombstone ${p.tombstoneId}`);
        expect(reported.stdout, p.rowId).toContain(`live row ${p.rowId}`);
      }
      expect(issueCount(reported.stdout), "twelve findings were not one counted issue").toBe(baseCount + 1);
    } finally {
      await remove("InstructionVersion", planted.map((p) => p.tombstoneId));
      await remove("Memory", planted.map((p) => p.rowId));
    }
  }, 180_000);

  test("reports the check as unrun and counted when the tables cannot be read", async () => {
    const base = await runDoctor(ADMIN_PASS);
    const baseCount = issueCount(base.stdout);

    const unreadable = await runDoctor("wrong-admin-pass-not-a-secret");
    expect(unreadable.stdout).toContain("Skill tombstones: NOT RUN");
    expect(unreadable.stdout).not.toContain(PASS_LINE);
    expect(issueCount(unreadable.stdout), "the unrun check left the summary clean").toBeGreaterThan(baseCount);
  }, 120_000);
});
