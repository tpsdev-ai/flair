/**
 * doctor-run.ts — the enumerable install-health runner (flair#1439).
 *
 * `flair doctor` and `flair upgrade` used to keep two definitions of
 * "healthy". Upgrade's success line (`renderVerifiedSummary`) could only
 * qualify a ✅ by the facts in its signature — version plus launchd — so
 * every other doctor check was invisible and rendered green. The previous
 * fix special-cased one known-unhealthy form (launchd detach). That is a
 * blacklist: the next unmeasured fact (a Codex SessionStart hook 0.49.0
 * never wrote) printed the same unqualified success marker.
 *
 * This module is the single entry point that runs the named install-health
 * checks. Adding a check to `DOCTOR_CHECK_IDS` automatically widens what
 * upgrade claims. Success is asserted POSITIVELY: every catalog id must
 * have been executed and none may have failed. An `unrun` member is never
 * treated as a pass — if a reachable state cannot produce "unrun ⇒ no ✅",
 * the enumeration is decorative and we have rebuilt the same guard.
 *
 * Skip (N/A) is not unrun. Linux has no launchd; a machine without Codex
 * does not owe a Codex hook. Those checks execute and return `skip`.
 */

import { existsSync, readdirSync } from "node:fs";
import {
  checkClaudeMdBootstrap,
  checkSessionStartHook,
  effectiveFlairUrl,
  hookCommandIsSilenced,
  isFlairHookCommand,
  partitionKeyIds,
  planAgentIterations,
  readClientMcpBlock,
} from "../doctor-client.js";
import {
  hookInstallHint,
  hookSettingsPath,
  SUPPORTED_HARNESSES,
  type Harness,
} from "../hook-install.js";
import {
  isDetached,
  renderDetachedWarning,
  type LaunchdManagement,
} from "./launchd-management.js";

/** Status of one catalog member. `unrun` is a first-class state, not a skip. */
export type DoctorCheckStatus = "pass" | "fail" | "skip" | "unrun";

export interface DoctorCheckResult {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail?: string;
  remedy?: string;
  /** When the SessionStart-hook check fails, which harnesses are missing. */
  missingHarnesses?: Harness[];
  /** Launchd observation, when this is the launchd-management check. */
  launchd?: LaunchdManagement;
}

export interface DoctorRunContext {
  homeDir: string;
  cwd: string;
  /**
   * Detected client ids (claude-code, codex, …). Callers pass the same
   * detection doctor uses (`detectClients().filter(c => c.detected)`).
   * Tests inject a list so they do not depend on PATH.
   */
  detectedClientIds: readonly string[];
  /** Observed launchd state. Omit to skip the check as N/A. */
  launchd?: LaunchdManagement;
  keysDir?: string;
  keyAgentIds?: string[];
  agentFlag?: string;
}

export type DoctorCheckFn = (ctx: DoctorRunContext) => DoctorCheckResult;

export interface DoctorCheckDef {
  id: string;
  label: string;
  run: DoctorCheckFn;
}

/**
 * The catalog. This is the contract upgrade asserts against.
 *
 * A new doctor install-health check is added HERE (id + runner). An id
 * without a runner is emitted as `unrun` and blocks the success marker —
 * that is the point, not a fallback.
 *
 * Flint's six named client-integration checks plus launchd (the previous
 * special-case, now a catalog member rather than a side channel).
 */
