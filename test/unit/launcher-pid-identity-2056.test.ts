// launcher-pid-identity-2056.test.ts — flair#2056.
//
// The launcher and resolveInstanceServingPid check the command line of the
// process hdb.pid names, not only that the pid is alive. The launcher refuses,
// and resolveInstanceServingPid uses the hdb.pid pid as PID-file evidence, only
// when that live process's command line is Harper-shaped: `node` or `bun`
// followed by a Harper entry path
// (`…/node_modules/[@<scope>/]harper/dist/bin/harper.js`, or Harper's own
// restart entry `dist/bin/harper.js`). A Harper path in a later argument does
// not count. The launcher reads the line `ps -o command=` reports (arguments
// joined by spaces), which does not establish which argument is the script;
// the LIMITATION tests below pin that. A flair#1454 sidecar (flair-daemon.json)
// is not required — a pre-sidecar instance, or the instance launchd starts, has
// none — but it disagrees when it names a different pid, or a startTimeMs more
// than 2000 ms from the process's start second (ps on macOS; /proc on Linux), and
// then the launcher does not refuse and the pid is not used as PID-file
// evidence. When the pid is not used, resolveInstanceServingPid returns the
// first process listening on the port, if any. The Harper-shaped processes
// here are timer stubs: they serve nothing.
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
import { connect, createServer } from "node:net";
import { readProcessStartSecondMs, readProcessStartTimeMs } from "../../src/lib/process-start-time.js";
import { isHarperProcessCommandLine, sidecarStartAgrees } from "../../src/lib/daemon-liveness.js";
import { defaultReadProcessCmdline } from "../../src/lib/upgrade-exec-path.js";
import { resolveInstanceServingPid } from "../../src/cli.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO_ROOT, "templates", "launchd", "start-flair-with-admin-pass.sh");
const MARKER = "STUB-HARPER-RAN";

// Bounds for a start-time read of a just-spawned pid (flair#2130). A fresh
// fork's start time is not always answerable on the first read — macOS
// `ps -o lstart=` (and Linux /proc) can briefly return nothing — so a single
// null read is "not yet readable", not "unreadable". Retry an unsuccessful
// read until the cutoff instead of failing on the first attempt; a read
// already in flight at the cutoff may still finish after it.
const START_TIME_READ_TIMEOUT_MS = 5_000;
const START_TIME_READ_POLL_MS = 25;

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
 * A Harper-shaped stub: a timer script at `<root>/node_modules/harper/dist/bin/harper.js`,
 * launched with the argv flair uses for Harper (`<runtime> <script> run .`;
 * `runtime` is `node` unless given, e.g. this test's own bun). It serves nothing.
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

/**
 * A live `node -e` listening on 127.0.0.1:`port`, with a harper.js path as an
 * argument it does not run: not Harper-shaped, but the port's listener.
 */
async function startNodeEvalListening(port: number): Promise<number> {
  const code = `require("node:net").createServer().listen(${port}, "127.0.0.1"); setTimeout(() => process.exit(0), 120_000);`;
  const pid = startBackground(["node", "-e", code, "/tmp/harper.js"]);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (up) return pid;
    await Bun.sleep(20);
  }
  throw new Error(`pid ${pid} did not listen on ${port}`);
}

/**
 * The start second `ps -o lstart=` reports for `pid`, in epoch seconds,
 * converted the way the launcher converts it (`date -j -f` on macOS,
 * `date -d` elsewhere).
 */
function psLstartSecond(pid: number): number {
  const conv = process.platform === "darwin"
    ? 'date -j -f "%a %b %e %T %Y" "$(ps -o lstart= -p "$1")" +%s'
    : 'date -d "$(ps -o lstart= -p "$1")" +%s';
  // Same bounded retry as tsStartSecondMs (flair#2130): a just-spawned pid's
  // lstart can be briefly unreadable, and this reference conversion must not
  // throw on a read the reader beside it would have retried.
  const deadline = Date.now() + START_TIME_READ_TIMEOUT_MS;
  let sec = NaN;
  let stderr = "";
  for (;;) {
    const r = spawnSync("sh", ["-c", conv, "sh", String(pid)], { encoding: "utf-8", timeout: 5_000 });
    sec = Number((r.stdout ?? "").trim());
    stderr = r.stderr ?? "";
    if (Number.isInteger(sec) && sec > 0) return sec;
    if (Date.now() >= deadline) break;
    sleepSync(START_TIME_READ_POLL_MS);
  }
  throw new Error(`could not read the start second of pid ${pid}: ${stderr}`);
}

