// launchd-2040-command-level.test.ts — flair#2040, driven through the commands.
//
// The incident: `flair doctor --fix` over ssh clean-stopped a HEALTHY instance,
// then could not load the launchd job (the GUI domain was unreachable from that
// session: `launchctl print gui/<uid>` → 125), leaving Flair down; and `flair
// init` printed a check mark for a job it never loaded.
//
// Each case drives the REAL executor — doctor's
// `repairLaunchdManagement`, init's `registerInitLaunchdService`, and the
// `flair start` command itself.
//
// SAFETY — this host may run a real Flair under launchd:
//
//   - `launchctl` is a shim on PATH (first) that records every invocation and
//     answers from a state directory this test owns. No invocation here reaches
//     real launchd. The shim's bootstrap "starts the job" by spawning the stub
//     below; its bootout "stops the job" by signalling the pid IT recorded.
//   - Harper is a stub: `node_modules/harper/dist/bin/harper.js` inside a copied
//     package tree under the temporary directory, removed after each test,
//     so every start path — launchd's, the direct fallback, the restore — spawns
//     the stub, never a database. The stub answers Flair's /Health on 127.0.0.1,
//     writes hdb.pid, opens `<dataDir>/operations-server`, and logs SIGTERM.
//     Every path runs it as `<this test's runtime (bun)> <stub> run .`, the argv
//     `flair start` spawns under bun, so the command line `ps` reports for a
//     live stub is Harper-shaped for the launcher's flair#2056 check.
//   - HOME is a throwaway directory for every CLI subprocess; every plist, data
//     dir, admin-pass file and label resolves inside it. Ports are ephemeral,
//     never 9926.
//   - The only processes signalled are stubs this file started, by pids the
//     stubs themselves recorded — and each is checked to be running the stub
//     script before it is killed.
//
// darwin-gated: every executor here is gated on `process.platform ===
// "darwin"`. Linux CI reports these as skipped (flair#1012); the darwin
// unit lane executes them.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLaunchdPlist, launchdLabel, launchdPlistPath, LEGACY_LAUNCHD_LABEL } from "../../src/cli.ts";
import { STUB_HARPER, stubLifetimeEnv } from "../helpers/stub-harper-2040.ts";

const isDarwin = process.platform === "darwin";
const repoRoot = join(import.meta.dirname, "..", "..");
const UID = typeof process.getuid === "function" ? process.getuid() : 0;
const GUI = `gui/${UID}`;
const ADMIN_PASS = "PLACEHOLDER-not-a-secret";
/** launchctl verbs that change launchd state. A refusal must issue none of them. */
const MUTATING_VERBS = ["bootout", "bootstrap", "kickstart", "load", "unload", "start", "stop", "enable", "disable", "remove", "submit"];

// The launchctl stand-in. State lives under $SHIM_STATE:
//   domain-code           exit code for `print gui/<uid>` (default 0)
//   disabled              stdout for `print-disabled gui/<uid>` (default: none disabled)
//   bootstrap-fail/<l>    make `bootstrap` of label <l> fail with 5: Input/output error
//   list-no-pid[-<l>]     `list` reports loaded jobs (or just <l>) WITHOUT a PID
//   loaded/<l>, pid/<l>   what is "loaded" and the pid "launchd" runs for it
//   bootout-order         (written) each bootout's label + whether the serving pid was alive
//   bootout-fail/<l>      `bootout` of <l> fails (5) and the job STAYS loaded
//   kickstart-fail/<l>    `kickstart` of <l> fails (5)
//   bootstrap-no-spawn/<l> `bootstrap` loads <l> but starts no process
//   stub-no-pidfile       the process a `bootstrap` starts writes no hdb.pid
//   stub-start-delay      the process a `bootstrap` starts runs at once, but binds its
//                         port and writes hdb.pid only after this many ms (a real boot)
//   stub-pidfile-first    ... and writes hdb.pid and opens its ops socket at once, BEFORE
//                         that delayed HTTP bind
//   print-fail/<l>        `print gui/<uid>/<l>` fails (5): presence UNKNOWN
const SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_LOG"
S="$SHIM_STATE"
verb="$1"; shift
case "$verb" in
  print)
    t="$1"
    case "$t" in
      gui/*/*)
        l="\${t#gui/*/}"
        if [ -f "$S/print-fail/$l" ]; then echo "Could not print service: 5: Input/output error" >&2; exit 5; fi
        if [ -f "$S/loaded/$l" ]; then printf '%s = {\\n}\\n' "$t"; exit 0; fi
        printf 'Could not find service "%s" in domain for user gui: %s\\n' "$l" "${UID}" >&2; exit 113 ;;
      gui/*)
        c=0; [ -f "$S/domain-code" ] && c=$(cat "$S/domain-code")
        [ "$c" = 125 ] && echo "Could not print domain: 125: Domain does not support specified action" >&2
        exit "$c" ;;
    esac
    exit 64 ;;
  print-disabled)
    if [ -f "$S/disabled" ]; then cat "$S/disabled"; else printf 'disabled services = {\\n}\\n'; fi
    exit 0 ;;
  list)
    l="$1"
    if [ -f "$S/loaded/$l" ]; then
      p=""; [ -f "$S/pid/$l" ] && p=$(cat "$S/pid/$l")
      printf '{\\n\\t"Label" = "%s";\\n\\t"LastExitStatus" = 0;\\n' "$l"
      if [ ! -f "$S/list-no-pid" ] && [ ! -f "$S/list-no-pid-$l" ] && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then printf '\\t"PID" = %s;\\n' "$p"; fi
      printf '};\\n'; exit 0
    fi
    printf 'Could not find service "%s" in domain for port\\n' "$l" >&2; exit 113 ;;
  bootout)
    l="\${1#gui/*/}"
    # Record whether the instance's serving process was alive at this bootout.
    sp=$(cat "$STUB_ROOT/hdb.pid" 2>/dev/null)
    if [ -n "$sp" ] && kill -0 "$sp" 2>/dev/null; then echo "$l serving-alive" >> "$S/bootout-order"; else echo "$l serving-gone" >> "$S/bootout-order"; fi
    if [ -f "$S/bootout-fail/$l" ]; then echo "Boot-out failed: 5: Input/output error" >&2; exit 5; fi
    if [ -f "$S/loaded/$l" ]; then
      if [ -f "$S/pid/$l" ]; then kill -TERM "$(cat "$S/pid/$l")" 2>/dev/null; rm -f "$S/pid/$l"; fi
      rm -f "$S/loaded/$l"; exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2; exit 3 ;;
  bootstrap)
    l=$(basename "$2" .plist)
    if [ -f "$S/bootstrap-fail/$l" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    : > "$S/loaded/$l"
    [ -f "$S/bootstrap-no-spawn/$l" ] && exit 0
    if [ -f "$S/stub-no-pidfile" ]; then export STUB_NO_PIDFILE=1; fi
    if [ -f "$S/stub-start-delay" ]; then export STUB_START_DELAY_MS="$(cat "$S/stub-start-delay")"; fi
    if [ -f "$S/stub-pidfile-first" ]; then export STUB_PIDFILE_FIRST=1; fi
    ROOTPATH="$STUB_ROOT" HTTP_PORT="$STUB_PORT" "$STUB_RUNTIME" "$STUB_HARPER" run . >/dev/null 2>&1 </dev/null &
    echo $! > "$S/pid/$l"
    exit 0 ;;
  kickstart)
    l="\${1#gui/*/}"
    if [ -f "$S/kickstart-fail/$l" ]; then echo "Could not kickstart service: 5: Input/output error" >&2; exit 5; fi
    [ -f "$S/loaded/$l" ] && exit 0
    echo "Could not find service" >&2; exit 113 ;;
