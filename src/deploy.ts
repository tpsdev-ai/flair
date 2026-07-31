import { spawn } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  COMPONENT_ENV_FILENAME,
  PUBLIC_URL_KEY,
  isLoopbackUrl,
  planComponentEnv,
  publicUrlRemedy,
  type ComponentEnvPlan,
} from "./component-env.js";
import {
  awaitOriginQuiescent,
  awaitReplicationConvergence,
  defaultConvergenceDeps,
  parseReplicationFailure,
  type ConvergenceDeps,
  type ConvergenceResult,
  type QuiescenceResult,
} from "./replication-convergence.js";

export interface DeployOptions {
  fabricOrg?: string;
  fabricCluster?: string;
  fabricUser?: string;
  fabricPassword?: string;
  fabricToken?: string;
  target?: string;
  project?: string;
  version?: string;
  replicated?: boolean;
  restart?: boolean;
  dryRun?: boolean;
  packageRoot?: string;
  // How long harper's own deploy CLI will wait for cluster-wide peer
  // replication / package install before giving up. Both default to
  // DEFAULT_DEPLOYMENT_TIMEOUT_MS / DEFAULT_INSTALL_TIMEOUT_MS — the harper
  // CLI's own default (120s) is too short for Fabric peer-replication and
  // was the root cause of a real incident where the CLI aborted and forced
  // a hand-rolled raw deploy.
  deploymentTimeoutMs?: number;
  installTimeoutMs?: number;
  // Post-deploy served-API verification (on by default). See verifyDeployServing.
  verify?: boolean;
  verifyResources?: string[];
  verifyTimeoutMs?: number;
  // Flaky-peer-replication resilience. A real Fabric deploy hit
  // "Component 'flair' was deployed on the origin node but failed to
  // replicate to 1 of 1 peer node(s): ... (Error: Connection closed 1006)"
  // and hard-exited 1 — a bare manual re-run cleared it with no other
  // change. That's a flake, not a deterministic failure, so it should
  // self-heal rather than force a human to notice and re-run (see the
  // CLI's own "self-healing over keepalive" invariant). See
  // REPLICATION_FAILURE_RE for how a replication failure is distinguished
  // from any other deploy failure (auth, bad package, missing files — those
  // must still fail fast, never retry).
  //
  // How many times to retry the FULL `harper deploy` (not just the peer
  // push) after a detected replication-signature failure. DEFAULT 0 as of
  // flair#878 — see DEFAULT_DEPLOY_RETRIES for why that default moved.
  deployRetries?: number;
  // Internal/testing knob: override the retry backoff schedule (ms per
  // attempt; last value repeats if retries exceed the array length).
  // Not exposed as a CLI flag — the default (5s, 10s) is deliberate for
  // real deploys; tests override it to avoid real sleeps.
  deployRetryBackoffMs?: number[];
  // Escape hatch: pass ignore_replication_errors=true to harper's own
  // deploy CLI (deploys to origin, treats peer-replication failure as
  // non-fatal there). Also a JS-level fallback: if a replication-signature
  // failure still reaches us after retries are exhausted (e.g. harper
  // itself didn't fully suppress it), the deploy is reported as a WARNED
  // success instead of failing — the peer catches up via normal federation
  // sync or a later deploy. Mutually sensible with deployRetries: retry
  // first (transient flakes usually clear on their own), fall back to
  // "accept origin-only" only once retries are exhausted.
  ignoreReplicationErrors?: boolean;
  // ── flair#878: convergence check before declaring a replication failure ──
  // Harper's peer replication converges ASYNCHRONOUSLY, so the deploy call's
  // replication error is a snapshot, not a verdict. Before this CLI reports
  // failure (or retries), it polls each named peer's component tree and
  // reports SUCCESS if replication healed on its own. See
  // src/replication-convergence.ts for the signal and its safety guards.
  // `false` skips the poll entirely and restores the pre-#878 behaviour.
  convergenceCheck?: boolean;
  convergenceTimeoutMs?: number;
  convergencePollIntervalMs?: number;
  // Injectable seam for the convergence/quiescence polls (tests supply fakes;
  // real runs get defaultConvergenceDeps built from the Fabric credentials).
  convergenceDeps?: ConvergenceDeps;
  // Optional progress sink so callers (the CLI) can surface what would
  // otherwise be a silent multi-minute poll. Never required — deploy() and
  // verifyDeployServing() work fine without it (e.g. fabric-upgrade.ts's
  // reuse of deploy() doesn't pass one).
  onProgress?: (msg: string) => void;
}

export interface DeployResult {
  url: string;
  project: string;
  version: string;
  packageRoot: string;
  dryRun: boolean;
  // true iff the deploy only succeeded because a peer-replication failure
  // was accepted via --ignore-replication-errors — the origin
  // node has the component, at least one peer does not (yet).
  replicationWarning?: boolean;
  // flair#878: true iff `harper deploy` exited non-zero with a peer-replication
  // error, and a subsequent per-node component-tree comparison showed every
  // named peer had actually converged. The deploy SUCCEEDED; this flag exists
  // so callers can say so out loud rather than silently swallowing the error.
  convergedAfterReplicationError?: boolean;
}

// Files that must be present in a Flair package for deployment.
// Mirrors the `files` array in package.json — keep in sync.
export const REQUIRED_PACKAGE_FILES = [
  "dist",
  "schemas",
  "config.yaml",
] as const;

