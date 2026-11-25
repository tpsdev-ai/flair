// quality-snapshot-id-3115.test.ts — flair#3115, real Harper.
//
// `flair quality --emit` stored its snapshot under
// `${agentId}-quality-snapshot-${Date.now()}` and PUT it as an upsert, so two
// emits by one agent in the same millisecond kept one row. This spawns the real
// CLI against a real ephemeral Harper with `Date.now()` frozen to one millisecond
// and checks that the agent's Memory rows hold BOTH snapshot rows.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline } from "../helpers/child-deadline.js";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

const CHILD_DEADLINE_MS = 60_000;

let harper: HarperInstance;
let PRELOAD = "";
let CLI_HOME = "";
let SCRATCH = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) throw new Error("refusing: not an instance this test started");
}

function runCli(args: string[], baseUrl: string, frozenNow: number, leg: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: CLI_HOME,
      FLAIR_URL: baseUrl,
      FLAIR_AGENT_ID: "agent-a",
      FLAIR_TEST_FROZEN_NOW: String(frozenNow),
      FLAIR_ADMIN_PASS: harper.admin.password,
    };
    for (const k of ["TPS_VAULT_KEY", "TPS_AGENT_ID", "HDB_ADMIN_PASSWORD", "FLAIR_TOKEN"]) delete env[k];
    const startedAt = Date.now();
    const child = spawn("bun", ["--preload", PRELOAD, "src/cli.ts", ...args], { cwd: ".", env, timeout: 60_000 });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, { status: code, signal, stdout: out, stderr: err, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

async function rowsFor(agentId: string): Promise<Array<{ id: string; content: string }>> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ operation: "search_by_value", database: "flair", table: "Memory", search_attribute: "agentId", search_value: agentId, get_attributes: ["id", "content"] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`ops search failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.map((r: any) => ({ id: r.id, content: r.content })).sort((a, b) => a.content.localeCompare(b.content));
}

const emit = (url: string, frozen: number, leg: string) =>
  runCli(["quality", "--emit", "--url", url, "--json"], url, frozen, leg);

describe("flair#3115 quality snapshots on a real Harper", () => {
  beforeAll(async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), "flair-test-3115-q-"));
    PRELOAD = join(SCRATCH, "freeze-clock.ts");
    writeFileSync(PRELOAD, "const f = Number(process.env.FLAIR_TEST_FROZEN_NOW);\nif (Number.isFinite(f) && f > 0) Date.now = () => f;\n");
    CLI_HOME = join(SCRATCH, "home");
    mkdirSync(CLI_HOME, { recursive: true });
    harper = await startHarper();
    assertOwnInstance(harper);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("two same-millisecond quality --emit runs leave both snapshot rows", async () => {
    const T = Date.now();
    const a = await emit(harper.httpURL, T, "quality emit 1");
    const b = await emit(harper.httpURL, T, "quality emit 2");
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const rows = await rowsFor("agent-a");
    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toStartWith("agent-a-quality-snapshot-");
  }, 150_000);
});