esac
exit 0
`;

interface Fixture {
  home: string;
  dataDir: string;
  agentsDir: string;
  shimBin: string;
  state: string;
  shimLog: string;
  startLog: string;
  probe: string;
  stubHarper: string;
  label: string;
  plistPath: string;
  port: number;
}

let fx: Fixture;
let fixtureReady = false;
const cleanupDirs: string[] = [];

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

function setupFixture(port: number): Fixture {
  // Short names: <dataDir>/operations-server must fit sun_path (104 on darwin).
  const home = mkdtempSync(join(tmpdir(), "fl2040h-"));
  cleanupDirs.push(home);
  const dataDir = join(home, ".flair", "data");
  mkdirSync(join(dataDir, "log"), { recursive: true });
  const agentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(home, ".flair", "admin-pass"), `${ADMIN_PASS}\n`, { mode: 0o600 });
  chmodSync(join(home, ".flair", "admin-pass"), 0o600);
  writeFileSync(
    join(dataDir, "harper-config.yaml"),
    `rootPath: ${dataDir}\nhttp:\n  port: ${port}\noperationsApi:\n  network:\n    port: ${port + 1}\n`,
  );

  const shimBin = join(home, "bin");
  mkdirSync(shimBin);
  writeFileSync(join(shimBin, "launchctl"), SHIM, { mode: 0o755 });
  const state = join(home, "shim-state");
  for (const d of ["loaded", "pid", "bootstrap-fail", "bootout-fail", "kickstart-fail", "bootstrap-no-spawn", "print-fail"]) mkdirSync(join(state, d), { recursive: true });

  // A package tree whose Harper is the stub (see the file header).
  const probe = mkdtempSync(join(tmpdir(), "fl2040p-"));
  cleanupDirs.push(probe);
  cpSync(join(repoRoot, "src"), join(probe, "src"), { recursive: true });
  cpSync(join(repoRoot, "templates"), join(probe, "templates"), { recursive: true });
  chmodSync(join(probe, "templates", "launchd", "start-flair-with-admin-pass.sh"), 0o755);
  const stubHarper = join(probe, "node_modules", "harper", "dist", "bin", "harper.js");
  mkdirSync(join(probe, "node_modules", "harper", "dist", "bin"), { recursive: true });
  writeFileSync(stubHarper, STUB_HARPER);
  for (const entry of readdirSync(join(repoRoot, "node_modules"))) {
    if (entry !== "harper") symlinkSync(join(repoRoot, "node_modules", entry), join(probe, "node_modules", entry));
  }
  symlinkSync(join(repoRoot, "packages"), join(probe, "packages"));
  cpSync(join(repoRoot, "package.json"), join(probe, "package.json"));
  writeFileSync(
    join(probe, "drive.ts"),
    [
      `import { chmodSync } from "node:fs";`,
      `import { initLaunchdExitCode, repairLaunchdManagement, registerInitLaunchdService, setLaunchdMigrationLintForTests, startFlairProcess } from "./src/cli.ts";`,
      `const [what, arg] = process.argv.slice(2);`,
      `const input = JSON.parse(arg);`,
      // A migration lint that THROWS instead of answering (flair#2040 r8).
      // `lockDirBeforeThrow` makes that directory read-only first, so putting a
      // plist in it back afterwards fails (flair#2078).
      `if (input.lintThrows) setLaunchdMigrationLintForTests(() => {`,
      `  if (input.lockDirBeforeThrow) chmodSync(input.lockDirBeforeThrow, 0o555);`,
      `  throw new Error(input.lintThrows);`,
      `});`,
      `let r;`,
      `if (what === "repair") r = await repairLaunchdManagement(input.dataDir, input.port);`,
      `else if (what === "init") r = await registerInitLaunchdService(input);`,
      // The start leg of restart / upgrade / snapshot, without their stop leg.
      `else {`,
      `  try { await startFlairProcess(input.port, input.dataDir); r = { started: true }; }`,
      `  catch (err) { r = { started: false, error: String(err?.message ?? err) }; }`,
      `}`,
      // Did the port serve at the moment the executor returned?
      `if (input.probeServingAtReturn) {`,
      `  let ok = false;`,
      `  try { ok = (await fetch("http://127.0.0.1:" + input.port + "/Health", { signal: AbortSignal.timeout(1000) })).ok; } catch {}`,
      `  console.log("SERVING_AT_RETURN " + ok);`,
      `}`,
      `console.log("RESULT " + JSON.stringify(r));`,
      // Driver exit follows the shared launchd outcome mapping. g4 below runs
      // the real init command to check its own exit call.
      `process.exit(what === "init" ? initLaunchdExitCode(r.kind) : 0);`,
    ].join("\n"),
  );
  // `flair start` itself (the CLI's own command path), with a migration lint
  // that THROWS instead of answering (flair#2040 r8): argv[2] is the error
  // message, the rest is the command line.
  writeFileSync(
    join(probe, "start-cli.ts"),
    [
      `import { runCli, setLaunchdMigrationLintForTests } from "./src/cli.ts";`,
      `const [lintThrows] = process.argv.splice(2, 1);`,
      `setLaunchdMigrationLintForTests(() => { throw new Error(lintThrows); });`,
      `await runCli();`,
    ].join("\n"),
  );
  // Run init through its command action while injecting the same lint failure
  // as the driver. This reaches src/commands/init.ts's own process.exit call.
  writeFileSync(
    join(probe, "init-cli.ts"),
    [
      `import { chmodSync } from "node:fs";`,
      `import { runCli, setLaunchdMigrationLintForTests } from "./src/cli.ts";`,
      `const [lintThrows, lockDir] = process.argv.splice(2, 2);`,
      `setLaunchdMigrationLintForTests(() => {`,
      `  chmodSync(lockDir, 0o555);`,
      `  throw new Error(lintThrows);`,
      `});`,
      `await runCli();`,
    ].join("\n"),
  );

  const label = launchdLabel(dataDir);
  return {
    home,
    dataDir,
    agentsDir,
    shimBin,
    state,
    shimLog: join(home, "launchctl.log"),
    startLog: join(home, "stub-starts.log"),
    probe,
    stubHarper,
    label,
    plistPath: launchdPlistPath(label, agentsDir),
    port,
  };
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(FLAIR_|HARPER_|HDB_|TPS_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: fx.home,
    PATH: `${fx.shimBin}:${process.env.PATH ?? ""}`,
    SHIM_LOG: fx.shimLog,
    SHIM_STATE: fx.state,
    STUB_ROOT: fx.dataDir,
    STUB_PORT: String(fx.port),
    STUB_RUNTIME: process.execPath,
    STUB_HARPER: fx.stubHarper,
    STUB_START_LOG: fx.startLog,
    // The stub ends on its own when THIS process (the test runner) is gone,
    // whatever signal killed it, and after a hard lifetime backstop (flair#2281).
    ...stubLifetimeEnv(process.pid),
  };
}

/** The instance serving before the command runs: a stub started DIRECTLY (not by launchd). */
async function startDirectStub(envOverride: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn([process.execPath, fx.stubHarper, "run", "."], {
    // cwd = a flair worktree + ROOTPATH, so the liveness machine can attribute
    // it (same arrangement as launchd-management-reporting.test.ts).
    cwd: repoRoot,
    env: { ...childEnv(), ROOTPATH: fx.dataDir, HTTP_PORT: `127.0.0.1:${fx.port}`, ...envOverride },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100 && !(await healthy()); i++) await Bun.sleep(50);
  if (!(await healthy())) throw new Error("direct stub did not come up");
  return proc.pid;
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${fx.port}/Health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hdbPid(): number | null {
  try { return Number(readFileSync(join(fx.dataDir, "hdb.pid"), "utf-8").trim()); } catch { return null; }
}

function shimLines(): string[] {
  if (!existsSync(fx.shimLog)) return [];
  return readFileSync(fx.shimLog, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
}

function mutatingCalls(): string[] {
  return shimLines().filter((l) => MUTATING_VERBS.includes(l.split(/\s+/)[0]));
}

function signals(): string {
  return existsSync(join(fx.dataDir, "signals.log")) ? readFileSync(join(fx.dataDir, "signals.log"), "utf-8") : "";
}

function stubStarts(): number[] {
  if (!existsSync(fx.startLog)) return [];
  return readFileSync(fx.startLog, "utf-8").split("\n").filter(Boolean).map(Number);
}

/** A pass-file plist for `label` whose paths all exist (the shape init/doctor write). */
function passFilePlist(label: string): string {
  return buildLaunchdPlist({
    label,
    execPath: process.execPath,
    harperBinPath: fx.stubHarper,
    workingDirectory: fx.probe,
    dataDir: fx.dataDir,
    modelsDir: join(fx.dataDir, "models"),
    setConfig: "{}",
    adminUser: "admin",
    httpPort: fx.port,
    opsNetworkPort: `127.0.0.1:${fx.port + 1}`,
    passFile: {
      launcher: join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh"),
      adminPassFile: join(fx.home, ".flair", "admin-pass"),
      home: fx.home,
      path: process.env.PATH ?? "/usr/bin:/bin",
    },
  });
}

/**
 * The environment a plist launch here runs under: the plist's
 * EnvironmentVariables, this file's start log, and the stub's lifetime env
 * against `ownerPid` (flair#2281).
 */
function plistLaunchEnv(plist: { EnvironmentVariables: Record<string, string> }, ownerPid = process.pid): Record<string, string> {
  return { ...plist.EnvironmentVariables, STUB_START_LOG: fx.startLog, ...stubLifetimeEnv(ownerPid) };
}

async function drive(
  what: "repair" | "init" | "startleg",
  input: unknown,
  envOverride: Record<string, string> = {},
  timeoutMs = 100_000,
): Promise<{ result: any; stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, join(fx.probe, "drive.ts"), what, JSON.stringify(input)], {
    cwd: fx.probe,
    env: { ...childEnv(), ...envOverride },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  expect(line, `driver produced no RESULT.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined();
  return { result: JSON.parse(line!.slice("RESULT ".length)), stdout, stderr, exitCode };
}

/**
 * `flair start --port <port>` in a child. `lintThrows` runs it through the
 * start-cli.ts entry, whose migration lint throws that message (flair#2040 r8);
 * `envOverride` is laid over the child's environment.
 */
