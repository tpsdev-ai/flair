// flair#2281 — a stub Harper must not outlive the process that started it.
//
// launchd-2040-command-level.test.ts starts stub Harpers from a temporary
// package tree; some deliberately ignore SIGTERM, and teardown is an `afterEach`.
// When the test process itself is killed (a tool timeout, Ctrl-C, a CI step
// timeout) the `afterEach` does not run, and the stubs are re-parented to PID 1
// and keep running after their tree is deleted.
//
// This file runs the same stub (STUB_HARPER, armed by stubLifetimeEnv) under a
// harness child that stands in for the test process. It waits until the stubs
// serve, SIGKILLs the harness, and then asserts both stubs it started are gone
// within a bounded window. One of the two stubs holds SIGTERM, so the exit
// cannot come from the signal that ended the harness.
//
// Only the pids this test started are polled or killed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_HARPER, STUB_MAX_LIFETIME_MS } from "../helpers/stub-harper-2040.ts";

// Stands in for the test process: it starts two stub Harpers the way the
// launchd-2040 fixture does (the same STUB_HARPER source, the lifetime env armed
// against its own pid), records their pids, then blocks. SIGKILL-ing it is the
// interrupted run: no teardown executes.
const HARNESS = `
import { writeFileSync } from "node:fs";
const [stubPath, root, pidFile] = process.argv.slice(2);
const pids = [];
for (let i = 0; i < 2; i++) {
  const proc = Bun.spawn([process.execPath, stubPath, "run", "."], {
    env: {
      ...process.env,
      ROOTPATH: root,
      HTTP_PORT: "127.0.0.1:0",
      STUB_OWNER_PID: String(process.pid),
      STUB_HOLD_ON_SIGTERM: i === 0 ? "1" : "",
      STUB_MAX_LIFETIME_MS: process.env.HARNESS_MAX_LIFETIME_MS ?? "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  pids.push(proc.pid);
}
writeFileSync(pidFile, JSON.stringify(pids));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll `pred` until it holds or `timeoutMs` elapses, then report its last value. */
async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

describe("flair#2281 — a stub Harper exits when the process that started it is killed", () => {
  test("SIGKILL the harness: the stubs it started exit, including one that holds SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2281-"));
    const root = join(dir, "root");
    const stubPath = join(dir, "harper.js");
    const harnessPath = join(dir, "harness.mjs");
    const pidFile = join(dir, "pids.json");
    mkdirSync(root);
    writeFileSync(stubPath, STUB_HARPER);
    writeFileSync(harnessPath, HARNESS);
    const harness = Bun.spawn([process.execPath, harnessPath, stubPath, root, pidFile], {
      env: {
        ...(process.env as Record<string, string>),
        // Far above this test's budget, so an exit here is the owner poll and
        // not the lifetime backstop.
        HARNESS_MAX_LIFETIME_MS: String(STUB_MAX_LIFETIME_MS),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let pids: number[] = [];
    try {
      // Poll by reading, never by stat-then-read: a setup stat before the read
      // is a check-then-use race.
      let raw: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && raw === null) {
        try { raw = readFileSync(pidFile, "utf-8"); } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      expect(raw, "the harness did not report its stub pids").not.toBeNull();
      pids = JSON.parse(raw!);
      expect(pids.length).toBe(2);
      for (const pid of pids) expect(alive(pid)).toBe(true);

      process.kill(harness.pid, "SIGKILL");
      // Reap the harness first: a zombie still answers kill(pid, 0), so without
      // this the stubs' owner poll could never see the pid as gone.
      await harness.exited;

      const gone = await waitUntil(() => pids.every((pid) => !alive(pid)), 10_000);
      for (const pid of pids) expect([pid, alive(pid)]).toEqual([pid, false]);
      expect(gone).toBe(true);
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      try { process.kill(harness.pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