// harper's own deploy CLI defaults to a 120s peer-replication timeout that's
// too short for Fabric — the CLI aborts mid-replicate with no override,
// which is exactly the incident this module now guards against. 10 minutes
// gives cluster-wide replication + install room to actually finish.
export const DEFAULT_DEPLOYMENT_TIMEOUT_MS = 600_000;
export const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

// Post-deploy verification: how long we'll wait for the served API to come
// back up after harper's restart, how often we poll while waiting, and how
// many consecutive reachable responses count as "settled" (a single
// reachable probe right after restart can be a fluke mid-flap).
export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
export const VERIFY_POLL_INTERVAL_MS = 15_000;
export const VERIFY_SETTLE_STREAK = 3;

// Fallback when dist/resources can't be scanned (e.g. an unusual package
// layout via --package-root). Memory is Flair's original, always-present
// resource — a reasonable single thing to check when derivation fails.
export const FALLBACK_VERIFY_RESOURCE = "Memory";

export function validateOptions(opts: DeployOptions): string[] {
  const errors: string[] = [];
  if (!opts.target) {
    if (!opts.fabricOrg)
      errors.push("--fabric-org required (or FABRIC_ORG env)");
    if (!opts.fabricCluster)
      errors.push("--fabric-cluster required (or FABRIC_CLUSTER env)");
  }
  const hasBasic = !!(opts.fabricUser && opts.fabricPassword);
  const hasBearer = !!opts.fabricToken;
  if (!hasBasic && !hasBearer) {
    errors.push(
      "credentials required: set FABRIC_USER + FABRIC_PASSWORD env (safest), or pass " +
        "--fabric-user + --fabric-password-file <path>, or --fabric-token (FABRIC_TOKEN env); " +
        "inline --fabric-user/--fabric-password also work but leak to shell history",
    );
  }
  return errors;
}

export function buildTargetUrl(opts: DeployOptions): string {
  if (opts.target) return opts.target;
  return `https://${opts.fabricCluster}.${opts.fabricOrg}.harperfabric.com`;
}

export function resolvePackageRoot(override?: string): string {
  if (override) {
    const abs = resolve(override);
    if (!existsSync(join(abs, "package.json"))) {
      throw new Error(`No package.json at ${abs}`);
    }
    return abs;
  }

  // Walk up from this module's location — works when installed locally
  // and when npx extracts the tarball to a tmpdir.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const json = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (json.name === "@tpsdev-ai/flair") return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }

  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("@tpsdev-ai/flair/package.json"));
  } catch {
    throw new Error(
      "Could not locate @tpsdev-ai/flair package root. Try --package-root.",
    );
  }
}

export function validatePackageLayout(packageRoot: string): void {
  const missing: string[] = [];
  for (const f of REQUIRED_PACKAGE_FILES) {
    if (!existsSync(join(packageRoot, f))) missing.push(f);
  }
  if (missing.length) {
    throw new Error(
      `Flair package at ${packageRoot} is missing required entries: ` +
        missing.join(", "),
    );
  }
}

// Derive the list of served, table-backed REST resources from the compiled
// package — no hardcoded resource list. Flair's jsResource files (dist/resources/*.js)
// contain both real Resource classes (routable, GET-able) and plain helper
// modules (embeddings, auth, scoring, etc). We only ship dist/ in the
// published package (resources/*.ts source is not in package.json's `files`),
// so this scans the COMPILED output, matching the convention every current
// table-backed resource follows:
//
//   export class <Name> extends databases.<db>.<Name> { ... }
//
// i.e. the exported class name equals the filename equals the underlying
// table name (Memory.js -> `export class Memory extends databases.flair.Memory`,
// same for Agent, Soul, MemoryGrant, Credential, OrgEvent, etc). Helper
// modules are lowercase-first (agent-auth.js, embeddings-provider.js, ...)
// and never match, so they're skipped without needing a denylist. Files
// that export a resource extending a *generic* `Resource` base (AgentCard,
// WorkspaceLatest, action-style endpoints) are deliberately excluded here —
// they're action/command endpoints, not GET-able collections, and asserting
// non-404 on them would be the wrong check.
// Literal regex (no interpolation — satisfies semgrep detect-non-literal-regexp):
// matches `export class <Name> extends databases.<db>.<Name>` where the `\1`
// backreference forces the class name and the table name to be identical.
// Capture group 1 is the resource name; the caller matches it against the filename.
const EXPORTED_TABLE_CLASS_RE = /export class (\w+) extends databases\.[A-Za-z_$][\w$]*\.\1\b/g;

export function deriveVerifyResources(packageRoot: string): string[] {
  const resourcesDir = join(packageRoot, "dist", "resources");
  let entries: string[];
  try {
    entries = readdirSync(resourcesDir);
  } catch {
    return [FALLBACK_VERIFY_RESOURCE];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const base = entry.slice(0, -3);
    if (!/^[A-Z]/.test(base)) continue; // helper modules are camelCase/lowercase
    let src: string;
    try {
      src = readFileSync(join(resourcesDir, entry), "utf8");
    } catch {
      continue;
    }
    // The file serves a table resource iff it exports a class whose name matches
    // its filename (base) and extends databases.<db>.<sameName>.
    for (const m of src.matchAll(EXPORTED_TABLE_CLASS_RE)) {
      if (m[1] === base) { names.push(base); break; }
    }
  }
  names.sort();
  return names.length ? names : [FALLBACK_VERIFY_RESOURCE];
}

