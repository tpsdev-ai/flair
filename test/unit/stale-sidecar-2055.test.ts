// stale-sidecar-2055.test.ts — flair#2055.
//
// After `flair stop` ends a directly started Harper, `<dataDir>/flair-daemon.json`
// still names the stopped pid. A later instance under a DIFFERENT supervisor
// (a systemd user unit's Harper) writes its own pid to `hdb.pid`, so `hdb.pid`
// and the sidecar disagree — and the liveness machine refused every stop and
// restart with "its identity could not be verified".
//
// These are the command-level acceptance cases:
//   - `flair stop` leaves NO sidecar naming the pid it confirmed gone;
//   - a stale sidecar (dead pid) beside a LIVE `hdb.pid` is not a disagreement:
//     the stop acts on the live process and the sidecar goes away;
//   - stop-then-start under another supervisor: `flair restart` acts on the
//     live process, and no stale sidecar remains.
//
// A "Harper" here is a decoy in its own process: flair-shaped /Health, cwd in
// this worktree, `ROOTPATH` = the data dir — exactly the evidence the existing
// self-heal requires (#1478). HOME is a throwaway dir; nothing touches the real
// launchctl/systemctl or any real Flair data dir.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const repoRoot = join(import.meta.dirname, "..", "..");

/** Flair's public /Health shape (probeHealth requires this, not a bare 200). */
const FLAIR_HEALTH_JSON = JSON.stringify({
  ok: true,
  version: "0.57.0",
  buildCommit: null,
  searchReady: true,
});

