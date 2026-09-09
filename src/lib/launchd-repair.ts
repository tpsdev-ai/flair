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
 */

import { resolve } from "node:path";
import type { LaunchdManagement } from "./launchd-management.js";
import type { DaemonState, HealthResult } from "./daemon-liveness.js";

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
      reason: "foreign" | "unattributable" | "config-unreadable";
      detail: string;
      plistPath?: string;
    }
  | { kind: "regenerate"; detail: string }
  | { kind: "adopt"; detail: string };

export interface PlanLaunchdRepairInput {
  observation: LaunchdManagement;
  disposition: PlistDisposition;
  plistPath: string;
  /** True when a direct (non-launchd) process is serving this instance right now. */
  directProcessRunning: boolean;
  /** True when the instance's harper-config.yaml is readable (the config-authority gate). */
  configReadable: boolean;
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
  const { observation, disposition, plistPath, directProcessRunning, configReadable } = input;

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
    };
  }

  // Repairable: absent, corrupt, or ours, with no direct process in the way.
  return {
    kind: "regenerate",
    detail: "regenerating the launchd plist for this instance",
  };
}

// ─── the executor's result ─────────────────────────────────────────────────

export type LaunchdRepairResult =
  | { kind: "no-op"; reason: "already-managed" | "not-applicable"; detail: string }
  | { kind: "refused"; reason: "foreign" | "unattributable" | "config-unreadable" | "engine-backwards"; detail: string; plistPath?: string }
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
  // Proceed ONLY when the port is provably free (ECONNREFUSED). "ok" means
  // something is still serving; "unreachable" means a wedged daemon may still
  // be BOUND to the port (ignored SIGTERM) — both would EADDRINUSE on load.
  if (postStopHealth.kind !== "refused") {
    return {
      kind: "failed",
      detail:
        postStopHealth.kind === "ok"
          ? "port still occupied after stopping the direct process"
          : "port not confirmed free after stopping the direct process (a wedged process may still hold it)",
      remedy: ["flair stop", "flair doctor --fix"],
    };
  }
  return "proceed";
}