/** A short synchronous pause, so a bounded retry needs no async plumbing. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The pid's start second from the same reader resolveInstanceServingPid uses,
 * read with a bounded retry (flair#2130). A process spawned a moment ago can
 * have a start time the reader cannot answer for yet, so retry until it
 * answers. The cutoff is checked only after an unsuccessful read, so a read in
 * flight at the cutoff may still answer; only a null after the cutoff fails.
 */
function readStartSecondWithin(
  pid: number,
  read: (pid: number) => number | null,
  timeoutMs: number = START_TIME_READ_TIMEOUT_MS,
): number | null {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ms = read(pid);
    if (ms !== null) return ms;
    if (Date.now() >= deadline) return null;
    sleepSync(START_TIME_READ_POLL_MS);
  }
}

function tsStartSecondMs(pid: number): number {
  const ms = readStartSecondWithin(pid, readProcessStartSecondMs);
  expect(ms).not.toBeNull();
  if (ms === null) throw new Error(`could not read the start second of pid ${pid} within ${START_TIME_READ_TIMEOUT_MS}ms`);
  expect(ms % 1000).toBe(0);
  return ms;
}

/**
 * A live node whose script is ONE argument containing a space,
 * `<root>/node_modules/harper/dist/bin/harper.js decoy` (a file with that name):
 * not a Harper entry path, but `ps -o command=` prints
 * `node <root>/node_modules/harper/dist/bin/harper.js decoy run .`.
 */
