// launchd-2040-command-level.test.ts — flair#2040, driven through the commands.
//
// The incident: `flair doctor --fix` over ssh clean-stopped a HEALTHY instance,
// then could not load the launchd job (the GUI domain was unreachable from that
// session: `launchctl print gui/<uid>` → 125), leaving Flair down; and `flair
// init` printed a check mark for a job it never loaded.
//
// The rule these tests pin: no command stops, unloads or replaces a running
// instance before it has checked everything it can about the replacement from
// this session, and every failure after a stop brings back what was running and
// says what state it left. Each case drives the REAL executor — doctor's
// `repairLaunchdManagement`, init's `registerInitLaunchdService`, and the
// `flair start` command itself — not a helper, so removing a gate from the
// executor turns a test red (see the mutation table in the PR).
//
// SAFETY — this host may run a real Flair under launchd:
//
//   - `launchctl` is a shim on PATH (first) that records every invocation and
//     answers from a state directory this test owns. No invocation here reaches
//     real launchd. The shim's bootstrap "starts the job" by spawning the stub
//     below; its bootout "stops the job" by signalling the pid IT recorded.
//   - Harper is a stub: `node_modules/harper/dist/bin/harper.js` inside a copied
//     package tree (`.flair2040-probe-*` in the repo, removed after each test),
//     so every start path — launchd's, the direct fallback, the restore — spawns
//     the stub, never a database. The stub answers Flair's /Health on 127.0.0.1,
//     writes hdb.pid, opens `<dataDir>/operations-server`, and logs SIGTERM.
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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLaunchdPlist, launchdLabel, launchdPlistPath, LEGACY_LAUNCHD_LABEL } from "../../src/cli.ts";

const isDarwin = process.platform === "darwin";
const repoRoot = join(import.meta.dirname, "..", "..");
const UID = typeof process.getuid === "function" ? process.getuid() : 0;
const GUI = `gui/${UID}`;
const ADMIN_PASS = "PLACEHOLDER-not-a-secret";
/** launchctl verbs that change launchd state. A refusal must issue none of them. */
const MUTATING_VERBS = ["bootout", "bootstrap", "kickstart", "load", "unload", "start", "stop", "enable", "disable", "remove", "submit"];

const STUB_HARPER = `
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.ROOTPATH;
const port = Number(((process.env.HTTP_PORT ?? "0").match(/(\\d+)$/) ?? [])[1] ?? 0);
if (process.env.STUB_START_LOG) appendFileSync(process.env.STUB_START_LOG, process.pid + "\\n");
const http = createServer((_q, r) => {
  r.writeHead(200, { "content-type": "application/json" });
  r.end('{"ok":true,"version":"0.57.0","buildCommit":null,"searchReady":true}');
});
http.listen(port, "127.0.0.1", () => {
  writeFileSync(join(root, "hdb.pid"), String(process.pid));
  writeFileSync(join(root, "stub-port"), String(http.address().port));
  try { rmSync(join(root, "operations-server"), { force: true }); } catch {}
  createNetServer((s) => s.end()).listen(join(root, "operations-server"));
});
process.on("SIGTERM", () => {
  appendFileSync(join(root, "signals.log"), "SIGTERM " + process.pid + "\\n");
  try { if (readFileSync(join(root, "hdb.pid"), "utf-8").trim() === String(process.pid)) rmSync(join(root, "hdb.pid")); } catch {}
  process.exit(0);
});
`;

// The launchctl stand-in. State lives under $SHIM_STATE:
//   domain-code           exit code for `print gui/<uid>` (default 0)
//   disabled              stdout for `print-disabled gui/<uid>` (default: none disabled)
//   bootstrap-fail/<l>    make `bootstrap` of label <l> fail with 5: Input/output error
//   list-no-pid[-<l>]     `list` reports loaded jobs (or just <l>) WITHOUT a PID
//   loaded/<l>, pid/<l>   what is "loaded" and the pid "launchd" runs for it
//   bootout-order         (written) each bootout's label + whether the serving pid was alive
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
    if [ -f "$S/loaded/$l" ]; then
      if [ -f "$S/pid/$l" ]; then kill -TERM "$(cat "$S/pid/$l")" 2>/dev/null; rm -f "$S/pid/$l"; fi
      rm -f "$S/loaded/$l"; exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2; exit 3 ;;
  bootstrap)
    l=$(basename "$2" .plist)
    if [ -f "$S/bootstrap-fail/$l" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    : > "$S/loaded/$l"
    ROOTPATH="$STUB_ROOT" HTTP_PORT="$STUB_PORT" "$STUB_RUNTIME" "$STUB_HARPER" run . >/dev/null 2>&1 </dev/null &
    echo $! > "$S/pid/$l"
    exit 0 ;;
  kickstart)
    l="\${1#gui/*/}"
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
  for (const d of ["loaded", "pid", "bootstrap-fail"]) mkdirSync(join(state, d), { recursive: true });

  // A package tree whose Harper is the stub (see the file header).
  const probe = mkdtempSync(join(repoRoot, ".flair2040-probe-"));
  cleanupDirs.push(probe);
  cpSync(join(repoRoot, "src"), join(probe, "src"), { recursive: true });
  cpSync(join(repoRoot, "templates"), join(probe, "templates"), { recursive: true });
  chmodSync(join(probe, "templates", "launchd", "start-flair-with-admin-pass.sh"), 0o755);
  const stubHarper = join(probe, "node_modules", "harper", "dist", "bin", "harper.js");
  mkdirSync(join(probe, "node_modules", "harper", "dist", "bin"), { recursive: true });
  writeFileSync(stubHarper, STUB_HARPER);
  writeFileSync(
    join(probe, "drive.ts"),
    [
      `import { repairLaunchdManagement, registerInitLaunchdService } from "./src/cli.ts";`,
      `const [what, arg] = process.argv.slice(2);`,
      `const input = JSON.parse(arg);`,
      `const r = what === "repair"`,
      `  ? await repairLaunchdManagement(input.dataDir, input.port)`,
      `  : await registerInitLaunchdService(input);`,
      `console.log("RESULT " + JSON.stringify(r));`,
      `process.exit(0);`,
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
  };
}

