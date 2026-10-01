// launcher-pid-identity-2056.test.ts — flair#2056.
//
// The launcher and resolveInstanceServingPid must identify the PROCESS behind
// hdb.pid, not just the pid. A live hdb.pid pid counts as the serving instance
// only when its command line is a Harper process: argv[0]'s basename is `node`
// or `bun`, and argv[1], the script it runs, is a Harper entry
// (`…/node_modules/[@<scope>/]harper/dist/bin/harper.js`, or Harper's own
// restart entry `dist/bin/harper.js`). A Harper path in any other position does
// not count. A flair#1454 sidecar (flair-daemon.json) is not required — a
// pre-sidecar instance, or the instance launchd starts, has none — but when one
// names a different pid, or the same pid with a start time more than 2 s off,
// the identity evidence disagrees and the pid is not treated as the instance.
//
// Hermetic: the stub Harper the launcher execs only prints a marker. Each
// launcher run is a spawnSync with a timeout, and each case has its own
// timeout. The background processes this file starts are killed in afterEach
// by the pids it recorded; each also exits by itself within 120 s, or (the
// `sh` reading a pipe) when this process exits.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.js";
import { isHarperProcessCommandLine } from "../../src/lib/daemon-liveness.js";
import { resolveInstanceServingPid } from "../../src/cli.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO_ROOT, "templates", "launchd", "start-flair-with-admin-pass.sh");
const MARKER = "STUB-HARPER-RAN";

const dirs: string[] = [];
const pids: number[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fl2056-"));
  dirs.push(root);
  return root;
}

function childEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(FLAIR_|HARPER_|HDB_|TPS_)/.test(k)) continue;
    env[k] = v;
  }
  env.ROOTPATH = root;
  return env;
}

/** The stub Harper the launcher execs (it prints a marker and exits). */
function stubHarper(root: string): string {
  const p = join(root, "stub-harper.js");
  writeFileSync(p, `console.log(${JSON.stringify(MARKER)});\n`);
  return p;
}

/** Start a background process this file owns (killed in afterEach). Returns its pid. */
function startBackground(argv: string[], stdin: "ignore" | "pipe" = "ignore"): number {
  const proc = Bun.spawn(argv, { stdin, stdout: "ignore", stderr: "ignore" });
  pids.push(proc.pid);
  return proc.pid;
}

/** A live, unrelated process (`sleep 60`). Returns its pid. */
function startSleep(): number {
  return startBackground(["sleep", "60"]);
}

/**
 * A live process launched the way flair launches Harper:
 * `<runtime> <root>/node_modules/harper/dist/bin/harper.js run .` (`runtime`
 * is `node` unless given, e.g. this test's own bun).
 */
function startHarperEntry(root: string, runtime = "node"): number {
  const dir = join(root, "node_modules", "harper", "dist", "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "harper.js");
  writeFileSync(script, "setTimeout(() => {}, 120_000);\n");
  return startBackground([runtime, script, "run", "."]);
}

/**
 * A live `sh -c '<cmd>' /tmp/node_modules/harper.js`. `<cmd>` is the builtin
 * `read` on a pipe this process holds open, so the shell itself stays the
 * process (`sh -c 'sleep 60'` would exec `sleep` in its place, dropping the
 * argument) and exits when that pipe closes.
 */
function startShellWithHarperArg(): number {
  return startBackground(["sh", "-c", "read -r line", "/tmp/node_modules/harper.js"], "pipe");
}

/** A live `node -e` whose arguments include a `harper.js` path that it does not run. */
function startNodeEvalWithHarperArg(): number {
  return startBackground(["node", "-e", "setTimeout(() => {}, 120_000)", "/tmp/harper.js"]);
}

/** The pid's command line as `ps -o command=` prints it (what the launcher reads). */
function psCommand(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }).stdout.trim();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until the pid is alive and its start time is readable (bounded). */
async function waitStarted(pid: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const t = readProcessStartTimeMs(pid);
    if (alive(pid) && t !== null) return t;
    await Bun.sleep(20);
  }
  throw new Error(`pid ${pid} did not start with a readable start time`);
}

