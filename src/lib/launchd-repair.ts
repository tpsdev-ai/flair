/**
 * launchd-repair.ts — the `doctor --fix` launchd repair (flair#1573 slice b).
 *
 * Slice (a) made the no-inline-secret plist a product capability (pass-file
 * mode + the product launcher). This module is the DECISION half of the repair
 * that uses it: given the current launchd observation and the on-disk plist,
 * decide what `doctor --fix` may do — and, just as importantly, what it must
 * refuse to do. The EXECUTION half (regenerate the plist, adopt a running
 * process, load, verify) lives in src/cli.ts, which owns the real filesystem
 * and launchctl; everything here is pure and unit-testable without either.
 *
 * The two load-bearing decisions, both from the adjudication (issue comment
 * 5607172125):
 *
 *   1. CONFIG AUTHORITY (flair#914). The whole fix is gated on the instance's
 *      own harper-config.yaml being readable. ROOTPATH and the ports come from
 *      that file — never ~/.flair/config.yaml, never defaults — because a
 *      wrong ROOTPATH boots Harper against the wrong data directory, which is
 *      the data-adjacent disaster this issue exists to prevent. If the config
 *      cannot be read, there is no safe way to regenerate the plist, so the
 *      repair refuses rather than invent a ROOTPATH.
 *
 *   2. OWNERSHIP GUARD (mirror flair#966). A plist is only repaired when it is
 *      provably ours (ROOTPATH == dataDir), provably corrupt (not XML), or
 *      absent. A valid plist whose ROOTPATH names a DIFFERENT directory is a
 *      different instance and is refused. A valid plist with NO ROOTPATH at all
 *      cannot be attributed, so it is refused and the file is named — the
 *      operator decides. (No TTY confirm-adopt escape hatch exists; a
 *      confirm-adopt for the unattributable case is slice b3, if ever.)
 *
 * The state matrix the plan collapses to:
 *
 *   - not-applicable (not macOS)  -> no-op.
 *   - managed                     -> no-op ("already managed").
 *   - absent / corrupt / ours     -> regenerate (pass-file mode).
 *   - foreign / unattributable    -> refuse.
 *   - config unreadable           -> refuse.
 *   - detached-and-running (ours) -> adopt (clean-stop -> regenerate -> load).
 *   - detached-and-running (foreign) -> refuse (ownership guard).
 *   - no satisfiable admin-pass   -> refuse (flair#1685; a pass-file plist
 *     whose launcher argv names a missing/unsafe file can never start). The
 *     plan carries the credential decision (`credential.writeAdminPassFile`)
 *     so the executor only writes when the planner says it is proven.
 */

import { resolve } from "node:path";
import type { LaunchdManagement } from "./launchd-management.js";
import type { DaemonState, HealthResult } from "./daemon-liveness.js";
import { preserveHttpPortValue, preserveSecurePort } from "./http-bind.js";

// ─── plist disposition (the ownership guard's first question) ─────────────

export type PlistDisposition =
  /** No plist file at the resolved path. */
  | "absent"
  /** A plist file exists but is not a readable XML document (e.g. the reported bare JSON array). */
  | "corrupt"
  /** A valid plist whose ROOTPATH resolves to this instance's data dir. */
  | "ours"
  /** A valid plist whose ROOTPATH resolves to a DIFFERENT data dir. */
  | "foreign"
  /** A valid plist with no ROOTPATH key at all — cannot be attributed. */
  | "unattributable";

export interface ClassifyPlistDeps {
  exists: (p: string) => boolean;
  /** Raw file contents, or null when unreadable. */
  read: (p: string) => string | null;
  /** The ROOTPATH value, or null when absent/unreadable. */
  readRootPath: (p: string) => string | null;
}

/**
 * Classify the plist at `plistPath` against `dataDir`.
 *
 * The "corrupt" test is deliberately structural, not a full plist parse: a
 * Flair plist is an XML document with a `<plist>` root and a `<dict>` body,
 * and the reported corruption (a bare JSON array) has neither. A full parser
 * would pull the whole EnvironmentVariables dict — including the admin
 * password — into memory to answer a question about two tags, and the shape
 * here is fixed because buildLaunchdPlist wrote it.
 */
