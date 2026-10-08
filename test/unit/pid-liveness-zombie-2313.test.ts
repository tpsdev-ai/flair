/**
 * pid-liveness-zombie-2313.test.ts — flair#2313.
 *
 * The shared process-liveness probe (`probePidLiveness`, used by `flair
 * doctor`'s stop wait and by the daemon classifier) decided liveness from
 * signal 0 alone. A zombie still answers signal 0, so an exited child whose
 * parent has not reaped it (state `Z`, `<defunct>`) read as alive and the stop
 * wait burned its whole deadline before refusing to restart.
 *
 * The fix reads the kernel state after signal 0 and reports `Z` as gone. These
 * tests pin it against a REAL unreaped child, and pin the fail-safe: an
 * unreadable state stays alive, never a false "exited".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DARWIN_STATE_READ_TIMEOUT_MS, gatherDaemonEvidence, probePidLiveness, waitForPidGone } from "../../src/cli.ts";
import { classifyDaemonState, isExitedState, parseProcStatState } from "../../src/lib/daemon-liveness.ts";

const IS_LINUX = process.platform === "linux";
const IS_DARWIN = process.platform === "darwin";

const CASE_TIMEOUT_MS = 10_000;
const ZOMBIE_WAIT_MS = 3_000;
const DARWIN_ZOMBIE_WAIT_MS = 10_000;
const DARWIN_CASE_TIMEOUT_MS = 240_000;
let darwinReadLatencyMs = 0;
let darwinReadError = "";
const WAIT_POLL_MS = 10;

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Spawn a REAL unreaped zombie: the helper shell backgrounds an immediately
 * exiting `sleep`, prints its pid, then `exec`s a long `sleep` that never
 * waits — so the backgrounded child stays a zombie (state `Z`) under it. The
 * helper is registered for cleanup.
 */
function spawnZombieHelper(): Promise<{ zombiePid: number; helper: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const helper = spawn("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 300"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: IS_DARWIN ? DARWIN_CASE_TIMEOUT_MS : CASE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    children.push(helper);
    const timer = setTimeout(() => reject(new Error("zombie helper never printed a pid")), ZOMBIE_WAIT_MS);
    let buf = "";
    helper.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      const pid = Number(buf.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) {
        clearTimeout(timer);
        resolve({ zombiePid: pid, helper });
      }
    });
    helper.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** The kernel state character for `pid`, read from `/proc` (Linux only). */
function readProcState(pid: number): string | null {
  try {
    return parseProcStatState(readFileSync(`/proc/${pid}/stat`, "utf-8"));
  } catch {
    return null;
  }
}

/** Prove the child is a zombie BEFORE asserting on it. */
async function waitForZombie(pid: number): Promise<string> {
  const deadline = Date.now() + ZOMBIE_WAIT_MS;
  let state: string | null = null;
  while (Date.now() < deadline) {
    state = readProcState(pid);
    if (state === "Z") return state;
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  throw new Error(`pid ${pid} never became a zombie (last state: ${state})`);
}

/** The state string the test's own `/bin/ps` read sees (Darwin). */
function darwinState(pid: number, deadline = Infinity): string {
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = Math.min(5_000, deadline - Date.now());
    if (timeout <= 0) break;
    const started = Date.now();
    const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C" },
      timeout,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    darwinReadLatencyMs = Math.max(darwinReadLatencyMs, Date.now() - started);
    const state = result.stdout?.trim();
    if (!result.error && result.status === 0 && state) return state;
    darwinReadError = `timeout ${timeout}ms; error ${String(result.error)}; status ${result.status}; stderr ${result.stderr?.trim()}`;
  }
  return "";
}

/** Prove the child is a zombie via the test's own `ps` read BEFORE asserting. */
async function waitForDarwinZombie(pid: number): Promise<void> {
  const deadline = Date.now() + DARWIN_ZOMBIE_WAIT_MS;
  let state = "";
  while (Date.now() < deadline) {
    state = darwinState(pid, deadline);
    if (state.startsWith("Z")) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`pid ${pid} never became a Darwin zombie (last state: ${state}; ${darwinReadError})`);
}

/** A 127.0.0.1 port nothing is listening on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("flair#2313 — the shared probe reports an unreaped zombie as exited", () => {
  test.skipIf(!IS_LINUX)("a real Linux zombie reads as gone through the probe and its caller", async () => {
    const { zombiePid, helper } = await spawnZombieHelper();
    try {
      expect(await waitForZombie(zombiePid)).toBe("Z");
      expect(probePidLiveness(zombiePid).kind).toBe("gone");

      // …and through gatherDaemonEvidence and the classifier.
      const dataDir = mkdtempSync(join(tmpdir(), "flair2313-"));
      dirs.push(dataDir);
      writeFileSync(join(dataDir, "hdb.pid"), `${zombiePid}\n`);
      const port = await freePort();
      const evidence = await gatherDaemonEvidence(port, dataDir);
      expect(evidence.pidLiveness?.kind).toBe("gone");
      expect(classifyDaemonState(evidence, { port, dataDir }).state).toBe("NOT_RUNNING");
    } finally {
      helper.kill("SIGKILL");
    }
  }, CASE_TIMEOUT_MS);

  test.skipIf(!IS_DARWIN)("a real Darwin zombie reads as gone through the default probe", async () => {
    const { zombiePid, helper } = await spawnZombieHelper();
    try {
      await waitForDarwinZombie(zombiePid);
      const waitMs = 4 * Math.max(DARWIN_STATE_READ_TIMEOUT_MS, darwinReadLatencyMs) + 2_000;
      console.info(`Darwin ps maximum observed latency: ${darwinReadLatencyMs}ms; stop wait: ${waitMs}ms`);
      const onReadError = (error: unknown, timeoutMs: number) => {
        console.info(`Darwin default ps read failed (timeout ${timeoutMs}ms): ${String(error)}`);
      };
      expect((await waitForPidGone(zombiePid, Date.now() + waitMs, undefined, undefined, onReadError)).gone).toBe(true);
      expect(darwinState(zombiePid)).toMatch(/^Z/);
      expect(probePidLiveness(zombiePid, undefined, undefined, onReadError).kind).toBe("gone");
    } finally {
      helper.kill("SIGKILL");
    }
  }, DARWIN_CASE_TIMEOUT_MS);

  test("a live process stays alive", () => {
    expect(probePidLiveness(process.pid).kind).toBe("alive");
  }, CASE_TIMEOUT_MS);

  test("an unreadable process state stays alive (fail safe)", () => {
    expect(probePidLiveness(process.pid, () => null).kind).toBe("alive");
    expect(probePidLiveness(process.pid, () => "R").kind).toBe("alive");
  }, CASE_TIMEOUT_MS);
});

describe("flair#2313 — the zombie state parser", () => {
  test("parses field 3 past the last ')' (comm may hold spaces and parens)", () => {
    expect(parseProcStatState("42 (a b) c) Z 1 2 3")).toBe("Z");
    expect(parseProcStatState("42 (node) S 1 2 3")).toBe("S");
    expect(parseProcStatState("42 (no-parens")).toBeNull();
  });

  test("Z is exited; R, S and an unreadable (null) state are not", () => {
    expect(isExitedState("Z")).toBe(true);
    expect(isExitedState("R")).toBe(false);
    expect(isExitedState("S")).toBe(false);
    expect(isExitedState(null)).toBe(false);
  });
});
