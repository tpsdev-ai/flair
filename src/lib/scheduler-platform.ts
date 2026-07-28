/**
 * Platform-scheduler primitives shared by every Flair-managed background job.
 *
 * Two modules install user-session scheduler entries today:
 *   - src/rem/scheduler.ts        (`flair rem nightly enable`)
 *   - src/federation/scheduler.ts (`flair federation sync enable`)
 *
 * They differ in what they schedule and how often; they do NOT differ in how
 * you ask launchd/systemd whether a job is really loaded, how you read the
 * answer, or how you render a template into a unit file. This module exists so
 * there is exactly ONE implementation of those — same reason src/lib/xml-escape.ts
 * exists (#918): the second copy of a subtle rule is where it goes wrong.
 *
 * `interpretActiveResult()` in particular encodes a production lesson
 * (flair#850) that took a real outage to learn. It must not be re-derived.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { platform } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SchedulerPlatform = "darwin" | "linux";

/**
 * 30s ceiling on launchctl/systemctl invocations so a hung service manager
 * can't block the CLI indefinitely. Sherlock #415 follow-up.
 */
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Status-check spawns (launchctl print / systemctl is-active) return
 * near-instantly when the service manager is reachable, and fail fast (no
 * hang) when it isn't (e.g. "Failed to connect to bus"). A short ceiling
 * keeps status commands and the Health endpoint responsive even when the
 * query is inconclusive.
 */
export const STATUS_CHECK_TIMEOUT_MS = 5_000;

export interface SpawnReport {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function detectPlatform(label: string, override?: SchedulerPlatform): SchedulerPlatform {
  if (override) return override;
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  throw new Error(`unsupported platform for ${label}: ${p} (only darwin and linux)`);
}

export function spawnReport(cmd: string[], timeoutMs: number = SPAWN_TIMEOUT_MS): SpawnReport {
  const r: SpawnSyncReturns<Buffer> = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "buffer",
    timeout: timeoutMs,
  });
  return {
    code: r.status,
    stdout: r.stdout?.toString("utf-8") ?? "",
    stderr: r.stderr?.toString("utf-8") ?? "",
  };
}

/**
 * Interprets the result of a `launchctl print` / `systemctl --user is-active`
 * probe. Shared by the sync (CLI) and async (server) callers of both
 * schedulers.
 *
 * - true  — the service manager confirms the job is loaded/active.
 * - false — confirmed NOT active. This includes the "no session bus" case
 *   (flair#850): when `systemctl --user` can't reach a bus, it fails
 *   before printing a status word ("Failed to connect to bus: No medium
 *   found") — but nothing CAN be running without a bus, so `false` is the
 *   honest answer, not "unknown".
 * - null  — genuinely inconclusive (the command itself couldn't run at
 *   all — e.g. the binary is missing — with no output to interpret).
 */
export function interpretActiveResult(
  plat: SchedulerPlatform,
  code: number | null,
  stdout: string,
  stderr: string,
): boolean | null {
  const noOutput = !stdout.trim() && !stderr.trim();
  if (plat === "darwin") {
    if (code === 0) return true;
    if (code === null && noOutput) return null; // spawn itself failed — inconclusive
    return false; // launchctl ran and reported not-loaded
  }
  const out = stdout.trim();
  if (out === "active" || out === "activating") return true;
  if (out === "inactive" || out === "failed" || out === "unknown") return false;
  if (code === null && noOutput) return null; // spawn itself failed — inconclusive
  return false; // covers the no-bus case: empty stdout, nonzero/failed exit
}

/**
 * Human remedy text for a failed scheduler-load attempt (flair#850). Covers
 * the one root cause traced so far: a missing systemd user session bus,
 * which blocks `systemctl --user` entirely in ssh-without-lingering,
 * container, and CI contexts. Returns null when the failure doesn't match a
 * known pattern — the caller already prints the raw stderr, so the operator
 * still has something to go on.
 *
 * `enableCommand` is the caller's own enable invocation, named in the remedy
 * so the operator is told to re-run the command they actually ran.
 */
export function describeLoadFailure(
  plat: SchedulerPlatform,
  loadResult: { code: number | null; stderr: string },
  enableCommand: string,
): string | null {
  const stderr = loadResult.stderr || "";
  if (plat === "linux" && /failed to connect to bus/i.test(stderr)) {
    return (
      "No systemd user session bus is available in this session (common over ssh without lingering, " +
      "in containers, or under CI). Fix: enable lingering for this user — `loginctl enable-linger <user>` " +
      `— then re-run \`${enableCommand}\`.`
    );
  }
  return null;
}

/** Single-pass `{{KEY}}` substitution, with a per-value escape hook. */
export function renderTemplateWith(
  text: string,
  subs: Record<string, string>,
  escape: (value: string) => string,
): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const value = subs[key];
    if (value === undefined) throw new Error(`unknown template placeholder: ${key}`);
    return escape(String(value));
  });
}

export function readTemplate(rootDir: string, relativePath: string): string {
  const full = resolve(rootDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`template not found: ${full}`);
  }
  return readFileSync(full, "utf-8");
}

export function writeFileWithDir(path: string, contents: string, mode: number = 0o600): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
}