export const DOCTOR_CHECK_IDS = [
  "mcp-block",
  "flair-url",
  "claude-md",
  "session-start-hook",
  "verified-read",
  "keys-prune",
  "launchd-management",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

const MCP_CLIENT_IDS = ["claude-code", "codex", "gemini", "cursor", "antigravity"] as const;

function result(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  extra: Partial<DoctorCheckResult> = {},
): DoctorCheckResult {
  return { id, label, status, ...extra };
}

function runMcpBlock(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "mcp-block";
  const label = "MCP server block";
  const mcp = ctx.detectedClientIds.filter((c): c is (typeof MCP_CLIENT_IDS)[number] =>
    (MCP_CLIENT_IDS as readonly string[]).includes(c),
  );
  if (mcp.length === 0) {
    return result(id, label, "skip", { detail: "no MCP client detected" });
  }
  const missing: string[] = [];
  for (const clientId of mcp) {
    const block = readClientMcpBlock(clientId, ctx.homeDir);
    if (!block.present) missing.push(`${clientId} (${block.configPath})`);
  }
  if (missing.length > 0) {
    return result(id, label, "fail", {
      detail: `no Flair MCP server configured: ${missing.join(", ")}`,
      remedy: "flair doctor --fix",
    });
  }
  return result(id, label, "pass", { detail: `configured for ${mcp.join(", ")}` });
}

function runFlairUrl(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "flair-url";
  const label = "FLAIR_URL";
  const mcp = ctx.detectedClientIds.filter((c): c is (typeof MCP_CLIENT_IDS)[number] =>
    (MCP_CLIENT_IDS as readonly string[]).includes(c),
  );
  if (mcp.length === 0) {
    return result(id, label, "skip", { detail: "no MCP client detected" });
  }
  // Presence of a working URL (explicit or client-defaulted) is the check.
  // Unreachable is a doctor warn, not an install-health failure — the
  // instance probe already covered liveness on the upgrade path.
  const present = mcp.filter((clientId) => readClientMcpBlock(clientId, ctx.homeDir).present);
  if (present.length === 0) {
    return result(id, label, "skip", { detail: "no MCP block present to take a URL from" });
  }
  const urls = present.map((clientId) => {
    const block = readClientMcpBlock(clientId, ctx.homeDir);
    const eff = effectiveFlairUrl(block);
    return `${clientId}=${eff.url}${eff.defaulted ? " (client default)" : ""}`;
  });
  return result(id, label, "pass", { detail: urls.join(", ") });
}

function runClaudeMd(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "claude-md";
  const label = "CLAUDE.md bootstrap";
  if (!ctx.detectedClientIds.includes("claude-code")) {
    return result(id, label, "skip", { detail: "Claude Code not detected" });
  }
  const check = checkClaudeMdBootstrap(ctx.cwd, ctx.homeDir);
  if (!check.present) {
    return result(id, label, "fail", {
      detail: "bootstrap instruction not found",
      remedy: "flair doctor --fix",
    });
  }
  return result(id, label, "pass", { detail: check.path ?? undefined });
}

function runSessionStartHook(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "session-start-hook";
  const label = "SessionStart hook";
  const harnesses = SUPPORTED_HARNESSES.filter((h) => ctx.detectedClientIds.includes(h));
  if (harnesses.length === 0) {
    return result(id, label, "skip", { detail: "no hook-capable client detected" });
  }
  const missing: Harness[] = [];
  const loud: Harness[] = [];
  for (const harness of harnesses) {
    const path = hookSettingsPath(ctx.homeDir, harness);
    const hook = checkSessionStartHook(ctx.homeDir, path);
    if (!hook.present) {
      missing.push(harness);
      continue;
    }
    if (hook.command && isFlairHookCommand(hook.command) && !hookCommandIsSilenced(hook.command)) {
      loud.push(harness);
    }
  }
  if (missing.length > 0) {
    const harness = missing[0]!;
    const path = hookSettingsPath(ctx.homeDir, harness);
    return result(id, label, "fail", {
      detail: `SessionStart hook (${harness}): not found in ${path}`,
      remedy: hookInstallHint(harness),
      missingHarnesses: missing,
    });
  }
  if (loud.length > 0) {
    const harness = loud[0]!;
    return result(id, label, "fail", {
      detail: `SessionStart hook (${harness}): a failure would print an error on every session`,
      remedy: hookInstallHint(harness),
    });
  }
  return result(id, label, "pass", {
    detail: `wired for ${harnesses.join(", ")}`,
  });
}

function runVerifiedRead(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "verified-read";
  const label = "per-agent verified-read";
  if (ctx.keyAgentIds === undefined) {
    return result(id, label, "skip", { detail: "no keys enumeration in context" });
  }
  const plan = planAgentIterations(ctx.keyAgentIds, ctx.agentFlag);
  if (plan.length === 0) {
    return result(id, label, "skip", { detail: "no agents to iterate" });
  }
  return result(id, label, "pass", { detail: `iterate ${plan.join(", ")}` });
}

function runKeysPrune(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "keys-prune";
  const label = "keys prune classification";
  if (!ctx.keysDir) {
    return result(id, label, "skip", { detail: "no keys dir in context" });
  }
  if (!existsSync(ctx.keysDir)) {
    return result(id, label, "skip", { detail: "keys dir absent" });
  }
  const ids = readdirSync(ctx.keysDir)
    .filter((f) => f.endsWith(".key"))
    .map((f) => f.replace(/\.key$/, ""));
  const { agentKeyIds, nodeKeyIds } = partitionKeyIds(ids, ctx.keysDir);
  return result(id, label, "pass", {
    detail: `classified ${agentKeyIds.length} agent / ${nodeKeyIds.length} node key(s)`,
  });
}

function runLaunchdManagement(ctx: DoctorRunContext): DoctorCheckResult {
  const id = "launchd-management";
  const label = "launchd management";
  if (!ctx.launchd) {
    return result(id, label, "skip", { detail: "launchd not observed" });
  }
  const m = ctx.launchd;
  if (isDetached(m)) {
    return result(id, label, "fail", {
      detail: m.detail,
      remedy: m.remedy?.join(" && "),
      launchd: m,
    });
  }
  if (m.state === "not-applicable" || m.state === "no-service") {
    return result(id, label, "skip", { detail: m.detail, launchd: m });
  }
  return result(id, label, "pass", { detail: m.detail, launchd: m });
}

/** Default implementations. An id in DOCTOR_CHECK_IDS missing from this
 *  list is emitted as `unrun` — that is a reachable incomplete state. */
export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
  { id: "mcp-block", label: "MCP server block", run: runMcpBlock },
  { id: "flair-url", label: "FLAIR_URL", run: runFlairUrl },
  { id: "claude-md", label: "CLAUDE.md bootstrap", run: runClaudeMd },
  { id: "session-start-hook", label: "SessionStart hook", run: runSessionStartHook },
  { id: "verified-read", label: "per-agent verified-read", run: runVerifiedRead },
  { id: "keys-prune", label: "keys prune classification", run: runKeysPrune },
  { id: "launchd-management", label: "launchd management", run: runLaunchdManagement },
];