export function classifyPlist(
  plistPath: string,
  dataDir: string,
  deps: ClassifyPlistDeps,
): PlistDisposition {
  if (!deps.exists(plistPath)) return "absent";
  const raw = deps.read(plistPath);
  if (raw === null) return "corrupt";
  if (!/<plist[\s>]/.test(raw) || !/<dict>/.test(raw)) return "corrupt";
  const rootPath = deps.readRootPath(plistPath);
  if (rootPath === null) return "unattributable";
  return resolve(rootPath) === resolve(dataDir) ? "ours" : "foreign";
}

// ─── the repair plan ───────────────────────────────────────────────────────

export type RepairPlan =
  | { kind: "no-op"; reason: "already-managed" | "not-applicable"; detail: string }
  | {
      kind: "refuse";
      reason: "foreign" | "unattributable" | "config-unreadable" | "unsupported-config" | "missing-credential";
      detail: string;
      plistPath?: string;
    }
  | { kind: "regenerate"; detail: string; credential: RepairPlanCredential }
  | { kind: "adopt"; detail: string; credential: RepairPlanCredential };

/**
 * How the executor can satisfy the pass-file launcher's argv (flair#1685).
 *
 * The generated plist is ALWAYS pass-file mode: its launcher
 * (templates/launchd/start-flair-with-admin-pass.sh) reads a 0600 file as
 * argv[1] and exits 1 when that file is missing or unsafe. So the planner may
 * only emit a regenerate/adopt plan when the file is already valid, or when a
 * credential is available AND a live instance exists to prove it against — the
 * file is materialized from a credential that provably belonged to THIS
 * instance seconds before the plist names it. Otherwise the plan refuses and
 * writes no plist.
 */
export type AdminPassAvailability =
  /** ~/.flair/admin-pass exists and satisfies readSecretFileSecure's mode check — reuse, never rewrite. */
  | { kind: "existing-valid" }
  /** A credential is available from the environment but has not yet been proven against the live instance. */
  | { kind: "candidate"; source: "env" }
  /** No usable credential and no usable pass file. `detail` states why, without the secret. */
  | { kind: "missing"; detail: string };

/** The credential half of a regenerate/adopt plan (flair#1685). */
export interface RepairPlanCredential {
  /**
   * True when the executor must materialize the credential into the pass file
   * BEFORE it writes the plist. Only ever true for an env candidate on the
   * adopt arm — the one case with a live instance to prove it against.
   */
  writeAdminPassFile: boolean;
  /** Where the credential comes from. */
  source: "existing-file" | "env";
}

export interface PlanLaunchdRepairInput {
  observation: LaunchdManagement;
  disposition: PlistDisposition;
  plistPath: string;
  /** True when a direct (non-launchd) process is serving this instance right now. */
  directProcessRunning: boolean;
  /** True when the instance's harper-config.yaml is readable (the config-authority gate). */
  configReadable: boolean;
  /** Absolute path the generated plist's launcher will read (defaultAdminPassPath()). */
  adminPassPath: string;
  /** Resolved pass-file availability (pure). */
  adminPass: AdminPassAvailability;
  /**
   * The instance's OWN recorded bind values, when the caller read a config.
   * Supplying them lets the PLANNER refuse a configuration the executor cannot
   * serialise (a disabled or unparseable http.port) BEFORE it stops anything —
   * see `validateRepairBindValues`. Omitted by callers with no config (the
   * config-authority gate refuses those anyway).
   */
  configBindValues?: RepairConfigBindValues;
}

/** The bind values a repair would serialise, read from harper-config.yaml. */
export interface RepairConfigBindValues {
  /** `http.port` — may be a bare port, a `host:port`, or null/absent (disabled). */
  httpPort: unknown;
  /** `http.securePort`, when the instance records one. */
  httpSecurePort?: unknown;
  /** `operationsApi.network.securePort`, when the instance records one. */
  opsSecurePort?: unknown;
}

/**
 * Refuse an instance whose recorded bind values a repair cannot serialise,
 * WITHOUT bouncing or writing anything. Returns the refusal detail, or null when
 * the values are repairable.
 *
 * This must run during PLANNING. `buildRepairPlist` (the executor's writer) is
 * the first caller of the preservation helpers and runs AFTER the adopt arm's
 * clean-stop, so a throw there would leave the live instance DOWN with the
 * circular remedy "flair doctor --fix" — the command that just bounced it.
 */