// flair#870: flair declares the BARE `harper` package name, so that is probed
// first. `@harperfast/harper` is a permanent lockstep publish of the same
// source under the legacy scoped name; it stays in the probe list because
// `packageRoot` can be a staged install of an OLDER published flair (see
// src/fabric-upgrade.ts) that declared the scoped name.
const HARPER_PKG_NAMES = ["harper", "@harperfast/harper"] as const;

function resolveHarperBin(packageRoot: string): string {
  for (const pkg of HARPER_PKG_NAMES) {
    const local = join(packageRoot, "node_modules", pkg, "dist/bin/harper.js");
    if (existsSync(local)) return local;
  }

  for (const pkg of HARPER_PKG_NAMES) {
    try {
      const req = createRequire(join(packageRoot, "package.json"));
      const mainPath = req.resolve(pkg);
      let dir = dirname(mainPath);
      for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "dist/bin/harper.js");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* try the next package name */
    }
  }
  throw new Error(
    `Could not locate Harper CLI binary (tried ${HARPER_PKG_NAMES.join(", ")}). ` +
      "Flair deploy requires Harper to be installed alongside Flair.",
  );
}

// Pure arg-array builder — separated from spawnHarper so the timeout
// passthrough (and the rest of the arg shape) is unit-testable without
// mocking child_process / actually spawning harper.
export function buildHarperDeployArgs(
  opts: DeployOptions,
  url: string,
  project: string,
): string[] {
  const deploymentTimeoutMs = opts.deploymentTimeoutMs ?? DEFAULT_DEPLOYMENT_TIMEOUT_MS;
  const installTimeoutMs = opts.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const args = [
    "deploy",
    `target=${url}`,
    `project=${project}`,
    `restart=${opts.restart !== false}`,
    `replicated=${opts.replicated !== false}`,
    `deployment_timeout=${deploymentTimeoutMs}`,
    `install_timeout=${installTimeoutMs}`,
  ];
  // --ignore-replication-errors escape hatch. Only appended when
  // set — omitted entirely otherwise, so this is a no-op for every existing
  // caller/test that doesn't pass it.
  if (opts.ignoreReplicationErrors) {
    args.push("ignore_replication_errors=true");
  }
  return args;
}

// Flaky-peer-replication resilience defaults. See DeployOptions
// for the full incident writeup this closes.
//
// ── Why this default is 0 (flair#878) ───────────────────────────────────────
// It was 2 (three attempts). The reasoning behind that — "a bare manual re-run
// cleared it, so let the tool self-heal" — was right about the symptom and
// wrong about the mechanism. What actually clears a peer-replication error is
// Harper finishing its own asynchronous replication; the re-run merely happened
// to take long enough for that to complete. Retrying is not what fixed it, and
// the retry is not free:
//
//   1. It races work that was going to succeed anyway. Harper keeps replicating
//      after the deploy call returns, so the retry re-issues a full deploy into
//      a cluster mid-heal.
//   2. It is not idempotent. A retry re-runs the whole deploy including
//      Harper's own `npm install` into the component directory on every node.
//      Overlapping that with the previous attempt's still-running install is
//      how the reported upgrade died with
//      `ENOTEMPTY: directory not empty, rmdir '.../node_modules/<pkg>/dist'`
//      on a native module — a hard failure the original error never was.
//   3. It is now redundant. The convergence poll added in flair#878 covers
//      exactly the window a retry was buying, WITHOUT touching the cluster:
//      it waits and looks instead of waiting and re-deploying.
//
// So the remedy was strictly worse than the problem it retried, and the thing
// it was compensating for is now observed directly. Retrying is kept as an
// explicit opt-in (`--deploy-retries <n>`) for the genuine case — replication
// observed NOT to converge — where it is additionally gated on the origin
// having gone quiescent first (see awaitOriginQuiescent).
export const DEFAULT_DEPLOY_RETRIES = 0;
export const DEPLOY_RETRY_BACKOFF_MS = [5_000, 10_000];

// The signature of a Fabric PEER-REPLICATION failure specifically — harper
// deploys fine to the origin node, but pushing the component to a peer
// fails, e.g.:
//   "Component 'flair' was deployed on the origin node but failed to
//    replicate to 1 of 1 peer node(s): ... (Error: Connection closed 1006)"
// This is the CORRECTNESS-CRITICAL part of the fix: matching this pattern
// (and ONLY this pattern) is what lets us retry a known flake while still
// failing fast on a real deploy failure (bad package, auth, missing files —
// none of which mention peer replication and must never be retried).
// Literal regex, no interpolation.
export const REPLICATION_FAILURE_RE =
  /failed to replicate to \d+ (of \d+ )?peer|connection closed\s+1006|ignore_replication_errors/i;

interface HarperSpawnResult {
  code: number | null;
  output: string;
}

// ─── Failure-class bookkeeping (flair#878) ──────────────────────────────────

/**
 * "replication" = harper reached the origin fine and only peer replication
 * failed (REPLICATION_FAILURE_RE). "other" = anything else — auth, bad package,
 * a broken install. The distinction is what makes the anti-escalation rule
 * below expressible.
 */
export type DeployFailureKind = "replication" | "other";

export interface DeployAttemptFailure {
  attempt: number;
  totalAttempts: number;
  code: number | null;
  kind: DeployFailureKind;
  /** A short, operator-legible extract of harper's output for this attempt. */
  summary: string;
}

const HARPER_OUTPUT_SUMMARY_MAX = 300;

