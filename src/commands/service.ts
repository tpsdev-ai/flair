/**
 * service.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair stop` / `flair start` / `flair restart`; shares plist-root inspection, launchd ownership assertion and post-swap restart helpers with the kept lifecycle sections.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { DEFAULT_ADMIN_USER, defaultAdminPassPath, readAdminPassFileSecure } from "../lib/auth-resolve.js";
import { seedUsingFlairSkill } from "../lib/skill-seed.js";
import { reconcilePendingSkillSeed, skillSeedPendingPath } from "../lib/skill-seed-pending.js";
import { classifyDaemonState } from "../lib/daemon-liveness.js";
import { decideStartOnUnknown, probePortListening } from "../lib/stop-start-recovery.js";
import { diagnoseLaunchdPlistPaths, isDetached, renderDetachedWarning, verifyLaunchdManagement } from "../lib/launchd-management.js";
import {
  LaunchdValidationRefusal,
  loadabilityAllowsAttempt,
  renderDirectRunNotice,
  renderStartLaunchdUnavailable,
} from "../lib/launchd-domain-preflight.js";
import { mapRepairThrow } from "../lib/launchd-repair.js";
import { opsSocketPathRefusal } from "../lib/socket-path-limit.js";
import { formatServingTreeLine, formatTreeAssessmentLines, type TreeAssessment } from "../lib/tree-divergence.js";
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ServiceCli = {
  afterFailedLaunchdAttempt: (...args: any[]) => any;
  assessInstallTree: (...args: any[]) => any;
  buildDirectSpawnEnv: (...args: any[]) => any;
  closedDirectSpawnEnv: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  ensureLaunchdServiceLoaded: (...args: any[]) => any;
  flairPackageDir: (...args: any[]) => any;
  gatherDaemonEvidence: (...args: any[]) => any;
  gatherDaemonOwnerEvidence: (...args: any[]) => any;
  guardEngineNotBackwards: (...args: any[]) => any;
  harperBinNotFoundMessage: (...args: any[]) => any;
  harperSearchRoots: (...args: any[]) => any;
  launchdLabel: (...args: any[]) => any;
  observeLaunchdLoadability: (...args: any[]) => any;
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
  removeStaleSidecarIfConfirmedDead: (...args: any[]) => any;
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

function afterFailedLaunchdAttempt(...args: any[]): any {
  return cli.afterFailedLaunchdAttempt(...args);
}

function buildDirectSpawnEnv(...args: any[]): any {
  return cli.buildDirectSpawnEnv(...args);
}

/**
 * flair#2034 §2: after a restart, say which install tree now serves the
 * instance — proven from the service manager that owns the serving process —
 * and whether it is this CLI's. This is the verification step of the
 * `flair init && flair restart` remedy. Report-only: the restart itself
 * succeeded, so the exit code is not changed; `ok` is false only when a
 * divergence is PROVEN to remain.
 */
