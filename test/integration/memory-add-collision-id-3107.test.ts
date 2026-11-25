// memory-add-collision-id-3107.test.ts — flair#3107, real Harper.
//
// Before the fix, `flair memory add` derived its Memory id from the agent id and
// the current millisecond, and the server's PUT is an upsert: two adds in the
// same millisecond left one row. This spawns the real CLI against a real
// ephemeral Harper and checks that both adds store a row; then it drives the
// #3087 retry interleaving — A refused once with 503 memory_provider_timeout, B
// writes, A's retry lands after B — and checks both rows survive.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest, Server } from "node:http";
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
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: CLI_HOME, FLAIR_URL: baseUrl, FLAIR_AGENT_ID: "", FLAIR_TEST_FROZEN_NOW: String(frozenNow) };
    for (const k of ["TPS_VAULT_KEY", "TPS_AGENT_ID", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_TOKEN"]) delete env[k];
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

const add = (agent: string, content: string, url: string, frozen: number, leg: string) =>
  runCli(["memory", "add", content, "--agent", agent, "--admin-pass", harper.admin.password], url, frozen, leg);

describe("flair#3107 on a real Harper", () => {
  beforeAll(async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), "flair-test-3107-"));
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

  test("two same-millisecond adds by one agent leave both memories", async () => {
    const T = Date.now();
    const a = await add("agent-3107-a", "memory one: the deploy key lives in vault path A", harper.httpURL, T, "same-ms add 1");
    const b = await add("agent-3107-a", "memory two: unrelated fact about the build cache", harper.httpURL, T, "same-ms add 2");
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const rows = await rowsFor("agent-3107-a");
    expect(rows.length).toBe(2);
  }, 150_000);

  test("a refused add's retry after another add does not replace that add's row", async () => {
    let refusedA = false;
    const releaseA: { fn: () => void } = { fn: () => {} };
    const bDone = new Promise<void>((r) => (releaseA.fn = r));
    const aRefused = { fn: () => {} };
    const aRefusedSignal = new Promise<void>((r) => (aRefused.fn = r));
    const target = new URL(harper.httpURL);
    const proxy: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const raw = Buffer.concat(chunks);
        let content = "";
        try { content = JSON.parse(raw.toString() || "{}").content ?? ""; } catch {}
        const isA = req.method === "PUT" && content.startsWith("memory A");
        if (isA && !refusedA) {
          refusedA = true;
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "memory_provider_timeout", message: "the embedding provider did not answer within its bound; nothing was written, retry" }));
          aRefused.fn();
          return;
        }
        if (isA) await bDone;
        const fwd = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        fwd.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
        fwd.end(raw);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
    const T = Date.now();
    const aRun = add("agent-3107-b", "memory A: written by session A", proxyUrl, T, "refused add A");
    try {
      // A may exit before its first PUT reaches the proxy (a refused credential,
      // a parse error). Waiting only on aRefusedSignal would hold the case to
      // the 150 s timeout; race it against A's completion and fail fast with
      // A's own output.
      const early = await Promise.race([aRefusedSignal.then(() => null), aRun.then((r) => r)]);
      if (early !== null) {
        throw new Error(
          `session A finished (exit ${early.code}) before its first PUT was refused\nstdout:\n${early.stdout}\nstderr:\n${early.stderr}`,
        );
      }
      const b = await add("agent-3107-b", "memory B: written by session B", proxyUrl, T, "add B");
      const rowsAfterB = await rowsFor("agent-3107-b");
      releaseA.fn();
      const a = await aRun;
      const rows = await rowsFor("agent-3107-b");
      expect(b.code, b.stderr).toBe(0);
      expect(a.code, a.stderr).toBe(0);
      expect(rowsAfterB.map((r) => r.content)).toContain("memory B: written by session B");
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.content)).toContain("memory A: written by session A");
    } finally {
      // Release the retry latch, let A finish, then close the proxy — in that
      // order, even when B or an assertion threw first.
      releaseA.fn();
      await aRun.catch(() => {});
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }, 150_000);
});
