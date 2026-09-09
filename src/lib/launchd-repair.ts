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
 *      operator decides (a TTY may confirm-adopt; a non-TTY never does).
 *
 * The state matrix the plan collapses to (slice b1 — the adopt path for a
 * detached-and-running instance is slice b2 and is deliberately NOT here):
 *
 *   - not-applicable (not macOS)  -> no-op.
 *   - managed                     -> no-op ("already managed").
 *   - absent / corrupt / ours     -> regenerate (pass-file mode).
 *   - foreign / unattributable    -> refuse.
 *   - config unreadable           -> refuse.
 *   - detached-and-running        -> refuse ("detached, needs adopt (b2)").
 */

import { resolve } from "node:path";
import type { LaunchdManagement } from "./launchd-management.js";

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
      reason: "foreign" | "unattributable" | "config-unreadable" | "detached";
      detail: string;
      plistPath?: string;
    }
  | { kind: "regenerate"; detail: string };

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
 * `regenerate` plan into a plist write + load + verify, and a `refuse` plan
 * into a named refusal (with a TTY confirm-adopt escape hatch for the
 * `unattributable` case, which the executor owns because it needs stdin).
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

  // Detached-and-running is OUT OF SCOPE for b1 (flair#1573 slice b1): a
  // direct (non-launchd) process is serving this instance, so regenerating +
  // loading the plist would collide on the port. b2 adds the adopt path that
  // clean-stops the direct process first; b1 refuses rather than mis-repair.
  if (directProcessRunning) {
    return {
      kind: "refuse",
      reason: "detached",
      detail:
        "the instance is running but not under launchd (direct-spawned) — detached, needs adopt (b2). " +
        "Refusing to repair: regenerating the plist now would collide with the running process on its port.",
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
  | { kind: "refused"; reason: "foreign" | "unattributable" | "config-unreadable" | "detached"; detail: string; plistPath?: string }
  | { kind: "repaired"; detail: string }
  | { kind: "failed"; detail: string; remedy?: string[] };
