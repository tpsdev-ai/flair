/**
 * service.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair stop` / `flair start` / `flair restart`; shares plist-root inspection, launchd ownership assertion and post-swap restart helpers with the kept lifecycle sections.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { DEFAULT_ADMIN_USER } from "../lib/auth-resolve.js";
import { classifyDaemonState } from "../lib/daemon-liveness.js";
import { diagnoseLaunchdPlistPaths, isDetached, renderDetachedWarning } from "../lib/launchd-management.js";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ServiceCli = {
  buildDirectSpawnEnv: (...args: any[]) => any;
  closedDirectSpawnEnv: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  ensureLaunchdServiceLoaded: (...args: any[]) => any;
  flairPackageDir: (...args: any[]) => any;
  gatherDaemonEvidence: (...args: any[]) => any;
  guardEngineNotBackwards: (...args: any[]) => any;
  harperBinNotFoundMessage: (...args: any[]) => any;
  harperSearchRoots: (...args: any[]) => any;
  observeLaunchdManagement: (...args: any[]) => any;
  probeHealth: (...args: any[]) => any;
  readyOpsSocketPosture: (...args: any[]) => any;
  resolveHarperBin: (...args: any[]) => any;
  resolveHttpBindHost: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveLaunchdLabel: (...args: any[]) => any;
  resolveOpsBindHost: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
  restartFlair: (...args: any[]) => any;
  stampEngineVersionIfRunning: (...args: any[]) => any;
  waitForHealth: (...args: any[]) => any;
  waitForProcessExit: (...args: any[]) => any;
  writeDaemonSidecar: (...args: any[]) => any;
  LEGACY_LAUNCHD_LABEL: any;
  STARTUP_TIMEOUT_MS: any;
};

let cli: ServiceCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: ServiceCli): void {
  cli = fns;
}

function buildDirectSpawnEnv(...args: any[]): any {
  return cli.buildDirectSpawnEnv(...args);
}

function closedDirectSpawnEnv(...args: any[]): any {
  return cli.closedDirectSpawnEnv(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function ensureLaunchdServiceLoaded(...args: any[]): any {
  return cli.ensureLaunchdServiceLoaded(...args);
}

function flairPackageDir(...args: any[]): any {
  return cli.flairPackageDir(...args);
}

function gatherDaemonEvidence(...args: any[]): any {
  return cli.gatherDaemonEvidence(...args);
}

function guardEngineNotBackwards(...args: any[]): any {
  return cli.guardEngineNotBackwards(...args);
}

function harperBinNotFoundMessage(...args: any[]): any {
  return cli.harperBinNotFoundMessage(...args);
}

function harperSearchRoots(...args: any[]): any {
  return cli.harperSearchRoots(...args);
}

function observeLaunchdManagement(...args: any[]): any {
  return cli.observeLaunchdManagement(...args);
}

function probeHealth(...args: any[]): any {
  return cli.probeHealth(...args);
}

function readyOpsSocketPosture(...args: any[]): any {
  return cli.readyOpsSocketPosture(...args);
}

function resolveHarperBin(...args: any[]): any {
  return cli.resolveHarperBin(...args);
}

function resolveHttpBindHost(...args: any[]): any {
  return cli.resolveHttpBindHost(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveLaunchdLabel(...args: any[]): any {
  return cli.resolveLaunchdLabel(...args);
}

function resolveOpsBindHost(...args: any[]): any {
  return cli.resolveOpsBindHost(...args);
}

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

function restartFlair(...args: any[]): any {
  return cli.restartFlair(...args);
}

function stampEngineVersionIfRunning(...args: any[]): any {
  return cli.stampEngineVersionIfRunning(...args);
}

function waitForHealth(...args: any[]): any {
  return cli.waitForHealth(...args);
}

function waitForProcessExit(...args: any[]): any {
  return cli.waitForProcessExit(...args);
}

function writeDaemonSidecar(...args: any[]): any {
  return cli.writeDaemonSidecar(...args);
}

export function register(program: Command): void {
  const LEGACY_LAUNCHD_LABEL = cli.LEGACY_LAUNCHD_LABEL;
  const STARTUP_TIMEOUT_MS = cli.STARTUP_TIMEOUT_MS;

// ─── flair stop ───────────────────────────────────────────────────────────────


program
  .command("stop")
  .description("Stop the running Flair (Harper) instance")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS: try launchd first. resolveLaunchdLabel (flair#693) finds
      // whichever label this data dir is actually registered under —
      // the new instance-scoped one, or a pre-flair#693 legacy install.
      const { plistPath } = resolveLaunchdLabel(defaultDataDir());
      if (existsSync(plistPath)) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
          console.log("✅ Flair stopped (launchd service unloaded)");
          return;
        } catch {
          // launchd unload failed, try PID fallback
        }
      }
    }

    // Non-launchd: the five-state liveness machine (flair#1454). The old
    // decision tree (launchd -> lsof -> "not running") is REPLACED, not
    // patched: `lsof` absence used to render as a definite "not running", and
    // the pidfile was only consulted to attribute port-derived PIDs. Now the
    // pidfile + identity sidecar are the primary evidence, and the health
    // probe is a cross-check — never the verdict.
    const dataDir = defaultDataDir();
    const evidence = await gatherDaemonEvidence(port, dataDir);
    const state = classifyDaemonState(evidence, { port, dataDir });

    switch (state.state) {
      case "RUNNING":
      case "WEDGED": {
        // Identity is already proven for both of these — killing a wedged
        // daemon is recovery, not a recycled-PID gamble.
        const pid = state.pid;
        const label = state.state === "WEDGED" ? "wedged daemon" : "daemon";
        try {
          process.kill(pid, "SIGTERM");
        } catch (err: any) {
          if (err?.code !== "ESRCH") {
            console.error(`❌ failed to signal pid ${pid}: ${err?.code ?? err?.message}`);
            process.exit(1);
          }
        }
        await waitForProcessExit(pid, STARTUP_TIMEOUT_MS);
        const after = await probeHealth(port);
        if (after.kind === "refused") {
          console.log(`✅ Flair stopped (${label}, pid ${pid})`);
        } else {
          console.log(`✅ Flair stopped (${label}, pid ${pid}; port ${port} may still be releasing)`);
        }
        return;
      }
      case "NOT_RUNNING":
        console.log("Flair is not running.");
        return;
      case "DISAGREEMENT":
        console.error(`⚠️  ${state.detail}`);
        console.error(`   Not stopping — the evidence conflicts.`);
        console.error(`   pidfile: ${join(dataDir, "hdb.pid")}`);
        console.error(`   port: ${port}`);
        console.error(`   To inspect: flair doctor`);
        process.exit(1);
      case "UNKNOWN":
        console.error(`⚠️  ${state.detail}`);
        console.error(`   Not stopping — could not determine whether Flair is running.`);
        process.exit(1);
    }
  });

// ─── flair start ──────────────────────────────────────────────────────────────


program
  .command("start")
  .description("Start Flair (Harper) — requires a prior 'flair init'")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const dataDir = defaultDataDir();

    // Already-running check via the five-state liveness machine (flair#1454).
    // The old check was a bare `fetch /Health` that treated "got a response"
    // as "already running" and exited 0 — half of #1454. Now the machine
    // classifies, and every non-NOT_RUNNING state refuses with a non-zero exit.
    const evidence = await gatherDaemonEvidence(port, dataDir);
    const state = classifyDaemonState(evidence, { port, dataDir });

    switch (state.state) {
      case "NOT_RUNNING":
        break; // proceed to boot
      case "RUNNING":
        console.error(`Flair is already running on port ${port} (pid ${state.pid}).`);
        process.exit(1);
      case "WEDGED":
        console.error(`⚠️  A wedged Flair daemon (pid ${state.pid}) is holding port ${port}.`);
        console.error(`   Run 'flair stop' first — never start over a live pid.`);
        process.exit(1);
      case "DISAGREEMENT":
        console.error(`⚠️  ${state.detail}`);
        console.error(`   Refusing to start — the evidence conflicts.`);
        console.error(`   pidfile: ${join(dataDir, "hdb.pid")}`);
        console.error(`   port: ${port}`);
        console.error(`   To inspect: flair doctor`);
        process.exit(1);
      case "UNKNOWN":
        console.error(`⚠️  ${state.detail}`);
        console.error(`   Refusing to start — could not determine whether Flair is running.`);
        process.exit(1);
    }

    if (!existsSync(dataDir)) {
      console.error("❌ No Flair data directory found. Run 'flair init' first.");
      process.exit(1);
    }

    // flair#1047: refuse to boot if the store was written by a newer engine.
    // Same guard startFlairProcess runs, so restart/upgrade/snapshot cannot
    // reach a boot this command would refuse (flair#1093).
    try {
      guardEngineNotBackwards(dataDir);
    } catch (err: any) {
      if (!err?.engineBackwards) throw err;
      console.error(`❌ Cannot start Flair — the data directory was written by a newer Harper engine.\n`);
      console.error(err.message);
      process.exit(1);
    }

    const platform = process.platform;
    if (platform === "darwin") {
      // resolveLaunchdLabel (flair#693) finds whichever label this data
      // dir is currently registered under (new instance-scoped, or a
      // pre-flair#693 legacy install) so the existsSync gate below is
      // accurate before we attempt anything.
      const { plistPath } = resolveLaunchdLabel(dataDir);
      if (existsSync(plistPath)) {
        try {
          // flair#1022, same pre-flight as startFlairProcess: launchctl exits 0
          // for a job it cannot exec, so a stale plist is only ever observable
          // as a startup timeout unless the paths are checked first.
          const stalePlist = diagnoseLaunchdPlistPaths(plistPath);
          if (stalePlist) {
            throw new Error(`${stalePlist.message} Fix it with: ${stalePlist.remedy.join(" && ")}`);
          }
          const { execSync } = await import("node:child_process");
          const { label, migrated } = ensureLaunchdServiceLoaded(dataDir, (cmd: string) => execSync(cmd, { stdio: "pipe" }));
          if (migrated) console.log(`Migrated launchd service off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${label} ✓`);
          await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
          readyOpsSocketPosture(dataDir); // flair#763: re-assert socket posture on the freshly-created socket
          stampEngineVersionIfRunning(dataDir); // flair#1047: stamp the store with the engine version
          console.log("✅ Flair started (launchd)");
          return;
        } catch (err: any) {
          console.error(`launchd start failed, falling back to direct start: ${err.message}`);
        }
      }
    }

    // Direct start (Linux, or macOS fallback when no launchd plist)
    const harper = resolveHarperBin(harperSearchRoots());
    if (!harper.path) {
      console.error(`❌ ${harperBinNotFoundMessage(harper.searched)}`);
      process.exit(1);
    }
    const bin = harper.path;

    const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS || "";
    // flair#670/#863: this fallback path (no launchd plist) sets no
    // HARPER_SET_CONFIG, so the ops bind has to be re-asserted explicitly on
    // every spawn — see buildDirectSpawnEnv. The escape hatch on this path is
    // FLAIR_OPS_BIND or the `opsBind` that `flair init --ops-bind` persisted to
    // ~/.flair/config.yaml; there is no --ops-bind flag on `start`.
    const env: Record<string, string> = closedDirectSpawnEnv(process.env, buildDirectSpawnEnv({
      dataDir,
      modelsDir: process.env.FLAIR_MODELS_DIR ?? join(dataDir, "models"),
      httpPort: port,
      httpBindHost: resolveHttpBindHost({}),
      opsPort: resolveOpsPort(opts),
      opsBindHost: resolveOpsBindHost({}),
      adminUser: DEFAULT_ADMIN_USER,
      adminPass,
    }));

    const proc = spawn(process.execPath, [bin, "run", "."], {
      cwd: flairPackageDir(), env, detached: true, stdio: "ignore",
    });
    proc.unref();

    // Write the identity sidecar immediately after spawn (flair#1454 decision
    // 3) — BEFORE waitForHealth, so startTimeMs stays within the ±2s tolerance
    // of the process's real start time. `proc.pid` is the pid Harper writes to
    // hdb.pid, since Harper runs in-process.
    if (proc.pid) writeDaemonSidecar(dataDir, proc.pid, port);

    try {
      await waitForHealth(port, DEFAULT_ADMIN_USER, adminPass, STARTUP_TIMEOUT_MS);
      readyOpsSocketPosture(dataDir); // flair#763: re-assert socket posture on the freshly-created socket
      stampEngineVersionIfRunning(dataDir); // flair#1047: stamp the store with the engine version
      console.log(`✅ Flair started on port ${port}`);
    } catch {
      console.error("❌ Flair failed to start within timeout. Check logs in " + join(dataDir, "harper.log"));
      process.exit(1);
    }
  });

// ─── flair restart ────────────────────────────────────────────────────────────




program
  .command("restart")
  .description("Restart the Flair (Harper) instance")
  .option("--port <port>", "Harper HTTP port")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    // Explicit, not defaulted inside restartFlair (flair#902): `flair
    // restart` has no --data-dir, so the default install IS what it means —
    // and saying so here is what keeps that true when someone adds one.
    try {
      await restartFlair(port, defaultDataDir());
      // flair#1022: a restart that fell back off launchd left the instance
      // running but unmanaged, and "✅ Flair restarted" was true of both
      // outcomes. Ask launchd what it is actually running now — an
      // observation, not a flag out of the restart, so it is right even when
      // the detachment predates this command.
      const managed = observeLaunchdManagement(defaultDataDir(), port);
      if (isDetached(managed)) {
        for (const line of renderDetachedWarning(managed, "Flair restarted, but it is NOT running under launchd.")) {
          console.error(line);
        }
        return;
      }
      console.log("✅ Flair restarted");
    } catch (err: any) {
      console.error(`❌ Flair failed to restart: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

}