export function restartTreeReport(a: TreeAssessment | null): { ok: boolean; lines: string[] } {
  if (!a) return { ok: true, lines: [] };
  if (a.state === "diverged") {
    return {
      ok: false,
      lines: [
        "⚠️  Flair restarted, but the instance still serves a DIFFERENT install tree than this CLI.",
        ...formatTreeAssessmentLines(a, { context: "restart" }),
      ],
    };
  }
  return { ok: true, lines: [`   ${formatServingTreeLine(a)}`] };
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

function removeStaleSidecarIfConfirmedDead(...args: any[]): any {
  return cli.removeStaleSidecarIfConfirmedDead(...args);
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

function launchdLabel(...args: any[]): any {
  return cli.launchdLabel(...args);
}

function observeLaunchdLoadability(...args: any[]): any {
  return cli.observeLaunchdLoadability(...args);
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

/**
 * Finish a local --skip-start init's deferred seed after this command has
 * started its instance (flair#2141 S2). A seed it cannot complete is a
 * WARNING, not a failure: the server started, so `flair start` exits 0 and the
 * pending marker stays for the next `flair start`. The credential case names
 * the remedy.
 */
async function seedAfterStart(dataDir: string, port: number): Promise<void> {
  try {
    const outcome = await reconcilePendingSkillSeed(dataDir, async () => {
      const passPath = defaultAdminPassPath();
      const pass = process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD ||
        (existsSync(passPath) ? readAdminPassFileSecure(passPath) : "");
      if (!pass) {
        throw new Error(
          `admin credentials are needed to seed it — set FLAIR_ADMIN_PASS or restore ${passPath}, ` +
          "then run 'flair start' again",
        );
      }
      return seedUsingFlairSkill({
        baseUrl: `http://127.0.0.1:${port}`,
        user: DEFAULT_ADMIN_USER,
        pass,
        notify: (line) => console.log(line),
      });
    });
    if (!outcome) return;
    if (outcome.kind === "refused") {
      console.error(`⚠️  Flair started, but the using-flair skill seed is still pending: ${outcome.message}`);
      return;
    }
    console.log(`using-flair skill: ${outcome.message}`);
  } catch (err: any) {
    console.error(`⚠️  Flair started, but the using-flair skill seed is still pending: ${err?.message ?? err}`);
  }
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
        const dataDir = defaultDataDir();
        let pid: number | null = null;
        try {
          const n = Number(readFileSync(join(dataDir, "hdb.pid"), "utf-8").trim());
          if (!Number.isSafeInteger(n) || n <= 0) throw new Error("recorded pid is invalid");
          pid = n;
          const { execSync } = await import("node:child_process");
          execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
          // Verify the captured pid exited before attempting confirmed-dead cleanup.
          await waitForProcessExit(pid, STARTUP_TIMEOUT_MS);
          removeStaleSidecarIfConfirmedDead(dataDir, pid);
          console.log("✅ Flair stopped (launchd service unloaded)");
          return;
        } catch (err) {
          const failure = mapRepairThrow(err);
          console.error(`❌ flair stop: launchd stop failed for ${dataDir} (pid ${pid ?? "unknown"}): ${failure.detail}`);
          if (failure.kind === "failed") {
            for (const remedy of failure.remedy ?? []) console.error(`   Fix: ${remedy}`);
          }
          process.exit(1);
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
        // Use the PID the exit probe observed gone for best-effort cleanup.
        removeStaleSidecarIfConfirmedDead(dataDir, pid);
        const after = await probeHealth(port);
        if (after.kind === "refused") {
          console.log(`✅ Flair stopped (${label}, pid ${pid})`);
        } else {
          console.log(`✅ Flair stopped (${label}, pid ${pid}; port ${port} may still be releasing)`);
        }
        return;
      }
      case "NOT_RUNNING":
        removeStaleSidecarIfConfirmedDead(dataDir);
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

       // flair#916: the operations socket is a Unix domain socket whose path is
      // capped by sun_path (darwin 103 / linux 107, NUL-excluded); a too-long
      // data dir would make Harper die with a bare `listen EINVAL` on boot.
      // This command uses the hardcoded defaultDataDir() today, so the limit is
      // unreachable here — the preflight is defensive against a future
      // --data-dir or a lengthened default. Refuse before touching disk.
    const socketRefusal = opsSocketPathRefusal(dataDir, process.platform);
    if (socketRefusal) {
      console.error(socketRefusal);
      process.exit(1);
        }

     // Already-running check via the five-state liveness machine (flair#1454).
    const evidence = await gatherDaemonEvidence(port, dataDir);
    const state = classifyDaemonState(evidence, { port, dataDir });

    let recoveryPid: number | undefined;
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
      case "UNKNOWN": {
        const probe = await probePortListening(port);
        const decision = decideStartOnUnknown({ evidence, detail: state.detail, port, probe });
        for (const line of decision.lines) console.error(line);
        if (decision.proceed) {
          recoveryPid = evidence.pidfile.kind === "present" ? evidence.pidfile.pid : evidence.lastKnownPid;
          break;
        }
        process.exit(1);
      }
    }

    const recheckRecovery = async (): Promise<void> => {
      if (recoveryPid === undefined) return;
      const observed = await gatherDaemonEvidence(port, dataDir);
      const probe = await probePortListening(port);
      const fresh = { ...observed, ...cli.gatherDaemonOwnerEvidence(dataDir) };
      const pid = fresh.pidfile.kind === "present" ? fresh.pidfile.pid : fresh.lastKnownPid;
      const decision = decideStartOnUnknown({
        evidence: pid === recoveryPid ? fresh : { ...fresh, pidLiveness: { kind: "unknown", reason: "recorded owner changed" } },
        detail: "Rechecking the recorded owner before start.", port,
        probe,
      });
      if (pid !== recoveryPid || !decision.proceed) {
        for (const line of decision.lines) console.error(line);
        process.exit(1);
      }
    };

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
    // Set when a launchd service is registered for this instance but this run
    // could not start it under launchd — the direct start below then reports
    // "running directly, NOT launchd-managed" instead of a plain success.
    let launchdFellBack = false;
    if (platform === "darwin") {
      // resolveLaunchdLabel (flair#693) finds whichever label this data
      // dir is currently registered under (new instance-scoped, or a
      // pre-flair#693 legacy install) so the existsSync gate below is
      // accurate before we attempt anything.
      const { plistPath, isLegacy } = resolveLaunchdLabel(dataDir);
      if (existsSync(plistPath)) {
        // flair#2040: preflight BEFORE the load — is the GUI domain reachable
        // from this session, and is the job enabled there? Read-only. When it
        // is not, say why (actor, state) and start directly.
        const jobLabel = launchdLabel(dataDir);
        const loadability = observeLaunchdLoadability(jobLabel);
        if (!loadabilityAllowsAttempt(loadability)) {
          console.error(renderStartLaunchdUnavailable("flair start", loadability));
          launchdFellBack = true;
        } else {
          try {
            // flair#1022, same pre-flight as startFlairProcess: launchctl exits 0
            // for a job it cannot exec, so a stale plist is only ever observable
            // as a startup timeout unless the paths are checked first.
            // flair#2040: a validation refusal — nothing loaded or unloaded.
            const stalePlist = diagnoseLaunchdPlistPaths(plistPath);
            if (stalePlist) {
              throw new LaunchdValidationRefusal(`${stalePlist.message} Fix it with: ${stalePlist.remedy.join(" && ")}`);
            }
            const { execSync } = await import("node:child_process");
            // Targeted at gui/<uid> — the domain the preflight probed (flair#2040).
            await recheckRecovery();
            const { label, migrated } = ensureLaunchdServiceLoaded(dataDir, (cmd: string) => execSync(cmd, { stdio: "pipe" }));
            await waitForHealth(port, DEFAULT_ADMIN_USER, process.env.HDB_ADMIN_PASSWORD ?? "", STARTUP_TIMEOUT_MS);
            readyOpsSocketPosture(dataDir); // flair#763: re-assert socket posture on the freshly-created socket
            stampEngineVersionIfRunning(dataDir); // flair#1047: stamp the store with the engine version
            // flair#2040: the launchd check mark only after VERIFYING that
            // launchd's pid IS the identified serving pid — a healthy port is
            // not proof that launchd started what answers it, and an
            // unidentified serving process is not proof either.
            const managed = observeLaunchdManagement(dataDir, port);
            const verdict = verifyLaunchdManagement(managed);
            if (verdict.verified) {
              await seedAfterStart(dataDir, port);
              // The migration's check mark too only after the strict verifier
              // passed: moving a plist is not launchd running this instance.
              if (migrated) console.log(`Migrated launchd service off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${label} ✓`);
              console.log(`✅ Flair started (launchd-managed: ${verdict.detail})`);
              return;
            }
            // Healthy, but not proven to be launchd's process: no launchd check
            // mark, and no claim about what happens at the next reboot either.
            console.error(`⚠️  Flair is running on port ${port}, but it is NOT verified as launchd-managed: ${managed.detail}`);
            if (migrated) console.error(`   The launchd service was moved off the legacy label (${LEGACY_LAUNCHD_LABEL}) → ${label}.`);
            if (managed.remedy?.length) console.error(`   Fix: ${managed.remedy.join(" && ")}`);
            if (existsSync(skillSeedPendingPath(dataDir))) {
              console.error("❌ Flair started, but its identity is unverified; the using-flair skill seed remains pending. Run 'flair doctor' before retrying.");
              process.exit(1);
            }
            return;
          } catch (err: any) {
            // flair#2040: start directly below only when no job for this
            // instance could start underneath the direct process. A failed LOAD
            // is unloaded again and verified gone; a VALIDATION refusal loaded
            // and unloaded nothing, so nothing is booted out — a loaded job (a
            // legacy one, say) refuses the direct start instead.
            const after = afterFailedLaunchdAttempt("flair start", jobLabel, isLegacy ? [jobLabel, LEGACY_LAUNCHD_LABEL] : [jobLabel], err);
            for (const line of after.lines) console.error(line);
            if (!after.directStart) process.exit(1);
            launchdFellBack = true;
          }
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

    await recheckRecovery();
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
      if (existsSync(skillSeedPendingPath(dataDir))) {
        const observed = classifyDaemonState(await gatherDaemonEvidence(port, dataDir), { port, dataDir });
        if (observed.state !== "RUNNING" || observed.pid !== proc.pid) {
          console.error("❌ Flair answered health, but this start did not prove the serving process; the using-flair skill seed remains pending.");
          process.exit(1);
        }
        await seedAfterStart(dataDir, port);
      }
      if (launchdFellBack) {
        // flair#2040: a direct start that took launchd's place says so.
        const [headline, ...rest] = renderDirectRunNotice(port, proc.pid ?? null);
        console.log(headline);
        for (const line of rest) console.error(line);
      } else {
        console.log(`✅ Flair started on port ${port}`);
      }
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
      // flair#916: the same defensive preflight `flair start` runs — the
      // operations socket path is capped by sun_path; refuse here, before a
      // restart touches the instance, rather than let Harper die with a bare
      // `listen EINVAL` on boot. `restart` uses the hardcoded defaultDataDir()
      // today, so the limit is unreachable; this is defense against a future
      // --data-dir or a lengthened default.
    const dataDir = defaultDataDir();
    const socketRefusal = opsSocketPathRefusal(dataDir, process.platform);
    if (socketRefusal) {
      console.error(socketRefusal);
      process.exit(1);
      }
    try {
      await restartFlair(port, dataDir);
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
      let tree: TreeAssessment | null = null;
      try {
        tree = cli.assessInstallTree(dataDir, port, { local: true }) as TreeAssessment;
      } catch {
        tree = null;
      }
      const report = restartTreeReport(tree);
      if (!report.ok) {
        for (const line of report.lines) console.error(line);
        return;
      }
      console.log("✅ Flair restarted");
      for (const line of report.lines) console.log(line);
    } catch (err: any) {
      console.error(`❌ Flair failed to restart: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

}