export interface DoctorRun {
  results: DoctorCheckResult[];
  /** True only when the catalog is non-empty, every member ran, and none failed. */
  healthy: boolean;
  /** True when any member is still `unrun`. */
  incomplete: boolean;
}

export interface RunDoctorChecksOptions {
  /** Override the catalog id list (tests). Defaults to DOCTOR_CHECK_IDS. */
  catalogIds?: readonly string[];
  /** Override implementations. Defaults to DOCTOR_CHECKS. */
  checks?: readonly DoctorCheckDef[];
  /**
   * Per-id replacement runners. A stub that returns `unrun` is the
   * shape-test seam: upgrade's success marker must not appear.
   */
  stubs?: Record<string, DoctorCheckFn>;
}

/**
 * Run every catalog id. Missing implementations and thrown runners become
 * `unrun`, never `pass`.
 */
export function runDoctorChecks(ctx: DoctorRunContext, opts: RunDoctorChecksOptions = {}): DoctorRun {
  const catalogIds = opts.catalogIds ?? DOCTOR_CHECK_IDS;
  const defs = new Map((opts.checks ?? DOCTOR_CHECKS).map((c) => [c.id, c]));
  const results: DoctorCheckResult[] = [];
  for (const id of catalogIds) {
    const stub = opts.stubs?.[id];
    const def = defs.get(id);
    if (stub) {
      try {
        results.push(normalizeResult(id, def?.label ?? id, stub(ctx)));
      } catch {
        results.push(unrunResult(id, def?.label ?? id, "check threw before returning"));
      }
      continue;
    }
    if (!def) {
      results.push(unrunResult(id, id, "check was not executed — no runner registered"));
      continue;
    }
    try {
      results.push(normalizeResult(id, def.label, def.run(ctx)));
    } catch {
      results.push(unrunResult(id, def.label, "check threw before returning"));
    }
  }
  return summarizeDoctorRunResults(results, catalogIds);
}

function normalizeResult(id: string, label: string, r: DoctorCheckResult): DoctorCheckResult {
  return { ...r, id, label: r.label || label };
}

function unrunResult(id: string, label: string, detail: string): DoctorCheckResult {
  return { id, label, status: "unrun", detail };
}

/**
 * Positive assertion over an already-collected result list. Any catalog id
 * absent from `results` is filled in as `unrun` so a partial list cannot
 * look complete.
 */
export function summarizeDoctorRunResults(
  results: DoctorCheckResult[],
  catalogIds: readonly string[] = DOCTOR_CHECK_IDS,
): DoctorRun {
  const byId = new Map(results.map((r) => [r.id, r]));
  const complete = catalogIds.map(
    (id) => byId.get(id) ?? unrunResult(id, id, "check was not executed"),
  );
  const incomplete = complete.some((r) => r.status === "unrun");
  const failed = complete.some((r) => r.status === "fail");
  return {
    results: complete,
    healthy: catalogIds.length > 0 && !incomplete && !failed,
    incomplete,
  };
}

/** What `flair upgrade` prints once its post-restart probe has PASSED
 *  and the doctor runner has returned a verdict. */
export interface VerifiedSummary {
  /** True when the run is not doctor-healthy — no unqualified success marker. */
  degraded: boolean;
  /** Exactly what to print. Written to stderr when degraded, stdout otherwise. */
  lines: string[];
}