/**
 * Pull the most useful single line out of harper's combined output. Prefers the
 * last line that looks like an error, falling back to the last non-empty line —
 * harper prints its fatal reason last on both paths.
 */
export function summarizeHarperOutput(output: string): string {
  const lines = (output ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^\s*[!>]\s?/, "").trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "(no output)";
  const errorish = [...lines].reverse().find((l) => /error|failed|cannot|denied|exit code/i.test(l));
  const chosen = errorish ?? lines[lines.length - 1];
  return chosen.length > HARPER_OUTPUT_SUMMARY_MAX
    ? chosen.slice(0, HARPER_OUTPUT_SUMMARY_MAX - 1) + "…"
    : chosen;
}

/**
 * Build the error message for a failed deploy from the FULL attempt history.
 *
 * ── The rule this encodes (flair#878, the core defect) ──────────────────────
 * The reported failure is always the FIRST attempt's failure. A later attempt
 * can only exist because this CLI chose to retry, so a later, different failure
 * describes the state the CLI's own remedy created — not the state the operator
 * needs to act on. In the reported incident attempt 1 was a transient
 * peer-replication warning and attempt 2 died with npm `ENOTEMPTY` on a native
 * module; surfacing the ENOTEMPTY sent the diagnosis into the component's
 * node_modules when the actual event was "a peer link blipped and then healed".
 *
 * The later failure is still REPORTED — suppressing it would hide that the
 * cluster may have been left in a worse state — but it is explicitly labelled
 * as a consequence of retrying, with the remedy (stop retrying) named inline.
 * Errors have to enable a response, and "ENOTEMPTY on node-llama-cpp/dist"
 * enables the wrong one.
 */
export function describeDeployFailure(
  failures: DeployAttemptFailure[],
  convergence?: ConvergenceResult | null,
): string {
  if (failures.length === 0) return "harper deploy failed with no recorded attempt";

  const primary = failures[0];
  const escalations = failures
    .slice(1)
    .filter((f) => f.kind !== primary.kind || f.summary !== primary.summary);

  const lines: string[] = [];
  if (primary.kind === "replication") {
    lines.push(
      `harper deploy exited with code ${primary.code}: the component deployed to the origin node but ` +
        `peer replication was reported failed, and this CLI could not confirm the peers converged.`,
    );
  } else {
    lines.push(`harper deploy exited with code ${primary.code}: ${primary.summary}`);
  }

  if (convergence) {
    lines.push(`  convergence check: ${convergence.detail}`);
  }

  if (failures.length > 1) {
    lines.push(
      `  attempt 1 of ${primary.totalAttempts} is the failure reported above (${primary.summary}).`,
    );
  }

  for (const f of escalations) {
    const consequence =
      primary.kind === "replication" && f.kind === "other"
        ? ` This is a CONSEQUENCE of retrying, not the original problem: re-running a deploy over a component ` +
          `directory the previous attempt is still installing into is not idempotent (npm ENOTEMPTY on a native ` +
          `module is the known shape). Diagnose the replication failure above, not this. Run with ` +
          `--deploy-retries 0 to remove this class of failure entirely.`
        : "";
    lines.push(`  attempt ${f.attempt} of ${f.totalAttempts} then failed with: ${f.summary}.${consequence}`);
  }

  if (primary.kind === "replication") {
    lines.push(
      `  Pass --ignore-replication-errors to accept an origin-only deploy, or re-run once the peer link recovers.`,
    );
  }

  return lines.join("\n");
}