/** The instance serving before the command runs: a stub started DIRECTLY (not by launchd). */
async function startDirectStub(): Promise<number> {
  const proc = Bun.spawn([process.execPath, fx.stubHarper, "run", "."], {
    // cwd = a flair worktree + ROOTPATH, so the liveness machine can attribute
    // it (same arrangement as launchd-management-reporting.test.ts).
    cwd: repoRoot,
    env: { ...childEnv(), ROOTPATH: fx.dataDir, HTTP_PORT: `127.0.0.1:${fx.port}` },
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

async function drive(what: "repair" | "init", input: unknown): Promise<{ result: any; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(fx.probe, "drive.ts"), what, JSON.stringify(input)], {
    cwd: fx.probe,
    env: childEnv(),
    timeout: 100_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`driver produced no RESULT.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return { result: JSON.parse(line.slice("RESULT ".length)), stdout, stderr };
}

async function flairStart(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, join(fx.probe, "src", "cli.ts"), "start", "--port", String(fx.port)], {
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

/** Mark `label` as loaded in the shim, running `pid` (what launchd would report). */
function markLoaded(label: string, pid: number | null): void {
  writeFileSync(join(fx.state, "loaded", label), "");
  if (pid !== null) writeFileSync(join(fx.state, "pid", label), String(pid));
}

beforeEach(async () => {
  fx = setupFixture(await freePort());
});

afterEach(() => {
  // Only stubs this file started: every stub logs its own pid, and each is
  // checked to be running the stub script before it is signalled.
  for (const pid of stubStarts()) {
    const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" }).stdout ?? "";
    if (cmd.includes(fx.stubHarper)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

      expect(result.kind).toBe("refused"); // doctor counts an issue and exits non-zero; never "repaired"
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

      expect(result.kind).toBe("refused");
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

      expect(result.kind).toBe("failed");
      expect(result.detail).toContain("start-flair-with-admin-pass.sh, which does not exist");
      expect(result.detail).toContain("Nothing was stopped, unloaded or rewritten");
      expect(alive(pid)).toBe(true);
      expect(hdbPid()).toBe(pid);
      expect(signals()).toBe("");
      expect(readFileSync(fx.plistPath, "utf-8")).toBe(plistBytes);
      expect(mutatingCalls()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!isDarwin)(
    "(b) POSITIVE CONTROL: the domain answers -> adoption bounces and VERIFIES, loading with commands that name gui/<uid>",
    async () => {
      const { pid } = await arrangeDirectInstance();

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result.kind).toBe("repaired");
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
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(b2) a job that is loaded but NOT serving is booted out BEFORE the direct process is stopped (KeepAlive cannot race the stop)",
    async () => {
      const { pid } = await arrangeDirectInstance();
      markLoaded(fx.label, null); // loaded, not running: e.g. the launcher refusing while the direct process serves

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result.kind).toBe("repaired");
      expect(signals()).toContain(`SIGTERM ${pid}`);
      const order = readFileSync(join(fx.state, "bootout-order"), "utf-8").split("\n").filter(Boolean);
      // The FIRST bootout of this job happened while the direct process still served.
      expect(order[0]).toBe(`${fx.label} serving-alive`);
    },
    90_000,
  );

  test.skipIf(!isDarwin)(
    "(b3) the job loads and the port answers, but launchd does not report the serving pid -> NOT repaired; restored directly",
    async () => {
      const { pid, plistBytes } = await arrangeDirectInstance();
      writeFileSync(join(fx.state, `list-no-pid-${fx.label}`), "");

      const { result } = await drive("repair", { dataDir: fx.dataDir, port: fx.port });

      expect(result.kind).toBe("failed");
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

      expect(result.kind).toBe("failed"); // never "repaired"
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

      expect(result.kind).toBe("skipped");
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

      expect(result.kind).toBe("managed");
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

      expect(result.kind).toBe("restored");
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

      expect(result.kind).toBe("restored");
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

      expect(result.kind).toBe("direct");
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
      env: { ...plist.EnvironmentVariables, STUB_START_LOG: fx.startLog },
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
      expect(result.kind).toBe("direct");

      const startsBefore = stubStarts().length;
      const refused = runAsLaunchd(fx.plistPath);
      expect(refused.status).toBe(0);
      expect(refused.stderr).toContain(`is already served by pid ${pid}`);
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
        env: { ...plist.EnvironmentVariables, STUB_START_LOG: fx.startLog },
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
      const calls = mutatingCalls();
      expect(calls[calls.length - 1]).toBe(`bootout ${GUI}/${fx.label}`);
      expect(await healthy()).toBe(true);
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