/**
 * The final status line of a successful `flair upgrade`.
 *
 * Success is asserted from the enumerated doctor run — never from "facts I
 * gathered, minus known-bad cases." The unqualified `✅ verified: healthy`
 * marker is emitted only when `run.healthy` is true. An unrun member, a
 * failed member, or an empty catalog all withhold it.
 */
export function renderVerifiedSummary(
  version: string | null,
  run: DoctorRun,
): VerifiedSummary {
  const facts = `healthy, authenticated${version ? `, running ${version}` : ""}`;
  if (run.healthy) {
    return { degraded: false, lines: [`✅ verified: ${facts}`] };
  }

  const lines: string[] = [];
  const launchdFail = run.results.find((r) => r.id === "launchd-management" && r.status === "fail");
  if (launchdFail?.launchd && isDetached(launchdFail.launchd)) {
    lines.push(
      ...renderDetachedWarning(
        launchdFail.launchd,
        `upgrade landed (${facts}) but the instance is NOT running under launchd.`,
      ),
    );
  } else if (run.incomplete) {
    const unrun = run.results.filter((r) => r.status === "unrun");
    lines.push(
      `⚠️  upgrade landed (${facts}) but install checks are incomplete — ${unrun.length} check(s) were not run.`,
    );
  } else {
    const failed = run.results.filter((r) => r.status === "fail");
    lines.push(
      `⚠️  upgrade landed (${facts}) but doctor found ${failed.length} issue${failed.length === 1 ? "" : "s"}.`,
    );
  }

  for (const r of run.results) {
    if (r.status === "unrun") {
      lines.push(`   UNRUN: ${r.label} — not yet checked (cannot treat as passing)`);
    } else if (r.status === "fail" && r.id !== "launchd-management") {
      lines.push(`   ✗ ${r.detail ?? r.label}`);
      if (r.remedy) lines.push(`   Fix: ${r.remedy}`);
    }
  }
  return { degraded: true, lines };
}

export type HookInstallConsent = "install" | "prompt" | "skip-noninteractive" | "skip-declined";

/**
 * Whether upgrade may write a SessionStart hook. Installing something that
 * executes at every session start is consent-bearing — the flag is the
 * documented non-interactive consent; a TTY prompt is the interactive one.
 * Silence (no flag, no TTY) never writes.
 */
export function resolveHookInstallConsent(opts: {
  installHooksFlag: boolean;
  interactive: boolean;
  promptAccepted?: boolean;
}): HookInstallConsent {
  if (opts.installHooksFlag) return "install";
  if (opts.interactive && opts.promptAccepted === undefined) return "prompt";
  if (opts.interactive && opts.promptAccepted) return "install";
  if (opts.interactive) return "skip-declined";
  return "skip-noninteractive";
}

/** Plain-language lines when upgrade will not write the hook. */
export function missingHookWithoutConsentLines(harness: Harness, path: string): string[] {
  return [
    `SessionStart hook (${harness}) is not installed at ${path}.`,
    "This hook runs at every session start — a consent-bearing write, so upgrade will not install it unprompted.",
    `Install with: flair upgrade --install-hooks`,
    `           or: ${hookInstallHint(harness)}`,
  ];
}

/** True when the SessionStart-hook check failed because a hook file is missing. */
export function sessionStartHookMissing(run: DoctorRun): boolean {
  const hook = run.results.find((r) => r.id === "session-start-hook");
  return hook?.status === "fail" && (hook.missingHarnesses?.length ?? 0) > 0;
}

/**
 * Inputs for a consented `installHook` after upgrade. Prefers the missing
 * harness's own MCP block, then env, then the provided fallbacks.
 */
export function resolveUpgradeHookInstall(
  homeDir: string,
  harness: Harness,
  fallbacks: { agentId?: string; flairUrl?: string; port?: number },
): { agentId: string; flairUrl: string } | { error: string } {
  const clientId = harness === "codex" ? "codex" : "claude-code";
  const block = readClientMcpBlock(clientId, homeDir);
  const agentId =
    (typeof process.env.FLAIR_AGENT_ID === "string" && process.env.FLAIR_AGENT_ID) ||
    block.agentId ||
    fallbacks.agentId;
  const flairUrl =
    (typeof process.env.FLAIR_URL === "string" && process.env.FLAIR_URL) ||
    block.flairUrl ||
    fallbacks.flairUrl ||
    (fallbacks.port ? `http://127.0.0.1:${fallbacks.port}` : "http://127.0.0.1:9926");
  if (!agentId) {
    return { error: "no agent id known — pass --agent or set FLAIR_AGENT_ID so the hook can be wired" };
  }
  return { agentId, flairUrl };
}