// Tee-style capture: streams harper's stdout/stderr to the user in real time
// (unchanged UX — a multi-minute deploy needs live progress, not a black
// box) while ALSO buffering the combined text so the caller can
// pattern-match REPLICATION_FAILURE_RE against it after exit. This replaces
// the previous stdio:"inherit" passthrough, which gave no way to inspect
// harper's output. stdin stays "inherit" — harper's deploy never reads
// from it, so there's nothing to tee there.
//
// Resolves on "close", NOT "exit" (flair#699). Node's child_process fires
// "exit" as soon as the process terminates, but the piped stdout/stderr
// streams can still have buffered `data` events in flight at that instant —
// "exit" makes no promise that every chunk already written by the child has
// been delivered to our listeners yet. "close" is the event Node guarantees
// fires only after all stdio streams have ended, i.e. every `data` chunk has
// already been pushed into `chunks`. Resolving on "exit" was a real
// output-capture race, not just a test artifact: under scheduler pressure
// (e.g. loaded CI runners) the process could exit and this promise could
// resolve before the final stderr chunk — often exactly the line carrying
// the replication-failure signature, since callers naturally console.error
// their last message immediately before process.exit() — had been received,
// so REPLICATION_FAILURE_RE silently missed a match it should have made and
// runHarperDeploy fell through to the generic "exited with code N" error.
function spawnHarperCaptured(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HarperSpawnResult> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env,
    });
    const chunks: string[] = [];
    p.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(d);
      chunks.push(d.toString("utf8"));
    });
    p.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(d);
      chunks.push(d.toString("utf8"));
    });
    p.on("error", rejectP);
    p.on("close", (code) => resolveP({ code, output: chunks.join("") }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Runs `harper deploy`, retrying ONLY on the flaky peer-replication failure
// signature (REPLICATION_FAILURE_RE) — the real incident this closes: the
// origin deployed fine, replication to a peer failed with a transient
// "Connection closed 1006", and a bare manual retry cleared it with no
// other change. This re-runs the FULL harper deploy (prepare/install/
// replicate), not just a peer-only re-push — wasteful, but it's exactly
// what worked by hand, and harper's CLI has no "retry replication only"
// entry point. Any other failure (bad package, auth, missing files, ...)
// is never retried — it fails fast, same as before this change.
async function runHarperDeploy(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: DeployOptions,
  targetUrl: string,
  project: string,
): Promise<{ replicationWarning: boolean; convergedAfterReplicationError: boolean }> {
  const maxRetries = opts.deployRetries ?? DEFAULT_DEPLOY_RETRIES;
  const backoff = opts.deployRetryBackoffMs ?? DEPLOY_RETRY_BACKOFF_MS;
  const totalAttempts = Math.max(1, maxRetries + 1);
  const convergenceDeps =
    opts.convergenceDeps ??
    defaultConvergenceDeps(opts.fabricUser, opts.fabricPassword, opts.onProgress);

  // The attempt history is what makes the anti-escalation rule possible —
  // describeDeployFailure() always reports failures[0], never the newest.
  const failures: DeployAttemptFailure[] = [];
  let lastConvergence: ConvergenceResult | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const { code, output } = await spawnHarperCaptured(bin, args, cwd, env);
    if (code === 0) return { replicationWarning: false, convergedAfterReplicationError: false };

    const isReplicationFailure = REPLICATION_FAILURE_RE.test(output);
    const isLastAttempt = attempt === totalAttempts;
    failures.push({
      attempt,
      totalAttempts,
      code,
      kind: isReplicationFailure ? "replication" : "other",
      summary: summarizeHarperOutput(output),
    });

    // A non-replication failure has never been retried and still isn't. It
    // fails fast — but through describeDeployFailure(), so that when it lands
    // as attempt 2+ it is reported as the consequence of a retry rather than
    // as the headline. That reordering IS the flair#878 fix.
    if (!isReplicationFailure) {
      throw new Error(describeDeployFailure(failures, lastConvergence));
    }

    // ── flair#878 step 1: check convergence BEFORE deciding anything ────────
    // Harper is still replicating after the call returned. Look before
    // declaring, and before retrying — a converged upgrade must report success.
    if (opts.convergenceCheck !== false) {
      const parsed = parseReplicationFailure(output);
      opts.onProgress?.(
        parsed.peers.length
          ? `peer replication reported failed for ${parsed.peers.length} node(s) — checking whether it converged anyway...`
          : `peer replication reported failed — harper named no peer nodes, so convergence cannot be checked`,
      );
      lastConvergence = await awaitReplicationConvergence(
        {
          targetUrl,
          project,
          peers: parsed.peers,
          timeoutMs: opts.convergenceTimeoutMs,
          pollIntervalMs: opts.convergencePollIntervalMs,
        },
        convergenceDeps,
      );

      if (lastConvergence.converged) {
        console.warn(
          `⚠ flair deploy: harper reported a peer-replication failure on attempt ${attempt}/${totalAttempts}, ` +
            `but replication CONVERGED on its own — ${lastConvergence.detail}. Harper replicates components ` +
            `asynchronously, so that error was a snapshot, not a verdict. Treating this deploy as SUCCESSFUL.`,
        );
        opts.onProgress?.(`peer replication converged after ${lastConvergence.elapsedMs}ms — deploy succeeded`);
        return { replicationWarning: false, convergedAfterReplicationError: true };
      }
    }

    // ── flair#878 steps 2 + 4: retry only when it is justified AND safe ─────
    // Justified: we positively OBSERVED non-convergence. An unknown is not a
    // licence to re-deploy — the retry is the destructive operation here.
    // Safe: the origin's component tree has stopped changing, so attempt N+1
    // cannot collide with attempt N's still-running server-side install (the
    // ENOTEMPTY shape).
    if (!isLastAttempt) {
      let refusal: string | null = null;
      let retryReason = "";

      if (opts.convergenceCheck === false) {
        // --no-convergence-check is an explicit "do what you did before
        // flair#878": no operations-API polling at all, retry on the
        // replication signature alone. Honour it rather than silently
        // downgrading it to "never retry" — an operator who set BOTH this and
        // --deploy-retries has asked for the old behaviour, hazard included.
        // The anti-escalation rule still applies, so a retry that fails
        // differently still cannot hijack what gets reported.
        retryReason = "convergence checking is disabled (--no-convergence-check)";
      } else if (!lastConvergence || !lastConvergence.conclusive) {
        refusal =
          `peer replication could not be confirmed either way ` +
          `(${lastConvergence?.detail ?? "no convergence result"}). Re-deploying without knowing whether the ` +
          `cluster converged risks colliding with an in-flight replication or install; reporting the original ` +
          `failure instead.`;
      } else {
        const quiescence: QuiescenceResult = await awaitOriginQuiescent(
          { targetUrl, project },
          convergenceDeps,
        );
        if (!quiescence.quiescent) {
          refusal =
            `${quiescence.detail}. Re-deploying while the origin's component directory is still being written ` +
            `is the overlap that turns a replication warning into a hard install failure (npm ENOTEMPTY over an ` +
            `existing native-module tree).`;
        } else {
          retryReason = `origin is quiescent (${quiescence.detail})`;
        }
      }

      if (refusal) {
        console.warn(`⚠ flair deploy: NOT retrying — ${refusal}`);
        opts.onProgress?.(`not retrying — ${refusal}`);
      } else {
        const waitMs = backoff[Math.min(attempt - 1, backoff.length - 1)];
        // Self-healing must be visible, never silent — console.warn directly
        // (not gated behind onProgress, which some callers like
        // fabric-upgrade.ts don't wire up) so this is loud regardless of caller.
        console.warn(
          `⚠ flair deploy: replication did not converge on attempt ${attempt}/${totalAttempts} ` +
            `(harper deploy exited ${code}); ${retryReason} — retrying in ${Math.round(waitMs / 1000)}s...`,
        );
        opts.onProgress?.(
          `replication did not converge on attempt ${attempt}/${totalAttempts} — retrying in ${Math.round(waitMs / 1000)}s...`,
        );
        await sleep(waitMs);
        continue;
      }
    }

    if (opts.ignoreReplicationErrors) {
      console.warn(
        `⚠ flair deploy: peer replication still failing after ${attempt} attempt(s), ` +
          `but --ignore-replication-errors is set — treating this as a WARNED SUCCESS ` +
          `(deployed to the origin node only; the peer will need to catch up via normal ` +
          `federation sync or a later deploy).`,
      );
      opts.onProgress?.(
        `WARNING: proceeding origin-only — peer replication did not complete after ${attempt} attempt(s)`,
      );
      return { replicationWarning: true, convergedAfterReplicationError: false };
    }

    throw new Error(describeDeployFailure(failures, lastConvergence));
  }

  // Unreachable — the loop always returns or throws — but keeps TS happy.
  throw new Error("harper deploy: exhausted retry loop without resolving");
}

// A single reachability probe against the served (REST) base URL. Harper
// restarts the process after every deploy, so the endpoint FLAPS for a bit —
// connection refused / reset / DNS blips are all EXPECTED right after
// restart, not a failure signal by themselves. Any HTTP response at all
// (regardless of status code — a 404 on `/` is normal) proves the process
// is back up and terminating TLS/HTTP again; that's all "reachable" means
// here. Resource-level 404s are a separate, later check.
async function probeReachable(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    await fetchImpl(baseUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

export interface VerifyDeployOptions {
  baseUrl: string;
  resources: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  settleStreak?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

async function pollUntilSettled(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
  settleStreak: number,
  fetchImpl: typeof fetch,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let attempt = 0;
  for (;;) {
    attempt++;
    const reachable = await probeReachable(baseUrl, fetchImpl);
    streak = reachable ? streak + 1 : 0;
    if (!reachable) {
      onProgress?.(`waiting for ${baseUrl} to come back up after restart (attempt ${attempt})...`);
    }
    if (streak >= settleStreak) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `deploy verification: ${baseUrl} did not settle within ${timeoutMs}ms after restart ` +
          `(Harper never came back up, or is unusually slow to restart post-deploy)`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

async function verifyResourcesServing(
  baseUrl: string,
  resources: string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  const notServing: string[] = [];
  for (const name of resources) {
    const path = `${base}/${name}`;
    let status: number;
    try {
      const res = await fetchImpl(path, { method: "GET", signal: AbortSignal.timeout(10_000) });
      status = res.status;
    } catch (err: any) {
      throw new Error(
        `deploy verification: request to ${path} failed even after the endpoint settled: ${err?.message ?? err}`,
      );
    }
    // 404 = the resource genuinely isn't being served (this is the incident:
    // harper reported "Successfully deployed" while the component was empty).
    // 401 = auth-gated, which means the resource IS being served correctly.
    // 200 = served + accessible. Both count as pass.
    if (status === 404) notServing.push(name);
  }
  if (notServing.length) {
    const list = notServing.map((n) => `/${n}`).join(", ");
    throw new Error(
      `deploy reported success but ${list} return${notServing.length === 1 ? "s" : ""} 404 — ` +
        `component is not serving; likely deployed the wrong package root`,
    );
  }
}

// ─── The component `.env` the deploy ships (flair#1005 item 2) ────────────────
//
// `harper deploy` packs its own CWD — every file under it except `node_modules`
// (harper/dist/bin/cliOperations.js sets `skip_node_modules` unless explicitly
// disabled, and harper/dist/components/packageComponent.js's `isExcluded` is the
// only other filter). So a `.env` sitting in the deploy root ships; there is no
// entries list to add it to, and no `.env` is special-cased away. Verified by
// running harper's own packer over a directory containing one.
//
// What this must NOT do is write into `packageRoot`. That directory is an
// npm-installed package — frequently not writable by the deploying user, shared by
// every deploy from this machine, and, when the operator has put their own `.env`
// there, theirs. So when flair has a key to add, it copies the deploy root to a
// temp directory, writes the merged file THERE, and points harper at the copy. The
// operator's tree is read and never written.
//
// The copy skips `node_modules` for the obvious reason (it can be gigabytes) and
// for the correctness one: harper excludes it at pack time regardless, so the
// resulting payload is identical. `deploy-staging.test.ts` asserts that identity
// with harper's real packer rather than trusting this paragraph.

const STAGING_PREFIX = "flair-deploy-";

export interface StagedDeployRoot {
  /** Directory harper should pack — either the staged copy or `packageRoot` itself. */
  dir: string;
  plan: ComponentEnvPlan;
  /** Removes the staged copy. A no-op when nothing was staged. */
  cleanup: () => void;
}

/** True for any path inside a `node_modules` directory under `root`. */
function isNodeModulesPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel.split(sep).includes("node_modules");
}

/**
 * Resolve the value `FLAIR_PUBLIC_URL` should carry for this deploy, or null.
 *
 * The deploy already knows this: `url` is the target it hands to harper AND the
 * base URL it verifies the served API against immediately afterwards. A loopback
 * target yields null — baking `http://127.0.0.1:...` into a shipped `.env` is
 * precisely the misconfiguration flair#1000 is about, so it is never generated.
 *
 * Anything that is not an absolute http(s) URL also yields null. `--target` is
 * operator-supplied and reaches here before harper has had a chance to reject it,
 * and a value that is not a URL cannot be the base of a discovery document — so
 * "cannot be determined" is answered by supplying nothing rather than by baking in
 * a string that would make every advertised endpoint malformed.
 */
export function resolveDeployPublicUrl(url: string): string | null {
  const trimmed = String(url ?? "").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return isLoopbackUrl(trimmed) ? null : trimmed;
}

/**
 * Prepare the directory harper will pack, supplying `FLAIR_PUBLIC_URL` when the
 * payload does not already carry it. Returns `packageRoot` unchanged (and a no-op
 * cleanup) whenever there is nothing to add — the common cases being a loopback
 * target and an operator who has already set the key.
 */
export function stageDeployRoot(packageRoot: string, publicUrl: string | null): StagedDeployRoot {
  const envPath = join(packageRoot, COMPONENT_ENV_FILENAME);
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  const plan = planComponentEnv(existing, publicUrl);

  if (plan.text === null) {
    return { dir: packageRoot, plan, cleanup: () => {} };
  }

  const dir = mkdtempSync(join(tmpdir(), STAGING_PREFIX));
  try {
    cpSync(packageRoot, dir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (src) => !isNodeModulesPath(packageRoot, src),
    });
    // 0600 even though the generated content is a public URL: an operator's own
    // keys may have been merged through, and the file's permissions should not
    // depend on what happens to be in it.
    writeFileSync(join(dir, COMPONENT_ENV_FILENAME), plan.text, { mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, plan, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Post-deploy: is the instance advertising a URL a client can reach? ───────
//
// This is the check that makes the writer above testable in production rather than
// merely present. flair#1000 was a deploy that reported success while the served
// OAuth discovery document named `http://127.0.0.1:9980` for every endpoint, so a
// remote client followed discovery to its own loopback. Nothing in the deploy
// noticed, because nothing looked.
//
// A failure here fails the command even though the component IS deployed — the same
// contract as verifyResourcesServing above ("the tool must not be able to lie"). A
// deploy that leaves an instance no client can authorize against is not a success,
// and the operator needs to hear that at deploy time rather than from a user.
//
// An unreadable document is NOT treated as a pass: it is reported as a check that
// did not run, with the reason.
//
// It POLLS rather than reading once. A Fabric restart is rolling, so for a while
// after `harper deploy` returns, a request to the cluster can be answered by a node
// that has not restarted yet and is still running the previous environment. Reading
// once would turn that race into a failed deploy for a change that was fine. The
// poll only ever converts a "not yet" into a wait — a genuinely misconfigured
// instance still fails, at the deadline.

export const OAUTH_METADATA_PATH = "/OAuthMetadata";
export const DEFAULT_ISSUER_CHECK_TIMEOUT_MS = 60_000;
export const ISSUER_CHECK_POLL_INTERVAL_MS = 5_000;

export interface VerifyPublicIssuerOptions {
  baseUrl: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

export interface PublicIssuerResult {
  /** false when the document could not be read — never rendered as a pass. */
  checked: boolean;
  issuer: string | null;
  detail: string;
}

/** One read of the discovery document. `issuer: null` means "could not be read". */
async function readAdvertisedIssuer(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ issuer: string | null; detail: string }> {
  try {
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { issuer: null, detail: `HTTP ${res.status} from ${url}` };
    const doc = (await res.json()) as { issuer?: unknown };
    if (typeof doc?.issuer !== "string" || doc.issuer === "") {
      return { issuer: null, detail: `${url} returned no issuer` };
    }
    return { issuer: doc.issuer, detail: `issuer ${doc.issuer}` };
  } catch (err: any) {
    return { issuer: null, detail: `${url} could not be read: ${err?.message ?? err}` };
  }
}

export async function verifyPublicIssuer(o: VerifyPublicIssuerOptions): Promise<PublicIssuerResult> {
  const {
    baseUrl,
    timeoutMs = DEFAULT_ISSUER_CHECK_TIMEOUT_MS,
    pollIntervalMs = ISSUER_CHECK_POLL_INTERVAL_MS,
    fetchImpl = fetch,
    onProgress,
  } = o;
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}${OAUTH_METADATA_PATH}`;
  onProgress?.(`checking ${OAUTH_METADATA_PATH} advertises a reachable issuer...`);

  const deadline = Date.now() + timeoutMs;
  let last = await readAdvertisedIssuer(url, fetchImpl);
  for (;;) {
    if (last.issuer !== null && !isLoopbackUrl(last.issuer)) {
      return { checked: true, issuer: last.issuer, detail: last.detail };
    }
    if (Date.now() >= deadline) break;
    onProgress?.(
      last.issuer === null
        ? `${OAUTH_METADATA_PATH} not readable yet (${last.detail}) — retrying...`
        : `${OAUTH_METADATA_PATH} still advertises ${last.issuer} — the restart may not have reached every node yet, retrying...`,
    );
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    last = await readAdvertisedIssuer(url, fetchImpl);
  }

  if (last.issuer !== null) {
    throw new Error(
      `deploy verification: ${url} advertises issuer ${last.issuer} — a loopback address, which ` +
        `every remote client will follow to its own machine (flair#1000). ${PUBLIC_URL_KEY} is ` +
        `not reaching the deployed component's process.env. Fix: ` +
        `${publicUrlRemedy(`${COMPONENT_ENV_FILENAME} in the deploy root`, base)}, then re-deploy.`,
    );
  }
  return { checked: false, issuer: null, detail: last.detail };
}

// The tool must not be able to lie. harper's deploy CLI can print
// "Successfully deployed" for an empty component — the only way to know the
// deploy actually worked is to curl the served API and check it isn't 404.
// This polls the served base URL (443, NOT the :9925 ops API deploy talks
// to) until it settles after harper's post-deploy restart, then asserts the
// derived resource(s) respond non-404.
export async function verifyDeployServing(o: VerifyDeployOptions): Promise<void> {
  const {
    baseUrl,
    resources,
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
    pollIntervalMs = VERIFY_POLL_INTERVAL_MS,
    settleStreak = VERIFY_SETTLE_STREAK,
    fetchImpl = fetch,
    onProgress,
  } = o;
  onProgress?.(`verifying ${baseUrl} is actually serving (not just reported deployed)...`);
  await pollUntilSettled(baseUrl, timeoutMs, pollIntervalMs, settleStreak, fetchImpl, onProgress);
  onProgress?.(`settled — checking ${resources.map((r) => `/${r}`).join(", ")}...`);
  await verifyResourcesServing(baseUrl, resources, fetchImpl);
  onProgress?.(`served API verified non-404 for ${resources.length} resource(s)`);
}

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const errors = validateOptions(opts);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  const packageRoot = resolvePackageRoot(opts.packageRoot);
  validatePackageLayout(packageRoot);

  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const version = opts.version ?? pkg.version;
  const project = opts.project ?? "flair";
  const url = buildTargetUrl(opts);

  if (opts.dryRun) {
    return { url, project, version, packageRoot, dryRun: true };
  }

  if (opts.fabricToken && !(opts.fabricUser && opts.fabricPassword)) {
    throw new Error(
      "Bearer token auth (--fabric-token) is not yet supported — " +
        "Harper's deploy_component CLI path only accepts Basic auth today. " +
        "Pass --fabric-user + --fabric-password instead.",
    );
  }

  const harperBin = resolveHarperBin(packageRoot);
  const args = buildHarperDeployArgs(opts, url, project);

  // Credentials go via env, not argv, so they don't appear in `ps` output
  // for the lifetime of the Harper child process. Harper's cliOperations
  // reads CLI_TARGET_USERNAME / CLI_TARGET_PASSWORD as env fallbacks.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLI_TARGET_USERNAME: opts.fabricUser,
    CLI_TARGET_PASSWORD: opts.fabricPassword,
  };

  // flair#1005 item 2: supply FLAIR_PUBLIC_URL to the component being deployed.
  // `deployRoot` is packageRoot itself whenever there is nothing to add.
  const publicUrl = resolveDeployPublicUrl(url);
  const staged = stageDeployRoot(packageRoot, publicUrl);
  for (const notice of staged.plan.notices) {
    console.warn(`⚠ flair deploy: ${notice}`);
    opts.onProgress?.(notice);
  }
  if (staged.plan.action === "added") {
    opts.onProgress?.(
      `shipping ${COMPONENT_ENV_FILENAME} with ${PUBLIC_URL_KEY}=${staged.plan.effectiveValue}`,
    );
  }

  let replicationWarning: boolean;
  let convergedAfterReplicationError: boolean;
  try {
    ({ replicationWarning, convergedAfterReplicationError } = await runHarperDeploy(
      harperBin,
      args,
      staged.dir,
      childEnv,
      opts,
      url,
      project,
    ));
  } finally {
    staged.cleanup();
  }

  // harper can print "Successfully deployed" for a component that isn't
  // actually serving anything (the incident this closes: an empty deploy,
  // reported success, /Memory 404ing in prod). Verify by curling the served
  // API — on by default, escape hatch via --no-verify.
  if (opts.verify !== false) {
    const resources = opts.verifyResources?.length
      ? opts.verifyResources
      : deriveVerifyResources(packageRoot);
    await verifyDeployServing({
      baseUrl: url,
      resources,
      timeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      onProgress: opts.onProgress,
    });

    // Only meaningful for a target that is not loopback: a local Harper SHOULD
    // advertise loopback, and asserting otherwise there would be wrong.
    if (publicUrl) {
      const issuerCheck = await verifyPublicIssuer({ baseUrl: url, onProgress: opts.onProgress });
      if (issuerCheck.checked) {
        opts.onProgress?.(`discovery advertises ${issuerCheck.issuer}`);
      } else {
        // Not a pass. Say which check did not run, and why.
        console.warn(
          `⚠ flair deploy: could not verify the advertised OAuth issuer — ${issuerCheck.detail}. ` +
            `This check did NOT run; ${PUBLIC_URL_KEY} may or may not have taken effect.`,
        );
        opts.onProgress?.(`issuer check did not run — ${issuerCheck.detail}`);
      }
    }
  }

  return {
    url,
    project,
    version,
    packageRoot,
    dryRun: false,
    replicationWarning,
    convergedAfterReplicationError,
  };
}
