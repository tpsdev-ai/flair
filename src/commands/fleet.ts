/**
 * fleet.ts — `flair fleet` command group (flair#1624 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration and action handlers. Shared CLI helpers
 * (resolveFabricCredentials) stay in cli.ts and are bound before register().
 * Sweep orchestration stays in src/fleet-verify.ts.
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import * as render from "../render.js";
import {
  sweepFleet,
  renderFleetSweepTable,
  type FleetSweepResult,
} from "../fleet-verify.js";

export type FleetCli = {
  resolveFabricCredentials: (opts: {
    fabricUser?: string;
    fabricPassword?: string;
    fabricPasswordFile?: string;
  }) => {
    fabricUser: string | undefined;
    fabricPassword: string | undefined;
    warnings: string[];
  };
};

let cli: FleetCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: FleetCli): void {
  cli = fns;
}

function resolveFabricCredentials(opts: {
  fabricUser?: string;
  fabricPassword?: string;
  fabricPasswordFile?: string;
}): {
  fabricUser: string | undefined;
  fabricPassword: string | undefined;
  warnings: string[];
} {
  return cli.resolveFabricCredentials(opts);
}

export function register(program: Command): void {
  // ─── flair fleet ────────────────────────────────────────────────────────────
  //
  // Fabric fleet operations (flair#636). `flair deploy` / `flair upgrade
  // --target` already run this sweep automatically post-deploy (skippable
  // with --no-fleet-verify) — this is the standalone entry point for running
  // it independently, e.g. as a periodic health check or before a rolling
  // restart step (see the flair#636 decision comment: this sweep is the gate
  // between peers during a rolling restart, not the restart mechanism itself).
  const fleet = program.command("fleet").description("Fabric fleet operations (post-deploy convergence verification)");

  fleet
    .command("verify")
    .description("Sweep a Fabric origin + its known federation peers for version/health convergence")
    .requiredOption("--target <url>", "Fabric URL to verify (the origin node)")
    .option("--fabric-user <user>", "Fabric admin username (env: FABRIC_USER — preferred; inline leaks to ps/shell history)")
    .option("--fabric-password <pass>", "Fabric admin password (prefer FABRIC_PASSWORD env or --fabric-password-file; inline leaks to shell history)")
    .option("--fabric-password-file <path>", "Read the Fabric admin password from a mode-0600 file (keeps it out of argv and env)")
    .option("--expect-version <semver>", "Version every node must report (default: the origin's own reported version — a self-consistency check)")
    .option("--timeout <ms>", "Per-node /Health poll timeout in ms", "60000")
    .option("--json", "Emit JSON (also: pipe + FLAIR_OUTPUT=json)")
    .addHelpText("after", `
Exit codes:
  0  all probed nodes verified (unverifiable peers — no endpoint on file —
     are listed as a warning and do not fail the run)
  1  origin failed (unreachable, unauthenticated, or wrong version)
  2  a reachable node diverged (wrong version) — NOT converged
  3  a reachable peer was unreachable or rejected auth (not unverifiable)

"peer" here means a Flair federation peer (GET /FederationPeers on the
origin) — NOT Harper's own cluster-replication nodes, which the OSS
harper build this CLI ships does not expose (cluster_status is
a harper-pro-only operation). A Fabric replica that was never
federation-paired (\`flair federation pair\`) is invisible to this sweep —
see src/fleet-verify.ts's file header for the full caveat.`)
    .action(async (opts: any) => {
      // Single source of truth for cred resolution + shell-history warnings,
      // shared with `flair upgrade --target` and `flair deploy`.
      const { fabricUser, fabricPassword, warnings } = resolveFabricCredentials(opts);
      for (const w of warnings) console.error(render.wrap(render.c.dim, w));

      if (!fabricUser || !fabricPassword) {
        console.error(render.wrap(render.c.red, "flair fleet verify: credentials required"));
        console.error("  set FABRIC_USER + FABRIC_PASSWORD env, or --fabric-password-file, or (discouraged) --fabric-user/--fabric-password inline");
        process.exit(1);
      }

      const result: FleetSweepResult = await sweepFleet({
        target: opts.target,
        fabricUser,
        fabricPassword,
        expectVersion: opts.expectVersion,
        timeoutMs: Number(opts.timeout ?? 60_000),
      });

      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(result));
      } else {
        console.log(render.wrap(render.c.bold, `Fleet verify — ${result.target}`));
        console.log(renderFleetSweepTable(result));
      }
      process.exit(result.exitCode);
    });
}
