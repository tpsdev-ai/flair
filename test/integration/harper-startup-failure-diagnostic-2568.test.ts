// flair#2568 — the harness's readiness-failure diagnostic against a REAL Harper.
//
// test/unit/harper-lifecycle-budgets.test.ts pins the phase parser to Harper's
// diagnostic lines; this file makes a real Harper fail to start and checks what
// the harness actually reports from Harper's actual output. Hermetic: each
// case boots the node_modules Harper on ephemeral ports in a temp install dir
// (startHarper), with a throwaway one-file component as the application in
// place of flair. startHarper kills a failed start and attempts to remove its
// install dir (best effort there); this test checks that both the Harper pid
// and the install dir are gone afterwards.
//
// Measured on harper 5.3.1: the harness's banner wait passes on the main
// thread's "Domain socket listening on" line before the HTTP worker loads
// components, so both failures surface in the readiness poll.
//   - A worker that dies while loading components: Harper logs "HTTP worker
//     slot 0 exited before ready (thread N, attempt N, phase loading
//     components)" on every restart, then exits 1 when restarts run out.
//   - A worker that blocks while loading: Harper's own diagnostic only appears
//     after its fixed 60 s watchdog, so a shorter readiness deadline fails
//     first, with no phase from Harper — the harness reports its own.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper } from "../helpers/harper-lifecycle";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const componentDirs: string[] = [];

afterAll(() => {
  for (const dir of componentDirs) rmSync(dir, { recursive: true, force: true });
});

/** A one-file Harper application whose resource module runs `resourcesJs` on load. */
function probeComponent(name: string, resourcesJs: string): string {
  const dir = mkdtempSync(join(tmpdir(), `flair-2568-${name}-`));
  componentDirs.push(dir);
  writeFileSync(join(dir, "config.yaml"), `name: probe-2568-${name}\nrest: true\njsResource:\n  files: resources.js\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `probe-2568-${name}`, version: "0.0.0" }));
  writeFileSync(join(dir, "resources.js"), resourcesJs);
  return dir;
}

/** Start Harper on `cwd`, expecting the start to fail; returns the error and the wall time. */
async function failedStart(cwd: string, readinessTimeoutMs?: number): Promise<{ message: string; wallMs: number }> {
  const t0 = Date.now();
  try {
    const inst = await startHarper({ cwd, harperBinDir: REPO_ROOT, readinessTimeoutMs });
    await stopHarper(inst);
  } catch (err) {
    // Harper colours parts of its console output (e.g. the pid); compare plain text.
    const message = (err as Error).message.replace(/\x1b\[[0-9;]*m/g, "");
    return { message, wallMs: Date.now() - t0 };
  }
  throw new Error("startHarper succeeded; the probe component was meant to make it fail");
}

/**
 * After the failed start: the pid Harper logged for itself ("Harper PID N") is
 * gone within a few seconds, and the install dir (the root of the
 * "Domain socket listening on <installDir>/operations-server" line) is gone.
 */
async function expectHarperGone(message: string): Promise<void> {
  const installDir = message.match(/Domain socket listening on (\S+)\/operations-server/)?.[1];
  expect(installDir, "Harper logged its operations socket under the install dir").toBeDefined();
  expect(existsSync(installDir!), `install dir ${installDir} left behind`).toBe(false);
  const pid = Number(message.match(/Harper PID (\d+)/)?.[1]);
  expect(pid, "Harper logged its PID").toBeGreaterThan(0);
  const deadline = Date.now() + 10_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      alive = false;
    }
  }
  expect(alive, `Harper pid ${pid} still alive after the failed start`).toBe(false);
}

describe("flair#2568: a real Harper's startup failure names its phase and elapsed time", () => {
  test("a worker that exits while loading components: the phase comes from Harper's exited-before-ready line", async () => {
    // `process.exit` in a Harper worker is intercepted and ignored; Harper's
    // message names `process._realExit` as the real exit. If a Harper upgrade
    // removes it, the load error is swallowed, the start succeeds, and
    // failedStart throws — loudly, not as a silent pass.
    const cwd = probeComponent("exit", "process._realExit(3);\nexports.Never = class Never {};\n");
    const { message, wallMs } = await failedStart(cwd);

    // Harper's actual diagnostic is in the captured output.
    expect(message).toMatch(/HTTP worker slot 0 exited before ready \(thread \d+, attempt \d+, phase loading components\)/);
    const m = message.match(
      /^Harper exited \(code=(\d+) signal=(\w+)\) while waiting for http:\/\/127\.0\.0\.1:\d+\/health to become healthy \((\d+)ms elapsed, stopped in phase: ([^)]+)\)\./,
    );
    expect(m, message.slice(0, 600)).not.toBeNull();
    expect(m![1]).toBe("1");
    // The reported phase is Harper's, not the poll's own "http readiness".
    expect(m![4]).toBe("loading components");
    const elapsed = Number(m![3]);
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(wallMs);
    await expectHarperGone(message);
  }, 150_000);

  test("a worker blocked while loading, before Harper logs any phase: the harness falls back to its own phase", async () => {
    // Blocks the worker thread for 30 s — far past the 8 s readiness deadline
    // below and far short of Harper's 60 s watchdog.
    const cwd = probeComponent("block", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);\nexports.Never = class Never {};\n");
    const READINESS_MS = 8_000;
    const { message, wallMs } = await failedStart(cwd, READINESS_MS);

    // Real output: the worker started loading this component, and Harper
    // printed no startup diagnostic, so there is no phase marker to read.
    expect(message).toContain("Loading application from");
    expect(message).toContain(cwd.split("/").pop()!);
    expect(message).not.toMatch(/before ready \(thread/);
    const m = message.match(
      new RegExp(`^Harper at http://127\\.0\\.0\\.1:\\d+ did not respond within ${READINESS_MS}ms \\((\\d+) attempts, (\\d+)ms elapsed, stopped in phase: ([^)]+)\\)\\. Process still alive\\.`),
    );
    expect(m, message.slice(0, 600)).not.toBeNull();
    // The fallback: the poll's own label.
    expect(m![3]).toBe("http readiness");
    const elapsed = Number(m![2]);
    expect(elapsed).toBeGreaterThanOrEqual(READINESS_MS);
    expect(elapsed).toBeLessThan(READINESS_MS + 5_000);
    expect(elapsed).toBeLessThanOrEqual(wallMs);
    await expectHarperGone(message);
  }, 150_000);
});
