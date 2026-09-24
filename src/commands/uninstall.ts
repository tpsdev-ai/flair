/**
 * uninstall.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair uninstall`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { formatPurgeReport, purgeFlairInstall, purgeHadFailures } from "../lib/uninstall-purge.js";
import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

import { join } from "node:path";
import { resolveHome } from "../lib/home.js";

export type UninstallCli = {
  configPath: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  launchdLabel: (...args: any[]) => any;
  launchdPlistPath: (...args: any[]) => any;
  listeningPidsOnPort: (...args: any[]) => any;
  readHarperPid: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  LEGACY_LAUNCHD_LABEL: any;
};

let cli: UninstallCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: UninstallCli): void {
  cli = fns;
}

function configPath(...args: any[]): any {
  return cli.configPath(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function launchdLabel(...args: any[]): any {
  return cli.launchdLabel(...args);
}

function launchdPlistPath(...args: any[]): any {
  return cli.launchdPlistPath(...args);
}

function listeningPidsOnPort(...args: any[]): any {
  return cli.listeningPidsOnPort(...args);
}

function readHarperPid(...args: any[]): any {
  return cli.readHarperPid(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

export function register(program: Command): void {
  const LEGACY_LAUNCHD_LABEL = cli.LEGACY_LAUNCHD_LABEL;

// ─── flair uninstall ──────────────────────────────────────────────────────────


program
  .command("uninstall")
  .description("Stop Flair and remove the launchd/systemd service")
  .option("--purge", "Also remove data, keys, secrets, schedulers, and client wiring (destructive)")
  .action(async (opts) => {
    const platform = process.platform;
    // Use the unified resolver: Harper's config > per-user config > default.
    // A default of 19926 that is "present but wrong" beats the actual port
    // Harper is serving on (flair#819). resolveHttpPort reads Harper's own
    // config in the data directory, which is authoritative.
    const port = resolveHttpPort({}, "address");

    // Stop first: remove launchd service(s) on macOS, then kill by port on
    // all platforms. Removes BOTH the new instance-scoped plist and a
    // pre-flair#693 legacy plist if present — uninstall's job is to purge
    // everything for this data dir, so it doesn't rely on resolveLaunchdLabel's
    // "prefer new" pick alone (which would skip a stray legacy leftover).
    if (platform === "darwin") {
      const dataDir = defaultDataDir();
      const candidatePlists = [launchdPlistPath(launchdLabel(dataDir)), launchdPlistPath(LEGACY_LAUNCHD_LABEL)];
      let removedAny = false;
      for (const plistPath of candidatePlists) {
        if (existsSync(plistPath)) {
          try {
            const { execSync } = await import("node:child_process");
            execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
          } catch { /* best effort */ }
          unlinkSync(plistPath);
          removedAny = true;
        }
      }
      if (removedAny) console.log("✅ Launchd service removed");
    }
    // Kill any process still on the port (covers direct-start, no-service, or
    // failed unload). Listening sockets only, never our own PID — see
    // parseListeningPids (flair#800/flair#905).
    //
    // Guard (flair#917): refuse to SIGTERM a PID that cannot be attributed to
    // this Flair instance. A port is not an identity — something else can hold
    // it. Killing the wrong PID and then purging data is the whole bug.
        let refusedKill = false;
    try {
      const { execSync } = await import("node:child_process");
      const pids = listeningPidsOnPort(port, (cmd: string) => execSync(cmd, { encoding: "utf-8" }));
      if (pids.length > 0) {
        // Verify ownership before killing: the PID must match this instance's
        // recorded PID (hdb.pid). If no PID file exists, Harper is already
        // stopped and the port is stale — safe to skip.
        const dataDir = defaultDataDir();
        const harperPid = readHarperPid(dataDir);
        if (harperPid !== null) {
          // PID file exists — the PID on the port must be Harper or we refuse.
          if (!pids.includes(harperPid)) {
            console.log(
              `⚠️  Process(es) on port ${port} (PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}) `
                + `do not match this Flair instance (PID ${harperPid}). `
                + `Not killing — cannot attribute the process to this instance. `
                + `Stop the process manually if it is not Flair.`,
            );
            refusedKill = true;
          } else {
            for (const pid of pids) {
              try { process.kill(pid, "SIGTERM"); } catch {}
            }
            await new Promise(r => setTimeout(r, 2000));
            console.log("✅ Flair process stopped");
          }
        } else {
          // No PID file — Harper is not (or was not) running here.
          // The port may be stale or held by something else; don't risk killing it.
          console.log(
            `⚠️  Process(es) on port ${port} (PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}) `
              + `but no PID file in data directory — not a running Flair instance. `
              + `Not killing — stop the process manually if it is not Flair.`,
          );
          refusedKill = true;
        }
      }
    } catch { /* not running */ }

    // Always remove per-user config on uninstall.
    {
      const cfgPath = configPath();
      if (existsSync(cfgPath)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(cfgPath);
        console.log("✅ Config removed");
      }
    }

    if (opts.purge) {
      if (refusedKill) {
        console.log("\n⚠️  Skipping purge: could not attribute the process on port — data preserved.");
        console.log("Stop the process manually, then re-run: flair uninstall --purge");
      } else {
        const home = resolveHome();
        const result = purgeFlairInstall({ homeDir: home });
        const report = formatPurgeReport(result);
        console.log(report.lines.join("\n"));
        if (purgeHadFailures(result)) process.exit(1);
      }
    } else {
      console.log("\nData and keys preserved at ~/.flair/");
      console.log("To remove everything: flair uninstall --purge");
    }
  });

}