async function flairStart(
  opts: { lintThrows?: string; envOverride?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = opts.lintThrows === undefined
    ? [join(fx.probe, "src", "cli.ts")]
    : [join(fx.probe, "start-cli.ts"), opts.lintThrows];
  const proc = Bun.spawn([process.execPath, ...entry, "start", "--port", String(fx.port)], {
    cwd: fx.probe,
    env: { ...childEnv(), ...(opts.envOverride ?? {}) },
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** `flair init` command action with a thrown lint and a failed put-back. */
async function flairInitWithFailedPutBack(lintThrows: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([
    process.execPath, join(fx.probe, "init-cli.ts"), lintThrows, fx.agentsDir,
    "init", "--no-mcp", "--skip-soul", "--data-dir", fx.dataDir, "--port", String(fx.port),
  ], {
    cwd: fx.probe,
    env: childEnv(),
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function initInput(adminPass = ADMIN_PASS) {
  return {
    dataDir: fx.dataDir,
    port: fx.port,
    plistDir: fx.agentsDir,
    write: {
      dataDir: fx.dataDir,
      plistPath: fx.plistPath,
      label: fx.label,
      adminPass,
      adminUser: "admin",
      modelsDir: join(fx.dataDir, "models"),
      execPath: process.execPath,
      harperBinPath: fx.stubHarper,
      workingDirectory: fx.probe,
      httpPort: fx.port,
      opsNetworkPort: `127.0.0.1:${fx.port + 1}`,
      setConfig: "{}",
      port: fx.port,
    },
  };
}

/**
 * Take away every way to identify the serving process: no hdb.pid, and an
 * `lsof` that cannot run (a shim first on PATH that fails). The serving
 * process keeps serving — it just cannot be attributed.
 */
function makeServingUnattributable(): void {
  rmSync(join(fx.dataDir, "hdb.pid"), { force: true });
  writeFileSync(join(fx.shimBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}

/** Mark `label` as loaded in the shim, running `pid` (what launchd would report). */
function markLoaded(label: string, pid: number | null): void {
  writeFileSync(join(fx.state, "loaded", label), "");
  if (pid !== null) writeFileSync(join(fx.state, "pid", label), String(pid));
}

/**
 * flair#2040 CI diagnostics: run a case's assertions; when one fails, print
 * what the driver saw (the whole result, its output tails, the shim's calls,
 * signals, stub starts), then fail as before.
 */
async function explainOnFailure(
  run: { result: unknown; stdout: string; stderr: string },
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
  } catch (err) {
    console.error(
      [
        "----- flair#2040 command-level diagnostics -----",
        `result: ${JSON.stringify(run.result, null, 2)}`,
        `driver stdout (tail):\n${run.stdout.slice(-4_000)}`,
        `driver stderr (tail):\n${run.stderr.slice(-4_000)}`,
        `launchctl shim calls:\n${shimLines().join("\n")}`,
        `signals:\n${signals()}`,
        `stub starts: ${stubStarts().join(", ")}`,
        `hdb.pid: ${hdbPid()}`,
      ].join("\n"),
    );
    throw err;
  }
}

beforeEach(async () => {
  fixtureReady = false;
  fx = setupFixture(await freePort());
  fixtureReady = true;
});

afterEach(() => {
  // Only stubs this file started: every stub logs its own pid, and each is
  // checked to be running the stub script before it is signalled.
  for (const pid of fixtureReady ? stubStarts() : []) {
    const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 1_000, killSignal: "SIGKILL" }).stdout ?? "";
    if (cmd.includes(fx.stubHarper)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  fixtureReady = false;
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

// ─── doctor --fix: repairLaunchdManagement ─────────────────────────────────

describe("flair#2040 — doctor --fix never stops an instance it cannot hand to launchd", () => {
  async function arrangeDirectInstance(): Promise<{ pid: number; plistBytes: string }> {
    // The incident's state: init wrote the plist, the job is not loaded, and a
    // direct process serves the instance.
    const plistBytes = passFilePlist(fx.label);
    writeFileSync(fx.plistPath, plistBytes);
    const pid = await startDirectStub();
    return { pid, plistBytes };
  }

  test.skipIf(!isDarwin)(
    "(a) THE INCIDENT: 125 from the domain probe -> refused, non-zero, never fixed; live pid, plist and stop record unchanged",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, "domain-code"), "125");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure // doctor counts an issue and exits non-zero; never "repaired"
      expect(result.reason).toBe("launchd-domain-unavailable");
      expect(result.detail).toContain(`launchctl print ${GUI} exited 125`);
      expect(result.detail).toContain("Nothing was stopped, unloaded or rewritten");
      expect(result.detail).toContain("from a console (GUI) login session");
      // The live instance is untouched: same pid serving, no signal, same plist bytes.
      expect(alive(pid)).toBe(true);
      expect(hdbPid()).toBe(pid);
      expect(await healthy()).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      // Only read-only launchctl traffic; the domain probe was asked.
      expect(mutatingCalls()).toEqual([]);
      expect(shimLines()).toContain(`print ${GUI}`);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(a2) the job's label is disabled in the domain -> refused before any stop, with the enable command",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, "disabled"), `disabled services = {\n\t\t"${fx.label}" => disabled\n\t}\n`);

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure
      expect(result.reason).toBe("launchd-job-disabled");
      expect(result.detail).toContain(`launchctl enable ${GUI}/${fx.label}`);
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(a3) the replacement plist cannot be loaded (launcher missing) -> failed BEFORE the stop; nothing touched",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      rmSync(join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh"));

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("start-flair-with-admin-pass.sh, which does not exist");
      expect(result.detail).toContain("Nothing was stopped or unloaded, and no plist was written");
      expect(alive(pid)).toBe(true);
      expect(hdbPid()).toBe(pid);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "SIGTERM removes the pidfile but leaves the direct process serving: repair reports the exit wait (#2205)",
    async () => {
      const plistBytes = passFilePlist(fx.label);
      writeFileSync(fx.plistPath, plistBytes);
      const pid = await startDirectStub({ STUB_HOLD_ON_SIGTERM: "1" });
      const run = await drive("repair", { dataDir: fx.dataDir, port: fx.port }, {}, 90_000);
      expect(run.result.kind).toBe("failed");
      expect(run.result.detail).toContain(`waiting for direct Harper process ${pid}`);
      expect(run.result.detail).toContain("not observed to exit before the deadline");
      expect(run.result.remedy.join(" ")).toContain("run flair doctor --fix after resolving the stop failure");
      expect(signals()).toBe(`SIGTERM ${pid}\n`);
      expect(hdbPid()).toBeNull();
      expect(alive(pid)).toBe(true);
      expect(await healthy()).toBe(true);
      expect(stubStarts()).toEqual([pid]);
      expect(mutatingCalls()).toEqual([]);
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
    },
    100_000,
  );

  test.skipIf(!isDarwin)(
    "(b) POSITIVE CONTROL: the domain answers -> adoption bounces and VERIFIES, loading with commands that name gui/<uid>",
    async () => {
      const { pid } = await arrangeDirectInstance();

      const run = await drive("repair", { dataDir: fx.dataDir, port: fx.port });
      const { result } = run;

      await explainOnFailure(run, async () => {
        expect(result).toMatchObject({ kind: "repaired" }); // whole result printed on failure
        expect(result.detail).toContain("adopted the direct-spawned instance into launchd");
        // The direct process was clean-stopped (SIGTERM), and launchd's job now serves.
        expect(signals()).toContain(`SIGTERM ${pid}`);
        expect(alive(pid)).toBe(false);
        const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
        expect(managedPid).not.toBe(pid);
        expect(hdbPid()).toBe(managedPid);
        expect(await healthy()).toBe(true);
        // The load names the probed domain; the legacy, domain-inferring verbs are gone.
        const verbs = mutatingCalls();
        expect(verbs).toContain(`bootstrap ${GUI} ${fx.plistPath}`);
        expect(verbs).toContain(`kickstart ${GUI}/${fx.label}`);
        expect(verbs.filter((l) => /^(load|unload|start)\b/.test(l))).toEqual([]);
      });
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(b2) a job that is loaded but NOT serving is booted out BEFORE the direct process is stopped (KeepAlive cannot race the stop)",
    async () => {
      const { pid } = await arrangeDirectInstance();
      markLoaded(fx.label, null); // loaded, not running: e.g. the launcher refusing while the direct process serves

      const run = await drive("repair", { dataDir: fx.dataDir, port: fx.port });
      const { result } = run;

      await explainOnFailure(run, async () => {
        expect(result).toMatchObject({ kind: "repaired" }); // whole result printed on failure
        expect(signals()).toContain(`SIGTERM ${pid}`);
        const order = readFileSync(join(fx.state, "bootout-order"), "utf-8").split("\n").filter(Boolean);
        // The FIRST bootout of this job happened while the direct process still served.
        expect(order[0]).toBe(`${fx.label} serving-alive`);
      });
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(b3) the job loads and the port answers, but launchd does not report the serving pid -> NOT repaired; restored directly",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, `list-no-pid-${fx.label}`), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("is loaded but not running");
      expect(result.detail).toContain("Flair was restarted directly");
      expect(signals()).toContain(`SIGTERM ${pid}`);
      expect(await healthy()).toBe(true);
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      // The job this repair loaded was unloaded again.
      expect(existsSync(join(fx.state, "loaded", fx.label))).toBe(false);
    },
    120_000,
  );

  test.skipIf(!isDarwin)(
    "(c) a failure AFTER the stop (bootstrap fails) -> the instance is restarted directly and the result says so; plist restored",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, "bootstrap-fail", fx.label), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure // never "repaired"
      expect(result.detail).toContain("Bootstrap failed: 5: Input/output error");
      expect(result.detail).toContain("Restored:");
      expect(result.detail).toContain("Flair was restarted directly");
      expect(result.detail).toContain("NOT under launchd");
      expect(result.detail).toContain("the plist and config files were put back as they were");
      // The old process WAS stopped, and a new direct one serves the instance.
      expect(signals()).toContain(`SIGTERM ${pid}`);
      expect(await healthy()).toBe(true);
      const restoredPid = hdbPid();
      expect(restoredPid).not.toBeNull();
      expect(restoredPid).not.toBe(pid);
      expect(alive(restoredPid!)).toBe(true);
      // Files as they were before the repair.
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      // The bootstrap WAS attempted against the probed domain (this is a post-stop failure).
      expect(mutatingCalls()).toContain(`bootstrap ${GUI} ${fx.plistPath}`);
    },
    120_000,
  );
});

// ─── init: registerInitLaunchdService ─────────────────────────────────────

describe("flair#2040 — init never unloads a serving legacy job it cannot replace", () => {
  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /** A pre-flair#693 legacy registration for THIS data dir whose job serves the instance. */
  async function arrangeServingLegacyJob(): Promise<{ pid: number; legacyBytes: string }> {
    const legacyBytes = passFilePlist(LEGACY_LAUNCHD_LABEL);
    writeFileSync(legacyPlistPath(), legacyBytes);
    const pid = await startDirectStub();
    markLoaded(LEGACY_LAUNCHD_LABEL, pid); // launchd's legacy job IS the serving process
    return { pid, legacyBytes };
  }

  test.skipIf(!isDarwin)(
    "(d) a running legacy job + an unavailable domain -> NOTHING unloaded, removed or written",
    async () => {
      const { pid, legacyBytes } = await arrangeServingLegacyJob();
      writeFileSync(join(fx.state, "domain-code"), "125");

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("the launchd GUI domain is unavailable from this session");
      expect(text).toContain("Nothing was unloaded or removed");
      expect(text).not.toContain("✓");
      expect(mutatingCalls()).toEqual([]);
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(await healthy()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(d2) POSITIVE CONTROL: domain available -> the legacy job is replaced, and the replacement is loaded AND verified",
    async () => {
      const { pid } = await arrangeServingLegacyJob();

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "managed" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain(`Migrated launchd service off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${fx.label}`);
      expect(text).toContain("✓");
      expect(existsSync(legacyPlistPath())).toBe(false);
      expect(existsSync(fx.plistPath)).toBe(true);
      expect(signals()).toContain(`SIGTERM ${pid}`);
      const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
      expect(hdbPid()).toBe(managedPid);
      expect(await healthy()).toBe(true);
      const calls = mutatingCalls();
      expect(calls.indexOf(`bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`)).toBeLessThan(calls.indexOf(`bootstrap ${GUI} ${fx.plistPath}`));
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(d3) the replacement fails to load AFTER the legacy job was unloaded -> the legacy job is restored and verified; both plists as they were",
    async () => {
      const { pid, legacyBytes } = await arrangeServingLegacyJob();
      writeFileSync(join(fx.state, "bootstrap-fail", fx.label), "");

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "restored" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("failed after the legacy job was unloaded");
      expect(text).toContain(`Restored: the legacy job ${LEGACY_LAUNCHD_LABEL} is loaded again and serving`);
      expect(signals()).toContain(`SIGTERM ${pid}`);
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(mutatingCalls()).toContain(`bootstrap ${GUI} ${legacyPlistPath()}`);
      const legacyPid = Number(readFileSync(join(fx.state, "pid", LEGACY_LAUNCHD_LABEL), "utf-8"));
      expect(hdbPid()).toBe(legacyPid);
      expect(await healthy()).toBe(true);
    },
    120_000,
  );

  test.skipIf(!isDarwin)(
    "(d5) the replacement loads but launchd does not report it as the serving process -> NOT migrated; legacy restored",
    async () => {
      const { legacyBytes } = await arrangeServingLegacyJob();
      writeFileSync(join(fx.state, `list-no-pid-${fx.label}`), "");

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "restored" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).not.toContain("✓");
      expect(text).toContain("is loaded but not running");
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(await healthy()).toBe(true);
    },
    120_000,
  );

  test.skipIf(!isDarwin)(
    "(d4) no legacy job, instance running directly -> plist written, reported as running directly, NOT launchd-managed; no check mark, nothing loaded",
    async () => {
      const pid = await startDirectStub();
      writeFileSync(join(fx.state, "domain-code"), "125");

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "direct" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain(`Launchd plist written (${fx.plistPath})`);
      expect(text).toContain("Flair is running directly, NOT launchd-managed");
      // flair#1749: init names only a process it started — never the pid it found serving.
      expect(text).not.toContain(`pid ${pid}`);
      expect(text).toContain("the launchd GUI domain is unavailable from this session");
      expect(text).toContain("Launchd may also start the job at the next console login");
      expect(text).toContain("provided the plist is valid and the job is enabled");
      expect(text).not.toContain("✓");
      expect(text).not.toContain("loads at the next console login");
      expect(mutatingCalls()).toEqual([]);
      expect(alive(pid)).toBe(true);
    },
    60_000,
  );
});

// ─── what launchd does with that plist while the direct process serves ─────

describe("flair#2040 — a launchd start of the job while a DIRECT process serves the data dir", () => {
  /** Run the plist's ProgramArguments with its EnvironmentVariables — exactly what launchd execs. */
  function runAsLaunchd(plistPath: string): { status: number | null; stderr: string } {
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf-8" });
    const plist = JSON.parse(json.stdout);
    const [program, ...args] = plist.ProgramArguments as string[];
    const r = spawnSync(program, args, {
      cwd: plist.WorkingDirectory,
      env: plistLaunchEnv(plist),
      encoding: "utf-8",
      timeout: 10_000,
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  test.skipIf(!isDarwin)(
    "the launcher exits 0 without starting a second instance; once the direct process is gone, the same start serves",
    async () => {
      const pid = await startDirectStub();
      writeFileSync(join(fx.state, "domain-code"), "125");
      const { result } = await drive("init", initInput());
      expect(result).toMatchObject({ kind: "direct" }); // whole result printed on failure

      const startsBefore = stubStarts().length;
      const refused = runAsLaunchd(fx.plistPath);
      expect(refused.status).toBe(0);
      expect(refused.stderr).toContain(`hdb.pid names pid ${pid}, whose command line as ps reports it is node or bun followed by a Harper entry path`);
      expect(refused.stderr).toContain("not starting a second instance");
      // No second Harper ran: no new stub start, hdb.pid and the server unchanged.
      expect(stubStarts().length).toBe(startsBefore);
      expect(hdbPid()).toBe(pid);
      expect(await healthy()).toBe(true);

      // CONTROL: the direct process exits (as at a reboot or `flair stop`); the
      // very same launchd start now execs Harper.
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
      const json = spawnSync("plutil", ["-convert", "json", "-o", "-", fx.plistPath], { encoding: "utf-8" });
      const plist = JSON.parse(json.stdout);
      const [program, ...args] = plist.ProgramArguments as string[];
      const proc = Bun.spawn([program, ...args], {
        cwd: plist.WorkingDirectory,
        env: plistLaunchEnv(plist),
        stdout: "ignore",
        stderr: "ignore",
      });
      for (let i = 0; i < 100 && !(await healthy()); i++) await Bun.sleep(50);
      expect(await healthy()).toBe(true);
      expect(hdbPid()).toBe(proc.pid);
      expect(stubStarts().length).toBe(startsBefore + 1);
    },
    60_000,
  );
});

// ─── flair#2281: a stub the plist's launcher starts ends with its owner ─────

describe("flair#2281 — a stub started through the plist's launcher exits when its owner is gone", () => {
  test.skipIf(!isDarwin)(
    "the launcher execs a serving stub; end its owner and the stub exits",
    async () => {
      writeFileSync(fx.plistPath, passFilePlist(fx.label));
      const json = spawnSync("plutil", ["-convert", "json", "-o", "-", fx.plistPath], { encoding: "utf-8", timeout: 10_000 });
      const plist = JSON.parse(json.stdout);
      const [program, ...args] = plist.ProgramArguments as string[];
      // The owner stands in for the test runner: a shell blocked reading a pipe
      // this process holds. It exits when that pipe closes, so also when this
      // process does.
      const owner = Bun.spawn(["sh", "-c", "read -r line"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      const stderrPath = join(fx.home, "plist-stub.stderr");
      const stderrFd = openSync(stderrPath, "w");
      try {
        const stub = Bun.spawn([program, ...args], {
          cwd: plist.WorkingDirectory,
          env: plistLaunchEnv(plist, owner.pid),
          stdout: "ignore",
          stderr: stderrFd,
        });
        const stubStderr = () => readFileSync(stderrPath, "utf-8");
        for (let i = 0; i < 100 && !(await healthy()); i++) await Bun.sleep(50);
        expect(await healthy(), `the launched stub did not serve; its stderr:\n${stubStderr()}`).toBe(true);
        expect(hdbPid(), `hdb.pid does not name the launched process; its stderr:\n${stubStderr()}`).toBe(stub.pid);

        // End the owner by closing its pipe, and reap it: a zombie still answers kill(pid, 0).
        owner.stdin.end();
        await owner.exited;

        const exited = await Promise.race([stub.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        expect(exited, `the stub (pid ${stub.pid}) outlived its owner by 10 s; its stderr:\n${stubStderr()}`).toBe(true);
      } finally {
        closeSync(stderrFd);
        try { owner.stdin.end(); } catch { /* already closed */ }
      }
    },
    60_000,
  );
});

// ─── flair start (src/commands/service.ts) ────────────────────────────────

describe("flair#2040 — `flair start` claims launchd only after verifying it", () => {
  function writeRegisteredPlist(): void {
    writeFileSync(fx.plistPath, passFilePlist(fx.label));
  }

  test.skipIf(!isDarwin)(
    "(e) POSITIVE CONTROL: launchd starts the job and launchd's pid is the serving pid -> ✅ launchd-managed",
    async () => {
      writeRegisteredPlist();
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
      expect(stdout).toContain(`✅ Flair started (launchd-managed: launchd job ${fx.label} is running as process ${managedPid})`);
      expect(stderr).not.toContain("NOT verified");
      expect(mutatingCalls()).toContain(`bootstrap ${GUI} ${fx.plistPath}`);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e2) healthy port but launchd does not report the job's pid -> NO launchd check mark; says not verified",
    async () => {
      writeRegisteredPlist();
      writeFileSync(join(fx.state, "list-no-pid"), "");
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("✅ Flair started (launchd");
      expect(stderr).toContain("NOT verified as launchd-managed");
      expect(stderr).toContain(`is loaded but not running`);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e3) the domain is unavailable -> actor+state named, NO load attempted, direct start reported as running directly, NOT launchd-managed",
    async () => {
      writeRegisteredPlist();
      writeFileSync(join(fx.state, "domain-code"), "125");
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      expect(stderr).toContain("flair start: launchd cannot start this instance's job from this session");
      expect(stderr).toContain(`launchctl print ${GUI} exited 125`);
      expect(stderr).not.toContain("launchd start failed");
      expect(stdout).toMatch(/✅ Flair started on port \d+ — running directly \(pid \d+\), NOT launchd-managed\./);
      expect(stderr).toContain("run 'flair doctor --fix' from a console (GUI) login session");
      expect(stderr).toContain("provided the plist is valid and the job is enabled");
      expect(mutatingCalls()).toEqual([]);
      expect(await healthy()).toBe(true);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e4) the launchd load fails -> the job is unloaded again, the failure is named, and the direct start says it is NOT launchd-managed",
    async () => {
      writeRegisteredPlist();
      writeFileSync(join(fx.state, "bootstrap-fail", fx.label), "");
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      expect(stderr).toContain(`flair start: launchd could not start the job ${fx.label}`);
      expect(stderr).toContain("Bootstrap failed: 5: Input/output error");
      expect(stderr).not.toContain("launchd start failed");
      expect(stdout).toContain("NOT launchd-managed");
      // The fallback VERIFIED the job absent (a read-only print after the
      // failed load) before starting directly, and says so (flair#2040 r4).
      expect(stderr).toContain("The job was unloaded again (verified absent)");
      const lines = shimLines();
      expect(lines[lines.length - 1]).toBe(`print ${GUI}/${fx.label}`);
      expect(await healthy()).toBe(true);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e5) a running launchd job whose serving process cannot be attributed -> NO launchd check mark (strict verifier)",
    async () => {
      writeRegisteredPlist();
      writeFileSync(join(fx.state, "stub-no-pidfile"), "");
      writeFileSync(join(fx.shimBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      expect(await healthy()).toBe(true);
      expect(stdout).not.toContain("✅ Flair started (launchd");
      expect(stderr).toContain("NOT verified as launchd-managed");
      expect(stderr).toContain("could not be identified");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e6) the load fails and the loaded job's bootout FAILS -> the uncertainty is reported, no 'unloaded again', and NO direct start",
    async () => {
      writeRegisteredPlist();
      for (const flag of ["bootstrap-no-spawn", "kickstart-fail", "bootout-fail"]) writeFileSync(join(fx.state, flag, fx.label), "");
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`flair start: launchd could not start the job ${GUI}/${fx.label}`);
      expect(stderr).toContain("unloading it again could not be confirmed");
      expect(stderr).toContain("Flair was NOT started directly");
      expect(stderr).not.toContain("unloaded again (verified absent)");
      expect(stdout).not.toContain("Flair started");
      expect(stubStarts()).toEqual([]);
      expect(await healthy()).toBe(false);
    },
    90_000,
  );
});

// ─── flair restart's start leg (startFlairProcess) ────────────────────────

describe("flair#2040 — `flair restart` preflights launchd before its start leg", () => {
  test.skipIf(!isDarwin)(
    "(f) the domain is unavailable -> named before the direct start; no load attempted; the instance comes back and is reported as not under launchd",
    async () => {
      writeFileSync(fx.plistPath, passFilePlist(fx.label));
      const pid = await startDirectStub();
      writeFileSync(join(fx.state, "domain-code"), "125");

      const proc = Bun.spawn([process.execPath, join(fx.probe, "src", "cli.ts"), "restart", "--port", String(fx.port)], {
        cwd: fx.probe,
        env: childEnv(),
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stderr).toContain("flair: launchd cannot start this instance's job from this session");
      expect(stderr).toContain(`launchctl print ${GUI} exited 125`);
      expect(stderr).not.toContain("launchd start failed");
      expect(stdout).not.toContain("✅ Flair restarted");
      expect(stderr).toContain("NOT running under launchd");
      expect(shimLines().filter((l) => /^(bootstrap|kickstart|load|start)\b/.test(l))).toEqual([]);
      expect(signals()).toContain(`SIGTERM ${pid}`);
      expect(await healthy()).toBe(true);
      expect(hdbPid()).not.toBe(pid);
    },
    120_000,
  );
});

// ─── round 4: unknown evidence never licenses a stop or a success claim ────
//
// Every case below removes one piece of evidence — the serving pid, a
// readable prior plist, a lint run, a confirmed unload, a free port — and
// asserts the executor refuses (touching nothing) or reports the uncertainty,
// instead of reading the missing answer as "fine".

describe("flair#2040 r4 — doctor --fix: an unknown answer refuses before any stop", () => {
  async function arrangeDirectInstance(): Promise<{ pid: number; plistBytes: string }> {
    const plistBytes = passFilePlist(fx.label);
    writeFileSync(fx.plistPath, plistBytes);
    const pid = await startDirectStub();
    return { pid, plistBytes };
  }

  test.skipIf(!isDarwin)(
    "(a5) plutil cannot run (dies on a signal) -> preparation FAILS; nothing stopped",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.shimBin, "plutil"), "#!/bin/sh\nkill -KILL $$\n", { mode: 0o755 });

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("plutil -lint could not check the plist");
      expect(result.detail).toContain("Nothing was stopped or unloaded");
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(a6) an existing plist that cannot be read + a commit that would fail -> refused BEFORE the stop; the plist is never deleted",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, "bootstrap-fail", fx.label), "");
      chmodSync(fx.plistPath, 0o000);

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure
      expect(result.reason).toBe("unreadable-prior-state");
      expect(result.detail).toContain(`${fx.plistPath} (EACCES`);
      expect(existsSync(fx.plistPath)).toBe(true);
      chmodSync(fx.plistPath, 0o644);
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(b4) launchd runs the job but the serving process cannot be attributed -> refused (unverifiable), never 'already managed', nothing touched",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      markLoaded(fx.label, pid);
      makeServingUnattributable();

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure
      expect(result.reason).toBe("unverifiable");
      expect(result.detail).toContain("could not be identified");
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(b5) regenerate: the new job serves but cannot be attributed -> NOT 'repaired'; the job is unloaded again and the plist removed",
    async () => {
      writeFileSync(join(fx.state, "stub-no-pidfile"), "");
      writeFileSync(join(fx.shimBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("could not be identified");
      expect(result.detail).toContain("Restored:");
      expect(result.detail).toContain("unloaded again (verified absent)");
      expect(result.detail).toContain("Flair was not running before this repair (its port was free)");
      expect(mutatingCalls()).toContain(`bootstrap ${GUI} ${fx.plistPath}`);
      expect(existsSync(join(fx.state, "loaded", fx.label))).toBe(false);
      expect(existsSync(fx.plistPath)).toBe(false);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(b6) a loaded job whose bootout FAILS -> stop here, BEFORE the direct process is touched; the result says so",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      markLoaded(fx.label, null);
      writeFileSync(join(fx.state, "bootout-fail", fx.label), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("could not unload the loaded job before stopping anything");
      expect(result.detail).toContain("the job is still loaded");
      expect(result.detail).toContain("this repair did not stop the running instance");
      expect(result.detail).not.toContain("is not loaded in this session now");
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls().filter((l) => l.startsWith("bootstrap"))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(b8) whether the job is loaded cannot be read -> refused before anything is unloaded or stopped",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, "print-fail", fx.label), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure
      expect(result.reason).toBe("unverifiable");
      expect(result.detail).toContain("could not say whether the job is loaded");
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(b9) after the stop, the new job is not verified AND cannot be unloaded -> NOT restarted directly (it could race the job); the result says so",
    async () => {
      const { pid } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, `list-no-pid-${fx.label}`), "");
      writeFileSync(join(fx.state, "bootout-fail", fx.label), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("the job this repair loaded could not be shown unloaded");
      expect(result.detail).toContain("Flair was NOT restarted directly");
      expect(result.remedy).toContain(`launchctl bootout ${GUI}/${fx.label}`);
      expect(signals()).toContain(`SIGTERM ${pid}`);
      // Two stub starts only: the direct instance and launchd's job — no third, direct restart.
      expect(stubStarts().length).toBe(2);
    },
    120_000,
  );

  test.skipIf(!isDarwin)(
    "(b7) regenerate: no serving process identified, but the port answers -> refused; 'none identified' is not 'none'",
    async () => {
      const pid = await startDirectStub();
      makeServingUnattributable();

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "refused" }); // whole result printed on failure
      expect(result.reason).toBe("unverifiable");
      expect(result.detail).toContain(`port ${fx.port} is not free`);
      expect(alive(pid)).toBe(true);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );
});

describe("flair#2040 r4 — init: a legacy job not PROVEN idle is never booted out", () => {
  test.skipIf(!isDarwin)(
    "(d7) a loaded, running legacy job + no attributable serving process (no hdb.pid, no lsof) -> skipped; nothing unloaded, removed or written",
    async () => {
      const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
      const legacyBytes = passFilePlist(LEGACY_LAUNCHD_LABEL);
      writeFileSync(legacyPath, legacyBytes);
      const pid = await startDirectStub();
      markLoaded(LEGACY_LAUNCHD_LABEL, pid);
      makeServingUnattributable();

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("may be the process serving this instance");
      expect(text).toContain("could not be identified");
      expect(text).not.toContain("✓");
      expect(mutatingCalls()).toEqual([]);
      expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(d8) whether the legacy job is loaded cannot be read -> skipped; nothing unloaded, removed or written",
    async () => {
      const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
      const legacyBytes = passFilePlist(LEGACY_LAUNCHD_LABEL);
      writeFileSync(legacyPath, legacyBytes);
      const pid = await startDirectStub();
      writeFileSync(join(fx.state, "print-fail", LEGACY_LAUNCHD_LABEL), "");

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("could not say whether it is loaded");
      expect(mutatingCalls()).toEqual([]);
      expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(alive(pid)).toBe(true);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(d6) no legacy job; launchd runs the new job but the serving process cannot be attributed -> 'NOT verified', no check mark",
    async () => {
      const pid = await startDirectStub();
      markLoaded(fx.label, pid);
      makeServingUnattributable();

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "unverified" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("launchd management is NOT verified");
      expect(text).not.toContain("✓");
      expect(mutatingCalls()).toEqual([]);
      expect(alive(pid)).toBe(true);
    },
    60_000,
  );
});

// ─── round 5: no check mark before the verifier, no plist lost to a failure ─

describe("flair#2040 r5 — init: an idle legacy job that cannot be shown unloaded keeps its plist", () => {
  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /** An owned legacy registration whose job is loaded but runs no process (idle), and whose bootout fails. */
  async function arrangeIdleLegacyWhoseBootoutFails(): Promise<{ pid: number; legacyBytes: string }> {
    const legacyBytes = passFilePlist(LEGACY_LAUNCHD_LABEL);
    writeFileSync(legacyPlistPath(), legacyBytes);
    const pid = await startDirectStub();
    markLoaded(LEGACY_LAUNCHD_LABEL, null);
    writeFileSync(join(fx.state, "bootout-fail", LEGACY_LAUNCHD_LABEL), "");
    return { pid, legacyBytes };
  }

  test.skipIf(!isDarwin)(
    "(d9) loaded-idle legacy job + bootout fails -> 'uncertain' (init exits 1); legacy plist kept byte-for-byte; the new plist removed again; no check mark",
    async () => {
      const { pid, legacyBytes } = await arrangeIdleLegacyWhoseBootoutFails();

      const { result, stdout, stderr } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "uncertain" }); // whole result printed on failure // init exits 1 on uncertain
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain(`the legacy job ${LEGACY_LAUNCHD_LABEL} could not be shown unloaded`);
      expect(text).toContain(`Its plist at ${legacyPlistPath()} was left in place`);
      expect(text).toContain(`the new plist ${fx.plistPath} was removed again`);
      expect(text).toContain(`launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expect(text).not.toContain("Launchd service registered");
      expect(`${text}\n${stdout}\n${stderr}`).not.toContain("✓");
      // Both plist states: the legacy plist as it was, the new one as it was (absent).
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacyBytes);
      expect(existsSync(fx.plistPath)).toBe(false);
      // The one mutating call was the failed bootout; nothing was loaded.
      expect(mutatingCalls()).toEqual([`bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`]);
      expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
      // The idle job was not the serving process: the direct instance still serves.
      expect(alive(pid)).toBe(true);
      expect(signals()).toBe("");
      expect(await healthy()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(d9b) same, with a prior plist at the new path that init rewrote -> that plist is put back byte-for-byte",
    async () => {
      const { legacyBytes } = await arrangeIdleLegacyWhoseBootoutFails();
      // Ours (ROOTPATH is this data dir), but not the pass-file launcher shape,
      // so init rewrites it.
      const launcher = join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh");
      const priorBytes = passFilePlist(fx.label).replace(`<string>${launcher}</string>`, "<string>/usr/bin/true</string>");
      expect(priorBytes).not.toBe(passFilePlist(fx.label));
      writeFileSync(fx.plistPath, priorBytes);

      const { result } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "uncertain" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain(`the prior plist bytes and mode at ${fx.plistPath} were restored`);
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(priorBytes);
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacyBytes);
      expect(mutatingCalls().filter((l) => l.startsWith("bootstrap"))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(d10) an owned legacy plist whose job is not loaded, Flair running directly -> retired with NO check mark; reported as running directly",
    async () => {
      const legacyBytes = passFilePlist(LEGACY_LAUNCHD_LABEL);
      writeFileSync(legacyPlistPath(), legacyBytes);
      const pid = await startDirectStub();

      const { result, stdout, stderr } = await drive("init", initInput());

      expect(result).toMatchObject({ kind: "direct" }); // whole result printed on failure
      const text = result.lines.map((l: any) => l.text).join("\n");
      expect(text).toContain("Flair is running directly, NOT launchd-managed");
      expect(stdout).toContain("Retired the legacy launchd plist");
      expect(`${text}\n${stdout}\n${stderr}`).not.toContain("✓");
      expect(existsSync(legacyPlistPath())).toBe(false);
      expect(existsSync(fx.plistPath)).toBe(true);
      expect(mutatingCalls()).toEqual([]);
      expect(alive(pid)).toBe(true);
    },
    60_000,
  );
});

describe("flair#2040 r5 — `flair start`: the legacy migration's check mark only after the strict verifier", () => {
  function writeLegacyPlist(): void {
    writeFileSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir), passFilePlist(LEGACY_LAUNCHD_LABEL));
  }

  test.skipIf(!isDarwin)(
    "(e7) legacy plist migrated and loaded, but launchd does not report the serving pid -> NO check mark anywhere; 'NOT verified'",
    async () => {
      writeLegacyPlist();
      writeFileSync(join(fx.state, `list-no-pid-${fx.label}`), "");
      const { stdout, stderr, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      expect(stderr).toContain("NOT verified as launchd-managed");
      expect(stderr).toContain(`moved off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${fx.label}`);
      expect(`${stdout}\n${stderr}`).not.toContain("✓");
      expect(stdout).not.toContain("✅ Flair started (launchd");
      // The migration itself did happen.
      expect(existsSync(launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir))).toBe(false);
      expect(existsSync(fx.plistPath)).toBe(true);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e8) POSITIVE CONTROL: legacy plist migrated and launchd's pid is the serving pid -> the migration check mark and ✅ launchd-managed",
    async () => {
      writeLegacyPlist();
      const { stdout, exitCode } = await flairStart();
      expect(exitCode).toBe(0);
      const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
      expect(stdout).toContain(`Migrated launchd service off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${fx.label} ✓`);
      expect(stdout).toContain(`✅ Flair started (launchd-managed: launchd job ${fx.label} is running as process ${managedPid})`);
    },
    90_000,
  );
});

describe("flair#2040 r5 — `flair start`: a malformed legacy plist is refused before anything is unloaded", () => {
  test.skipIf(!isDarwin)(
    "(e9) the legacy plist keeps its Label but is not a valid plist -> the default plutil -lint refuses the migration; nothing unloaded, written or removed; Flair started directly",
    async () => {
      const legacyPath = launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
      const malformed = passFilePlist(LEGACY_LAUNCHD_LABEL).replace("</array>", "");
      expect(malformed).toContain(`<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`);
      expect(malformed).not.toContain("</array>");
      writeFileSync(legacyPath, malformed);

      const { stdout, stderr, exitCode } = await flairStart();

      expect(exitCode).toBe(0);
      expect(stderr).toContain("not migrating off the legacy launchd label: the replacement plist");
      expect(stderr).toContain("plutil -lint rejected the plist");
      // Nothing was unloaded or loaded: only read-only presence probes reached launchctl.
      expect(mutatingCalls()).toEqual([]);
      // The legacy plist is as it was, and no replacement was written.
      expect(readFileSync(legacyPath, "utf-8")).toBe(malformed);
      expect(existsSync(fx.plistPath)).toBe(false);
      expect(`${stdout}\n${stderr}`).not.toContain("✓");
      expect(stdout).toContain("NOT launchd-managed");
      expect(await healthy()).toBe(true);
    },
    90_000,
  );
});

describe("flair#2040 r5 — doctor --fix: a failed repair puts a corrupt plist back byte-for-byte", () => {
  test.skipIf(!isDarwin)(
    "(c2) a plist with invalid UTF-8 bytes + a bootstrap that fails after the write -> failed; the file's bytes are identical to before",
    async () => {
      // Invalid UTF-8 (0xff 0xfe, a lone continuation byte, a truncated
      // sequence): a corrupt plist is repairable (regenerate), and decoding it
      // as UTF-8 would replace these bytes.
      const corrupt = Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x3c, 0x70, 0x6c, 0x80, 0xc3, 0x28, 0x0a]),
        Buffer.from("not a plist\n", "utf-8"),
        Buffer.from([0xe2, 0x82]),
      ]);
      writeFileSync(fx.plistPath, corrupt);
      writeFileSync(join(fx.state, "bootstrap-fail", fx.label), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "failed" }); // whole result printed on failure
      expect(result.detail).toContain("Bootstrap failed: 5: Input/output error");
      expect(result.detail).toContain("the plist and config files were put back as they were");
      // The repair did write its plist (the failure is after the write) ...
      expect(mutatingCalls()).toContain(`bootstrap ${GUI} ${fx.plistPath}`);
      // ... and the restore put the ORIGINAL bytes back, not a decoded copy.
      const after = readFileSync(fx.plistPath);
      expect(after.length).toBe(corrupt.length);
      expect(Buffer.compare(after, corrupt)).toBe(0);
    },
    90_000,
  );
});

describe("flair#2040 r6 — doctor --fix waits for the job it loaded to START before judging it", () => {
  // A real launchd job has not bound its port or written hdb.pid when
  // `kickstart` returns (flair#1827). Judging that first observation strictly
  // reported every real hand-off as a failure and unloaded the job again —
  // leaving nothing serving (the macOS runner's real-launchd lane, round 4+).
  const SLOW_START_MS = 1_500;

  test.skipIf(!isDarwin)(
    "(r6a) regenerate: the job binds and writes hdb.pid 1.5 s after kickstart -> repaired and serving; not unloaded",
    async () => {
      writeFileSync(join(fx.state, "stub-start-delay"), String(SLOW_START_MS));

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "repaired" }); // whole result printed on failure
      const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
      expect(result.detail).toContain(`is running as process ${managedPid}`);
      expect(hdbPid()).toBe(managedPid);
      expect(alive(managedPid)).toBe(true);
      expect(await healthy()).toBe(true);
      expect(existsSync(fx.plistPath)).toBe(true);
      expect(existsSync(join(fx.state, "loaded", fx.label))).toBe(true);
      // Loaded once, never booted out after the load.
      const verbs = mutatingCalls();
      expect(verbs.filter((l) => l.startsWith("bootstrap"))).toEqual([`bootstrap ${GUI} ${fx.plistPath}`]);
      expect(verbs.slice(verbs.indexOf(`kickstart ${GUI}/${fx.label}`)).filter((l) => l.startsWith("bootout"))).toEqual([]);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(r6b) adopt: the job binds and writes hdb.pid 1.5 s after kickstart -> adopted, and the direct process is not restarted",
    async () => {
      writeFileSync(fx.plistPath, passFilePlist(fx.label));
      const directPid = await startDirectStub();
      writeFileSync(join(fx.state, "stub-start-delay"), String(SLOW_START_MS));

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result).toMatchObject({ kind: "repaired" }); // whole result printed on failure
      expect(result.detail).toContain("adopted the direct-spawned instance into launchd");
      expect(signals()).toContain(`SIGTERM ${directPid}`);
      const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
      expect(managedPid).not.toBe(directPid);
      expect(hdbPid()).toBe(managedPid);
      expect(await healthy()).toBe(true);
      // The direct stub and launchd's job only: no direct restart by a restore.
      expect(stubStarts()).toEqual([directPid, managedPid]);
    },
    90_000,
  );
});

// ─── round 7: a validation refusal never unloads a loaded legacy job ───────
//
// Both start paths — `flair start`, and startFlairProcess (the start leg of
// restart / upgrade / snapshot, driven here without their stop leg) — used to
// answer ANY failed launchd attempt by booting out every job for the instance,
// the legacy one included. A plist that fails validation loaded nothing and
// unloaded nothing, so a loaded (idle) legacy job was then booted out by the
// failure handler of a check that had refused to touch it.

describe("flair#2040 r7 — a failed validation leaves a loaded legacy job and both plists untouched (both start paths)", () => {
  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /** A malformed legacy plist that still carries its Label; `loaded` marks its job loaded and idle (no pid). */
  function arrangeMalformedLegacy(loaded: boolean): string {
    const malformed = passFilePlist(LEGACY_LAUNCHD_LABEL).replace("</array>", "");
    expect(malformed).toContain(`<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`);
    expect(malformed).not.toContain("</array>");
    writeFileSync(legacyPlistPath(), malformed);
    if (loaded) markLoaded(LEGACY_LAUNCHD_LABEL, null);
    return malformed;
  }

  function expectUntouched(malformed: string): void {
    // Zero launchctl calls that change launchd's state ...
    expect(mutatingCalls()).toEqual([]);
    // ... the legacy plist byte-for-byte, no replacement written ...
    expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(malformed);
    expect(existsSync(fx.plistPath)).toBe(false);
  }

  test.skipIf(!isDarwin)(
    "(e10) `flair start`: LOADED-IDLE legacy job + malformed replacement -> refused (exit 1), zero mutating calls, the legacy job still loaded, nothing started, the bootout remedy named",
    async () => {
      const malformed = arrangeMalformedLegacy(true);

      const { stdout, stderr, exitCode } = await flairStart();

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`flair start: did not load the launchd job ${fx.label}`);
      expect(stderr).toContain("plutil -lint rejected the plist");
      expect(stderr).toContain(`${GUI}/${LEGACY_LAUNCHD_LABEL} is loaded`);
      expect(stderr).toContain("Flair was NOT started directly");
      expect(stderr).toContain(`launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expect(stderr).not.toContain("unloaded again");
      expectUntouched(malformed);
      // The job was READ (a presence probe), never booted out.
      expect(shimLines()).toContain(`print ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
      expect(stubStarts()).toEqual([]);
      expect(await healthy()).toBe(false);
      expect(`${stdout}\n${stderr}`).not.toContain("✓");
      expect(stdout).not.toContain("Flair started");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(f2) start leg (startFlairProcess): LOADED-IDLE legacy job + malformed replacement -> throws, zero mutating calls, the legacy job still loaded, nothing started",
    async () => {
      const malformed = arrangeMalformedLegacy(true);

      const { result, stdout } = await drive("startleg", { dataDir: fx.dataDir, port: fx.port });

      expect(result.started).toBe(false); // whole result printed on failure
      expect(result.error).toContain(`flair: did not load the launchd job ${fx.label}`);
      expect(result.error).toContain("plutil -lint rejected the plist");
      expect(result.error).toContain(`${GUI}/${LEGACY_LAUNCHD_LABEL} is loaded`);
      expect(result.error).toContain("Flair was NOT started directly");
      expect(result.error).toContain(`launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expectUntouched(malformed);
      expect(shimLines()).toContain(`print ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
      expect(stubStarts()).toEqual([]);
      expect(await healthy()).toBe(false);
      expect(stdout).not.toContain("✓");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(f3) POSITIVE CONTROL, start leg: the same malformed replacement with NO job loaded -> jobs verified absent by read-only probes, zero mutating calls, Flair started directly",
    async () => {
      const malformed = arrangeMalformedLegacy(false);

      const { result, stderr } = await drive("startleg", { dataDir: fx.dataDir, port: fx.port });

      expect(result.started).toBe(true); // whole result printed on failure
      expect(stderr).toContain(`flair: did not load the launchd job ${fx.label}`);
      expect(stderr).toContain("plutil -lint rejected the plist");
      expect(stderr).toContain("(verified absent); starting Flair directly instead");
      expectUntouched(malformed);
      // The absence was READ for both labels before the direct start.
      expect(shimLines()).toContain(`print ${GUI}/${fx.label}`);
      expect(shimLines()).toContain(`print ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
      expect(await healthy()).toBe(true);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e11) `flair start`: a stale plist (missing launcher) whose job is LOADED and idle -> refused (exit 1), zero mutating calls, the plist unchanged, nothing started",
    async () => {
      const stale = passFilePlist(fx.label).replace(
        join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh"),
        join(fx.home, "gone", "start-flair-with-admin-pass.sh"),
      );
      expect(stale).toContain(join(fx.home, "gone"));
      writeFileSync(fx.plistPath, stale);
      markLoaded(fx.label, null);

      const { stdout, stderr, exitCode } = await flairStart();

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`flair start: did not load the launchd job ${fx.label}`);
      expect(stderr).toContain("which no longer exists");
      expect(stderr).toContain(`${GUI}/${fx.label} is loaded`);
      expect(stderr).toContain("Flair was NOT started directly");
      expect(mutatingCalls()).toEqual([]);
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(stale);
      expect(existsSync(join(fx.state, "loaded", fx.label))).toBe(true);
      expect(stubStarts()).toEqual([]);
      expect(stdout).not.toContain("Flair started");
    },
    90_000,
  );
});

describe("flair#2040 r7 — doctor --fix: a pid file is not a serving port", () => {
  test.skipIf(!isDarwin)(
    "(r7a) regenerate: the job writes hdb.pid AT ONCE and binds 1.5 s later -> 'repaired' only once the port serves",
    async () => {
      writeFileSync(join(fx.state, "stub-start-delay"), "1500");
      writeFileSync(join(fx.state, "stub-pidfile-first"), "");

      const run = await drive("repair", { dataDir: fx.dataDir, port: fx.port, probeServingAtReturn: true });

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "repaired" });
        // The fixture really was pid-file-before-bind ...
        expect(readFileSync(join(fx.dataDir, "stub-events.log"), "utf-8").split("\n").filter(Boolean)).toEqual(["pidfile", "bound"]);
        // ... and doctor returned 'repaired' only when the port was serving
        // (the ops socket was up from the start, so nothing else held it back).
        expect(run.stdout).toContain("SERVING_AT_RETURN true");
        const managedPid = Number(readFileSync(join(fx.state, "pid", fx.label), "utf-8"));
        expect(run.result.detail).toContain(`is running as process ${managedPid}`);
        expect(hdbPid()).toBe(managedPid);
        // Loaded once, never booted out after the load.
        const verbs = mutatingCalls();
        expect(verbs.filter((l) => l.startsWith("bootstrap"))).toEqual([`bootstrap ${GUI} ${fx.plistPath}`]);
        expect(verbs.slice(verbs.indexOf(`kickstart ${GUI}/${fx.label}`)).filter((l) => l.startsWith("bootout"))).toEqual([]);
      });
    },
    90_000,
  );
});

// ─── init: the plist writer's flair#2034 outcomes under flair#2040's verifier ─
//
// flair#2044 (merged into main) gave init's plist writer two new outcomes — a
// re-point of an adopted plist's runtime paths, and a refusal to re-point
// ("not re-pointed") — plus a deliberate-node-pin note on "unchanged". The
// flair#2040 step reports every one of them, and a check mark only when launchd
// is verified to run the serving process.

describe("flair#2040 × flair#2034 — init reports the plist writer's outcome; a check mark only when verified", () => {
  /** An executable file named `node`. Never run: only its path and identity matter to the planner. */
  function nodeBinary(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "node");
    writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return p;
  }

  /** An adopted pass-file plist for THIS instance, running `harperBin` from `tree` under `nodeBin`. */
  function adoptedPlist(tree: string, nodeBin: string, harperBin: string): string {
    return buildLaunchdPlist({
      label: fx.label,
      execPath: nodeBin,
      harperBinPath: harperBin,
      workingDirectory: tree,
      dataDir: fx.dataDir,
      modelsDir: join(fx.dataDir, "models"),
      setConfig: "{}",
      adminUser: "admin",
      httpPort: fx.port,
      opsNetworkPort: `127.0.0.1:${fx.port + 1}`,
      passFile: {
        launcher: join(tree, "templates", "launchd", "start-flair-with-admin-pass.sh"),
        adminPassFile: join(fx.home, ".flair", "admin-pass"),
        home: fx.home,
        path: process.env.PATH ?? "/usr/bin:/bin",
      },
    });
  }

  /** A flair install tree (launcher + Harper entry) at `tree`; `version` adds its package.json. */
  function installTree(tree: string, version?: string): { tree: string; harper: string } {
    const harper = join(tree, "node_modules", "harper", "dist", "bin", "harper.js");
    mkdirSync(join(tree, "templates", "launchd"), { recursive: true });
    mkdirSync(join(tree, "node_modules", "harper", "dist", "bin"), { recursive: true });
    writeFileSync(join(tree, "templates", "launchd", "start-flair-with-admin-pass.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(harper, "");
    if (version) writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version }));
    return { tree, harper };
  }

  /** init's input with this CLI's runtime a `node` binary (the re-point planner accepts only one). */
  function initInputWithNode(cliNode: string) {
    const input = initInput();
    input.write.execPath = cliNode;
    return input;
  }

  function texts(result: any, stream?: "out" | "err"): string[] {
    return (result.lines as Array<{ stream: string; text: string }>)
      .filter((l) => stream === undefined || l.stream === stream)
      .map((l) => l.text);
  }

  /** A plist serving an npm-global tree of flair 0.56.0, with this CLI's probe tree at 0.57.0. */
  function arrangeRepointable(): { oldTree: string; cliNode: string } {
    writeFileSync(join(fx.probe, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.57.0" }));
    const old = installTree(join(fx.home, "oldprefix", "lib", "node_modules", "@tpsdev-ai", "flair"), "0.56.0");
    const oldNode = nodeBinary(join(fx.home, "oldnode", "bin"));
    const cliNode = nodeBinary(join(fx.home, "clinode", "bin"));
    writeFileSync(fx.plistPath, adoptedPlist(old.tree, oldNode, old.harper));
    return { oldTree: old.tree, cliNode };
  }

  test.skipIf(!isDarwin)(
    "(m1) a deliberate node pin while Flair runs directly -> 'NOT launchd-managed', the pin's hand edit, no check mark",
    async () => {
      const pinned = nodeBinary(join(fx.home, "pinned", "bin"));
      const cliNode = nodeBinary(join(fx.home, "clinode", "bin"));
      const bytes = adoptedPlist(fx.probe, pinned, fx.stubHarper);
      writeFileSync(fx.plistPath, bytes);
      await startDirectStub();

      const run = await drive("init", initInputWithNode(cliNode));

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "direct" });
        const text = texts(run.result).join("\n");
        expect(text).toContain(`Launchd plist unchanged (${fx.plistPath}) — Flair is running directly, NOT launchd-managed`);
        expect(text).toContain(`serves this CLI's tree with node ${pinned}`);
        expect(text).toContain(`change that node path to ${cliNode} by hand`);
        expect(text).not.toContain("✓");
        expect(readFileSync(fx.plistPath, "utf-8")).toBe(bytes);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(m2) POSITIVE CONTROL: the same pin, launchd's pid = the serving pid -> 'already managed' ✓, then the pin",
    async () => {
      const pinned = nodeBinary(join(fx.home, "pinned", "bin"));
      const cliNode = nodeBinary(join(fx.home, "clinode", "bin"));
      writeFileSync(fx.plistPath, adoptedPlist(fx.probe, pinned, fx.stubHarper));
      const pid = await startDirectStub();
      markLoaded(fx.label, pid);

      const run = await drive("init", initInputWithNode(cliNode));

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "managed" });
        const out = texts(run.result, "out");
        expect(out[0]).toBe(
          `Launchd service already managed — plist unchanged; launchd job ${fx.label} is running as process ${pid} ✓`,
        );
        expect(out[1]).toContain(`serves this CLI's tree with node ${pinned}`);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(m3) a plist serving a plain (not npm-global) tree is not re-pointed -> the refusal on stderr, no write, no check mark",
    async () => {
      const plain = installTree(join(fx.home, "plain-tree"));
      const oldNode = nodeBinary(join(fx.home, "oldnode", "bin"));
      const cliNode = nodeBinary(join(fx.home, "clinode", "bin"));
      const bytes = adoptedPlist(plain.tree, oldNode, plain.harper);
      writeFileSync(fx.plistPath, bytes);
      await startDirectStub();

      const run = await drive("init", initInputWithNode(cliNode));

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "direct" });
        const err = texts(run.result, "err").join("\n");
        expect(err).toContain(
          `Launchd service left unchanged — the launchd plist ${fx.plistPath} serves ${plain.tree}, which is not an npm-global install`,
        );
        const text = texts(run.result).join("\n");
        expect(text).toContain(`Launchd plist unchanged (${fx.plistPath}) — Flair is running directly, NOT launchd-managed`);
        expect(text).not.toContain("✓");
        expect(readFileSync(fx.plistPath, "utf-8")).toBe(bytes);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(m4) a plist serving another npm-global tree is re-pointed while Flair runs directly -> what changed, 'flair restart', no check mark",
    async () => {
      const { oldTree, cliNode } = arrangeRepointable();
      await startDirectStub();

      const run = await drive("init", initInputWithNode(cliNode));

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "direct" });
        const text = texts(run.result).join("\n");
        expect(text).toContain(`Launchd plist re-pointed at this CLI's install tree (re-pointed the launchd plist ${fx.plistPath} (`);
        expect(text).toContain("Flair is running directly, NOT launchd-managed");
        expect(text).toContain("It takes effect when launchd next starts the service: flair restart");
        expect(text).not.toContain("✓");
        const after = readFileSync(fx.plistPath, "utf-8");
        expect(after).toContain(`<string>${fx.probe}</string>`);
        expect(after).toContain(`<string>${cliNode}</string>`);
        expect(after).not.toContain(oldTree);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(m5) POSITIVE CONTROL: the same re-point, launchd's pid = the serving pid -> 're-pointed' ✓ with the verifier's detail, then 'flair restart'",
    async () => {
      const { cliNode } = arrangeRepointable();
      const pid = await startDirectStub();
      markLoaded(fx.label, pid);

      const run = await drive("init", initInputWithNode(cliNode));

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "managed" });
        const out = texts(run.result, "out");
        expect(out[0]).toStartWith(`Launchd service re-pointed at this CLI's install tree — re-pointed the launchd plist ${fx.plistPath} (`);
        expect(out[0]).toEndWith(`; launchd job ${fx.label} is running as process ${pid} ✓`);
        expect(out[1]).toBe("  It takes effect when launchd next starts the service: flair restart");
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );
});

// ─── round 8: a lint that THROWS is a validation refusal too ────────────────
//
// Round 7 made a lint that RETURNED a problem a validation refusal. A lint can
// also THROW: the default one creates, writes and removes a temporary copy of
// the plist, and any of those can fail. A thrown error reached the start paths'
// failed-LOAD handling, which boots every job for the instance out — the loaded
// legacy job included — for a check that had refused to touch it.

describe("flair#2040 r8 — a lint that throws leaves a loaded legacy job and both plists untouched (both start paths)", () => {
  const LINT_THROWS = "injected lint failure (flair#2040 r8)";

  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /**
   * A WELL-FORMED legacy plist whose paths all exist (so only the lint's own
   * failure stops the migration), and its job loaded and idle (no pid).
   */
  function arrangeLoadedLegacy(): string {
    const plist = passFilePlist(LEGACY_LAUNCHD_LABEL);
    expect(plist).toContain(`<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`);
    writeFileSync(legacyPlistPath(), plist);
    markLoaded(LEGACY_LAUNCHD_LABEL, null);
    return plist;
  }

  /** A TMPDIR that does not exist: the default lint cannot create its temporary copy. */
  function missingTmpdir(): Record<string, string> {
    const dir = join(fx.home, "no-such-tmp");
    expect(existsSync(dir)).toBe(false);
    return { TMPDIR: dir };
  }

  function expectLegacyUntouched(plist: string): void {
    // Zero launchctl calls that change launchd's state ...
    expect(mutatingCalls()).toEqual([]);
    // ... the legacy plist byte-for-byte, no replacement written ...
    expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(plist);
    expect(existsSync(fx.plistPath)).toBe(false);
    // ... and the legacy job READ (a presence probe), still loaded, nothing started.
    expect(shimLines()).toContain(`print ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
    expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
    expect(stubStarts()).toEqual([]);
  }

  function expectStartRefused(stderr: string, actorLine: string, lintDetail: string): void {
    expect(stderr).toContain(actorLine);
    expect(stderr).toContain(`could not be validated (the lint failed: ${lintDetail}`);
    expect(stderr).toContain("Nothing was loaded or unloaded");
    expect(stderr).toContain(`${GUI}/${LEGACY_LAUNCHD_LABEL} is loaded`);
    expect(stderr).toContain("Flair was NOT started directly");
    expect(stderr).toContain(`launchctl bootout ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
    expect(stderr).not.toContain("unloaded again");
  }

  test.skipIf(!isDarwin)(
    "(e12) `flair start`: LOADED-IDLE legacy job + an injected lint that THROWS -> refused (exit 1), zero mutating calls, the legacy job still loaded, nothing started",
    async () => {
      const plist = arrangeLoadedLegacy();

      const { stdout, stderr, exitCode } = await flairStart({ lintThrows: LINT_THROWS });

      expect(exitCode).toBe(1);
      expectStartRefused(stderr, `flair start: did not load the launchd job ${fx.label}`, LINT_THROWS);
      expectLegacyUntouched(plist);
      expect(await healthy()).toBe(false);
      expect(`${stdout}\n${stderr}`).not.toContain("✓");
      expect(stdout).not.toContain("Flair started");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(e13) `flair start`: LOADED-IDLE legacy job + the DEFAULT lint unable to create its temporary file -> refused (exit 1), zero mutating calls, the legacy job still loaded, nothing started",
    async () => {
      const plist = arrangeLoadedLegacy();

      const { stdout, stderr, exitCode } = await flairStart({ envOverride: missingTmpdir() });

      expect(exitCode).toBe(1);
      expectStartRefused(stderr, `flair start: did not load the launchd job ${fx.label}`, "ENOENT");
      expect(stderr).toContain("mkdtemp");
      expectLegacyUntouched(plist);
      expect(await healthy()).toBe(false);
      expect(`${stdout}\n${stderr}`).not.toContain("✓");
      expect(stdout).not.toContain("Flair started");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(f4) start leg (startFlairProcess): LOADED-IDLE legacy job + an injected lint that THROWS -> throws, zero mutating calls, the legacy job still loaded, nothing started",
    async () => {
      const plist = arrangeLoadedLegacy();

      const { result, stdout } = await drive("startleg", { dataDir: fx.dataDir, port: fx.port, lintThrows: LINT_THROWS });

      expect(result.started).toBe(false);
      expectStartRefused(result.error, `flair: did not load the launchd job ${fx.label}`, LINT_THROWS);
      expectLegacyUntouched(plist);
      expect(await healthy()).toBe(false);
      expect(stdout).not.toContain("✓");
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(f5) start leg (startFlairProcess): LOADED-IDLE legacy job + the DEFAULT lint unable to create its temporary file -> throws, zero mutating calls, the legacy job still loaded, nothing started",
    async () => {
      const plist = arrangeLoadedLegacy();

      const { result, stdout } = await drive("startleg", { dataDir: fx.dataDir, port: fx.port }, missingTmpdir());

      expect(result.started).toBe(false);
      expectStartRefused(result.error, `flair: did not load the launchd job ${fx.label}`, "ENOENT");
      expect(result.error).toContain("mkdtemp");
      expectLegacyUntouched(plist);
      expect(await healthy()).toBe(false);
      expect(stdout).not.toContain("✓");
    },
    90_000,
  );
});

describe("flair#2078 — init: a lint that throws puts back the plist init wrote beside the legacy one", () => {
  const LINT_THROWS = "injected lint failure (flair#2078)";

  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /**
   * A WELL-FORMED legacy plist for THIS data dir whose paths all exist (so only
   * the lint's own failure stops init), and its job loaded and idle (no pid).
   */
  function arrangeLoadedLegacy(): string {
    const plist = passFilePlist(LEGACY_LAUNCHD_LABEL);
    expect(plist).toContain(`<key>Label</key><string>${LEGACY_LAUNCHD_LABEL}</string>`);
    writeFileSync(legacyPlistPath(), plist);
    markLoaded(LEGACY_LAUNCHD_LABEL, null);
    return plist;
  }

  /**
   * A prior plist at the new path that init REWRITES: ours (ROOTPATH is this
   * data dir), but not the pass-file launcher shape.
   */
  function arrangePriorNewPlist(): string {
    const launcher = join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh");
    const prior = passFilePlist(fx.label).replace(`<string>${launcher}</string>`, "<string>/usr/bin/true</string>");
    expect(prior).not.toBe(passFilePlist(fx.label));
    writeFileSync(fx.plistPath, prior);
    return prior;
  }

  /** Every file in the LaunchAgents directory: name -> mode and bytes. */
  function agentsDirState(): Record<string, string> {
    const state: Record<string, string> = {};
    for (const name of readdirSync(fx.agentsDir).sort()) {
      const path = join(fx.agentsDir, name);
      state[name] = `${(statSync(path).mode & 0o7777).toString(8)} ${readFileSync(path).toString("base64")}`;
    }
    return state;
  }

  /** A TMPDIR that does not exist: the default lint cannot create its temporary copy. */
  function missingTmpdir(): Record<string, string> {
    const dir = join(fx.home, "no-such-tmp");
    expect(existsSync(dir)).toBe(false);
    return { TMPDIR: dir };
  }

  function expectRefusedUntouched(result: any, before: Record<string, string>, lintDetail: string): string {
    expect(result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
    const text = result.lines.map((l: any) => l.text).join("\n");
    // The refusal names the plist, the error, and what was left as it was.
    expect(text).toContain(`the plist init would install for ${fx.label} could not be validated (the lint failed: ${lintDetail}`);
    expect(text).toContain(`the legacy job ${LEGACY_LAUNCHD_LABEL} and its plist at ${legacyPlistPath()} were left as they were`);
    expect(text).not.toContain("✓");
    expect(text).not.toContain("Launchd service registered");
    // The LaunchAgents directory is exactly as it was: same files, same bytes.
    expect(agentsDirState()).toEqual(before);
    // Zero launchctl calls that change launchd's state; the legacy job was only
    // READ, is still loaded, and nothing was started.
    expect(mutatingCalls()).toEqual([]);
    expect(shimLines()).toContain(`print ${GUI}/${LEGACY_LAUNCHD_LABEL}`);
    expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
    expect(stubStarts()).toEqual([]);
    return text;
  }

  test.skipIf(!isDarwin)(
    "(g1) a prior plist at the new path + an injected lint that THROWS -> refused; the LaunchAgents directory byte-for-byte as before; zero mutating calls",
    async () => {
      arrangeLoadedLegacy();
      arrangePriorNewPlist();
      const before = agentsDirState();
      expect(Object.keys(before).length).toBe(2);

      const run = await drive("init", { ...initInput(), lintThrows: LINT_THROWS });

      await explainOnFailure(run, async () => {
        const text = expectRefusedUntouched(run.result, before, LINT_THROWS);
        expect(text).toContain(`the prior plist bytes and mode at ${fx.plistPath} were restored`);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(g2) NO prior plist at the new path + an injected lint that THROWS -> refused; the new plist does not remain; zero mutating calls",
    async () => {
      const legacy = arrangeLoadedLegacy();
      const before = agentsDirState();
      expect(Object.keys(before)).toEqual([`${LEGACY_LAUNCHD_LABEL}.plist`]);

      const run = await drive("init", { ...initInput(), lintThrows: LINT_THROWS });

      await explainOnFailure(run, async () => {
        const text = expectRefusedUntouched(run.result, before, LINT_THROWS);
        expect(text).toContain(`the new plist ${fx.plistPath} was removed again`);
        expect(existsSync(fx.plistPath)).toBe(false);
        expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacy);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(g3) the DEFAULT lint unable to create its temporary file (TMPDIR missing) -> the same refusal; the LaunchAgents directory byte-for-byte as before",
    async () => {
      arrangeLoadedLegacy();
      arrangePriorNewPlist();
      const before = agentsDirState();

      const run = await drive("init", initInput(), missingTmpdir());

      await explainOnFailure(run, async () => {
        const text = expectRefusedUntouched(run.result, before, "ENOENT");
        expect(text).toContain("mkdtemp");
        expect(text).toContain(`the prior plist bytes and mode at ${fx.plistPath} were restored`);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(g4) the lint throws AND the plist cannot be put back -> 'uncertain' (init exits 1), the failed put-back named; nothing loaded or unloaded",
    async () => {
      const legacy = arrangeLoadedLegacy();
      const before = agentsDirState();
      expect(Object.keys(before)).toEqual([`${LEGACY_LAUNCHD_LABEL}.plist`]);

      let run: Awaited<ReturnType<typeof flairInitWithFailedPutBack>>;
      try {
        run = await flairInitWithFailedPutBack(LINT_THROWS);
      } finally {
        chmodSync(fx.agentsDir, 0o755);
      }

      // The validation and failed put-back lines prove this command reached the
      // uncertain launchd outcome. Its exit status comes from init.ts itself.
      expect(run.stderr).toContain(`could not be validated (the lint failed: ${LINT_THROWS})`);
      expect(run.stderr).toContain(`putting ${fx.plistPath} back FAILED`);
      expect(run.stderr).toContain("EACCES");
      expect(run.stderr).not.toContain("✓");
      expect(run.exitCode).toBe(1);
      const after = agentsDirState();
      expect(Object.keys(after).sort()).toEqual([`${LEGACY_LAUNCHD_LABEL}.plist`, `${fx.label}.plist`].sort());
      expect(after[`${LEGACY_LAUNCHD_LABEL}.plist`]).toBe(before[`${LEGACY_LAUNCHD_LABEL}.plist`]);
      expect(after[`${fx.label}.plist`].split(" ")[0]).toBe("644");
      expect(existsSync(fx.plistPath)).toBe(true);
      expect(readFileSync(legacyPlistPath(), "utf-8")).toBe(legacy);
      expect(mutatingCalls()).toEqual([]);
      expect(existsSync(join(fx.state, "loaded", LEGACY_LAUNCHD_LABEL))).toBe(true);
      expect(stubStarts().length).toBe(1);
      expect(await healthy()).toBe(true);
    },
    60_000,
  );
});


describe("flair#2085 — init validates the plist it writes when there is no legacy job to migrate", () => {
  const LINT_THROWS = "injected lint failure (flair#2085)";

  function legacyPlistPath(): string {
    return launchdPlistPath(LEGACY_LAUNCHD_LABEL, fx.agentsDir);
  }

  /** A prior plist at the new path that init REWRITES: ours (ROOTPATH is this data dir), but not the pass-file launcher shape. */
  function arrangePriorNewPlist(): string {
    const launcher = join(fx.probe, "templates", "launchd", "start-flair-with-admin-pass.sh");
    const prior = passFilePlist(fx.label).replace(`<string>${launcher}</string>`, "<string>/usr/bin/true</string>");
    expect(prior).not.toBe(passFilePlist(fx.label));
    writeFileSync(fx.plistPath, prior);
    return prior;
  }

  /** Every file in the LaunchAgents directory: name -> mode and bytes. */
  function agentsDirState(): Record<string, string> {
    const state: Record<string, string> = {};
    for (const name of readdirSync(fx.agentsDir).sort()) {
      const path = join(fx.agentsDir, name);
      state[name] = `${(statSync(path).mode & 0o7777).toString(8)} ${readFileSync(path).toString("base64")}`;
    }
    return state;
  }

  test.skipIf(!isDarwin)(
    "(h1) NO legacy job + a prior plist init rewrites + an injected lint that THROWS -> refused; the prior plist put back byte-for-byte; zero mutating calls; exit 0",
    async () => {
      const prior = arrangePriorNewPlist();
      const before = agentsDirState();
      expect(Object.keys(before)).toEqual([`${fx.label}.plist`]);

      const run = await drive("init", { ...initInput(), lintThrows: LINT_THROWS });

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
        expect(run.exitCode).toBe(0);
        const text = run.result.lines.map((l: any) => l.text).join("\n");
        expect(text).toContain(`the plist init would install for ${fx.label} could not be validated (the lint failed: ${LINT_THROWS}`);
        expect(text).toContain(`the prior plist bytes and mode at ${fx.plistPath} were restored`);
        expect(text).not.toContain("✓");
        expect(text).not.toContain("Launchd service registered");
        expect(readFileSync(fx.plistPath, "utf-8")).toBe(prior);
        // The LaunchAgents directory is exactly as it was: same names, modes and bytes.
        expect(agentsDirState()).toEqual(before);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(h2) NO legacy job and NO prior plist + an injected lint that THROWS -> refused; the new plist removed again; zero mutating calls; exit 0",
    async () => {
      const before = agentsDirState();
      expect(before).toEqual({});

      const run = await drive("init", { ...initInput(), lintThrows: LINT_THROWS });

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "skipped" }); // whole result printed on failure
        expect(run.exitCode).toBe(0);
        const text = run.result.lines.map((l: any) => l.text).join("\n");
        expect(text).toContain(`the new plist ${fx.plistPath} was removed again`);
        expect(existsSync(fx.plistPath)).toBe(false);
        expect(agentsDirState()).toEqual(before);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(h3) NO legacy job + lint throws AND the plist cannot be put back -> 'uncertain', the failed put-back named; exit 1; nothing loaded or unloaded",
    async () => {
      const before = agentsDirState();
      expect(before).toEqual({});
      expect(existsSync(legacyPlistPath())).toBe(false);

      let run: Awaited<ReturnType<typeof drive>>;
      try {
        run = await drive("init", { ...initInput(), lintThrows: LINT_THROWS, lockDirBeforeThrow: fx.agentsDir });
      } finally {
        chmodSync(fx.agentsDir, 0o755);
      }

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "uncertain" }); // whole result printed on failure
        expect(run.exitCode).toBe(1);
        const text = run.result.lines.map((l: any) => l.text).join("\n");
        expect(text).toContain(`putting ${fx.plistPath} back FAILED`);
        expect(text).toContain("EACCES");
        expect(text).not.toContain("✓");
        // Reported honestly: the new plist IS still there, with the mode init writes.
        const after = agentsDirState();
        expect(Object.keys(after)).toEqual([`${fx.label}.plist`]);
        expect(after[`${fx.label}.plist`].split(" ")[0]).toBe("644");
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(h4) POSITIVE CONTROL: NO legacy job, a healthy lint -> the plist is written and reported; exit 0",
    async () => {
      const run = await drive("init", initInput());

      await explainOnFailure(run, async () => {
        expect(run.result).toMatchObject({ kind: "direct" }); // whole result printed on failure
        expect(run.exitCode).toBe(0);
        expect(existsSync(fx.plistPath)).toBe(true);
        expect(existsSync(legacyPlistPath())).toBe(false);
        expect(mutatingCalls()).toEqual([]);
      });
    },
    60_000,
  );
});