export function validateRepairBindValues(values: RepairConfigBindValues): string | null {
  try {
    preserveHttpPortValue(values.httpPort);
    preserveSecurePort(values.httpSecurePort);
    preserveSecurePort(values.opsSecurePort);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Decide what `doctor --fix` may do about launchd management.
 *
 * Pure: no filesystem, no launchctl. The executor in cli.ts turns a
 * `regenerate` plan into a plist write + load + verify, an `adopt` plan into
 * a clean-stop + regenerate + load + verify, and a `refuse` plan into a named
 * refusal.
 */
export function planLaunchdRepair(input: PlanLaunchdRepairInput): RepairPlan {
  const { observation, disposition, plistPath, directProcessRunning, configReadable, adminPass, adminPassPath } = input;

  if (observation.state === "not-applicable") {
    return { kind: "no-op", reason: "not-applicable", detail: observation.detail };
  }
  if (observation.state === "managed") {
    return { kind: "no-op", reason: "already-managed", detail: observation.detail };
  }

  // Config authority (flair#914): no readable harper-config.yaml means no safe
  // ROOTPATH/ports, so the repair cannot proceed without inventing them.
  if (!configReadable) {
    return {
      kind: "refuse",
      reason: "config-unreadable",
      detail:
        "cannot repair launchd management: the instance's harper-config.yaml is missing or unreadable, " +
        "so its ROOTPATH and ports cannot be established. Run 'flair init' to (re)create the instance.",
    };
  }

  // Ownership guard (flair#966 mirror).
  if (disposition === "foreign") {
    return {
      kind: "refuse",
      reason: "foreign",
      detail:
        `refusing to repair the launchd plist at ${plistPath}: it is registered to a different data ` +
        "directory, so it belongs to a different Flair instance.",
      plistPath,
    };
  }
  if (disposition === "unattributable") {
    return {
      kind: "refuse",
      reason: "unattributable",
      detail:
        `refusing to repair the launchd plist at ${plistPath}: it has no ROOTPATH, so it cannot be ` +
        "proven to belong to this instance.",
      plistPath,
    };
  }

  // Bind values the executor could not serialise (ops-nv9d slice 2). Decided
  // HERE, before any arm that stops the live instance, so an unsupported
  // configuration refuses instead of bouncing first and refusing after.
  if (input.configBindValues) {
    const unsupported = validateRepairBindValues(input.configBindValues);
    if (unsupported) {
      return { kind: "refuse", reason: "unsupported-config", detail: unsupported, plistPath };
    }
  }

  // Credential before plist (flair#1685). The plist this plan authorizes is
  // ALWAYS pass-file mode, so its launcher cannot start unless
  // `adminPassPath` exists and is safe. Never authorize a write the product
  // has not itself made startable: reuse a valid file, materialize a proven
  // env candidate, or refuse.
  const credential = planCredential(adminPass, directProcessRunning, adminPassPath, plistPath);
  if ("kind" in credential) {
    return credential;
  }

  // Detached-and-running (flair#1573 slice b2): a direct (non-launchd) process
  // is serving this instance. The plist is ours/absent/corrupt (the foreign and
  // unattributable cases were refused above), so the direct process is THIS
  // instance's and the adopt path clean-stops it before regenerating + loading.
  // The plan states the bounce explicitly: adopt is the one repair that takes
  // the live instance down and back up.
  if (directProcessRunning) {
    return {
      kind: "adopt",
      detail:
        "the instance is running but not under launchd (direct-spawned) — adopting it into launchd " +
        "will clean-stop the live process (SIGTERM, wait for exit), regenerate the plist, and reload it. " +
        "This bounces the live instance.",
      credential: credential as RepairPlanCredential,
    };
  }

  // Repairable: absent, corrupt, or ours, with no direct process in the way.
  return {
    kind: "regenerate",
    detail: "regenerating the launchd plist for this instance",
    credential: credential as RepairPlanCredential,
  };
}

/**
 * Decide whether the pass-file launcher's argv is satisfiable, and how.
 *
 *   - an existing valid file          -> reuse it (never rewrite; flair#827)
 *   - an env candidate + live instance -> write it, after the executor proves
 *     it against the instance
 *   - an env candidate with no live instance, or nothing at all -> refuse
 *
 * A live instance is required to WRITE because the password is not recoverable
 * from Harper (it stores a hash): the only safe source of the file's bytes is a
 * credential that authenticates against THIS instance right now. Trusting an
 * unverified env value would reintroduce the flair#827 desync this avoids.
 */
function planCredential(
  adminPass: AdminPassAvailability,
  directProcessRunning: boolean,
  adminPassPath: string,
  plistPath: string,
): RepairPlanCredential | Extract<RepairPlan, { kind: "refuse" }> {
  if (adminPass.kind === "existing-valid") {
    return { writeAdminPassFile: false, source: "existing-file" };
  }
  if (adminPass.kind === "candidate") {
    if (directProcessRunning) return { writeAdminPassFile: true, source: "env" };
    return {
      kind: "refuse",
      reason: "missing-credential",
      detail:
        `refusing to repair the launchd plist at ${plistPath}: a credential is present in the environment, ` +
        `but no running instance is available to prove it against, so ${adminPassPath} cannot be written ` +
        "safely. Start the instance and re-run 'flair doctor --fix', or run 'flair init' to provision " +
        `${adminPassPath}.`,
      plistPath,
    };
  }
  return {
    kind: "refuse",
    reason: "missing-credential",
    detail: `refusing to repair the launchd plist at ${plistPath}: ${adminPass.detail}`,
    plistPath,
  };
}

// ─── the post-adopt serving proof (flair#1685) ────────────────────────────

/** The evidence available after an adopt bounce. */
export interface AdoptServingEvidence {
  /** The pid serving the instance BEFORE adoption (the direct process). */
  directPid: number | null;
  /** launchd's reported pid for the adopted job, or null when unreadable. */
  managedPid: number | null;
  /** The pid actually serving the instance AFTER load (hdb.pid or the port listener). */
  servingPid: number | null;
  /** Whether `directPid` is still alive after the bounce. */
  directPidAlive: boolean;
}

/**
 * The proof result, modelled as a nullable object rather than an
 * `{ ok: true } | { ok: false }` union keyed on a boolean literal:
 * `tsconfig.cli.json` compiles src/cli.ts with `strict: false`, and without
 * `strictNullChecks` TypeScript does not narrow a boolean-literal discriminated
 * union at call sites. A nullable object narrows under both configurations
 * (same reason `StalePlistPath` is nullable). `null` means proven.
 */
export type AdoptServingProof = { detail: string } | null;

/**
 * Prove the adopted launchd job — not the old direct process — serves the
 * instance (flair#1685). Port health ALONE is the green light that lied in
 * #1684: the direct-spawned init instance answered 9926 the whole time the
 * adopted job was failing to start. The proof is therefore about IDENTITY and
 * CHANGE, not reachability:
 *
 *   1. the pre-adopt process must be dead (otherwise it is still answering);
 *   2. the serving pid must have CHANGED from the pre-adopt pid;
 *   3. the serving pid must be launchd's reported pid for the adopted label
 *      (the label's process owns the listener).
 */
export function verifyAdoptServing(input: AdoptServingEvidence): AdoptServingProof {
  const { directPid, managedPid, servingPid, directPidAlive } = input;
  if (directPid !== null && directPidAlive) {
    return {
      detail:
        `the pre-adopt process ${directPid} is still alive after the bounce, so whatever answers the port ` +
        "may be that process, not the launchd job",
    };
  }
  if (servingPid === null) {
    return {
      detail: "could not identify the process serving this instance after adoption (no hdb.pid and no port listener)",
    };
  }
  if (directPid !== null && servingPid === directPid) {
    return {
      detail: `the serving process is still pid ${servingPid}, the pre-adopt process — adoption did not bounce the live instance`,
    };
  }
  if (managedPid === null) {
    return {
      detail:
        "the launchd job reports no pid after load - the adopted job's identity cannot be confirmed, " +
        "so the listener cannot be attributed to it",
      };
    }
  if (managedPid !== null && servingPid !== managedPid) {
    return {
      detail:
        `the instance is served by pid ${servingPid}, but launchd reports pid ${managedPid} for the adopted ` +
        "job — the launchd job does not own the listener",
    };
  }
  return null;
}

// ─── the executor's result ─────────────────────────────────────────────────

export type LaunchdRepairResult =
  | { kind: "no-op"; reason: "already-managed" | "not-applicable"; detail: string }
  | { kind: "refused"; reason: "foreign" | "unattributable" | "config-unreadable" | "unsupported-config" | "engine-backwards" | "missing-credential"; detail: string; plistPath?: string }
  | { kind: "repaired"; detail: string }
  | { kind: "failed"; detail: string; remedy?: string[] };

// ─── the executor's pure helpers (slice b2) ───────────────────────────────

/**
 * Map a throw from the executor arm to a named result (flair#1573 slice b2,
 * Kern's b1 defect). `doctor --fix` must never crash mid-report: every throw
 * becomes a `failed` result, except an engine-backwards refusal (flair#1093),
 * which is a refusal by nature and is surfaced as `refused` so the operator
 * sees the actor/state/remedy rather than a generic failure.
 *
 * NOTE: the engine-backwards `refused` intentionally carries its remedy in the
 * detail prose (the actor/state/remedy sentence buildRecoveryLines renders),
 * NOT in a structured `remedy` field — a refusal is a verdict, not a failure,
 * and the prose is what the operator reads.
 */
export function mapRepairThrow(err: unknown): LaunchdRepairResult {
  const e = err as { engineBackwards?: boolean; message?: string } | null;
  if (e?.engineBackwards) {
    return { kind: "refused", reason: "engine-backwards", detail: e.message ?? "engine is backwards" };
  }
  return {
    kind: "failed",
    detail: e?.message ?? String(err),
    remedy: ["flair doctor --fix"],
  };
}

/**
 * Decide whether the adopt path may proceed to regenerate + load, given the
 * liveness classification of the direct process and the post-stop health probe
 * (flair#1573 slice b2). Pure — the SIGTERM + wait and the probe happen in the
 * executor; this only maps their results to a verdict.
 *
 *   - DISAGREEMENT / UNKNOWN -> failed (never stop a foreign/unattributable
 *     process — the liveness machine refused to verify identity).
 *   - post-stop health "ok"  -> failed ("port still occupied" — the old
 *     process did not fully exit, so loading the new plist would collide).
 *   - post-stop health "unreachable" -> failed ("port not confirmed free" — a
 *     wedged daemon that ignored SIGTERM but stays BOUND to the port while no
 *     longer serving /Health would EADDRINUSE on load; "unreachable" is the
 *     probe's "cannot tell", so it must NOT proceed).
 *   - post-stop health "refused" -> proceed (ECONNREFUSED — nothing is
 *     listening, the port is provably free).
 */
export function decideAdoptStop(
  state: DaemonState,
  postStopHealth: HealthResult,
): "proceed" | LaunchdRepairResult {
  switch (state.state) {
    case "RUNNING":
    case "WEDGED":
    case "NOT_RUNNING":
      break;
    case "DISAGREEMENT":
    case "UNKNOWN":
      return {
        kind: "failed",
        detail: `refusing to adopt: ${state.detail}`,
        remedy: ["flair stop", "flair doctor --fix"],
      };
  }
  // Proceed ONLY when the port is provably free (ECONNREFUSED). "ok" or
  // "foreign" means something is still serving; "unreachable" means a wedged
  // daemon may still be BOUND to the port (ignored SIGTERM) — both would
  // EADDRINUSE on load.
  if (postStopHealth.kind !== "refused") {
    return {
      kind: "failed",
      detail:
        postStopHealth.kind === "ok" || postStopHealth.kind === "foreign"
          ? "port still occupied after stopping the direct process"
          : "port not confirmed free after stopping the direct process (a wedged process may still hold it)",
      remedy: ["flair stop", "flair doctor --fix"],
    };
  }
  return "proceed";
}

// ─── poll-then-verify (flair#1827) ───────────────────────────────────────────
//
// Both adopt gates used to read ONE observation. On a slow (but healthy) start
// the launchd-started Harper had not yet written hdb.pid or bound the port when
// the serving side read it, and the stop side read the post-stop health before
// the listener was gone — so adoption was reported as a false failure. The
// helpers below poll an INJECTED observation until a predicate holds or a
// deadline passes, then hand the FINAL observation to the UNCHANGED verdicts.

export interface PollUntilOptions<T> {
  observe: () => T | Promise<T>;
  until: (value: T) => boolean;
  deadlineMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollUntilResult<T> {
  value: T;
  timedOut: boolean;
  waitedMs: number;
  observations: number;
}

/**
 * Poll `observe` until `until(value)` holds or `deadlineMs` elapses (measured on
 * the injected `now`). No global timers live in the logic — `sleep` is injected
 * too — so the whole loop is deterministic and unit-testable. Returns the LAST
 * observation plus whether it timed out.
 */
export async function pollUntil<T>(opts: PollUntilOptions<T>): Promise<PollUntilResult<T>> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? 250;
  const start = now();
  let value = await opts.observe();
  let observations = 1;
  while (!opts.until(value)) {
    if (now() - start >= opts.deadlineMs) {
      return { value, timedOut: true, waitedMs: now() - start, observations };
    }
    await sleep(intervalMs);
    value = await opts.observe();
    observations++;
  }
  return { value, timedOut: false, waitedMs: now() - start, observations };
}

function fmtPid(pid: number | null): string {
  return pid === null ? "null" : String(pid);
}

export interface AdoptServingWaitResult {
  evidence: AdoptServingEvidence;
  proof: AdoptServingProof;
  timedOut: boolean;
  waitedMs: number;
  observations: number;
}

/**
 * Wait for the adopted job to actually serve, then prove it with
 * `verifyAdoptServing` UNCHANGED (flair#1827). Polls `{managedPid, servingPid,
 * directPidAlive}` until `servingPid !== null && !directPidAlive` (the launchd
 * job has written hdb.pid / bound the port AND the pre-adopt process is gone) or
 * the deadline. On timeout the failure detail names the wait and the last
 * observation. All three identity rules of the proof are preserved.
 */
export async function verifyAdoptServingWithWait(opts: {
  observe: () => AdoptServingEvidence | Promise<AdoptServingEvidence>;
  deadlineMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AdoptServingWaitResult> {
  const poll = await pollUntil<AdoptServingEvidence>({
    observe: opts.observe,
    until: (e) => e.servingPid !== null && !e.directPidAlive,
    deadlineMs: opts.deadlineMs,
    intervalMs: opts.intervalMs,
    now: opts.now,
    sleep: opts.sleep,
  });
  const proof = verifyAdoptServing(poll.value);
  if (proof && poll.timedOut) {
    return {
      evidence: poll.value,
      proof: {
        detail:
          `${proof.detail} (waited ${poll.waitedMs}ms for the launchd job to serve; last observation: ` +
          `managedPid=${fmtPid(poll.value.managedPid)}, servingPid=${fmtPid(poll.value.servingPid)}, ` +
          `directPidAlive=${poll.value.directPidAlive})`,
      },
      timedOut: true,
      waitedMs: poll.waitedMs,
      observations: poll.observations,
    };
  }
  return { evidence: poll.value, proof, timedOut: poll.timedOut, waitedMs: poll.waitedMs, observations: poll.observations };
}

export interface AdoptStopWaitResult {
  health: HealthResult;
  decision: "proceed" | LaunchdRepairResult;
  timedOut: boolean;
  waitedMs: number;
  observations: number;
}

/**
 * Wait for the port to be provably free, then apply `decideAdoptStop` UNCHANGED
 * (flair#1827). Polls the post-stop health until `refused` (ECONNREFUSED) or the
 * deadline; on timeout the failure keeps the existing refusal wording and adds
 * how long it waited and the last health observed.
 */
export async function decideAdoptStopWithWait(
  state: DaemonState,
  opts: {
    observe: () => HealthResult | Promise<HealthResult>;
    deadlineMs: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<AdoptStopWaitResult> {
  // flair#1827 review: a STATE refusal (DISAGREEMENT / UNKNOWN) does not depend on
  // the port probe, and the caller sends no SIGTERM for it — so decide it BEFORE
  // polling, with ONE health observation. Otherwise the poll could wait the full
  // deadline on a process that is still serving and append a misleading
  // "waited … for the port to free" suffix. decideAdoptStop with a `refused`
  // probe returns "proceed" for RUNNING/WEDGED/NOT_RUNNING (so those still poll)
  // and the refusal for the state cases.
  const stateDecision = decideAdoptStop(state, { kind: "refused" });
  if (stateDecision !== "proceed") {
    const now = opts.now ?? (() => Date.now());
    const start = now();
    const health = await opts.observe();
    return { health, decision: stateDecision, timedOut: false, waitedMs: now() - start, observations: 1 };
  }
  const poll = await pollUntil<HealthResult>({
    observe: opts.observe,
    until: (h) => h.kind === "refused",
    deadlineMs: opts.deadlineMs,
    intervalMs: opts.intervalMs,
    now: opts.now,
    sleep: opts.sleep,
  });
  const decision = decideAdoptStop(state, poll.value);
  if (decision !== "proceed" && poll.timedOut) {
    return {
      health: poll.value,
      decision: {
        ...decision,
        detail: `${decision.detail} (waited ${poll.waitedMs}ms for the port to free; last health probe: ${poll.value.kind})`,
      },
      timedOut: true,
      waitedMs: poll.waitedMs,
      observations: poll.observations,
    };
  }
  return { health: poll.value, decision, timedOut: poll.timedOut, waitedMs: poll.waitedMs, observations: poll.observations };
}