function writeSidecar(root: string, pid: number, startTimeMs: number): void {
  writeFileSync(join(root, "flair-daemon.json"), `${JSON.stringify({ pid, startTimeMs, port: 9926, flairVersion: "test" })}\n`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function runLauncher(root: string, node: string, harperBin: string): { status: number | null; stdout: string; stderr: string } {
  const passFile = join(root, "admin-pass");
  writeFileSync(passFile, "not-a-real-secret\n", { mode: 0o600 });
  chmodSync(passFile, 0o600);
  const r = spawnSync("sh", [LAUNCHER, passFile, node, harperBin], {
    encoding: "utf-8",
    timeout: 20_000,
    env: childEnv(root),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isHarperProcessCommandLine", () => {
  test("matches node or bun running a Harper entry script", () => {
    // What `flair start` and the launchd launcher run (live shape on a macOS host).
    expect(isHarperProcessCommandLine("/opt/homebrew/Cellar/node/26.8.1/bin/node /opt/homebrew/lib/node_modules/@tpsdev-ai/flair/node_modules/harper/dist/bin/harper.js run .")).toBe(true);
    // A pre-flair#870 tree's scoped Harper package.
    expect(isHarperProcessCommandLine("node /opt/flair/node_modules/@harperfast/harper/dist/bin/harper.js run .")).toBe(true);
    // The flair CLI under bun spawns Harper with bun (process.execPath).
    expect(isHarperProcessCommandLine("/home/u/.bun/bin/bun /opt/flair/node_modules/harper/dist/bin/harper.js run .")).toBe(true);
    // Harper's own restart forks its entry relative to its package directory.
    expect(isHarperProcessCommandLine("/usr/bin/node dist/bin/harper.js")).toBe(true);
    // Linux /proc/<pid>/cmdline: NUL-separated argv, so a path with a space still matches.
    expect(isHarperProcessCommandLine("/opt/my node/bin/node\u0000/opt/my flair/node_modules/harper/dist/bin/harper.js\u0000run\u0000.\u0000")).toBe(true);
  });

  test("does not match a Harper path that is not the script being run", () => {
    // The shell runs `sleep`; the harper.js path is only $0.
    expect(isHarperProcessCommandLine("sh -c sleep 60 /tmp/node_modules/harper.js")).toBe(false);
    // `-e` runs no script; /tmp/harper.js is only an argument.
    expect(isHarperProcessCommandLine("node -e setInterval(() => {}, 1000) /tmp/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("node -e x /opt/flair/node_modules/harper/dist/bin/harper.js")).toBe(false);
    // An option value is not the script.
    expect(isHarperProcessCommandLine("node --require=/opt/flair/node_modules/harper/dist/bin/harper.js app.js")).toBe(false);
    expect(isHarperProcessCommandLine("node /opt/app.js /opt/flair/node_modules/harper/dist/bin/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("bun test /opt/flair/node_modules/harper/dist/bin/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("sh\u0000-c\u0000sleep 60\u0000/tmp/node_modules/harper.js\u0000")).toBe(false);
  });

  test("does not match a script that is not a Harper entry, or another executable", () => {
    expect(isHarperProcessCommandLine("node /tmp/harper.js run .")).toBe(false);
    expect(isHarperProcessCommandLine("node /tmp/node_modules/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("node /opt/harper/dist/bin/harper.js run .")).toBe(false);
    expect(isHarperProcessCommandLine("node /opt/node_modules/@a/b/harper/dist/bin/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("nodejs /opt/flair/node_modules/harper/dist/bin/harper.js")).toBe(false);
    expect(isHarperProcessCommandLine("sleep 60")).toBe(false);
    expect(isHarperProcessCommandLine("node")).toBe(false);
    expect(isHarperProcessCommandLine("")).toBe(false);
  });
});

describe("flair#2056 — the launchd launcher identifies the process behind hdb.pid", () => {
  test("hdb.pid names a live UNRELATED process -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("already served");
  }, 30_000);

  test("hdb.pid names a live `sh` with a node_modules/harper.js ARGUMENT -> not Harper; the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startShellWithHarperArg();
    await waitStarted(pid);
    expect(psCommand(pid)).toContain("/tmp/node_modules/harper.js"); // the misleading line is what ps shows
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("already served");
  }, 30_000);

  test("hdb.pid names a live `node -e` with a harper.js ARGUMENT -> not Harper; the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startNodeEvalWithHarperArg();
    await waitStarted(pid);
    expect(psCommand(pid)).toContain("/tmp/harper.js"); // the misleading line is what ps shows
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("already served");
  }, 30_000);

  test("CONTROL: node running a Harper entry, with a matching sidecar, is refused", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(`already served by pid ${pid}`);
  }, 30_000);

  test("a matching sidecar with a non-Harper command line (`sleep`) -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startSleep();
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start); // matches pid + start time, but it is `sleep`
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);

  test("node running a Harper entry with NO sidecar is refused (a pre-sidecar or launchd-started instance)", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    // No flair-daemon.json: the command line alone identifies the serving process.
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(`already served by pid ${pid}`);
  }, 30_000);

  test("bun running a Harper entry with NO sidecar is refused (the flair CLI under bun spawns Harper with bun)", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root, process.execPath);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(`already served by pid ${pid}`);
  }, 30_000);

  test("a sidecar naming a DIFFERENT pid: the identity evidence disagrees -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeSidecar(root, pid + 1, Date.now()); // the sidecar names another pid
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);

  test("a sidecar with the same pid but a start time 60 s off: the identity evidence disagrees -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start + 60_000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);
});

describe("flair#2056 — resolveInstanceServingPid identifies the process behind hdb.pid", () => {
  // freePort(): nothing listens there, so a pid that is not used yields null.
  test("a live unrelated pid in hdb.pid is not the serving process", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const serving = resolveInstanceServingPid(root, await freePort());
    expect(serving).not.toBe(pid);
    expect(serving).toBeNull();
  }, 30_000);

  test("a live `sh` or `node -e` with a Harper path ARGUMENT in hdb.pid is not the serving process", async () => {
    for (const start of [startShellWithHarperArg, startNodeEvalWithHarperArg]) {
      const root = mkRoot();
      const pid = start();
      await waitStarted(pid);
      writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
      expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
    }
  }, 30_000);

  test("CONTROL: node running a Harper entry, with a matching sidecar, is returned", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const serving = resolveInstanceServingPid(root, await freePort());
    expect(serving).toBe(pid);
  }, 30_000);

  test("node running a Harper entry with NO sidecar is the serving process", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const serving = resolveInstanceServingPid(root, await freePort());
    expect(serving).toBe(pid);
  }, 30_000);

  test("a sidecar naming a DIFFERENT pid: the identity evidence disagrees -> not the serving process", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeSidecar(root, pid + 1, Date.now());
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
  }, 30_000);

  test("a sidecar with the same pid but a start time 60 s off: the identity evidence disagrees -> not the serving process", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start + 60_000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
  }, 30_000);
});
