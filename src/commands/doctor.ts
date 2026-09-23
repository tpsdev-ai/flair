/**
 * doctor.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair doctor` plus its pure summary/exit helper (flair#721).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { COMPONENT_ENV_FILENAME, PUBLIC_URL_KEY, describePublicUrlFinding, readEnvValue } from "../component-env.js";
import { AgentGateState, checkClaudeMdBootstrap, checkContinuityCaptureHooks, describeAgentGateFinding, effectiveFlairUrl, embeddingsSkipRemedy, fixClaudeMdBootstrap, fixCommandAgentHint, fixContinuityCaptureHooks, fixSessionStartHook, inspectSessionStartHook, partitionKeyIds, planAgentIterations, readClientMcpBlock, resolveFixAgentId, resolveWireFlairUrl, upgradeSessionStartHookCommand } from "../doctor-client.js";
import { FleetPresenceRow, markStale, sortOldestVersionFirst } from "../fleet-presence.js";
import { hookSettingsPath, resolveHookAgentId } from "../hook-install.js";
import { detectClients, type ClientId, wireAntigravity, wireClaudeCode, wireCodex, wireCursor, wireGemini } from "../install/clients.js";
import { checkGlobalBinOnPath, resolveNpmGlobalPrefix } from "../install/global-bin-path.js";
import { buildEd25519Auth, defaultAdminPassPath, defaultKeysDir, resolveAdminUser, resolveKeyPath, resolveLocalAdminPass } from "../lib/auth-resolve.js";
import { flairConfigYamlCandidates, readPortFromYamlFile, resolveFlairConfigYaml } from "../lib/doctor-config-path.js";
import { collectFederationEnv, describeFederationDriverFinding, federationPeersConfigured, loadYamlDoc } from "../lib/doctor-federation-driver.js";
import { plistCarriesInlineAdminPassword } from "../lib/launchd-management.js";
import { DOCTOR_CHECK_IDS, catalogIssueDelta, mcpRepinIcon, renderCatalogDoctorLines, runDoctorChecks } from "../lib/doctor-run.js";
import { describeEmbedGpuDoctorFinding } from "../lib/embed-gpu-doctor.js";
import { adminPassDesyncFinding, detectPersistedAdminUser } from "../lib/init-admin-pass.js";
import { opsApiBindFinding } from "../lib/ops-api-bind.js";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec, unpinnedSpecWarning } from "../lib/mcp-spec.js";
import { mcpClientPinFindings, refreshOwnedPins, repinSessionStartHookGuarded, sessionStartHookPinFindings } from "../lib/owned-pins.js";
import * as render from "../render.js";
import { checkVersion, formatVersionNudge, probeInstanceVersion, FLAIR_PKG_NAME } from "../version-check.js";
import { resolveRegistryNotice } from "../lib/npm-registry.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type DoctorCli = {
  api: (...args: any[]) => any;
  checkAgentRegistered: (...args: any[]) => any;
  classifyOpsSocketPosture: (...args: any[]) => any;
  configPath: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  flairPackageDir: (...args: any[]) => any;
  listeningPidsOnPort: (...args: any[]) => any;
  persistDefaultInstallCoordinates: (...args: any[]) => any;
  planLaunchdRepairFor: (...args: any[]) => any;
  probeFlairReachable: (...args: any[]) => any;
  readHarperConfig: (...args: any[]) => any;
  readPortFromConfig: (...args: any[]) => any;
  relativeTime: (...args: any[]) => any;
  repairLaunchdManagement: (...args: any[]) => any;
  resolveHttpPort: (...args: any[]) => any;
  resolveOpsPort: (...args: any[]) => any;
  verifyAuditLog: (...args: any[]) => any;
  verifySemanticSearch: (...args: any[]) => any;
  __pkgVersion: any;
};

let cli: DoctorCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: DoctorCli): void {
  cli = fns;
}

function api(...args: any[]): any {
  return cli.api(...args);
}

function checkAgentRegistered(...args: any[]): any {
  return cli.checkAgentRegistered(...args);
}

function classifyOpsSocketPosture(...args: any[]): any {
  return cli.classifyOpsSocketPosture(...args);
}

function configPath(...args: any[]): any {
  return cli.configPath(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function flairPackageDir(...args: any[]): any {
  return cli.flairPackageDir(...args);
}

function listeningPidsOnPort(...args: any[]): any {
  return cli.listeningPidsOnPort(...args);
}

function persistDefaultInstallCoordinates(...args: any[]): any {
  return cli.persistDefaultInstallCoordinates(...args);
}

function planLaunchdRepairFor(...args: any[]): any {
  return cli.planLaunchdRepairFor(...args);
}

function probeFlairReachable(...args: any[]): any {
  return cli.probeFlairReachable(...args);
}

function readHarperConfig(...args: any[]): any {
  return cli.readHarperConfig(...args);
}

function readPortFromConfig(...args: any[]): any {
  return cli.readPortFromConfig(...args);
}

function relativeTime(...args: any[]): any {
  return cli.relativeTime(...args);
}

function repairLaunchdManagement(...args: any[]): any {
  return cli.repairLaunchdManagement(...args);
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveOpsPort(...args: any[]): any {
  return cli.resolveOpsPort(...args);
}

function verifyAuditLog(...args: any[]): any {
  return cli.verifyAuditLog(...args);
}

function verifySemanticSearch(...args: any[]): any {
  return cli.verifySemanticSearch(...args);
}

export function summarizeDoctorRun(
  found: number,
  fixed: number,
  autoFix: boolean,
): { line: string; exitCode: number } {
  const plural = (n: number) => `issue${n === 1 ? "" : "s"}`;
  if (found === 0) {
    return { line: `  ${render.icons.ok} ${render.wrap(render.c.green, "No issues found")}`, exitCode: 0 };
  }
  if (!autoFix) {
    return {
      line: `  ${render.icons.error} ${render.wrap(render.c.red, `${found} ${plural(found)} found`)} ${render.wrap(render.c.dim, "— see fixes above")}`,
      exitCode: 1,
    };
  }
  if (fixed >= found) {
    return {
      line: `  ${render.icons.ok} ${render.wrap(render.c.green, `${found} ${plural(found)} found, ${fixed} fixed ✓`)}`,
      exitCode: 0,
    };
  }
  const remaining = found - fixed;
  return {
    line: `  ${render.icons.error} ${render.wrap(render.c.red, `${found} ${plural(found)} found, ${fixed} fixed, ${remaining} remaining`)}`,
    exitCode: 1,
  };
}

/**
 * flair#1761 — the single place a Health-derived Metal finding becomes doctor
 * output and exit-code weight. Extracted from the action callback so the
 * detected-vs-env-vs-unrecognized severity is exercised on the real
 * rendering/counting path (the action's Harper probe, console side effects
 * and process.exit cannot be driven directly — see doctor-summary.test.ts for
 * the same extraction convention).
 *
 * The finding carries its own icon and issue weight: a derived ("detected")
 * Metal default is rendered as a persistent warning and does NOT increment
 * the issue count, while an explicit request or an unrecognized source is a
 * blocking `✗` that does. `lines` is returned for tests; production passes a
 * writer (default: console.log).
 */
export function renderEmbedGpuDoctorFinding(
  embedding: unknown,
  write: (line: string) => void = (line) => console.log(line),
): { lines: string[]; issueDelta: number } {
  const finding = describeEmbedGpuDoctorFinding(embedding);
  if (!finding) return { lines: [], issueDelta: 0 };
  const icon = finding.icon === "warn" ? render.icons.warn : render.icons.error;
  const lines = [
    `  ${icon} ${finding.message}`,
    `     ${render.wrap(render.c.dim, "Fix:")} ${finding.fixHint}`,
  ];
  for (const line of lines) write(line);
  return { lines, issueDelta: finding.isIssue ? 1 : 0 };
}

// ─── flair doctor ─────────────────────────────────────────────────────────────