describe("flair#2055 — a stale identity sidecar never refuses and never survives a stop", () => {
  let tmpHome: string;
  let dataDir: string;
  const spawned: Array<{ kill: (sig?: NodeJS.Signals | number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair2055-"));
    // `flair restart` has no --data-dir and acts on defaultDataDir(); the other
    // cases use --data-dir. Both name this same directory.
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(9); } catch { /* already gone */ }
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** A pid that is CONFIRMED gone: spawn, record it, and wait for it to exit. */
  async function confirmedDeadPid(): Promise<number> {
    const p = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    const pid = (p as unknown as { pid: number }).pid;
    await p.exited;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { return pid; }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`pid ${pid} was still alive after exit`);
  }

  /**
   * The "live Harper": a decoy in its own process that serves flair's /Health.
   * Its cwd is this worktree and its ROOTPATH is the data dir, so the self-heal
   * can identify it. The script is STATIC — body and port file arrive through
   * the child's env, never interpolated into source.
   */
  async function spawnHarperDecoy(): Promise<{ pid: number; port: number }> {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const portFile = join(tmpHome, `decoy-port-${tag}.txt`);
    const script = join(tmpHome, `decoy-${tag}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const body = process.env.DECOY_BODY ?? "";`,
        `const portFile = process.env.DECOY_PORT_FILE;`,
        `const srv = createServer((_req, res) => {`,
        `  res.writeHead(200, { "content-type": "application/json" });`,
        `  res.end(body);`,
        `});`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script], {
      cwd: repoRoot,
      env: {
        ...(process.env as Record<string, string>),
        ROOTPATH: dataDir,
        DECOY_BODY: FLAIR_HEALTH_JSON,
        DECOY_PORT_FILE: portFile,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc as unknown as { kill: (sig?: NodeJS.Signals | number) => void });
    const pid = (proc as unknown as { pid: number }).pid;

    let port = 0;
    for (let i = 0; i < 80 && port === 0; i++) {
      if (existsSync(portFile)) {
        const n = Number(readFileSync(portFile, "utf-8").trim());
        if (Number.isInteger(n) && n > 0) port = n;
      }
      if (port === 0) await new Promise((r) => setTimeout(r, 50));
    }
    if (port === 0) throw new Error("decoy did not report a bound port");

    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(200) });
        if (res.status === 200) return { pid, port };
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`decoy on ${port} did not become ready`);
  }

  async function runFlair(args: string[]) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
    };
    // FLAIR_URL outranks the resolved port; an ambient one would mask what this
    // measures.
    delete (env as Record<string, string | undefined>)["FLAIR_URL"];
    delete (env as Record<string, string | undefined>)["FLAIR_TARGET"];
    const proc = Bun.spawn(["bun", cliPath, ...args], {
      cwd: repoRoot,
      timeout: 20_000,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  function sidecarPath(): string {
    return join(dataDir, "flair-daemon.json");
  }

  test(
    "flair stop leaves no sidecar naming the pid it confirmed gone",
    async () => {
      const { pid, port } = await spawnHarperDecoy();
      // The supervisor's Harper wrote its own pid, and flair wrote the identity
      // sidecar at spawn (Date.now() is within the ±2s tolerance of the decoy's
      // real start time — this is what makes the stop attributable).
      writeFileSync(join(dataDir, "hdb.pid"), `${pid}\n`);
      writeFileSync(sidecarPath(), JSON.stringify({
        pid,
        startTimeMs: Date.now(),
        port,
        flairVersion: "0.57.0",
      }));

      const { stdout, stderr, exitCode } = await runFlair(["stop", "--port", String(port)]);

      expect(exitCode).toBe(0);
      expect(stdout + stderr).toMatch(/Flair stopped/i);
      // The stop acted on the live process, and the process it named is gone.
      expect(pidAlive(pid)).toBe(false);
      // THE ASSERTION (the defect): no sidecar names the stopped pid anymore.
      expect(existsSync(sidecarPath())).toBe(false);
    },
    30_000,
  );

  test(
    "a stale sidecar (dead pid) beside a live hdb.pid is not a disagreement: stop acts and clears it",
    async () => {
      const deadPid = await confirmedDeadPid();
      const { pid, port } = await spawnHarperDecoy();
      // The leftover from a previous `flair stop`, beside the pid the CURRENT
      // supervisor's Harper wrote for itself.
      writeFileSync(sidecarPath(), JSON.stringify({
        pid: deadPid,
        startTimeMs: Date.now() - 3_600_000,
        port,
        flairVersion: "0.57.0",
      }));
      writeFileSync(join(dataDir, "hdb.pid"), `${pid}\n`);

      const { stdout, stderr, exitCode } = await runFlair(["stop", "--port", String(port)]);

      // Before the fix this refused with "its identity could not be verified"
      // and exited non-zero, leaving the live process running.
      expect(exitCode).toBe(0);
      expect(stdout + stderr).toMatch(/Flair stopped/i);
      expect(stdout + stderr).not.toMatch(/could not be verified/i);
      expect(pidAlive(pid)).toBe(false);
      expect(existsSync(sidecarPath())).toBe(false);
    },
    30_000,
  );

  test(
    "stop-then-start under another supervisor: flair restart acts on the live process and no stale sidecar remains",
    async () => {
      // 1. A directly started Harper, whose stop left a sidecar naming its pid.
      const first = await spawnHarperDecoy();
      writeFileSync(join(dataDir, "hdb.pid"), `${first.pid}\n`);
      writeFileSync(sidecarPath(), JSON.stringify({
        pid: first.pid,
        startTimeMs: Date.now(),
        port: first.port,
        flairVersion: "0.57.0",
      }));
      const stopped = await runFlair(["stop", "--port", String(first.port)]);
      expect(stopped.exitCode).toBe(0);
      expect(pidAlive(first.pid)).toBe(false);
      expect(existsSync(sidecarPath())).toBe(false);

      // 2. A later instance under a DIFFERENT supervisor: its Harper writes its
      // own pid to hdb.pid. (Its port is what `flair restart` will act on.)
      const second = await spawnHarperDecoy();
      writeFileSync(join(dataDir, "hdb.pid"), `${second.pid}\n`);
      // A sidecar naming the first instance's now-dead pid is still on disk —
      // the exact leftover the published `flair stop` leaves. Restart must not
      // refuse on it.
      writeFileSync(sidecarPath(), JSON.stringify({
        pid: first.pid,
        startTimeMs: Date.now() - 3_600_000,
        port: first.port,
        flairVersion: "0.57.0",
      }));

      // 3. `flair restart` acts on the live process. Its START leg then refuses
      //    for an unrelated fixture reason: a newer engine stamp in the store,
      //    so it never spawns a real Harper. That keeps this a unit test; the
      //    STOP leg — the code under test — ran first.
      writeFileSync(join(dataDir, "engine-version.txt"), "99.0.0\n");

      const { stdout, stderr, exitCode } = await runFlair(["restart", "--port", String(second.port)]);

      // The stop leg acted: the live process is gone and no stale sidecar
      // remains. (The non-zero exit is the start leg's engine-version refusal.)
      expect(exitCode).not.toBe(0);
      expect(pidAlive(second.pid)).toBe(false);
      expect(existsSync(sidecarPath())).toBe(false);
      expect(stdout + stderr).not.toMatch(/could not be verified/i);
      expect(stdout + stderr).toMatch(/was last written by Harper 99\.0\.0/i);
    },
    30_000,
  );
});
