/**
 * deploy.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair deploy`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { buildTargetUrl as buildDeployUrl, deploy as deployToFabric, validateOptions as validateDeployOptions } from "../deploy.js";
import { renderFleetSweepTable, sweepFleet } from "../fleet-verify.js";

export type DeployCli = {
  fleetSweepCallerExitMessage: (...args: any[]) => any;
  resolveFabricCredentials: (...args: any[]) => any;
  shouldRunFleetVerify: (...args: any[]) => any;
};

let cli: DeployCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: DeployCli): void {
  cli = fns;
}

function fleetSweepCallerExitMessage(...args: any[]): any {
  return cli.fleetSweepCallerExitMessage(...args);
}

function resolveFabricCredentials(...args: any[]): any {
  return cli.resolveFabricCredentials(...args);
}

function shouldRunFleetVerify(...args: any[]): any {
  return cli.shouldRunFleetVerify(...args);
}

export function register(program: Command): void {
// ─── flair deploy ─────────────────────────────────────────────────────────────

// NOTE on env-var naming for `flair deploy`: the FABRIC_* env vars below intentionally
// do NOT carry the FLAIR_ prefix that the rest of the CLI uses (FLAIR_ADMIN_PASS,
// FLAIR_TARGET, FLAIR_PAIRING_TOKEN, etc.). FABRIC_* credentials are shared with
// the broader TPS tooling stack — multiple tools deploy to the same Harper Fabric
// org/cluster with the same auth, and demanding a tool-specific prefix would force
// operators to maintain duplicated env vars. Per Kern review on PR #306: the
// inconsistency is deliberate, document it here so the next agent doesn't "fix" it.

program
  .command("deploy")
  .description("Deploy Flair as a component to a remote Harper Fabric cluster")
  .option("--fabric-org <org>", "Fabric org (env: FABRIC_ORG)")
  .option("--fabric-cluster <cluster>", "Fabric cluster within the org (env: FABRIC_CLUSTER)")
  .option("--fabric-user <user>", "Fabric admin username (env: FABRIC_USER preferred; inline leaks to shell history)")
  .option("--fabric-password <pass>", "Fabric admin password (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
  .option("--fabric-password-file <path>", "Read the Fabric admin password from a file (chmod 600)")
  .option("--fabric-token <token>", "OAuth bearer token (env: FABRIC_TOKEN) — reserved for future Fabric bearer support")
  .option("--target <url>", "Override the Fabric URL template (https://<cluster>.<org>.harperfabric.com)")
  .option("--project <name>", "Component name in Fabric", "flair")
  .option("--pkg-version <semver>", "Override version label (default: installed package version)")
  .option("--no-replicated", "Disable cluster-wide replication (default: replicated=true)")
  .option("--no-restart", "Do not restart the component after deploy (default: restart=true)")
  .option("--dry-run", "Resolve package, validate args, skip the deploy call")
  .option("--package-root <dir>", "Override package root (mainly for testing)")
  .option("--deployment-timeout <ms>", "Milliseconds harper waits for cluster-wide peer replication (env: FABRIC_DEPLOYMENT_TIMEOUT; default: 600000 — harper's own 120s default is too short for Fabric)")
  .option("--install-timeout <ms>", "Milliseconds harper waits for package install (env: FABRIC_INSTALL_TIMEOUT; default: 600000)")
  .option("--no-verify", "Skip post-deploy served-API verification (default: verify — on by design, so the CLI can't report success on an empty/broken deploy)")
  .option("--verify-timeout <ms>", "Milliseconds to wait for the served API to settle after harper's post-deploy restart before verifying (default: 300000)")
  .option("--verify-resource <name>", "Resource to verify is serving after deploy (repeatable; default: derived from the deployed package's dist/resources)", (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option("--deploy-retries <n>", "Retry the full harper deploy this many times, ONLY when peer replication is positively observed not to converge (default: 0 — retrying re-runs harper's component install and can escalate a transient replication warning into a hard ENOTEMPTY install failure; see flair#878)", "0")
  .option("--ignore-replication-errors", "If peer replication still hasn't converged, treat it as a non-fatal warning and succeed with an origin-only deploy (the peer catches up via federation sync or a later deploy)")
  .option("--no-convergence-check", "Skip the post-replication-error convergence poll and fail on harper's error verbatim (default: poll — Harper replicates asynchronously, so its error is a snapshot, not a verdict; flair#878)")
  .option("--convergence-timeout <ms>", "How long to wait for peer replication to converge before reporting a replication failure (default: 180000)")
  .option("--no-fleet-verify", "Skip the automatic post-deploy fleet convergence sweep (default: sweep runs — see flair#636)")
  .action(async (opts) => {
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

    let fabricUser: string | undefined;
    let fabricPassword: string | undefined;
    let credWarnings: string[] = [];
    try {
      ({ fabricUser, fabricPassword, warnings: credWarnings } = resolveFabricCredentials(opts));
    } catch (err: any) {
      console.error(red(`Error: ${err.message}`));
      process.exit(1);
    }

    const deployOpts = {
      fabricOrg: opts.fabricOrg ?? process.env.FABRIC_ORG,
      fabricCluster: opts.fabricCluster ?? process.env.FABRIC_CLUSTER,
      fabricUser,
      fabricPassword,
      fabricToken: opts.fabricToken ?? process.env.FABRIC_TOKEN,
      target: opts.target,
      project: opts.project,
      version: opts.pkgVersion,
      replicated: opts.replicated !== false,
      restart: opts.restart !== false,
      dryRun: opts.dryRun ?? false,
      packageRoot: opts.packageRoot,
      deploymentTimeoutMs: Number(opts.deploymentTimeout ?? process.env.FABRIC_DEPLOYMENT_TIMEOUT ?? 600_000),
      installTimeoutMs: Number(opts.installTimeout ?? process.env.FABRIC_INSTALL_TIMEOUT ?? 600_000),
      verify: opts.verify !== false,
      verifyResources: (opts.verifyResource as string[] | undefined)?.length ? opts.verifyResource : undefined,
      verifyTimeoutMs: Number(opts.verifyTimeout ?? 300_000),
      deployRetries: Number(opts.deployRetries ?? 0),
      ignoreReplicationErrors: opts.ignoreReplicationErrors ?? false,
      convergenceCheck: opts.convergenceCheck !== false,
      convergenceTimeoutMs: opts.convergenceTimeout != null ? Number(opts.convergenceTimeout) : undefined,
      onProgress: (msg: string) => console.log(dim(`  ${msg}`)),
    };

    const errors = validateDeployOptions(deployOpts);
    if (errors.length) {
      console.error(red("flair deploy: missing required options"));
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }

    // Never log the credential VALUES — only the flag names, via the
    // resolver's own warning strings (see resolveFabricCredentials above).
    for (const w of credWarnings) console.error(dim(w));

    const url = buildDeployUrl(deployOpts);
    console.log(`${green("→")} Deploying ${deployOpts.project} to ${url}`);
    if (deployOpts.dryRun) console.log(dim("  (dry-run: skipping API call)"));

    try {
      const result = await deployToFabric(deployOpts);
      if (result.dryRun) {
        console.log(`${green("✓")} dry-run OK: ${result.project} ${result.version} ready to deploy to ${result.url}`);
        console.log(dim(`  package root: ${result.packageRoot}`));
        return;
      }
      if (result.convergedAfterReplicationError) {
        // flair#878: harper's exit code said failure; the per-node component
        // comparison said otherwise. Both halves get said out loud.
        console.log(`\n${yellow("⚠")} harper reported a peer-replication failure, but every named peer node's component tree matched the origin when checked afterwards — replication converged on its own.`);
      }
      if (result.replicationWarning) {
        console.log(`\n${yellow("⚠")} Flair ${result.version} deployed to the ORIGIN NODE ONLY — peer replication did not complete (see warning above). The peer will catch up via federation sync or a later deploy.`);
      } else {
        console.log(`\n${green("✓")} Flair ${result.version} deployed${deployOpts.verify ? " and verified serving" : ""}`);
      }
      console.log(`\n  URL:     ${result.url}`);
      console.log(`  Project: ${result.project}`);

      // ── Post-deploy fleet sweep (flair#636) ─────────────────────────────
      // Harper's own "Successfully deployed" (and the served-API verify
      // above) only confirm the ORIGIN. This sweeps the origin + every known
      // federation peer for actual version/health convergence — the gap that
      // let the 0.21.0 deploy report success while a peer was still throwing
      // 1006s. Skippable with --no-fleet-verify. Needs Basic-auth creds
      // (fabricUser+fabricPassword) — a --fabric-token-only deploy has no way
      // to authenticate the sweep, so it's skipped with a note instead of a
      // silent no-op.
      if (!shouldRunFleetVerify(opts)) {
        console.log(dim("\n(--no-fleet-verify: skipping post-deploy fleet sweep)"));
      } else if (!deployOpts.fabricUser || !deployOpts.fabricPassword) {
        console.log(dim("\n(skipping fleet verify — no --fabric-user/--fabric-password to authenticate the sweep; only --fabric-token was provided)"));
      } else {
        console.log(`\n${green("→")} Fleet verify`);
        const sweep = await sweepFleet({
          target: result.url,
          fabricUser: deployOpts.fabricUser,
          fabricPassword: deployOpts.fabricPassword,
          expectVersion: result.version,
        });
        console.log(renderFleetSweepTable(sweep));
        const deploySweepFail = fleetSweepCallerExitMessage(sweep);
        if (deploySweepFail) {
          console.error(red(`\n✗ ${deploySweepFail}`));
          process.exit(sweep.exitCode);
        }
      }

      console.log(`\nNext steps:`);
      console.log(dim(`  1. Set an admin password in Fabric Studio (Cluster Settings → Admin)`));
      console.log(dim(`  2. Seed your first agent:`));
      console.log(`     flair agent add --remote ${result.url} --name my-agent`);
    } catch (err: any) {
      console.error(red(`\n✗ deploy failed: ${err.message}`));
      const hint = err.message?.toLowerCase();
      if (hint?.includes("401") || hint?.includes("unauthoriz")) {
        console.error(dim("  hint: check Fabric Studio → Cluster Settings → Admin for the admin password"));
      }
      if (hint?.includes("component is not serving")) {
        console.error(dim("  hint: harper reported success but the served API disagrees — check the Fabric Studio component logs for the real deploy error, then retry"));
      }
      if (hint?.includes("did not settle")) {
        console.error(dim("  hint: Harper may still be restarting — check Fabric Studio, or retry with a longer --verify-timeout"));
      }
      if (hint?.includes("peer replication")) {
        console.error(dim("  hint: pass --ignore-replication-errors to accept an origin-only deploy, or re-run once the peer link recovers"));
        console.error(dim("  hint: --convergence-timeout <ms> waits longer for asynchronous replication before giving up (default 180000)"));
      }
      process.exit(1);
    }
  });

}