export function register(program: Command): void {
  const __pkgVersion = cli.__pkgVersion;

// ─── flair doctor — pure summary/exit helper ─────────────────────────────────
// Extracted for testability (flair#721), same pattern as formatCandidateLine /
// describeReflectError in src/commands/rem.ts: the action callback spawns process.exit and a
// long sequence of console.log side effects, which makes it high-effort/
// low-value to drive directly — this is the actual decision logic. Before
// #721, doctor tracked only a single `issues` counter: every detected
// problem incremented it, and the final summary/exit-code read that counter
// alone, with no separate record of which of those issues `--fix` actually
// resolved during the same run. So a `--fix` run that interactively fixed
// every issue it found still printed "N issues found — see fixes above" and
// exited 1 — indistinguishable from a run that fixed nothing. This helper
// takes the accumulated found/fixed counts plus whether `--fix` was passed
// at all, and decides the summary line + exit code:
//   - 0 found                       → "No issues found", exit 0 (unchanged)
//   - found, no --fix               → "N issues found — see fixes above", exit 1 (unchanged)
//   - found, --fix, all fixed       → "N issues found, N fixed ✓", exit 0
//   - found, --fix, some remaining  → "N issues found, M fixed, K remaining", exit 1

program
  .command("doctor")
  .description("Diagnose common Flair problems and suggest fixes")
  .option("--port <port>", "Harper HTTP port")
  .option("--agent <id>", "Agent ID to use for the semantic-search round-trip (or FLAIR_AGENT_ID env)")
  .option("--fix", "Automatically fix issues where possible")
  .option("--dry-run", "Show what --fix would do without making changes")
  .action(async (opts) => {
    const port = resolveHttpPort(opts);
    const autoFix = opts.fix ?? false;
    const dryRun = opts.dryRun ?? false;
    if (dryRun && !autoFix) {
      console.log("  ℹ️  --dry-run only has effect with --fix\n");
    }
    let effectivePort = port;
    let baseUrl = `http://127.0.0.1:${port}`;
    let issues = 0;
    let fixed = 0; // issues that --fix successfully resolved during this run (flair#721)
    let harperResponding = false;
    let keyAgentIds: string[] = []; // populated by step 2 (Keys directory) below; feeds the flair#722 per-agent iteration
    let nodeKeyIds: string[] = []; // node-scoped federation keys; feeds the #1514 driver gate

    console.log(`\n${render.wrap(render.c.bold, "🩺 Flair Doctor")}\n`);

    // 0. Version check (flair#587) — offline-tolerant + cached, independent
    // of Harper being up. A gap of ≥2 minor versions (or any major) is
    // treated as loud/red — heuristic for "likely missed a security fix"
    // since we don't have advisory data, only the version gap. A red gap
    // counts as an issue (exit 1); a quieter yellow gap (one minor, or
    // patch-only) is printed but doesn't fail doctor.
    // ── flair#1072: the currency claim must be about the INSTANCE ─────────────
    //
    // This check used to run `checkVersion(__pkgVersion)` — the version of the
    // CLI you happen to have installed — and print "flair <x> is current". When
    // FLAIR_URL or --url points at a deployed instance, every other line doctor
    // prints is genuinely remote, so that sentence reads as a statement about
    // the thing you are talking to. It was a statement about your laptop.
    //
    // Reported against an instance five minors behind, where doctor said
    // "current". Telling you that is doctor's entire job.
    //
    // UNKNOWN MUST NOT FALL BACK TO THE LOCAL NUMBER. An older instance may not
    // expose its version at all, and the tempting fix is to use the one already
    // in hand — which is precisely how this bug reads today. If the instance
    // version cannot be determined, say so and count it as an issue rather than
    // answering from the wrong machine.
    const instanceVersion = await probeInstanceVersion(baseUrl);
    const versionSubject = instanceVersion ?? null;

    if (versionSubject === null) {
      console.log(
        `  ${render.icons.warn} ${render.wrap(render.c.yellow, `could not determine the version running at ${baseUrl} — not reporting currency. ` +
          `(The local CLI is ${__pkgVersion}; that is NOT the instance.)`)}`,
      );
      issues++;
    } else {
      const versionCheckResult = await checkVersion(versionSubject);
      const versionNudge = formatVersionNudge(versionCheckResult);
      if (versionNudge) {
        const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
        const icon = versionNudge.severity === "red" ? render.wrap(render.c.red, "✗") : render.icons.warn;
        console.log(`  ${icon} ${render.wrap(color, versionNudge.message)}`);
        if (versionNudge.severity === "red") issues++;
      } else if (versionCheckResult.latest) {
        console.log(`  ${render.icons.ok} instance at ${baseUrl} runs flair ${versionSubject} — current`);
      }
      if (versionSubject !== __pkgVersion) {
        console.log(
          `  ${render.icons.warn} ${render.wrap(render.c.yellow, `local CLI is ${__pkgVersion}, instance is ${versionSubject} — they differ. ` +
            `Commands run through the CLI; the instance serves the data.`)}`,
        );
      }
    }

    // flair#1692: name the registry (and where it came from) on every doctor
    // check, so a redirected mirror is visible to the operator.
    const registryNotice = await resolveRegistryNotice(FLAIR_PKG_NAME);
    if (registryNotice.line) {
      console.log(`  ${render.icons.info} ${render.wrap(render.c.dim, registryNotice.line)}`);
    }
    if (registryNotice.error) {
      console.log(`  ${render.icons.warn} ${render.wrap(render.c.yellow, registryNotice.error)}`);
      issues++;
    }

    // 0.5 npm global bin dir on PATH (flair#1134) — a user-prefix
    // `npm i -g` succeeds and then `flair` is command-not-found because
    // <prefix>/bin never made it into PATH. postinstall warns at install
    // time, but lifecycle scripts are suppressed on several real paths
    // (--ignore-scripts, bun without trustedDependencies, tar-swap
    // deploys), so doctor re-runs the same check — cheap, local, and
    // independent of Harper being up. When npm itself is absent or slow
    // the check SKIPS silently: flair may be installed by other means,
    // and "npm missing" has no actionable fix this check could print.
    const npmGlobalPrefix = await resolveNpmGlobalPrefix();
    if (npmGlobalPrefix) {
      const binCheck = checkGlobalBinOnPath({
        prefix: npmGlobalPrefix,
        pathEnv: process.env.PATH,
        shell: process.env.SHELL,
      });
      if ("message" in binCheck) {
        console.log(`  ${render.icons.warn} ${render.wrap(render.c.yellow, `npm global bin dir ${binCheck.binDir} is NOT on PATH — global npm installs (flair included) won't be found by name`)}`);
        for (const line of binCheck.message.split("\n")) {
          console.log(`     ${render.wrap(render.c.dim, line)}`);
        }
        issues++;
      } else {
        console.log(`  ${render.icons.ok} npm global bin dir ${render.wrap(render.c.dim, binCheck.binDir)} is on PATH`);
      }
    }

    // Helper: try to reach Harper on a given port.
    // Must return true ONLY when Harper's /Health endpoint returns 200 OK.
    // A generic HTTP status > 0 (flair#862) would accept 404 from a Node
    // inspector on 9229 or any other service — "present but wrong" beats
    // "absent but correct".
    async function probePort(p: number): Promise<boolean> {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/Health`, { signal: AbortSignal.timeout(3000) });
        return res.ok; // 200-299 only — /Health returns { ok: true } on 200
      } catch { return false; }
    }

    // Helper: discover what port a Harper PID is listening on.
    // Scans ALL listening ports for this PID and returns the first one that
    // responds to /Health with 200 OK. This avoids picking a debug port (9229)
    // or any non-Flair listener that happens to share the process (flair#862).
    async function discoverPortFromPid(pid: string): Promise<number | null> {
      // Defense-in-depth: caller already validates, but re-check here
      if (!/^\d+$/.test(pid)) return null;
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync(`lsof -aPi -p ${pid} -sTCP:LISTEN -Fn 2>/dev/null || true`, { encoding: "utf-8" });
        // Extract all ports from lsof -Fn output (lines like "n127.0.0.1:PORT")
        const ports = [...out.matchAll(/n(?:\S+):(\d+)/g)].map(m => Number(m[1]));
        if (ports.length === 0) return null;
        // Try each port until one responds to /Health with 200 OK
        for (const port of ports) {
          if (await probePort(port)) return port;
        }
        return null; // No port responded to /Health
      } catch { /* ignore */ }
      return null;
    }

    // 1. Port check — is something listening?
    // First, check PID file so we can cross-reference
    const dataDir0 = defaultDataDir();
    const pidFile0 = join(dataDir0, "hdb.pid");
    let pidAlive = false;
    let pidValue = "";
    if (existsSync(pidFile0)) {
      const rawPid = (await import("node:fs")).readFileSync(pidFile0, "utf-8").trim();
      // Strict integer validation — PID must be purely numeric to prevent injection
      if (/^\d+$/.test(rawPid)) {
        pidValue = rawPid;
        try { process.kill(Number(pidValue), 0); pidAlive = true; } catch { /* dead */ }
      } else {
        console.log(`  ${render.icons.warn} PID file contains non-numeric value: ${render.wrap(render.c.dim, pidFile0)} — skipping`);
      }
    }

    if (await probePort(port)) {
      console.log(`  ${render.icons.ok} Harper responding on port ${render.wrap(render.c.bold, String(port))}`);
      harperResponding = true;
    } else {
      // Port didn't respond — but if PID is alive, try to find the real port
      let discoveredPort: number | null = null;
      if (pidAlive) {
        discoveredPort = await discoverPortFromPid(pidValue);
        if (discoveredPort && discoveredPort !== port && await probePort(discoveredPort)) {
          console.log(`  ${render.icons.warn} Harper not on expected port ${port}, but responding on port ${render.wrap(render.c.bold, String(discoveredPort))} ${render.wrap(render.c.dim, `(PID ${pidValue})`)}`);
          console.log(`     ${render.wrap(render.c.dim, `Your config says port ${port} but Harper is actually running on ${discoveredPort}`)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would update config to port")} ${discoveredPort}`);
            } else {
              // dataDir0 is defaultDataDir() — `flair doctor` has no
              // --data-dir, so the default install is what it means, and
              // saying so keeps that true when it grows one (flair#914).
              persistDefaultInstallCoordinates(dataDir0, discoveredPort);
              console.log(`     ${render.icons.ok} Updated config to port ${discoveredPort}`);
              fixed++;
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(updates config to match running port)")}`);
          }
          effectivePort = discoveredPort;
          baseUrl = `http://127.0.0.1:${discoveredPort}`;
          harperResponding = true;
          issues++;
        } else {
          console.log(`  ${render.icons.error} Harper process alive (PID ${pidValue}) but not responding on any detected port`);
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          issues++;
        }
      } else {
        // No live PID — Harper genuinely isn't running
        // Check if something else grabbed the port
        try {
          const { execSync } = await import("node:child_process");
          // Listening sockets only, never our own PID — doctor has already
          // probed this port over HTTP, so a bare lsof reports doctor's own
          // process as the squatter and tells the operator to kill it
          // (flair#905; see parseListeningPids).
          const pids = listeningPidsOnPort(port, (cmd: string) => execSync(cmd, { encoding: "utf-8" }));
          if (pids.length > 0) {
            const lsof = pids.join(" ");
            console.log(`  ${render.icons.error} Nothing responding on port ${port} ${render.wrap(render.c.dim, `(port occupied by PID ${lsof})`)}`);
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} kill ${lsof} && flair restart`);
          } else {
            console.log(`  ${render.icons.error} Harper is not running`);
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          }
        } catch {
          console.log(`  ${render.icons.error} Harper is not running`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would run:")} flair restart`);
            } else {
              console.log(`     ${render.wrap(render.c.dim, "Attempting restart...")}`);
              try {
                const { execSync } = await import("node:child_process");
                execSync(`${process.argv[0]} ${process.argv[1]} restart --port ${port}`, { stdio: "inherit" });
                console.log(`     ${render.icons.ok} Restart attempted`);
                fixed++;
              } catch {
                console.log(`     ${render.icons.error} Restart failed — try: flair init --agent-id <your-agent>`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
          }
        }
        issues++;
      }
    }

    // 1a. CLI ↔ running-server version handshake (flair#695 §B) — the
    // version TRIPLE: this CLI's own version (__pkgVersion, checked against
    // npm-latest in step 0 above), and the RUNNING server's reported
    // version (GET /Health — public, no auth needed). A mismatch means the
    // installed package was upgraded but the daemon hasn't restarted onto
    // it yet — exactly the bare-npm trap the global preAction hook (above,
    // every other command) nudges about on stderr; doctor prints the full
    // picture here instead of a one-liner and `--fix` offers the restart.
    let runningVersion: string | null = null;
    let embedGpuFromHealth: unknown;
    if (harperResponding) {
      try {
        const healthRes = await fetch(`${baseUrl}/Health`, { signal: AbortSignal.timeout(3000) });
        if (healthRes.ok) {
          const body = (await healthRes.json()) as { version?: unknown; embedding?: unknown };
          runningVersion = typeof body?.version === "string" ? body.version : null;
          embedGpuFromHealth = body.embedding;
        }
      } catch { /* leave runningVersion null — reported below as "unknown" */ }

      if (runningVersion && runningVersion !== __pkgVersion) {
        console.log(`  ${render.icons.error} Version mismatch: CLI/installed ${render.wrap(render.c.bold, __pkgVersion)} but server is running ${render.wrap(render.c.bold, runningVersion)}`);
        if (autoFix) {
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would run:")} flair restart`);
          } else {
            try {
              const { execSync } = await import("node:child_process");
              execSync(`${process.argv[0]} ${process.argv[1]} restart --port ${effectivePort}`, { stdio: "inherit" });
              console.log(`     ${render.icons.ok} Restarted onto ${__pkgVersion}`);
              fixed++;
            } catch {
              console.log(`     ${render.icons.error} Restart failed — try: flair restart`);
            }
          }
        } else {
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair restart`);
        }
        issues++;
      } else if (runningVersion) {
        console.log(`  ${render.icons.ok} Server running version matches CLI (${runningVersion})`);
      } else {
        console.log(`  ${render.icons.warn} Could not determine the running server's version`);
      }

      // flair#1437 (severity split flair#1761): Health states an unconfirmed
      // Metal offload; operators read doctor. The finding carries its own
      // severity — a derived ("detected") default is an advisory warning that
      // does NOT fail the run, while an explicit request or an unrecognized
      // source still fails closed. A stated CPU default is silent here.
      issues += renderEmbedGpuDoctorFinding(embedGpuFromHealth).issueDelta;
    }

    // 2. Keys directory
    const keysDir = defaultKeysDir();
    if (existsSync(keysDir)) {
      const keyFiles = (await import("node:fs")).readdirSync(keysDir).filter((f: string) => f.endsWith(".key"));
      // ~/.flair/keys is shared by agent Ed25519 signing keys and node-scoped
      // federation keys (flair#1193). Only agent keys are signing identities;
      // node keys are AES-GCM keystore blobs that must never be parsed as, or
      // inferred as, an agent. Partition them out here so every downstream
      // consumer of keyAgentIds (registration checks, --fix inference,
      // fixCommandAgentHint) is node-free by construction.
      const partitioned = partitionKeyIds(
        keyFiles.map((f: string) => f.replace(/\.key$/, "")),
        keysDir,
      );
      keyAgentIds = partitioned.agentKeyIds;
      nodeKeyIds = partitioned.nodeKeyIds;
      if (keyAgentIds.length > 0) {
        console.log(`  ${render.icons.ok} Keys found: ${render.wrap(render.c.bold, String(keyAgentIds.length))} agent(s) in ${render.wrap(render.c.dim, keysDir)}`);
        if (partitioned.nodeKeyIds.length > 0) {
          console.log(`     ${render.icons.info} ${render.wrap(render.c.dim, `${partitioned.nodeKeyIds.length} node-scoped federation key(s) present — not agent signing keys; skipping`)}`);
        }
      } else if (partitioned.nodeKeyIds.length > 0) {
        // Node keys but no agent key: functionally there is no agent identity
        // here. Report it plainly (not the old DECODER false alarm) and point
        // at the real remedy. Kept a warn — not an issues++ — so a genuine
        // federation-only host doesn't newly fail doctor's exit code.
        console.log(`  ${render.icons.warn} No agent signing key found — only ${render.wrap(render.c.bold, String(nodeKeyIds.length))} node-scoped federation key(s) in ${render.wrap(render.c.dim, keysDir)}`);
        console.log(`     ${render.wrap(render.c.dim, "These are Fabric node keys, not agent identities. Fix:")} flair init --agent-id <your-agent>`);
      } else {
        console.log(`  ${render.icons.error} Keys directory exists but no .key files found`);
        console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
        issues++;
      }
    } else {
      console.log(`  ${render.icons.error} Keys directory missing: ${render.wrap(render.c.dim, keysDir)}`);
      console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
      issues++;
    }

    // 3. Config file (flair#1514) — same resolution Harper uses: cwd, then
    // the component/package dir, then ~/.flair. Looking only at
    // ~/.flair/config.yaml printed "using defaults" on wrapper-launched
    // component dirs whose real config is ~/agents/flair/config.yaml.
    const configLookup = {
      cwd: process.cwd(),
      homeDir: homedir(),
      componentDir: flairPackageDir(),
    };
    const cfgPath = resolveFlairConfigYaml(configLookup);
    if (cfgPath) {
      const savedPort = readPortFromYamlFile(cfgPath) ?? readPortFromConfig();
      console.log(`  ${render.icons.ok} Config: ${render.wrap(render.c.dim, cfgPath)} ${render.wrap(render.c.dim, `(port: ${savedPort ?? "default"})`)}`);
    } else {
      const tried = flairConfigYamlCandidates(configLookup);
      console.log(`  ${render.icons.warn} No config file at ${render.wrap(render.c.dim, tried[0] ?? configPath())} — using defaults`);
      if (tried.length > 1) {
        console.log(`     ${render.wrap(render.c.dim, `also tried: ${tried.slice(1).join(", ")}`)}`);
      }
    }

    // 3b. Ops API bind (flair#670) — report-only finding, never auto-fixed.
    // Rebinding the ops API requires a Harper restart to take effect, so
    // `doctor --fix` deliberately does not touch it here; the fix is
    // `flair init` (re-run, then `flair restart` to apply it) or a manual
    // harper-config.yaml edit + restart. flair#827: re-running `flair init`
    // used to regenerate ~/.flair/admin-pass unconditionally, desyncing it
    // from Harper's already-persisted credential and breaking admin auth on
    // the very re-run this remedy prescribed — resolveInitAdminPasswordSource
    // (see its doc comment) now reuses the existing password instead, so this
    // remedy is safe to follow on a working install.
    try {
      const finding = opsApiBindFinding(readHarperConfig(defaultDataDir()));
      if (finding?.allInterfaces) {
        console.log(`  ${render.icons.error} ${finding.message}`);
        console.log(`     ${render.wrap(render.c.dim, finding.remedy)}`);
        issues++;
      }
    } catch { /* best-effort — don't fail doctor over a malformed harper-config.yaml */ }

    // 3b2. Admin-pass vs persisted Harper user (flair#837) — report-only,
    // never `--fix`. File missing + hdb_user still in the data dir is the
    // state bare `init` used to "fix" by writing a fresh file that 401s.
    // The remedy names the two exits: `--admin-pass-file` / `--reset-admin-pass`.
    try {
      const dataDir = defaultDataDir();
      const finding = adminPassDesyncFinding({
        adminPassFileExists: existsSync(defaultAdminPassPath()),
        persistedAdminUser: detectPersistedAdminUser(dataDir),
        dataDir,
        adminPassPath: defaultAdminPassPath(),
      });
      if (finding?.flagged) {
        console.log(`  ${render.icons.error} ${finding.message}`);
        console.log(`     ${render.wrap(render.c.dim, finding.remedy)}`);
        issues++;
      }
    } catch { /* best-effort — a missing data dir is not a doctor crash */ }

    // 3c. Ops-socket permission posture (flair#763) — report-only, never
    // auto-fixed. Re-tightening a live socket needs a restart, so the remedy is
    // `flair init`/restart (which re-applies the posture), not a `doctor --fix`.
    // Only assessed when the socket exists (Harper has booted at least once).
    try {
      const socketPath = join(defaultDataDir(), "operations-server");
      if (existsSync(socketPath)) {
        const dirMode = statSync(dirname(socketPath)).mode;
        const socketMode = statSync(socketPath).mode;
        const groupOptIn = !!(process.env.FLAIR_SOCKET_GROUP && process.env.FLAIR_SOCKET_GROUP.trim().length > 0);
        const verdict = classifyOpsSocketPosture(dirMode, socketMode, groupOptIn);
        if (verdict.flagged) {
          console.log(`  ${render.icons.error} Ops socket permissions: ${verdict.reason}`);
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init ${render.wrap(render.c.dim, "(re-applies the 0700 dir / 0600 socket posture on next start; set FLAIR_SOCKET_GROUP for deliberate multi-user access)")}`);
          issues++;
        }
      }
    } catch { /* best-effort — a stat failure shouldn't fail doctor */ }

    // 3d. The URL this instance tells the world to use (flair#1005, flair#1000).
    //
    // Asks the instance for its OWN discovery document rather than inferring
    // anything from config: /OAuthMetadata's `issuer` is the exact field that was
    // wrong in flair#1000, and it is the only thing that proves what a client
    // will actually be handed. describePublicUrlFinding (src/component-env.ts) is
    // pure decision logic, unit-tested, and documents in its own header why the
    // detectable condition is DRIFT rather than "unset on a public instance" —
    // doctor reaches this instance over loopback and cannot observe whether it is
    // also reachable at a public address.
    if (harperResponding) {
      let advertisedIssuer: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/OAuthMetadata`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const doc = (await res.json()) as { issuer?: unknown };
          if (typeof doc?.issuer === "string" && doc.issuer !== "") advertisedIssuer = doc.issuer;
        }
      } catch { /* unreachable/unparseable → null → the finding is skipped, not passed */ }

      // The component directory for a local install is the flair package itself:
      // `flair start` spawns `harper run .` with cwd = flairPackageDir().
      // That path is often inside node_modules on an npm install-g; doctor still
      // READs it for drift detection, but describePublicUrlFinding never names
      // it as the fix (flair#1313 — wiped on every upgrade).
      const componentEnvPath = join(flairPackageDir(), COMPONENT_ENV_FILENAME);
      let componentEnvValue: string | null = null;
      try {
        if (existsSync(componentEnvPath)) {
          componentEnvValue = readEnvValue(readFileSync(componentEnvPath, "utf-8"), PUBLIC_URL_KEY);
        }
      } catch { /* unreadable → treat as absent */ }

      const finding = describePublicUrlFinding({
        advertisedIssuer,
        componentEnvValue,
        processEnvValue: process.env.FLAIR_PUBLIC_URL ?? null,
        componentEnvPath,
      });
      if (finding) {
        const icon =
          finding.icon === "ok" ? render.icons.ok
          : finding.icon === "warn" ? render.icons.warn
          : render.icons.error;
        console.log(`  ${icon} ${finding.message}`);
        if (finding.fixHint) console.log(`     ${render.wrap(render.c.dim, "Fix:")} ${finding.fixHint}`);
        if (finding.isIssue) issues++;
      }
    }

    // 4. Embeddings check — REAL semantic round-trip (only if Harper is responding).
    //
    // The dead-simple `{ q: "test" }` probe used to pass even when embeddings were
    // not loaded: SemanticSearch falls back to keyword-only scan, and an
    // unauthenticated probe 401s → "cannot verify" → no issue counted. A clean-VM
    // dogfood found semantic search DEAD out of the box (sudo/root-owned install
    // can't write the models symlink → EACCES) while `flair doctor` reported
    // "no issues found". This now stores a memory with a distinctive phrase and
    // searches for a PARAPHRASE (no shared keywords). If the top result isn't
    // recovered by MEANING, recall-by-meaning is broken and doctor FAILS LOUDLY.
    if (harperResponding) {
      const semanticStatus = await verifySemanticSearch(baseUrl, opts.agent, defaultKeysDir());
      switch (semanticStatus.state) {
        case "ok":
          console.log(`  ${render.icons.ok} Embeddings: semantic search operational ${render.wrap(render.c.dim, `(paraphrase recall verified, score ${semanticStatus.score.toFixed(2)})`)}`);
          break;
        case "degraded":
          // LOUD failure — never report all-clear when recall-by-meaning is dead.
          console.log(`  ${render.icons.error} Semantic search DEGRADED ${render.wrap(render.c.dim, `— ${semanticStatus.detail}`)}`);
          console.log(`     ${render.wrap(render.c.red, "Embeddings are not loaded; recall-by-meaning will NOT work.")}`);
          console.log(`     ${render.wrap(render.c.dim, "Common cause: the embeddings component lacks write access (sudo/root global installs).")}`);
          console.log(`     ${render.wrap(render.c.dim, "See:")} docs/troubleshooting.md ${render.wrap(render.c.dim, "→ \"Semantic search DEGRADED\"")}`);
          issues++;
          break;
        case "failed":
          // flair#1501: a rejected signature is LOUD. It is either a real auth
          // defect (the key is unregistered or stale) or a doctor defect, and
          // both need a person — never soften it to "not verified". The detail
          // names the identity and key path the probe signed with.
          console.log(`  ${render.icons.error} Embeddings: probe rejected ${render.wrap(render.c.dim, `— ${semanticStatus.detail}`)}`);
          console.log(`     ${render.wrap(render.c.dim, "Fix: register this key on the instance (`flair agent add <id>`) or pass --agent <a registered agent id>.")}`);
          issues++;
          break;
        case "skipped": {
          // Could not run the round-trip. Don't claim all-clear — surface that
          // the check was skipped, but don't count it as a hard issue since
          // the user may simply not have an agent yet.
          //
          // flair#1023: the remedy is chosen from the classified reason
          // (embeddingsSkipRemedy, src/doctor-client.ts) instead of being
          // printed unconditionally. A key that will not decode gets no
          // "pass --agent" advice, because following it changes nothing.
          console.log(`  ${render.icons.warn} Embeddings: not verified ${render.wrap(render.c.dim, `(${semanticStatus.detail})`)}`);
          const remedy = embeddingsSkipRemedy(semanticStatus.reason);
          if (remedy) console.log(`     ${render.wrap(render.c.dim, remedy)}`);
          break;
        }
      }
    }

    // 4b. Audit-log positive control (flair#970) — REAL write→read_audit_log
    // round-trip, only if Harper is responding. `describe_table` reporting
    // `audit: true` proves nothing: a node that joined or resynced via
    // cluster base copy holds zero audit history while reporting audit
    // enabled and answering read_audit_log with clean empty (harper#2212).
    // So doctor writes probe rows and asserts their audit entries come back —
    // never trusts the flag. Same ok/degraded/skipped discipline as the
    // embeddings check above: skipped is rendered UNVERIFIED, never as a pass.
    if (harperResponding) {
      // read_audit_log only exists on the ops API (its own port), which the
      // agent's Ed25519 header cannot authenticate — resolve the local admin
      // credential (env or ~/.flair/admin-pass; never prompts). A file with
      // unsafe permissions throws — that is "could not probe", not "broken".
      let auditAdminPass: string | undefined;
      let auditCredIssue: string | null = null;
      try {
        auditAdminPass = resolveLocalAdminPass(undefined);
      } catch (err: unknown) {
        auditCredIssue = err instanceof Error ? err.message : String(err);
      }
      const auditStatus = auditCredIssue
        ? ({ state: "skipped", reason: "no-admin-credentials", detail: auditCredIssue } as const)
        : await verifyAuditLog(
            baseUrl,
            opts.agent,
            defaultKeysDir(),
            `http://127.0.0.1:${resolveOpsPort(opts)}`,
            resolveAdminUser(undefined),
            auditAdminPass,
          );
      switch (auditStatus.state) {
        case "ok":
          // Present-tense claim ONLY (see AuditVerifyResult): the probe
          // proves the log records writes NOW — never that history is
          // complete. Overclaiming here would rebuild the false trust
          // anchor this check exists to kill, one layer up.
          console.log(`  ${render.icons.ok} Audit log: recording (verified now) ${render.wrap(render.c.dim, "(verifies current recording, not history — a resynced node's audit has a hard start boundary at its copy time)")}`);
          break;
        case "degraded":
          if (auditStatus.cause === "disabled") {
            console.log(`  ${render.icons.error} Audit log DISABLED ${render.wrap(render.c.dim, `— ${auditStatus.detail}`)}`);
            console.log(`     ${render.wrap(render.c.dim, "Fix: enable logging.auditLog in the ROOT harperdb-config.yaml (the Harper instance config, NOT flair's component config.yaml), then restart Harper.")}`);
          } else {
            console.log(`  ${render.icons.error} Audit log NOT RECORDING ${render.wrap(render.c.dim, `— ${auditStatus.detail}`)}`);
            console.log(`     ${render.wrap(render.c.red, "Audit reports as enabled, but fresh writes produced no audit entries — do not treat the audit log as a record of what happened.")}`);
            console.log(`     ${render.wrap(render.c.dim, "On a node that joined or resynced via cluster base copy, audit history has a hard start boundary at copy time (harper#2212) — \"no history\" does not mean \"nothing happened\".")}`);
            console.log(`     ${render.wrap(render.c.dim, "Check logging.auditLog in the ROOT harperdb-config.yaml (not flair's component config.yaml), then restart Harper.")}`);
          }
          issues++;
          break;
        case "failed":
          // Same loud discipline as the embeddings probe above (flair#1501).
          console.log(`  ${render.icons.error} Audit log: probe rejected ${render.wrap(render.c.dim, `— ${auditStatus.detail}`)}`);
          console.log(`     ${render.wrap(render.c.dim, "Fix: register this key on the instance (`flair agent add <id>`) or pass --agent <a registered agent id>.")}`);
          issues++;
          break;
        case "skipped":
          // An unrun check must not look like a pass — UNVERIFIED, visually
          // distinct from ok, but not a hard issue (mirrors the embeddings
          // skip: the operator may simply have no agent or no local admin
          // credential on this box).
          console.log(`  ${render.icons.warn} Audit log: UNVERIFIED (could not probe — ${auditStatus.detail})`);
          break;
      }
    }

    // 5. Stale PID file (skip if already reported in port check)
    const dataDir = defaultDataDir();
    const pidFile = join(dataDir, "hdb.pid");
    if (existsSync(pidFile)) {
      const pidContent = (await import("node:fs")).readFileSync(pidFile, "utf-8").trim();
      try {
        process.kill(Number(pidContent), 0);
        if (harperResponding) {
          console.log(`  ${render.icons.ok} PID file: ${render.wrap(render.c.dim, pidFile)} ${render.wrap(render.c.dim, `(process ${pidContent} is alive)`)}`);
        }
        // If not responding, we already reported the issue in step 1
      } catch {
        console.log(`  ${render.icons.error} Stale PID file: ${render.wrap(render.c.dim, pidFile)} ${render.wrap(render.c.dim, `(process ${pidContent} is dead)`)}`);
        if (autoFix) {
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would remove:")} ${pidFile}`);
          } else {
            (await import("node:fs")).unlinkSync(pidFile);
            console.log(`     ${render.icons.ok} Removed stale PID file`);
            fixed++;
          }
        } else {
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} rm ${pidFile} && flair restart`);
        }
        issues++;
      }
    }

    // 6. Data directory
    if (existsSync(dataDir)) {
      console.log(`  ${render.icons.ok} Data directory: ${render.wrap(render.c.dim, dataDir)}`);
    } else {
      // Check ~/harper/ (common alternative)
      const altDir = join(homedir(), "harper");
      if (existsSync(altDir)) {
        console.log(`  ${render.icons.warn} Data at ${render.wrap(render.c.dim, "~/harper/")} (not ${render.wrap(render.c.dim, "~/.flair/data")}) — old install location`);
      } else {
        console.log(`  ${render.icons.error} No data directory found`);
        console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair init --agent-id <your-agent>`);
        issues++;
      }
    }

    // 7. Client integration (flair#588) — the first 6 checks diagnose the
    // SERVER side. This diagnoses whether Flair is actually wired to a real
    // client: for MCP clients (Claude Code, Codex, Gemini, Cursor,
    // Antigravity) the MCP block present + reachable + the configured agent
    // genuinely registered; for pi (a NATIVE EXTENSION host — flair#1342) the
    // pi-flair reference in pi's own settings, including the flair#1346
    // npm:-under-"extensions" trap; plus CLAUDE.md (Claude Code) and the
    // SessionStart hook (Claude Code + Codex — flair#1148). Reuses
    // detectClients() rather than reimplementing client detection.
    console.log(`\n  ${render.wrap(render.c.bold, "Client integration")}`);

    // Prompt y/N before a content-editing fix, but only when interactive —
    // in a non-TTY context (CI, scripts) --fix itself is the consent signal,
    // matching how doctor's other --fix branches already behave unprompted.
    // Mirrors the confirm pattern at `flair fabric upgrade` (~line 6258).
    async function confirmFix(question: string): Promise<boolean> {
      if (!process.stdin.isTTY) return true;
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question(question, (a) => { rl.close(); res(a); }),
      );
      return /^y(es)?$/i.test(answer.trim());
    }

    const detectedClients = detectClients().filter((c) => c.detected);
    // flair#1439 — install-health (MCP, FLAIR_URL, CLAUDE.md, SessionStart
    // hook, verified-read plan, keys classification, launchd) is the same
    // catalog upgrade asserts. Adding a check to DOCTOR_CHECK_IDS widens
    // both. Extra doctor UX (pi, --fix, execution probe, continuity,
    // agent registration) stays below and does not redefine those checks.
    //
    // flair#1573 slice b — launchd management is diagnosed + repaired by its
    // own section below (planLaunchdRepairFor / repairLaunchdManagement), not
    // by the install-health catalog. The catalog's launchd check stays for
    // `upgrade` (flair#1022), but doctor would otherwise double-count the same
    // drift (catalog "detached" fail + repair "regenerate"/"adopt"/"refuse").
    const doctorCatalogIds = DOCTOR_CHECK_IDS.filter((id) => id !== "launchd-management");
    const doctorCtx = {
      homeDir: homedir(),
      cwd: process.cwd(),
      detectedClientIds: detectedClients.map((c) => c.id),
      keysDir,
      keyAgentIds,
      agentFlag: typeof opts.agent === "string" ? opts.agent : undefined,
    };
    const catalogBefore = runDoctorChecks(doctorCtx, { catalogIds: doctorCatalogIds });
    if (detectedClients.length === 0) {
      console.log(`  ${render.icons.info} No MCP client detected — skipping client-integration checks`);
    } else {
      let claudeCodeAgentId: string | undefined;
      let codexAgentId: string | undefined;
      let anyKnownAgentId: string | undefined;

      // `doctor --fix` writes client configs through the same wire functions
      // init does, so it owes the user the same warning when the spec it would
      // write cannot be pinned (flair#907).
      if (autoFix) {
        const pinWarning = unpinnedSpecWarning();
        if (pinWarning) {
          for (const line of pinWarning.split("\n")) console.log(`  ${render.icons.warn} ${line}`);
        }
      }

      for (const client of detectedClients) {
        // flair#989 — pi is a dead namespace: the pi (kind:
        // "native-extension") check is removed from doctor entirely. pi was
        // the last non-MCP client here, and a detected-but-unwired pi was
        // counted as an install failure for a namespace nobody opts into any
        // more. Doctor now diagnoses only MCP clients the user wired (below).
        if (client.kind !== "mcp") continue;

        const block = readClientMcpBlock(client.id, homedir());
        if (client.id === "claude-code" && block.agentId) claudeCodeAgentId = block.agentId;
        if (client.id === "codex" && block.agentId) codexAgentId = block.agentId;
        if (block.agentId) anyKnownAgentId = anyKnownAgentId ?? block.agentId;

        if (!block.present) {
          // flair#989: this client is DETECTED (binary/config on the box) but
          // was never wired to Flair — the user did not opt into it. That is
          // not an install FAILURE, so it renders as info, never a ✗, and is
          // not counted (the catalog's opt-in mcp-block check owns the count).
          // `--fix` still offers to wire it, on the user's y/N consent.
          console.log(`  ${render.icons.info} ${client.label}: detected but not wired to Flair — optional (no Flair MCP server in ${render.wrap(render.c.dim, block.configPath)})`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would wire")} ${client.label} (writes ${block.configPath})`);
            } else {
              const proceed = await confirmFix(`  Wire ${client.label} now? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                // flair#802b: fall back to the sole locally-keyed agent when
                // nothing else identifies one — the only case doctor can
                // infer without being told (see inferSoleAgentId's doc
                // comment in doctor-client.ts for why 0/2+ keys don't guess).
                // flair#1193: resolveFixAgentId additionally refuses a
                // node-scoped federation id from ANY source (inference, env,
                // or a wired block a prior buggy run may have poisoned) — a
                // node id can't sign, so wiring it would authenticate the
                // connector as a phantom unregistered node.
                const fixAgentId = resolveFixAgentId({
                  optsAgent: opts.agent,
                  envAgentId: process.env.FLAIR_AGENT_ID,
                  anyKnownAgentId,
                  keyAgentIds,
                  keysDir: defaultKeysDir(),
                });
                if (!fixAgentId) {
                  if (keyAgentIds.length > 1) {
                    console.log(`     ${render.icons.warn} Cannot auto-wire ${client.label}: multiple agents found (${[...keyAgentIds].sort().join(", ")}) — pass --agent <id> to choose which one`);
                  } else {
                    console.log(`     ${render.icons.warn} Cannot auto-wire ${client.label}: no agent identity found in keys/ — run \`flair init --agent <name>\` or \`flair agent add <name>\` before wiring a connector`);
                  }
                } else {
                  const wireEnv = { FLAIR_AGENT_ID: fixAgentId, FLAIR_URL: resolveWireFlairUrl(block.flairUrl, baseUrl) };
                  const wireResult =
                    client.id === "claude-code" ? wireClaudeCode(wireEnv) :
                    client.id === "codex" ? wireCodex(wireEnv) :
                    client.id === "gemini" ? wireGemini(wireEnv) :
                    client.id === "antigravity" ? wireAntigravity(wireEnv) :
                    wireCursor(wireEnv);
                  console.log(`     ${wireResult.ok ? render.icons.ok : render.icons.warn} ${wireResult.message}`);
                  if (wireResult.ok) {
                    if (client.id === "claude-code") claudeCodeAgentId = fixAgentId;
                    if (client.id === "codex") codexAgentId = fixAgentId;
                    anyKnownAgentId = anyKnownAgentId ?? fixAgentId;
                  }
                }
              }
            }
          } else {
            // flair#802b: only splice in a concrete --agent if the id isn't
            // already resolvable some other way — an explicit --agent /
            // FLAIR_AGENT_ID / an already-wired client's agent id means bare
            // `--fix` already works, so don't clutter the suggestion.
            const knownAgentId = opts.agent || process.env.FLAIR_AGENT_ID || anyKnownAgentId;
            const agentHint = knownAgentId ? "" : fixCommandAgentHint(keyAgentIds);
            console.log(`     ${render.wrap(render.c.dim, "To wire it (optional):")} flair doctor --fix${agentHint} ${render.wrap(render.c.dim, `(wires ${client.label})`)}`);
          }
          continue;
        }

        console.log(`  ${render.icons.ok} ${client.label}: MCP server configured (${render.wrap(render.c.dim, block.configPath)})`);

        // flair#1287: a block with FLAIR_AGENT_ID but no FLAIR_URL is a
        // WORKING setup — flair-client falls back to its built-in default —
        // and must never be reported as unconfigured. Say which URL applies
        // and keep verifying against it, exactly as for an explicit one.
        const eff = effectiveFlairUrl(block);
        const urlLabel = eff.defaulted ? `${eff.url} (client default)` : eff.url;
        if (eff.defaulted) {
          console.log(`     ${render.icons.info} FLAIR_URL not set — flair-mcp defaults to ${render.wrap(render.c.dim, eff.url)}`);
        }

        const reachable = await probeFlairReachable(eff.url);
        if (!reachable) {
          console.log(`     ${render.icons.warn} FLAIR_URL ${render.wrap(render.c.dim, urlLabel)} not reachable — cannot verify agent registration`);
          continue;
        }
        console.log(`     ${render.icons.ok} FLAIR_URL ${render.wrap(render.c.dim, urlLabel)} reachable`);

        const reg = await checkAgentRegistered(eff.url, block.agentId!, defaultKeysDir());
        if (reg.state === "registered") {
          console.log(`     ${render.icons.ok} agent '${block.agentId}' registered`);
        } else if (reg.state === "not-registered") {
          console.log(`     ${render.icons.error} agent '${block.agentId}' is NOT registered on this Flair instance`);
          console.log(`        ${render.wrap(render.c.dim, "Fix:")} flair agent add ${block.agentId}`);
          issues++;
        } else {
          // flair#1023: `reachable` was just established two lines above, so
          // reuse the same self-inconsistency guard the agent gates use
          // rather than echoing a detail that may claim the opposite.
          const finding = describeAgentGateFinding(block.agentId!, reg.state, reg.detail, { instanceReachable: reachable });
          console.log(`     ${render.icons.warn} ${finding?.message ?? `could not verify agent registration (${reg.detail})`}`);
        }
      }

      // flair#1779: `doctor --fix` re-pins a BEHIND MCP-client block the same
      // way it re-pins a behind SessionStart hook. It routes through the ONE
      // guarded writer the upgrade refresh uses (refreshOwnedPins), restricted
      // to the behind wired clients and preserving each block's OWN agent id
      // and FLAIR_URL. ahead/unknown are HELD (already a pass/warn), so only
      // `behind` is written; the catalog delta below counts the fix.
      if (autoFix) {
        const behindMcp = mcpClientPinFindings(homedir(), flairCliVersion())
          .filter((f) => f.direction === "behind")
          // flair#1834 A1: key off STRUCTURAL presence (entryExists), not
          // `present` (= agent id set). A behind entry without an identity is
          // still a pin we own and re-pin — the pin-only writer preserves
          // whatever identity the entry carries.
          .filter((f) => f.reading.entryExists);
        if (behindMcp.length > 0) {
          if (dryRun) {
            for (const f of behindMcp) {
              console.log(`     ${render.wrap(render.c.dim, "Would re-pin the MCP server block in")} ${f.reading.target.path}`);
            }
          } else {
            const overrides = behindMcp.map((f) => {
              const id = f.reading.target.id as ClientId;
              return { kind: "mcp-client" as const, id };
            });
            const results = refreshOwnedPins({ homeDir: homedir(), targets: overrides });
            for (const r of results) {
              if (r.target.kind !== "mcp-client") continue;
              // flair#1834 round 3: an attempted-but-skipped fix (e.g. a behind
              // Codex pin until A2 lands) is not a success — never ✓.
              console.log(`     ${render.icons[mcpRepinIcon(r.action, r.ok)]} ${r.message}`);
            }
          }
        }
      }

      // flair#989: the harness-specific checks below (CLAUDE.md, SessionStart
      // hook, continuity, Codex hook) run only for a harness the user actually
      // WIRED — its MCP block is present. A harness merely DETECTED on the box
      // but never opted into owes none of these; flagging them was the false-
      // positive this fix removes. Read the block fresh so a `--fix` that just
      // wired the client during the loop above is reflected here.
      const claudeCodeDetected = detectedClients.some((c) => c.id === "claude-code");
      const claudeCodeConfigured =
        claudeCodeDetected && readClientMcpBlock("claude-code", homedir()).present;
      const codexConfigured =
        detectedClients.some((c) => c.id === "codex") && readClientMcpBlock("codex", homedir()).present;

      // Claude-Code-specific: CLAUDE.md + SessionStart hook + continuity.
      // Codex has a SessionStart hook too (checked below); CLAUDE.md and
      // continuity stay Claude Code only.
      //
      // flair#989: CLAUDE.md and the SessionStart hook are wiring-dependent —
      // they apply, and can only fail, once Claude Code is WIRED — so they are
      // gated on `claudeCodeConfigured`. Continuity (below) is a separate
      // opt-in that renders "not enabled" as info and never a failure, so it
      // stays gated on mere detection (flair#1324/#1257).
      if (claudeCodeConfigured) {
        const claudeMd = checkClaudeMdBootstrap(process.cwd(), homedir());
        if (claudeMd.present) {
          console.log(`  ${render.icons.ok} CLAUDE.md: bootstrap instruction present (${render.wrap(render.c.dim, claudeMd.path!)})`);
        } else {
          console.log(`  ${render.icons.error} CLAUDE.md: bootstrap instruction not found (checked ${render.wrap(render.c.dim, join(process.cwd(), "CLAUDE.md"))} and ${render.wrap(render.c.dim, join(homedir(), ".claude", "CLAUDE.md"))})`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would append bootstrap instruction to")} ${join(process.cwd(), "CLAUDE.md")}`);
            } else {
              const proceed = await confirmFix(`  Add the Flair bootstrap line to ./CLAUDE.md? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixRes = fixClaudeMdBootstrap(process.cwd());
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(adds the mcp__flair__bootstrap line to ./CLAUDE.md)")}`);
          }
        }

        // flair#1007: presence was never the problem — the failing entry was
        // perfectly well-formed. inspectSessionStartHook() additionally RUNS
        // the registered command (bounded, side-effect-free via
        // FLAIR_HOOK_PROBE) so doctor can tell "wired" from "wired and still
        // works", and reports the shell-level silencing separately so an
        // already-installed loud hook can be upgraded rather than only
        // diagnosed.
        const hook = inspectSessionStartHook(homedir());
        if (hook.present) {
          // flair#1485: pin ≠ installed CLI version is a failure, never a
          // ✓ "still runs". Check freshness first so a stale pin cannot
          // hide behind the execution probe. Catalog owns the issue count.
          const claudeStale = sessionStartHookPinFindings(homedir()).find((f) => f.reading.target.id === "claude-code");
          if (claudeStale && claudeStale.direction === "unknown") {
            // flair#1778: a pin we cannot compare is its OWN finding — a warn,
            // never the stale "old adapter" error, and NOT re-pinned (the
            // refresh holds an unreadable pin). Needs no --fix.
            console.log(`  ${render.icons.warn} SessionStart hook: pin is not a version I can compare: ${claudeStale.reading.pin} — not re-pinned; re-run flair init or edit the hook if this is unintended`);
          } else if (claudeStale && claudeStale.direction === "ahead") {
            // flair#1778 follow-up: a pin AHEAD of the running CLI is not stale
            // — re-pinning would LOWER it and the refresh HOLDS it. Report a
            // held pass: no ✗, no issue count (the catalog agrees), no --fix.
            console.log(`  ${render.icons.ok} SessionStart hook: pinned to flair-mcp@${claudeStale.reading.pin}, ahead of the installed CLI ${flairCliVersion()} — held`);
          } else if (claudeStale) {
            console.log(`  ${render.icons.error} SessionStart hook: pinned to flair-mcp@${claudeStale.reading.pin} (installed CLI is ${flairCliVersion()}) — the hook still launches the OLD adapter on every session`);
            if (autoFix) {
              if (dryRun) {
                console.log(`     ${render.wrap(render.c.dim, "Would re-pin the SessionStart hook in")} ${hook.path}`);
              } else {
                const repin = repinSessionStartHookGuarded(homedir(), "claude-code");
                // flair#1834 A1 round 3 + PR-H: the SAME icon rule as the MCP
                // re-pin line — a hold (or a failed write) renders ⚠, never a
                // false ✓ for an attempted-but-held fix.
                console.log(`     ${render.icons[mcpRepinIcon(repin.action, repin.ok)]} ${repin.message}`);
              }
            } else {
              console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair hook install ${render.wrap(render.c.dim, "(re-pins the hook to the installed CLI version)")}`);
            }
          } else if (hook.execution === "broken") {
            // Two very different states that share one probe outcome:
            //
            // 1. Silenced (current) command that didn't run — the npx cache
            //    is cold, the machine is offline, or the adapter hasn't been
            //    fetched yet.  On a fresh install this is NORMAL: the hook is
            //    wired but no Claude Code session has exercised it yet.
            //    Report as informational, not a warning, and never suggest
            //    reinstall — the setup is correct, the environment just
            //    hasn't warmed yet.
            //
            // 2. Unsilenced (legacy) command that didn't run — the hook has
            //    been in place long enough that a cold cache is not the
            //    explanation.  This IS a genuine failure: warn and name the
            //    actual state with a fitting remedy.
            if (hook.silenced) {
              console.log(`  ${render.icons.ok} SessionStart hook: wired in ${render.wrap(render.c.dim, hook.path)} — not yet exercised`);
              console.log(`     ${render.wrap(render.c.dim, hook.detail ?? "")}`);
              console.log(`     ${render.wrap(render.c.dim, "The hook is correctly wired but the adapter has not been fetched yet.")}`);
              console.log(`     ${render.wrap(render.c.dim, "This is normal on a fresh install — the first Claude Code session will warm the npx cache.")}`);
            } else {
              console.log(`  ${render.icons.warn} SessionStart hook: wired in ${render.wrap(render.c.dim, hook.path)}, but its command did not run just now`);
              console.log(`     ${render.wrap(render.c.dim, hook.detail ?? "")}`);
              console.log(`     ${render.wrap(render.c.dim, "The hook command could not be executed. Check that npx can resolve")}`);
              console.log(`     ${render.wrap(render.c.dim, "@tpsdev-ai/flair-mcp — a cold npx cache or network issue")}`);
              console.log(`     ${render.wrap(render.c.dim, "issue can prevent the adapter from running on its first invocation.")}`);
              console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(rewrites the hook to the current silent-failure form)")}`);
            }
          } else if (hook.execution === "unknown") {
            console.log(`  ${render.icons.warn} SessionStart hook: wired in ${render.wrap(render.c.dim, hook.path)}, but could not be verified ${render.wrap(render.c.dim, `(${hook.detail ?? "no detail"})`)}`);
          } else if (!hook.ours) {
            console.log(`  ${render.icons.ok} SessionStart hook: wired in ${render.wrap(render.c.dim, hook.path)} ${render.wrap(render.c.dim, "(custom command — not verified, not modified)")}`);
          } else {
            console.log(`  ${render.icons.ok} SessionStart hook: flair-session-start wired in ${render.wrap(render.c.dim, hook.path)} ${render.wrap(render.c.dim, "and still runs")}`);
          }

          // Independent of whether it runs today: would it stay quiet if it
          // stopped? Only offered as a repair when the command is the exact
          // string Flair itself wrote — a hand-edited or pinned hook is the
          // user's, and doctor reports on it rather than rewriting it.
          if (!hook.silenced && hook.ours) {
            console.log(`  ${render.icons.warn} SessionStart hook: a failure would print an error on every session (this command predates the silent-failure fix)`);
            if (hook.upgradable) {
              if (autoFix) {
                if (dryRun) {
                  console.log(`     ${render.wrap(render.c.dim, "Would rewrite the hook command in")} ${hook.path}`);
                } else {
                  const proceed = await confirmFix(`  Rewrite the Flair SessionStart hook in ${hook.path} so failures stay silent? [y/N] `);
                  if (!proceed) {
                    console.log(`     Skipped.`);
                  } else {
                    const upgrade = upgradeSessionStartHookCommand(homedir());
                    console.log(`     ${upgrade.ok ? render.icons.ok : render.icons.warn} ${upgrade.message}`);
                  }
                }
              } else {
                console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(rewrites the hook command in place — same agent, same instance)")}`);
              }
            } else {
              console.log(`     ${render.wrap(render.c.dim, "This hook was hand-edited, so Flair will not rewrite it. To adopt the current form:")} flair hook install`);
            }
          }
        } else {
          console.log(`  ${render.icons.error} SessionStart hook: not found in ${render.wrap(render.c.dim, hook.path)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would add SessionStart hook to")} ${hook.path}`);
            } else {
              const proceed = await confirmFix(`  Add the flair-session-start SessionStart hook to ${hook.path}? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixAgentId = claudeCodeAgentId || opts.agent || process.env.FLAIR_AGENT_ID;
                const fixRes = fixSessionStartHook(homedir(), fixAgentId);
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(adds the flair-session-start SessionStart hook)")}`);
          }
        }
      } // end CLAUDE.md + SessionStart hook (claudeCodeConfigured)

      // Continuity capture is a standalone Claude Code opt-in — shown whenever
      // Claude Code is DETECTED, independent of MCP wiring (flair#1324/#1257).
      if (claudeCodeDetected) {
        // flair#1257 slice 2 — continuity capture pair (the check-5 twin of
        // the SessionStart check above: installed / absent / stale-form).
        // Continuity is OPT-IN — installing the PostToolUse+Stop pair IS the
        // opt-in — so "absent" renders as informational "not enabled": NEVER
        // a pass (an unrun check must not look green), never counted as an
        // issue, and NEVER wired by --fix (flair#1324: doctor's fixable set
        // is broken state; initiating an opt-in the user hasn't made is not a
        // fix — a y/N prompt auto-answers yes in every non-TTY run, so it was
        // no consent gate at all; enablement is `flair hook install
        // --continuity` only). A partial or stale pair IS evidence of a prior
        // opt-in, so repairing it to the complete current form remains a
        // legitimate --fix.
        const continuity = checkContinuityCaptureHooks(homedir());
        if (continuity.state === "installed") {
          console.log(`  ${render.icons.ok} Continuity capture hooks: PostToolUse + Stop wired in ${render.wrap(render.c.dim, continuity.path)}`);
        } else if (continuity.state === "absent") {
          console.log(`  ${render.icons.info} Continuity capture hooks: not enabled ${render.wrap(render.c.dim, "(opt-in — auto-journal working state into the ephemeral memory tier; enable: flair hook install --continuity)")}`);
        } else {
          const continuityDetail = continuity.state === "partial"
            ? (!continuity.postToolUse.present ? "the PostToolUse entry is missing" : "the Stop entry is missing")
            : "an entry is not the current form (unsilenced, hand-altered, or a drifted PostToolUse matcher)";
          console.log(`  ${render.icons.warn} Continuity capture hooks: ${continuity.state} — ${continuityDetail}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would rewrite the continuity capture hooks in")} ${continuity.path}`);
            } else {
              const proceed = await confirmFix(`  Rewrite the continuity capture hooks in ${continuity.path} to the current form? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixAgentId = claudeCodeAgentId || opts.agent || process.env.FLAIR_AGENT_ID;
                // Preserve the FLAIR_URL an existing entry already carries —
                // a repair must never silently re-point the hooks at a
                // different instance.
                const existingCommand = continuity.postToolUse.command || continuity.stop.command || "";
                const existingUrl = existingCommand.match(/FLAIR_URL=(\S+)/)?.[1];
                const fixRes = fixContinuityCaptureHooks(homedir(), fixAgentId, existingUrl);
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
                if (fixRes.ok && fixRes.changed) fixed++;
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(rewrites both entries to the current form — same agent, same instance)")}`);
          }
          issues++;
        }
      }

      // Codex SessionStart hook (flair#1148) — same flair-session-start
      // command Claude Code uses, written to ~/.codex/hooks.json. Continuity
      // and CLAUDE.md stay Claude-Code-only; Codex's session-start mechanism
      // is the hook file.
      // flair#1834 PR-H: a hook file on disk IS the wiring. Inspect Codex's
      // SessionStart hook whenever one is PRESENT on disk, not only when Codex
      // is otherwise detected/configured on this box (a `codex` binary on PATH
      // or a wired ~/.codex/config.toml). Gating the whole block on Codex's MCP
      // configuration silently skipped a wired ~/.codex/hooks.json when Codex
      // was not installed — exactly the quiet skip PR-H exists to prevent (a
      // HOLD must be printed). A `codexConfigured` box with NO hook still falls
      // through to the "not found / add" report below.
      const hook = inspectSessionStartHook(homedir(), { settingsPath: hookSettingsPath(homedir(), "codex") });
      if (codexConfigured || hook.present) {
        if (hook.present) {
          const codexStale = sessionStartHookPinFindings(homedir()).find((f) => f.reading.target.id === "codex");
          if (codexStale && codexStale.direction === "unknown") {
            // flair#1778: same direction rule as Claude Code above.
            console.log(`  ${render.icons.warn} SessionStart hook (codex): pin is not a version I can compare: ${codexStale.reading.pin} — not re-pinned; re-run flair init or edit the hook if this is unintended`);
          } else if (codexStale && codexStale.direction === "ahead") {
            // flair#1778 follow-up: same direction rule as Claude Code above.
            console.log(`  ${render.icons.ok} SessionStart hook (codex): pinned to flair-mcp@${codexStale.reading.pin}, ahead of the installed CLI ${flairCliVersion()} — held`);
          } else if (codexStale) {
            console.log(`  ${render.icons.error} SessionStart hook (codex): pinned to flair-mcp@${codexStale.reading.pin} (installed CLI is ${flairCliVersion()}) — the hook still launches the OLD adapter on every session`);
            if (autoFix) {
              if (dryRun) {
                console.log(`     ${render.wrap(render.c.dim, "Would re-pin the SessionStart hook in")} ${hook.path}`);
              } else {
                const repin = repinSessionStartHookGuarded(homedir(), "codex");
                // flair#1834 A1 round 3 + PR-H: the SAME icon rule as the MCP
                // re-pin line — a hold (or a failed write) renders ⚠, never a
                // false ✓ for an attempted-but-held fix.
                console.log(`     ${render.icons[mcpRepinIcon(repin.action, repin.ok)]} ${repin.message}`);
              }
            } else {
              console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair hook install --harness codex ${render.wrap(render.c.dim, "(re-pins the hook to the installed CLI version)")}`);
            }
          } else if (hook.execution === "broken") {
            if (hook.silenced) {
              console.log(`  ${render.icons.ok} SessionStart hook (codex): wired in ${render.wrap(render.c.dim, hook.path)} — not yet exercised`);
              console.log(`     ${render.wrap(render.c.dim, hook.detail ?? "")}`);
              console.log(`     ${render.wrap(render.c.dim, "The hook is correctly wired but the adapter has not been fetched yet.")}`);
              console.log(`     ${render.wrap(render.c.dim, "This is normal on a fresh install — the first Codex session will warm the npx cache.")}`);
              console.log(`     ${render.wrap(render.c.dim, "Codex requires /hooks to trust a newly written command before it runs.")}`);
            } else {
              console.log(`  ${render.icons.warn} SessionStart hook (codex): wired in ${render.wrap(render.c.dim, hook.path)}, but its command did not run just now`);
              console.log(`     ${render.wrap(render.c.dim, hook.detail ?? "")}`);
              console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair hook install --harness codex ${render.wrap(render.c.dim, "(rewrites the hook to the current silent-failure form)")}`);
            }
          } else if (hook.execution === "unknown") {
            console.log(`  ${render.icons.warn} SessionStart hook (codex): wired in ${render.wrap(render.c.dim, hook.path)}, but could not be verified ${render.wrap(render.c.dim, `(${hook.detail ?? "no detail"})`)}`);
          } else if (!hook.ours) {
            console.log(`  ${render.icons.ok} SessionStart hook (codex): wired in ${render.wrap(render.c.dim, hook.path)} ${render.wrap(render.c.dim, "(custom command — not verified, not modified)")}`);
          } else {
            console.log(`  ${render.icons.ok} SessionStart hook (codex): flair-session-start wired in ${render.wrap(render.c.dim, hook.path)} ${render.wrap(render.c.dim, "and still runs")}`);
          }

          if (!hook.silenced && hook.ours) {
            console.log(`  ${render.icons.warn} SessionStart hook (codex): a failure would print an error on every session (this command predates the silent-failure fix)`);
            if (hook.upgradable) {
              if (autoFix) {
                if (dryRun) {
                  console.log(`     ${render.wrap(render.c.dim, "Would rewrite the hook command in")} ${hook.path}`);
                } else {
                  const proceed = await confirmFix(`  Rewrite the Flair SessionStart hook in ${hook.path} so failures stay silent? [y/N] `);
                  if (!proceed) {
                    console.log(`     Skipped.`);
                  } else {
                    const upgrade = upgradeSessionStartHookCommand(homedir(), hook.path);
                    console.log(`     ${upgrade.ok ? render.icons.ok : render.icons.warn} ${upgrade.message}`);
                  }
                }
              } else {
                console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair hook install --harness codex ${render.wrap(render.c.dim, "(rewrites the hook command in place — same agent, same instance)")}`);
              }
            } else {
              console.log(`     ${render.wrap(render.c.dim, "This hook was hand-edited, so Flair will not rewrite it. To adopt the current form:")} flair hook install --harness codex`);
            }
          }
        } else {
          console.log(`  ${render.icons.error} SessionStart hook (codex): not found in ${render.wrap(render.c.dim, hook.path)}`);
          if (autoFix) {
            if (dryRun) {
              console.log(`     ${render.wrap(render.c.dim, "Would add SessionStart hook to")} ${hook.path}`);
            } else {
              const proceed = await confirmFix(`  Add the flair-session-start SessionStart hook to ${hook.path}? [y/N] `);
              if (!proceed) {
                console.log(`     Skipped.`);
              } else {
                const fixAgentId = resolveHookAgentId({ agent: opts.agent }, homedir(), "codex");
                const fixRes = fixSessionStartHook(homedir(), fixAgentId, hook.path);
                console.log(`     ${fixRes.ok ? render.icons.ok : render.icons.warn} ${fixRes.message}`);
              }
            }
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair hook install --harness codex`);
          }
        }
      }
    }

    // Catalog is the install-health verdict — count fail/unrun here, not
    // via a second issues++ on MCP / CLAUDE.md / SessionStart hook above.
    // --fix that cleared a catalog member shows up in the found→fixed delta.
    const catalogAfter = autoFix ? runDoctorChecks(doctorCtx, { catalogIds: doctorCatalogIds }) : catalogBefore;
    const catalogDelta = catalogIssueDelta(catalogBefore, catalogAfter);
    issues += catalogDelta.found;
    if (autoFix) fixed += catalogDelta.fixed;

    console.log(`\n  ${render.wrap(render.c.bold, "Install health")}`);
    for (const row of renderCatalogDoctorLines(catalogAfter)) {
      console.log(`  ${render.icons[row.icon]} ${row.line}`);
    }

    // 7b. Launchd management repair (flair#1573 slice b) — `doctor --fix`
    //     repairs a MISSING, CORRUPT, or DETACHED launchd plist. This is a
    //     distinct concern from the install-health catalog above (which
    //     `upgrade` also asserts), so it owns its own reporting + counting
    //     rather than double-counting the catalog's launchd check. The
    //     DECISION is pure (planLaunchdRepairFor -> planLaunchdRepair); the
    //     EXECUTION (adopt: clean-stop -> regenerate pass-file plist -> load ->
    //     verify) is repairLaunchdManagement, which is the only place that
    //     touches the real filesystem and launchctl.
    console.log(`\n  ${render.wrap(render.c.bold, "Launchd management")}`);
    // #1693: an adopted/registered plist that embeds the admin password inline
    // is a FAIL even when launchd still reports the job managed — launchd keeps
    // the loaded definition, so the on-disk downgrade hides behind a healthy
    // job. The path is resolved BEFORE the repair for the no-fix arm and AFTER
    // it for the --fix arm, so a --fix that regenerated in pass-file mode (or
    // migrated the label) clears the finding.
    let launchdPlistForCheck: string | undefined;
    if (autoFix && !dryRun) {
      // Execute the repair directly; it re-derives the plan internally and
      // verifies via assessLaunchdManagement (fail-loud, never a silent pass).
      const repairResult = await repairLaunchdManagement(defaultDataDir(), effectivePort);
      switch (repairResult.kind) {
        case "no-op":
          console.log(`  ${render.icons.ok} ${repairResult.detail}`);
          break;
        case "refused":
          issues++;
          console.log(`  ${render.icons.error} ${repairResult.detail}`);
          break;
        case "repaired":
          fixed++;
          console.log(`  ${render.icons.ok} ${repairResult.detail}`);
          break;
        case "failed":
          issues++;
          console.log(`  ${render.icons.error} ${repairResult.detail}`);
          if (repairResult.remedy) console.log(`     ${render.wrap(render.c.dim, "Fix:")} ${repairResult.remedy.join(" && ")}`);
          break;
      }
    } else {
      // Report only (no --fix, or --fix --dry-run): compute the plan, touch
      // nothing. A regenerate plan is drift; a refuse plan is a named refusal.
      const repairPlan = planLaunchdRepairFor(defaultDataDir(), effectivePort);
      launchdPlistForCheck = repairPlan.plistPath as string | undefined;
      switch (repairPlan.plan.kind) {
        case "no-op":
          console.log(`  ${render.icons.ok} ${repairPlan.plan.detail}`);
          break;
        case "refuse":
          issues++;
          console.log(`  ${render.icons.error} ${repairPlan.plan.detail}`);
          break;
        case "regenerate":
          issues++;
          console.log(`  ${render.icons.error} ${repairPlan.plan.detail}`);
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would regenerate")} the launchd plist (pass-file mode) and load it`);
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(regenerates the plist in pass-file mode, loads it, and verifies)")}`);
          }
          break;
        case "adopt":
          issues++;
          console.log(`  ${render.icons.error} ${repairPlan.plan.detail}`);
          if (dryRun) {
            console.log(`     ${render.wrap(render.c.dim, "Would adopt")} the direct-spawned instance into launchd (clean-stop, regenerate, load — bounces the live instance)`);
          } else {
            console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(clean-stops the direct process, regenerates the plist, loads it, and verifies — bounces the live instance)")}`);
          }
          break;
      }
    }
    // flair#1693: the check itself (the shared plist writer that stops
    // init/doctor/upgrade producing this shape is #1693's own change). In the
    // --fix arm the plan was executed above, so resolve the (possibly
    // label-migrated) plist path now and read post-repair bytes.
    if (launchdPlistForCheck === undefined) {
      launchdPlistForCheck = planLaunchdRepairFor(defaultDataDir(), effectivePort).plistPath as string | undefined;
    }
    if (typeof launchdPlistForCheck === "string" && existsSync(launchdPlistForCheck)) {
      try {
        const raw = readFileSync(launchdPlistForCheck, "utf-8");
        if (plistCarriesInlineAdminPassword(raw)) {
          issues++;
          console.log(`  ${render.icons.error} the launchd plist at ${launchdPlistForCheck} embeds HDB_ADMIN_PASSWORD inline instead of using the pass-file launcher`);
          console.log(`     ${render.wrap(render.c.dim, "Fix:")} flair doctor --fix ${render.wrap(render.c.dim, "(regenerate in pass-file mode; #1693)")}`);
        }
      } catch {
        // Plist unreadable — the launchd plan above already reports presence.
      }
    }

    // 7a. Resolve which agent identities the two verified-read sections below
    // (Fleet presence, Migrations) iterate (flair#722). Previously both
    // sections required --agent explicitly; doctor already enumerates every
    // key in ~/.flair/keys (step 2 above), so by default it now runs the
    // signed read AS EACH of those agents instead of hiding behind a flag —
    // a real dogfood run found the #720 halted-migration warning visible via
    // `flair status --agent local` but invisible in the default `doctor` run
    // the same user ran minutes later. --agent <id> narrows this to exactly
    // that one identity (planAgentIterations — same pre-#722 semantics: a
    // single signed identity, just no longer widened to "every key").
    //
    // The registration gate (checkAgentRegistered — same signed GET
    // /Agent/:id used by the Client integration section above) is resolved
    // ONCE here per agent and shared by both sections, so a bad/unregistered
    // key doesn't cost two network round-trips, and its "found" count isn't
    // double-counted by each section re-discovering the same finding
    // (flair#721 found/fixed/remaining summary — these are found-only, no
    // --fix action exists for a bad local key). A gate failure for one agent
    // never aborts the others — that's the failure isolation flair#722 asks
    // for; describeAgentGateFinding (src/doctor-client.ts) is pure decision
    // logic so it's unit-tested without a real Harper.
    const verifiedReadAgentIds = harperResponding
      ? planAgentIterations(keyAgentIds, opts.agent || process.env.FLAIR_AGENT_ID)
      : [];
    const agentGates: Array<{ id: string; state: AgentGateState; detail?: string }> = [];
    for (const id of verifiedReadAgentIds) {
      const reg = await checkAgentRegistered(baseUrl, id, defaultKeysDir());
      agentGates.push({ id, state: reg.state, detail: reg.detail });
      // harperResponding is necessarily true here (verifiedReadAgentIds is
      // empty otherwise), so an "unreachable" verdict from this loop is
      // always a self-contradiction — flair#1023. Hand the guard the fact.
      const finding = describeAgentGateFinding(id, reg.state, reg.detail, { instanceReachable: harperResponding });
      if (finding?.isIssue) issues++;
    }

    // Shared renderer for one agent's registration-gate outcome — prints the
    // "Agent: <id>" subsection header, and if the gate isn't clean, the
    // finding (never re-counted here; already counted once above) and
    // returns false so the caller skips its own verified fetch for this
    // agent and moves on to the next (failure isolation).
    function renderAgentGateHeader(gate: { id: string; state: AgentGateState; detail?: string }): boolean {
      console.log(`    ${render.wrap(render.c.dim, `Agent: ${gate.id}`)}`);
      const finding = describeAgentGateFinding(gate.id, gate.state, gate.detail, { instanceReachable: harperResponding });
      if (!finding) return true;
      const icon = finding.icon === "error" ? render.icons.error : render.icons.warn;
      console.log(`      ${icon} ${finding.message}`);
      if (finding.fixHint) console.log(`         ${render.wrap(render.c.dim, "Fix:")} ${finding.fixHint}`);
      return false;
    }

    // 8. Fleet presence (flair#639) — known instances via /Presence heartbeats.
    //
    // "Instance" here means each AGENT's heartbeat row — Presence is keyed by
    // agentId (schemas/schema.graphql), not by Flair server — so several rows
    // can (and typically will) share one flairVersion/harperVersion whenever
    // several agents heartbeat through the same Flair. That's still the
    // useful fleet signal: an outlier version on one row means THAT agent's
    // serving instance is behind the rest.
    //
    // SCOPE, verified against runFederationSyncOnce's own table list in
    // src/commands/federation.ts (`const tables = ["Memory", "Soul", "Agent",
    // "Relationship"]`): Presence is NOT one of the tables federation sync
    // replicates. So this section reports only what THIS instance's own
    // Presence table has recorded — every agent whose FLAIR_URL points
    // directly at the Flair `doctor` is talking to. On a hub+spokes
    // deployment where each spoke runs its own separate Flair database, a
    // spoke's locally-recorded heartbeats are invisible from the hub's
    // `doctor` unless those agents also heartbeat straight to the hub. Not
    // fixed here — flair#639's fix list is version-stamping + a doctor
    // listing, not widening federation sync scope.
    //
    // flair#722: iterated per agent (agentGates above) instead of a single
    // --agent-gated read. flairVersion/harperVersion are gated to verified
    // readers on the server (resources/Presence.ts, same boundary as
    // currentTask), so each agent subsection signs its own GET — a working
    // key reveals versions for that subsection; roster IDENTITY is public
    // either way. Zero local keys (and no --agent) falls back to exactly the
    // pre-#722 single unauthenticated read (hidden versions, "Pass --agent"
    // hint) — there's no agent to sign as, but remote agents may still have
    // heartbeated onto this instance and identities are worth showing.
    async function fetchAndRenderFleetPresence(headers: Record<string, string>, canSign: boolean, indent: string): Promise<void> {
      try {
        const presRes = await fetch(`${baseUrl}/Presence`, { headers, signal: AbortSignal.timeout(5000) });
        if (!presRes.ok) {
          console.log(`${indent}${render.icons.warn} Could not fetch presence roster (HTTP ${presRes.status})`);
          return;
        }
        const roster = (await presRes.json()) as FleetPresenceRow[];
        if (!Array.isArray(roster) || roster.length === 0) {
          console.log(`${indent}${render.icons.info} No known instances yet — no /Presence heartbeats recorded on this instance`);
          return;
        }
        const rows = sortOldestVersionFirst(markStale(roster));
        for (const row of rows) {
          const lastSeen = typeof row.lastHeartbeatAt === "number"
            ? render.relativeTime(new Date(row.lastHeartbeatAt).toISOString())
            : "—";
          const versionLabel = !canSign
            ? render.wrap(render.c.dim, "hidden")
            : row.flairVersion
              ? `v${row.flairVersion}`
              : render.wrap(render.c.dim, "no version reported");
          const staleNote = row.stale && row.newestVersion
            ? " " + render.wrap(render.c.yellow, `(stale — fleet newest is v${row.newestVersion})`)
            : "";
          const icon = row.stale ? render.icons.warn : render.icons.ok;
          const statusSuffix = row.presenceStatus ? ` (${row.presenceStatus})` : "";
          // Natural-presence: same staleness principle as the version
          // column — a live activity is shown as current, a decayed one as
          // "last-known". `activityFresh === false` (server verdict) plus a
          // known lastActivity → "(was: X)"; a fresh, non-idle activity →
          // "(X)". Skip entirely when there's nothing informative to say
          // (no signal, or idle) so the line stays quiet for the common case.
          const lastActivity = row.lastActivity ?? row.activity;
          const activityNote = row.activityFresh === false
            ? (lastActivity && lastActivity !== "idle"
                ? " " + render.wrap(render.c.dim, `(was: ${lastActivity})`)
                : "")
            : (row.activity && row.activity !== "idle"
                ? " " + render.wrap(render.c.dim, `(${row.activity})`)
                : "");
          console.log(`${indent}${icon} ${row.id} — ${versionLabel} — last seen ${lastSeen}${statusSuffix}${activityNote}${staleNote}`);
        }
        if (!canSign) {
          console.log(`${indent}   ${render.wrap(render.c.dim, "Pass --agent <id> (with a matching key in ~/.flair/keys) to reveal versions — flairVersion/harperVersion require a verified signature, same as currentTask.")}`);
        }
        console.log(`${indent}   ${render.wrap(render.c.dim, "Staleness above is fleet-relative (newest version seen among these instances) — comparing against the latest PUBLISHED flair is the version check at the top of this report, not this section.")}`);
      } catch (err: any) {
        console.log(`${indent}${render.icons.warn} Fleet presence check failed: ${err?.message ?? err}`);
      }
    }

    if (harperResponding) {
      console.log(`\n  ${render.wrap(render.c.bold, "Fleet presence")}`);
      if (agentGates.length === 0) {
        await fetchAndRenderFleetPresence({}, false, "  ");
      } else {
        for (const gate of agentGates) {
          const registered = renderAgentGateHeader(gate);
          if (!registered) continue;
          const keyPath = resolveKeyPath(gate.id) ?? join(defaultKeysDir(), `${gate.id}.key`);
          const headers: Record<string, string> = { Authorization: buildEd25519Auth(gate.id, "GET", "/Presence", keyPath) };
          await fetchAndRenderFleetPresence(headers, true, "      ");
        }
      }
    }

    // 9. Migration state (flair#695) — pending/in-progress/blocked + last
    // ledger-derived outcome per registered migration, read off the same
    // authenticated /HealthDetail the "Fleet presence" section above
    // already fetches. `--fix` here means the SAME restart offered in step
    // 1a above (a halted migration retries automatically on the next boot —
    // there's no separate "run the migration now" fix; the fix for
    // "blocked" is whatever the halt reason names, e.g. freeing disk).
    //
    // flair#722: iterated per agent (agentGates above), same as Fleet
    // presence — each subsection's finding is found-only (no per-agent
    // --fix here beyond the existing restart-on-halt story). Gate FINDINGS
    // are rendered in full under Fleet presence only (the first
    // verified-read section); re-printing the identical per-agent finding
    // here doubled the noise on real multi-key machines (a 27-key dogfood
    // box printed 15 not-registered findings twice each), so this section
    // iterates only the gate-passed agents and rolls the rest into one
    // aggregate skip line. The issue COUNT is unaffected either way — gate
    // findings are counted exactly once, at gate-resolution time (step 7a).
    async function fetchAndRenderMigrations(headers: Record<string, string>, indent: string): Promise<void> {
      try {
        const migRes = await fetch(`${baseUrl}/HealthDetail`, { headers, signal: AbortSignal.timeout(5000) });
        if (!migRes.ok) {
          console.log(`${indent}${render.icons.warn} Could not fetch migration state (HTTP ${migRes.status})`);
          return;
        }
        const detail = (await migRes.json()) as { migrations?: { cyclePhase?: string; lastCycleError?: string | null; migrations?: Array<{ id: string; state: string; rowsDone: number; rowsRemaining: number; reason?: string }> } };
        const migBlock = detail?.migrations;
        if (!migBlock || !Array.isArray(migBlock.migrations) || migBlock.migrations.length === 0) {
          console.log(`${indent}${render.icons.info} No migrations registered on this instance`);
          return;
        }
        if (migBlock.cyclePhase === "pre-hash") {
          console.log(`${indent}${render.icons.info} Pre-flight integrity check in progress — migrations deferred until it completes`);
        }
        // flair#812: the boot trigger sets `scheduled` synchronously at
        // module load, so `idle` means resources/migration-boot.js never
        // loaded in the serving process — NO migration will ever run on
        // this instance, which is precisely the failure that went unnoticed
        // because a skipped cycle looked identical to a clean one.
        if (migBlock.cyclePhase === "idle") {
          console.log(`${indent}${render.icons.error} Migration boot cycle never fired on this instance — no migration will run until this is resolved. Check the instance log for [flair-migrations] and confirm the running build ships dist/resources/migration-boot.js.`);
          issues++;
        }
        // A cycle that reached a terminal phase carrying an error explains
        // itself here rather than only in the process log — the reason
        // string names the paths tried and the remedy.
        if (migBlock.lastCycleError) {
          console.log(`${indent}${render.icons.error} Last migration cycle did not complete: ${migBlock.lastCycleError}`);
          issues++;
        }
        for (const m of migBlock.migrations) {
          if (m.state === "completed") {
            // flair#812: a `reason` on a COMPLETED migration means the
            // runner short-circuited it from the (hand-editable) state file
            // rather than verifying the corpus this boot. Print it, so an
            // unverified claim is never rendered as a verified one.
            const note = m.reason ? ` ${render.wrap(render.c.dim, `(${m.reason})`)}` : "";
            console.log(`${indent}${render.icons.ok} ${m.id}: completed${note}`);
          } else if (m.state === "halted" || m.state === "failed") {
            console.log(`${indent}${render.icons.error} ${m.id}: ${m.state}${m.reason ? ` — ${m.reason}` : ""}`);
            issues++;
          } else if (m.state === "running") {
            console.log(`${indent}${render.icons.info} ${m.id}: in progress (${m.rowsDone} done, ${m.rowsRemaining} remaining)`);
          } else {
            console.log(`${indent}${render.icons.info} ${m.id}: ${m.state}`);
          }
        }
      } catch (err: any) {
        console.log(`${indent}${render.icons.warn} Migration state check failed: ${err?.message ?? err}`);
      }
    }

    if (harperResponding) {
      console.log(`\n  ${render.wrap(render.c.bold, "Migrations")}`);
      if (agentGates.length === 0) {
        console.log(`  ${render.icons.info} Pass --agent <id> (with a matching key in ~/.flair/keys) to see migration state — requires a verified read, same as Fleet presence above.`);
      } else {
        const passedGates = agentGates.filter((g) => describeAgentGateFinding(g.id, g.state, g.detail, { instanceReachable: harperResponding }) === null);
        for (const gate of passedGates) {
          renderAgentGateHeader(gate);
          const keyPath = resolveKeyPath(gate.id) ?? join(defaultKeysDir(), `${gate.id}.key`);
          const headers: Record<string, string> = { Authorization: buildEd25519Auth(gate.id, "GET", "/HealthDetail", keyPath) };
          await fetchAndRenderMigrations(headers, "      ");
        }
        const skipped = agentGates.length - passedGates.length;
        if (skipped > 0) {
          console.log(`  ${render.icons.info} ${skipped} agent(s) skipped — registration-gate findings reported under Fleet presence above`);
        }
      }
    }

    // 10. Scheduled drivers (flair#1278) — launchd/systemd liveness for the
    // background schedulers (federation sync, REM nightly), read from the
    // LOCAL service manager (no Harper dependency, so no harperResponding
    // gate). Neither #1231 fleet incident (launchd spawn error 209 from a
    // missing log dir, exit 126 from a stripped exec bit) was visible in
    // doctor: driver health only surfaced in `flair federation sync status`
    // / `flair rem nightly status` — commands an operator has to think to
    // run, while doctor is the tool they actually run when something feels
    // off. Reuses each scheduler's own status read (installed + genuinely
    // loaded, flair#850) plus the #1282 last-exit plumbing
    // (queryLastExitStatus); the verdict is describeScheduledDriverFinding
    // (src/lib/scheduler-platform.ts) — pure decision logic, unit-tested
    // without spawning launchctl/systemctl. Not-enabled renders as
    // informational: an unenabled scheduler is a choice — never the pass
    // marker, never the fail marker, never an issue.
    //
    // flair#1514: the federation driver is additionally gated on peers
    // being configured. Zero peers → N/A (never ✗). Peers configured +
    // driver missing/broken still ✗. Config.yaml is the component-dir
    // file resolved above, not only ~/.flair/config.yaml.
    console.log(`\n  ${render.wrap(render.c.bold, "Scheduled drivers")}`);
    try {
      const { queryLastExitStatus, describeScheduledDriverFinding } = await import("../lib/scheduler-platform.js");
      const fedSched = await import("../federation/scheduler.js");
      const remSched = await import("../rem/scheduler.js");
      const guiDomain = `gui/${process.getuid?.() ?? ""}`;

      let livePeerCount: number | null = null;
      if (harperResponding) {
        try {
          const r = await api("GET", "/FederationPeers", undefined, { baseUrl }) as { peers?: Array<{ status?: string }> };
          const peers = Array.isArray(r?.peers) ? r.peers : [];
          livePeerCount = peers.filter((p) => p?.status !== "revoked").length;
        } catch {
          livePeerCount = null;
        }
      }
      const configDoc = cfgPath ? loadYamlDoc(cfgPath) : null;
      const fedEnv = collectFederationEnv({
        processEnv: process.env,
        envFilePaths: [
          join(process.cwd(), COMPONENT_ENV_FILENAME),
          join(flairPackageDir(), COMPONENT_ENV_FILENAME),
          ...(cfgPath ? [join(dirname(cfgPath), COMPONENT_ENV_FILENAME)] : []),
        ],
      });
      const peersConfigured = federationPeersConfigured({
        livePeerCount,
        configDoc,
        env: fedEnv,
        nodeKeyIds,
      });

      const drivers = [
        {
          kind: "federation" as const,
          status: fedSched.schedulerStatus(),
          label: "Federation sync driver",
          enableCommand: "flair federation sync enable",
          statusCommand: "flair federation sync status",
          darwinTarget: `${guiDomain}/${fedSched.LAUNCHD_LABEL}`,
          linuxServiceUnit: fedSched.SYSTEMD_SERVICE_UNIT,
          stderrLogPath: join(homedir(), ".flair", "logs", "federation-sync.stderr.log"),
        },
        {
          kind: "rem" as const,
          status: remSched.schedulerStatus(),
          label: "REM nightly driver",
          enableCommand: "flair rem nightly enable",
          statusCommand: "flair rem nightly status",
          darwinTarget: `${guiDomain}/${remSched.LAUNCHD_LABEL}`,
          linuxServiceUnit: remSched.SYSTEMD_SERVICE_UNIT,
          stderrLogPath: join(homedir(), ".flair", "logs", "rem-nightly.stderr.log"),
        },
      ];
      for (const d of drivers) {
        // Read the last run only when the service manager actually has the
        // job — "not installed" and "not loaded" carry their own findings,
        // and layering a last-exit read on top would blur which actor failed.
        const lastExit = d.status.installed && d.status.active === true
          ? queryLastExitStatus({ plat: d.status.platform, darwinTarget: d.darwinTarget, linuxServiceUnit: d.linuxServiceUnit })
          : null;
        const facts = {
          label: d.label,
          enableCommand: d.enableCommand,
          statusCommand: d.statusCommand,
          installed: d.status.installed,
          active: d.status.active,
          lastExit,
          stderrLogPath: d.stderrLogPath,
        };
        const finding = d.kind === "federation"
          ? describeFederationDriverFinding({ peersConfigured, driver: facts })
          : describeScheduledDriverFinding(facts);
        console.log(`  ${render.icons[finding.icon as keyof typeof render.icons]} ${finding.message}`);
        finding.detail.forEach((line: string, i: number) => {
          // Embed-verify degraded style: the actor+state line loud (red),
          // the remedy dim.
          const color = finding.state === "degraded" && i === 0 ? render.c.red : render.c.dim;
          console.log(`     ${render.wrap(color, line)}`);
        });
        if (finding.isIssue) issues++;
      }
    } catch (err: any) {
      // An unsupported platform (neither darwin nor linux) or a broken unit
      // read must not take down doctor — report the section as unchecked
      // (UNVERIFIED, not a pass), same as the other probes' skip discipline.
      console.log(`  ${render.icons.warn} Scheduled drivers: could not check ${render.wrap(render.c.dim, `(${err?.message ?? err})`)}`);
    }

    // Summary — see summarizeDoctorRun above (flair#721): distinguishes
    // issues --fix actually resolved this run from ones still outstanding.
    console.log("");
    const summary = summarizeDoctorRun(issues, fixed, autoFix);
    console.log(summary.line);
    console.log("");

    if (summary.exitCode !== 0) process.exit(summary.exitCode);
  });

}
