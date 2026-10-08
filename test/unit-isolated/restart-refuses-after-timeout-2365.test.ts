/**
 * restart-refuses-after-timeout-2365.test.ts — flair#2365.
 *
 * `stopFlairProcess` waits for the old process to exit best-effort: a timeout
 * there is swallowed so `flair stop` on an already-stopped instance stays a
 * harmless no-op. The restart flow must not treat that timeout as success — it
 * is about to start a replacement next to a process that may still hold the
 * data directory and the ports. These tests drive the restart flow with an
 * injected exit wait: the timed-out wait must refuse (naming the process it
 * waited on and the remedy) and start no replacement, while a wait that sees
 * the old process exit must still start it. The old "process" is a live
 * stand-in that does not exit on the stop's SIGTERM, so the timeout is the real
 * condition.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartFlair } from "../../src/cli.ts";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("flair#2365 — restart and the stop leg's exit wait", () => {
  let home: string;
  let dataDir: string;
  let decoy: { pid: number; kill: (signal: string) => void; exited: Promise<number> } | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "flair2365-"));
    dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Darwin skips the Linux systemd plan, so the restart flow takes its plain
    // stop-then-start branch. No launchd plist exists under the fixture HOME, so
    // the stop leg is the port-based one that carries the exit wait.
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    if (decoy) {
      try { process.kill(decoy.pid, "SIGKILL"); } catch { /* already gone */ }
      decoy = null;
    }
    Object.defineProperty(process, "platform", platformDescriptor);
    rmSync(home, { recursive: true, force: true });
  });

  /** An OS-assigned port with nothing listening: bind, read the port, close. */
  async function closedPort(): Promise<number> {
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const p = srv.port;
    await srv.stop(true);
    if (typeof p !== "number" || p <= 0) throw new Error("closedPort: no port");
    return p;
  }

  /** Record a live stand-in as this instance's process: pidfile, sidecar, and a
   * stand-in that does not exit on the stop's SIGTERM — the process the exit
   * wait gives up on. */
  async function arrangeLiveInstance(): Promise<{ pid: number; port: number }> {
    const port = await closedPort();
    const proc = Bun.spawn(
      ["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const pid = (proc as unknown as { pid: number }).pid;
    decoy = { pid, kill: (s) => proc.kill(s as never), exited: proc.exited };
    writeFileSync(join(dataDir, "hdb.pid"), `${pid}\n`);
    // The identity sidecar, stamped from the live process's start time — the
    // same read the daemon-liveness machine verifies against.
    writeFileSync(join(dataDir, "flair-daemon.json"), JSON.stringify({
      pid,
      startTimeMs: readProcessStartTimeMs(pid) ?? Date.now(),
      port,
      flairVersion: "0.0.0",
    }));
    return { pid, port };
  }

  test("the refusal names the waited-on process and the remedy, and starts no replacement", async () => {
    const { pid, port } = await arrangeLiveInstance();

    let replacementStarted = false;
    const err = await restartFlair(port, dataDir, {
      waitForExit: async (waitedPid, timeoutMs) => {
        throw new Error(`Process ${waitedPid} did not exit within ${timeoutMs}ms`);
      },
      startReplacement: async () => { replacementStarted = true; },
    }).then(() => null, (e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(`pid ${pid}`);
    expect(err!.message).toContain("did not exit within 60000ms");
    expect(err!.message).toContain("refusing to start a replacement");
    expect(err!.message).toContain("Stop it, then re-run 'flair restart'");
    expect(replacementStarted).toBe(false);
  }, 20_000);

  test("an exit wait that sees the old process gone still starts the replacement", async () => {
    const { port } = await arrangeLiveInstance();

    let replacementStarted = false;
    await expect(restartFlair(port, dataDir, {
      waitForExit: async () => {},
      startReplacement: async () => { replacementStarted = true; },
    })).resolves.toBeUndefined();

    expect(replacementStarted).toBe(true);
  }, 20_000);
});