function startSpaceDecoy(root: string): number {
  const dir = join(root, "node_modules", "harper", "dist", "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "harper.js decoy");
  writeFileSync(script, "setTimeout(() => {}, 120_000);\n");
  return startBackground(["node", script, "run", "."]);
}

/** Sidecar offsets from the start second, in ms, and whether each agrees (within 2000 ms). */
const BOUNDARY_CASES: ReadonlyArray<readonly [number, boolean]> = [
  [1_900, true],
  [2_000, true],
  [2_001, false],
  [2_500, false],
  [-2_000, true],
  [-2_001, false],
];

function offsetLabel(offsetMs: number): string {
  return `${offsetMs < 0 ? "-" : "+"}${Math.abs(offsetMs)} ms`;
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

/** Wait for the Harper entry argv that the resolver will inspect. */
async function waitHarperCommand(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const command = defaultReadProcessCmdline(pid);
    if (command !== null && isHarperProcessCommandLine(command)) return;
    await Bun.sleep(20);
  }
  throw new Error(`pid ${pid} did not expose a Harper-shaped command line`);
}

/** The refusal line the launcher prints for `pid`. */
function refusal(pid: number): string {
  return `hdb.pid names pid ${pid}, whose command line as ps reports it is node or bun followed by a Harper entry path; not starting a second instance`;
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
  test("matches node or bun followed by a Harper entry path", () => {
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

  test("does not match a Harper path in a later argument, or after an option", () => {
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

  // Documented limitation (flair#2056): `ps -o command=` joins arguments with
  // spaces, so one argument containing a space can produce a matching line. An
  // argument-preserving reader on macOS would reject it; flip this test then.
  test("LIMITATION: a ps line where a space inside one argument fakes a Harper entry path IS accepted", () => {
    expect(isHarperProcessCommandLine("node /tmp/node_modules/harper/dist/bin/harper.js decoy run .")).toBe(true);
    // The same arguments NUL-separated (/proc/<pid>/cmdline) keep the boundary and are rejected.
    expect(isHarperProcessCommandLine("node\u0000/tmp/node_modules/harper/dist/bin/harper.js decoy\u0000run\u0000.\u0000")).toBe(false);
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

describe("readStartSecondWithin — a just-spawned pid's start second is retried, bounded (flair#2130)", () => {
  test("a reader that answers only after a few reads is retried, not failed", () => {
    let reads = 0;
    const ms = readStartSecondWithin(4242, () => (reads++ < 3 ? null : 12_000), 1_000);
    expect(ms).toBe(12_000);
    expect(reads).toBe(4);
  });

  test("a reader that never answers returns null once the bound expires (and does not hang)", () => {
    const started = Date.now();
    const ms = readStartSecondWithin(4242, () => null, 60);
    expect(ms).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("sidecarStartAgrees — within 2000 ms of the start second, in milliseconds", () => {
  test("a start second of 12 s: a sidecar at 14.5 s disagrees, at 13.9 s agrees", () => {
    expect(sidecarStartAgrees(12_000, 14_500)).toBe(false);
    expect(sidecarStartAgrees(12_000, 13_900)).toBe(true);
  });

  test("the 2000 ms bound on both sides", () => {
    expect(sidecarStartAgrees(12_000, 14_000)).toBe(true);
    expect(sidecarStartAgrees(12_000, 14_001)).toBe(false);
    expect(sidecarStartAgrees(12_000, 10_000)).toBe(true);
    expect(sidecarStartAgrees(12_000, 9_999)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("macOS: readProcessStartSecondMs is the second `ps -o lstart=` reports", async () => {
    const pid = startSleep();
    await waitStarted(pid);
    expect(tsStartSecondMs(pid)).toBe(psLstartSecond(pid) * 1000);
  }, 30_000);

  test.skipIf(process.platform !== "linux")("Linux: the reader agrees with ps and remains stable across a wall-clock second", async () => {
    const pid = startSleep();
    await waitStarted(pid);
    const startSecondMs = tsStartSecondMs(pid);
    expect(startSecondMs).toBe(psLstartSecond(pid) * 1000);
    await Bun.sleep(1_050 - (Date.now() % 1_000));
    expect(tsStartSecondMs(pid)).toBe(startSecondMs);
  }, 30_000);
});

describe("flair#2056 — the launchd launcher refuses only when hdb.pid names a live process with a Harper-shaped command line", () => {
  test("hdb.pid names a live UNRELATED process -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("not starting a second instance");
  }, 30_000);

  test("hdb.pid names a live `sh` with a node_modules/harper.js ARGUMENT -> not Harper-shaped; the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startShellWithHarperArg();
    await waitStarted(pid);
    expect(psCommand(pid)).toContain("/tmp/node_modules/harper.js"); // the misleading line is what ps shows
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("not starting a second instance");
  }, 30_000);

  test("hdb.pid names a live `node -e` with a harper.js ARGUMENT -> not Harper-shaped; the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startNodeEvalWithHarperArg();
    await waitStarted(pid);
    expect(psCommand(pid)).toContain("/tmp/harper.js"); // the misleading line is what ps shows
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("not starting a second instance");
  }, 30_000);

  test("CONTROL: a Harper-shaped stub (node followed by a Harper entry path) with a matching sidecar is refused", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeSidecar(root, pid, psLstartSecond(pid) * 1000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(refusal(pid));
  }, 30_000);

  test("a matching sidecar with a command line that is not Harper-shaped (`sleep`) -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeSidecar(root, pid, psLstartSecond(pid) * 1000); // matches pid + start second, but it is `sleep`
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);

  test("a Harper-shaped stub with NO sidecar is refused (as for a pre-sidecar or launchd-started instance)", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    // No flair-daemon.json: the command line alone decides.
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(refusal(pid));
  }, 30_000);

  test("a Harper-shaped stub run by bun, with NO sidecar, is refused (the flair CLI under bun spawns Harper with bun)", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root, process.execPath);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(refusal(pid));
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
    await waitStarted(pid);
    writeSidecar(root, pid, psLstartSecond(pid) * 1000 + 60_000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);

  // Start second 12.000 s: a sidecar at 14.500 s (+2500 ms) disagrees, at 13.900 s (+1900 ms) agrees.
  for (const [offsetMs, agrees] of BOUNDARY_CASES) {
    test(`sidecar at the start second ${offsetLabel(offsetMs)}: ${agrees ? "agrees -> refused" : "disagrees -> the launcher execs Harper"}`, async () => {
      const root = mkRoot();
      const pid = startHarperEntry(root);
      await waitStarted(pid);
      writeSidecar(root, pid, psLstartSecond(pid) * 1000 + offsetMs);
      writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
      const r = runLauncher(root, "node", stubHarper(root));
      expect(r.status).toBe(0);
      if (agrees) {
        expect(r.stdout).not.toContain(MARKER);
        expect(r.stderr).toContain(refusal(pid));
      } else {
        expect(r.stdout).toContain(MARKER);
        expect(r.stderr).not.toContain("not starting a second instance");
      }
    }, 30_000);
  }

  test("LIMITATION: a live node whose script argument is `…/harper.js decoy` (one argument, with a space) IS refused", async () => {
    const root = mkRoot();
    const pid = startSpaceDecoy(root);
    await waitStarted(pid);
    expect(psCommand(pid)).toContain("/node_modules/harper/dist/bin/harper.js decoy run ."); // what the launcher reads
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(refusal(pid));
  }, 30_000);

  test("a sidecar startTimeMs written with leading zeros is read as decimal, not octal", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    const startTimeMs = psLstartSecond(pid) * 1000 + 500;
    writeFileSync(join(root, "flair-daemon.json"), `{"pid": ${pid}, "startTimeMs": 00${startTimeMs}, "port": 9926}\n`);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(refusal(pid));
  }, 30_000);
});

describe("flair#2056 — resolveInstanceServingPid uses the hdb.pid pid only when its command line is Harper-shaped", () => {
  // freePort(): nothing listens there, so a pid that is not used yields null.
  test("a live unrelated pid in hdb.pid is not returned", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const picked = resolveInstanceServingPid(root, await freePort());
    expect(picked).not.toBe(pid);
    expect(picked).toBeNull();
  }, 30_000);

  test("a live `sh` or `node -e` with a Harper path ARGUMENT in hdb.pid is not returned", async () => {
    for (const start of [startShellWithHarperArg, startNodeEvalWithHarperArg]) {
      const root = mkRoot();
      const pid = start();
      await waitStarted(pid);
      writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
      expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
    }
  }, 30_000);

  test("CONTROL: a Harper-shaped stub with a matching sidecar is returned", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    await waitHarperCommand(pid);
    writeSidecar(root, pid, tsStartSecondMs(pid));
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBe(pid);
  }, 30_000);

  test("unknown start second leaves a matching sidecar unconfirmed", () => {
    const root = mkRoot();
    // Inject a Harper-shaped command line so the time result is decisive.
    writeSidecar(root, process.pid, Date.now());
    writeFileSync(join(root, "hdb.pid"), `${process.pid}\n`);
    let startReads = 0;
    const deps = {
      findListeningPids: () => [],
      readCmdline: () => "node /opt/node_modules/harper/dist/bin/harper.js run .",
    };
    expect(resolveInstanceServingPid(root, 9926, {
      ...deps,
      readStartSecondMs: () => Math.floor(Date.now() / 1000) * 1000,
    })).toBe(process.pid);
    expect(resolveInstanceServingPid(root, 9926, {
      ...deps,
      readStartSecondMs: () => {
        startReads++;
        return null;
      },
    })).toBeNull();
    expect(startReads).toBe(1);
  }, 30_000);

  test("a Harper-shaped stub with NO sidecar is returned", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    await waitHarperCommand(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBe(pid);
  }, 30_000);

  test("a sidecar naming a DIFFERENT pid: the identity evidence disagrees -> not returned", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    await waitHarperCommand(pid);
    writeSidecar(root, pid + 1, Date.now());
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
  }, 30_000);

  test("a sidecar with the same pid but a start time 60 s off: the identity evidence disagrees -> not returned", async () => {
    const root = mkRoot();
    const pid = startHarperEntry(root);
    await waitStarted(pid);
    await waitHarperCommand(pid);
    writeSidecar(root, pid, tsStartSecondMs(pid) + 60_000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBeNull();
  }, 30_000);

  for (const [offsetMs, agrees] of BOUNDARY_CASES) {
    test(`sidecar at the start second ${offsetLabel(offsetMs)}: ${agrees ? "agrees -> returned" : "disagrees -> not returned"}`, async () => {
      const root = mkRoot();
      const pid = startHarperEntry(root);
      await waitStarted(pid);
      await waitHarperCommand(pid);
      const startSecondMs = tsStartSecondMs(pid);
      writeSidecar(root, pid, startSecondMs + offsetMs);
      writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
      expect(resolveInstanceServingPid(root, await freePort())).toBe(agrees ? pid : null);
    }, 30_000);
  }

  test("LIMITATION: the `…/harper.js decoy` node is returned from the macOS ps line; from a readable /proc on Linux it is not", async () => {
    const root = mkRoot();
    const pid = startSpaceDecoy(root);
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(resolveInstanceServingPid(root, await freePort())).toBe(process.platform === "linux" ? null : pid);
  }, 30_000);

  test("a pid that is not Harper-shaped is still returned when it is the port's listener (the port fallback)", async () => {
    const root = mkRoot();
    const port = await freePort();
    const pid = await startNodeEvalListening(port);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    expect(isHarperProcessCommandLine(psCommand(pid))).toBe(false);
    expect(resolveInstanceServingPid(root, port)).toBe(pid);
  }, 30_000);
});
