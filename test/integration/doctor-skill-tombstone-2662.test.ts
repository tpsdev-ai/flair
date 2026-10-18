/**
 * doctor-skill-tombstone-2662.test.ts — flair#2662 against a REAL Harper and
 * the REAL built CLI.
 *
 * The "Skill tombstones" doctor section reports each skill subject whose newest
 * InstructionVersion is a `delete` tombstone while the skill's Memory row is
 * still open-live (not archived, not expired, no validTo — the skill writer's
 * predicate). It lists every subject (more than ten included), and a table read
 * that fails while the section runs is a counted NOT RUN issue rather than a
 * pass.
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
import nacl from "tweetnacl";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass
const PASS_LINE = "No delete tombstone is the newest version of a skill with an open-live Memory row (not archived, not expired, no validTo).";

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

async function readRows(table: "Memory" | "InstructionVersion", attribute: string, value: string): Promise<any[]> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({
      database: "flair",
      operation: "search_by_value",
      table,
      search_attribute: attribute,
      search_type: "equals",
      search_value: value,
      get_attributes: ["*"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `read ${table}.${attribute} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return JSON.parse(text) as any[];
}

interface WriterAgent { id: string; publicKey: string; secretKey: Uint8Array }

function mkAgent(id: string): WriterAgent {
  const pair = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(pair.publicKey).toString("base64"), secretKey: pair.secretKey };
}

/** Sign and send a request as the real agent-facing resource writer. */
async function sendAs(agent: WriterAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const signature = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
  return fetch(harper.httpURL + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(signature).toString("base64")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

  test("the writer's own delete passes, and reopening its row names the ids it produced", async () => {
    const agent = mkAgent("agent-a");
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    let subjectId = "";
    let rowId = "";
    let versionIds: string[] = [];
    try {
      const created = await sendAs(agent, "POST", "/Memory", {
        agentId: agent.id,
        content: "a writer-produced skill",
        trigger: "when the seam test runs",
        tags: ["skill"],
        durability: "persistent",
      });
      expect([200, 201], `POST /Memory returned ${created.status}`).toContain(created.status);
      rowId = String((await created.json()).id);
      const [row] = await readRows("Memory", "id", rowId);
      subjectId = String(row.skillSubjectId);
      expect(subjectId.length).toBeGreaterThan(0);

      const base = await runDoctor(ADMIN_PASS);
      const baseCount = issueCount(base.stdout);

      // Delete through the real Memory resource: the tombstone and the close
      // are Flair-produced, not planted by the test.
      const deleted = await sendAs(agent, "DELETE", `/Memory/${rowId}`);
      expect(deleted.status, `DELETE /Memory returned ${deleted.status}`).toBe(200);
      const [closed] = await readRows("Memory", "id", rowId);
      expect(typeof closed.validTo === "string" && closed.validTo.length > 0, "the writer's close did not land").toBe(true);
      const versions = await readRows("InstructionVersion", "subjectId", subjectId);
      versionIds = versions.map((version) => String(version.id));
      const tombstones = versions.filter((version) => version.kind === "delete");
      expect(tombstones, "the writer did not append exactly one delete tombstone").toHaveLength(1);
      const tombstoneId = String(tombstones[0].id);

      const closedDoctor = await runDoctor(ADMIN_PASS);
      expect(closedDoctor.stdout).toContain(PASS_LINE);
      expect(issueCount(closedDoctor.stdout), "the writer's own closed row was reported").toBe(baseCount);

      // Reopen the writer-produced row as an operator: clear its close.
      await ops({ operation: "update", table: "Memory", records: [{ id: rowId, validTo: null }] });
      const [reopened] = await readRows("Memory", "id", rowId);
      expect(reopened.validTo ?? null, "the reopen did not clear validTo").toBeNull();

      const reopenedDoctor = await runDoctor(ADMIN_PASS);
      expect(reopenedDoctor.stdout).toContain(`${subjectId} (tombstone ${tombstoneId}, live row ${rowId})`);
      expect(reopenedDoctor.stdout).not.toContain(PASS_LINE);
      expect(issueCount(reopenedDoctor.stdout), "the reopened row did not move the summary").toBe(baseCount + 1);
    } finally {
      await remove("InstructionVersion", versionIds);
      if (rowId) await ops({ operation: "delete", table: "Memory", hash_values: [rowId] });
      await ops({ operation: "delete", table: "Agent", hash_values: [agent.id] });
    }
  }, 180_000);

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
