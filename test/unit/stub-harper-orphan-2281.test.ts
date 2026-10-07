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
import { STUB_HARPER } from "../helpers/stub-harper-2040.ts";

const HELPER = join(import.meta.dirname, "..", "helpers", "stub-harper-2040.ts");

// Stands in for the test process: it starts two stub Harpers the way the
// launchd-2040 fixture does (the same STUB_HARPER source, stubLifetimeEnv()
// against its own pid), each in its own root with its stderr kept in a file,
// records their pids, then blocks for at most 60 s. SIGKILL-ing it is the
// interrupted run: no teardown executes.
const HARNESS = `
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stubLifetimeEnv } from ${JSON.stringify(HELPER)};
const [stubPath, dir, pidFile] = process.argv.slice(2);
const pids = [];
for (let i = 0; i < 2; i++) {
  const proc = Bun.spawn([process.execPath, stubPath, "run", "."], {
    env: {
      ...process.env,
      ROOTPATH: join(dir, "root-" + i),
      HTTP_PORT: "127.0.0.1:0",
      STUB_HOLD_ON_SIGTERM: i === 0 ? "1" : "",
      ...stubLifetimeEnv(process.pid),
    },
    stdout: "ignore",
    stderr: openSync(join(dir, "stub-" + i + ".stderr"), "w"),
  });
  pids.push(proc.pid);
}
writeFileSync(pidFile, JSON.stringify(pids));
setTimeout(() => {}, 60_000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll by reading (never stat-then-read) until `path` has content; null after `timeoutMs`. */
async function readWhenPresent(path: string, timeoutMs: number): Promise<string | null> {
  const read = () => { try { return readFileSync(path, "utf-8").trim() || null; } catch { return null; } };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return read();
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
    const stubPath = join(dir, "harper.js");
    const harnessPath = join(dir, "harness.mjs");
    const pidFile = join(dir, "pids.json");
    for (let i = 0; i < 2; i++) mkdirSync(join(dir, `root-${i}`));
    writeFileSync(stubPath, STUB_HARPER);
    writeFileSync(harnessPath, HARNESS);
    const stubStderr = (i: number) => { try { return readFileSync(join(dir, `stub-${i}.stderr`), "utf-8"); } catch { return "(none)"; } };
    const harness = Bun.spawn([process.execPath, harnessPath, stubPath, dir, pidFile], {
      env: process.env as Record<string, string>,
      stdout: "ignore",
      stderr: "ignore",
    });
    let pids: number[] = [];
    try {
      const raw = await readWhenPresent(pidFile, 10_000);
      expect(raw, "the harness did not report its stub pids").not.toBeNull();
      pids = JSON.parse(raw!);
      expect(pids.length).toBe(2);

      // Readiness: each stub serves /Health from its own root, whose hdb.pid names it.
      for (let i = 0; i < 2; i++) {
        const root = join(dir, `root-${i}`);
        const port = await readWhenPresent(join(root, "stub-port"), 10_000);
        expect(port, `stub ${i} (pid ${pids[i]}) never bound; its stderr:\n${stubStderr(i)}`).not.toBeNull();
        expect(readFileSync(join(root, "hdb.pid"), "utf-8").trim(), `stub ${i}'s hdb.pid; its stderr:\n${stubStderr(i)}`).toBe(String(pids[i]));
        let served = false;
        try { served = (await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* not served */ }
        expect(served, `stub ${i} (pid ${pids[i]}) did not serve /Health; its stderr:\n${stubStderr(i)}`).toBe(true);
      }

      process.kill(harness.pid, "SIGKILL");
      // Reap the harness first: a zombie still answers kill(pid, 0), so without
      // this the stubs' owner poll could never see the pid as gone.
      await harness.exited;

      const gone = await waitUntil(() => pids.every((pid) => !alive(pid)), 10_000);
      for (const [i, pid] of pids.entries()) {
        expect([pid, alive(pid)], `stub ${i} outlived the harness; its stderr:\n${stubStderr(i)}`).toEqual([pid, false]);
      }
      expect(gone).toBe(true);
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      try { process.kill(harness.pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("flair#2281 — a stub Harper missing its lifetime env fails closed", () => {
  test.each([
    ["neither variable", {}],
    ["no STUB_MAX_LIFETIME_MS", { STUB_OWNER_PID: String(process.pid) }],
    ["no STUB_OWNER_PID", { STUB_MAX_LIFETIME_MS: "60000" }],
  ] as const)("a stub started with %s exits with STUB_LIFETIME_UNSET and never binds", async (_name, lifetime) => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2281-"));
    try {
      const stubPath = join(dir, "harper.js");
      writeFileSync(stubPath, STUB_HARPER);
      const proc = Bun.spawn([process.execPath, stubPath, "run", "."], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ROOTPATH: dir, HTTP_PORT: "127.0.0.1:0", ...lifetime },
        stdout: "ignore",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect(stderr).toContain("STUB_LIFETIME_UNSET");
      expect(code).toBe(1);
      let port: string | null = null;
      try { port = readFileSync(join(dir, "stub-port"), "utf-8"); } catch { /* never bound */ }
      expect(port).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
