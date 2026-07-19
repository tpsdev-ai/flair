// ─── `flair hook install` — ambient memory via harness SessionStart hooks (flair#745) ──
//
// Design record: https://github.com/tpsdev-ai/flair/issues/719 ("Paved-paths
// design round" — the `flair hook install` section) + Kern's and Sherlock's
// verdicts on that thread. Issue: https://github.com/tpsdev-ai/flair/issues/745
//
// `flair doctor --fix` and `flair init` already wire a SessionStart hook into
// ~/.claude/settings.json (src/doctor-client.ts's checkSessionStartHook /
// fixSessionStartHook, driven by `applyOrReportSessionStartHook`) — but that
// wiring is a side effect of a broader diagnostic/setup flow, not a
// standalone, symmetric, testable command a user or an automation can run on
// its own. This module is the pure (no network, no process spawn) decision
// logic behind the new top-level `flair hook install|uninstall|status`
// command family (wired into src/cli.ts). It intentionally reuses
// doctor-client.ts's SESSION_START_HOOK_MARKER as the single source of truth
// for "is this our hook" — so `flair doctor`'s existing check keeps
// recognizing anything this module writes with ZERO changes to that check.
// The one deliberate shape difference: this module's command always sets
// BOTH FLAIR_AGENT_ID and FLAIR_URL (mirroring src/install/clients.ts's
// WireEnv/flairMcpEntry, which does the same for the MCP server block),
// where doctor/init's minimal shape sets only FLAIR_AGENT_ID. That addition
// never breaks doctor's marker-substring check (the marker is still present
// verbatim), and is what makes a remote-instance install actually target the
// remote instance instead of silently falling back to flair-mcp's localhost
// default.
//
// Binding review conditions (Sherlock, #719 thread) this module implements:
//   1. Malformed settings.json fails CLOSED — a backup is taken BEFORE the
//      parse attempt (whenever the file exists and we're not in --dry-run),
//      and on a parse error we report and refuse to touch the real file:
//      never truncate, never write a partial replacement.
//   2. Idempotent merge — parse, add/update ONLY our hook entry (found via
//      the SESSION_START_HOOK_MARKER substring, exactly like doctor's own
//      check), never touch unrelated hooks/keys. Re-running with unchanged
//      inputs is a byte-identical no-op; re-running with a changed
//      agent/URL updates just that one hook's `command` field in place.
//   3. --dry-run computes the exact delta (before/after hook group) without
//      writing anything — no backup either, since a backup is itself a write.
//   4. Remote-instance transport — this module never touches HTTP/TLS at
//      all (see packages/flair-mcp/src/session-start-hook.ts, which uses
//      FlairClient's plain global `fetch`, no rejectUnauthorized/NODE_TLS_*
//      bypass anywhere — test/unit/hook-install.test.ts asserts that
//      statically).
//   5. Silent-fast degradation — also owned by session-start-hook.ts (hard
//      timeout, no-op-on-any-failure); this module only writes the pointer
//      to it.
//   6. Size-budgeted payload — also owned by session-start-hook.ts, which
//      reuses bootstrap's own maxTokens machinery.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_START_HOOK_MARKER } from "./doctor-client.js";

// ── harness registry ────────────────────────────────────────────────────────

/** v1 supports exactly one harness. The flag/type exist so a second harness
 *  is an additive registry entry, not a rewrite (Kern's #719 verdict: "a
 *  switch statement... is fine until we have 3+ harnesses"). */
export const SUPPORTED_HARNESSES = ["claude-code"] as const;
export type Harness = (typeof SUPPORTED_HARNESSES)[number];

export function isSupportedHarness(value: string): value is Harness {
  return (SUPPORTED_HARNESSES as readonly string[]).includes(value);
}

/** Where this harness's hook config lives, given a home directory (never
 *  reads process.env.HOME itself — callers pass homedir() in production and
 *  a temp dir in tests, mirroring doctor-client.ts's withHome technique). */
export function hookSettingsPath(homeDir: string, harness: Harness): string {
  switch (harness) {
    case "claude-code":
      return join(homeDir, ".claude", "settings.json");
  }
}

/** Backup path convention: a single sibling `<path>.bak`, overwritten on
 *  every mutating run — recovery insurance for the mutation that's about to
 *  happen, not a version history. Exported so tests assert against the same
 *  constant this module uses internally. */
export function hookBackupPath(settingsPath: string): string {
  return `${settingsPath}.bak`;
}

// ── the hook command itself ─────────────────────────────────────────────────

/** The exact `command` string written into the SessionStart hook entry.
 *  Always carries both FLAIR_AGENT_ID and FLAIR_URL (see module doc above)
 *  and always contains SESSION_START_HOOK_MARKER verbatim, so doctor's
 *  existing checkSessionStartHook recognizes it unchanged. */
export function buildHookCommand(agentId: string, flairUrl: string): string {
  return `FLAIR_AGENT_ID=${agentId} FLAIR_URL=${flairUrl} npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`;
}

/** Best-effort recovery of the agentId/flairUrl a previously-wired hook
 *  command carries — used by `flair hook status`. Pure string scan, never
 *  throws on an unexpected shape. */
export function parseHookCommandEnv(command: string): { agentId?: string; flairUrl?: string } {
  const agentMatch = command.match(/FLAIR_AGENT_ID=(\S+)/);
  const urlMatch = command.match(/FLAIR_URL=(\S+)/);
  return { agentId: agentMatch?.[1], flairUrl: urlMatch?.[1] };
}

interface HookEntry {
  type: "command";
  command: string;
}

export interface HookGroup {
  hooks: HookEntry[];
}

function makeHookGroup(command: string): HookGroup {
  return { hooks: [{ type: "command", command }] };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Locate our hook (by marker substring, exactly like doctor's
 *  checkSessionStartHook) inside a parsed settings object, if present.
 *  Returns array indices (not the doctor-client boolean) since install/
 *  uninstall need to mutate/splice in place without disturbing siblings. */
function findHookEntry(config: any): { groupIndex: number; hookIndex: number } | null {
  const groups = config?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return null;
  for (let gi = 0; gi < groups.length; gi++) {
    const hooks = groups[gi]?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (let hi = 0; hi < hooks.length; hi++) {
      if (typeof hooks[hi]?.command === "string" && hooks[hi].command.includes(SESSION_START_HOOK_MARKER)) {
        return { groupIndex: gi, hookIndex: hi };
      }
    }
  }
  return null;
}

// ── settings.json read (fail-closed) ────────────────────────────────────────

interface ReadSettingsResult {
  exists: boolean;
  parsed: any | null;
  /** Set (parsed is null) on ANY reason we must not proceed: missing-file is
   *  NOT an error (parsed defaults to {}), but an unreadable or unparseable
   *  existing file always is — never silently coerced to "absent". */
  parseError: string | null;
}

function readSettingsFile(path: string): ReadSettingsResult {
  if (!existsSync(path)) return { exists: false, parsed: {}, parseError: null };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { exists: true, parsed: null, parseError: `could not read ${path}: ${reason}` };
  }
  if (!raw.trim()) return { exists: true, parsed: {}, parseError: null };
  try {
    return { exists: true, parsed: JSON.parse(raw), parseError: null };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { exists: true, parsed: null, parseError: `malformed JSON in ${path} (${reason})` };
  }
}

/** Copy the existing file to its backup path. Caller must only call this
 *  when the file exists AND we're about to mutate for real (never during
 *  --dry-run — a backup is itself a write). Throws on failure so the caller
 *  can fail closed rather than silently proceeding without a safety copy. */
function takeBackup(path: string): string {
  const dest = hookBackupPath(path);
  copyFileSync(path, dest);
  return dest;
}

// ── delta computation (pure) ────────────────────────────────────────────────

export type HookDeltaAction = "add" | "update" | "remove" | "noop";

export interface HookDelta {
  action: HookDeltaAction;
  path: string;
  harness: Harness;
  before: HookGroup | null;
  after: HookGroup | null;
}

function computeInstallDelta(
  config: any,
  agentId: string,
  flairUrl: string,
): { action: HookDeltaAction; before: HookGroup | null; after: HookGroup; newConfig: any } {
  const command = buildHookCommand(agentId, flairUrl);
  const after = makeHookGroup(command);
  const existing = findHookEntry(config);

  if (existing) {
    const beforeGroup = config.hooks.SessionStart[existing.groupIndex];
    const beforeSnapshot: HookGroup = deepClone(beforeGroup);
    const beforeCommand = beforeGroup.hooks[existing.hookIndex]?.command;
    if (beforeCommand === command && beforeGroup.hooks.length === 1) {
      return { action: "noop", before: beforeSnapshot, after, newConfig: config };
    }
    const newConfig = deepClone(config);
    // Update ONLY the one matching hook entry — any sibling hooks in the
    // same group (or other groups/keys) are left byte-identical.
    newConfig.hooks.SessionStart[existing.groupIndex].hooks[existing.hookIndex] = { type: "command", command };
    return { action: "update", before: beforeSnapshot, after, newConfig };
  }

  const newConfig = deepClone(config);
  newConfig.hooks = newConfig.hooks && typeof newConfig.hooks === "object" && !Array.isArray(newConfig.hooks) ? newConfig.hooks : {};
  newConfig.hooks.SessionStart = Array.isArray(newConfig.hooks.SessionStart) ? newConfig.hooks.SessionStart : [];
  newConfig.hooks.SessionStart.push(after);
  return { action: "add", before: null, after, newConfig };
}

function computeRemovalDelta(config: any): { action: "remove" | "noop"; before: HookGroup | null; newConfig: any } {
  const existing = findHookEntry(config);
  if (!existing) return { action: "noop", before: null, newConfig: config };

  const beforeSnapshot: HookGroup = deepClone(config.hooks.SessionStart[existing.groupIndex]);
  const newConfig = deepClone(config);
  const group = newConfig.hooks.SessionStart[existing.groupIndex];
  group.hooks.splice(existing.hookIndex, 1);
  if (group.hooks.length === 0) {
    newConfig.hooks.SessionStart.splice(existing.groupIndex, 1);
  }
  if (newConfig.hooks.SessionStart.length === 0) {
    delete newConfig.hooks.SessionStart;
  }
  if (newConfig.hooks && Object.keys(newConfig.hooks).length === 0) {
    delete newConfig.hooks;
  }
  return { action: "remove", before: beforeSnapshot, newConfig };
}

// ── public mutation surface ─────────────────────────────────────────────────

export interface HookMutationResult {
  ok: boolean;
  path: string;
  harness: Harness;
  dryRun: boolean;
  message: string;
  /** Path of the pre-mutation backup, when one was taken. null when nothing
   *  existed to back up (fresh install) or when --dry-run (never writes). */
  backupPath: string | null;
  delta: HookDelta | null;
}

export interface InstallHookOptions {
  homeDir: string;
  harness: Harness;
  agentId: string;
  flairUrl: string;
  dryRun?: boolean;
}

/** Idempotent, fail-closed, dry-run-able install of the Flair SessionStart
 *  hook into `harness`'s settings file. See module doc for the Sherlock
 *  conditions this implements. */
export function installHook(opts: InstallHookOptions): HookMutationResult {
  const { homeDir, harness, agentId, flairUrl } = opts;
  const dryRun = !!opts.dryRun;
  const path = hookSettingsPath(homeDir, harness);

  if (dryRun) {
    const read = readSettingsFile(path);
    if (read.parseError) {
      return {
        ok: false, path, harness, dryRun,
        message: `${read.parseError} — dry run: nothing would be written until this is fixed`,
        backupPath: null, delta: null,
      };
    }
    const { action, before, after } = computeInstallDelta(read.parsed ?? {}, agentId, flairUrl);
    const delta: HookDelta = { action, path, harness, before, after };
    const message = action === "noop"
      ? `already correct in ${path} — no changes`
      : `would ${action} the SessionStart hook in ${path} (dry run — nothing written)`;
    return { ok: true, path, harness, dryRun, message, backupPath: null, delta };
  }

  // Backup BEFORE the parse attempt (Sherlock condition 1) — only meaningful
  // when a file already exists; a fresh install has nothing to protect.
  let backupPath: string | null = null;
  if (existsSync(path)) {
    try {
      backupPath = takeBackup(path);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false, path, harness, dryRun,
        message: `could not back up ${path} before mutating it: ${reason} — refusing to touch it`,
        backupPath: null, delta: null,
      };
    }
  }

  const read = readSettingsFile(path);
  if (read.parseError) {
    return {
      ok: false, path, harness, dryRun,
      message: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}` +
        (backupPath ? `; backup copy at ${backupPath}.` : "."),
      backupPath, delta: null,
    };
  }

  const { action, before, after, newConfig } = computeInstallDelta(read.parsed ?? {}, agentId, flairUrl);
  const delta: HookDelta = { action, path, harness, before, after };

  if (action === "noop") {
    return { ok: true, path, harness, dryRun, message: `SessionStart hook already correct in ${path}`, backupPath, delta };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(newConfig, null, 2) + "\n");
  return {
    ok: true, path, harness, dryRun,
    message: `${action === "add" ? "added" : "updated"} the SessionStart hook in ${path}`,
    backupPath, delta,
  };
}

export interface UninstallHookOptions {
  homeDir: string;
  harness: Harness;
  dryRun?: boolean;
}

/** Symmetric removal — deletes ONLY our hook entry (found the same way
 *  install finds it: SESSION_START_HOOK_MARKER substring match), never
 *  touches unrelated hooks/keys. A no-op (ok:true, action "noop") when
 *  nothing is installed — never creates a file that didn't already exist. */
export function uninstallHook(opts: UninstallHookOptions): HookMutationResult {
  const { homeDir, harness } = opts;
  const dryRun = !!opts.dryRun;
  const path = hookSettingsPath(homeDir, harness);

  if (dryRun) {
    const read = readSettingsFile(path);
    if (read.parseError) {
      return {
        ok: false, path, harness, dryRun,
        message: `${read.parseError} — dry run: nothing would be removed until this is fixed`,
        backupPath: null, delta: null,
      };
    }
    const { action, before } = computeRemovalDelta(read.parsed ?? {});
    const delta: HookDelta = { action, path, harness, before, after: null };
    const message = action === "noop"
      ? `no Flair SessionStart hook found in ${path} — nothing to remove`
      : `would remove the Flair SessionStart hook from ${path} (dry run — nothing written)`;
    return { ok: true, path, harness, dryRun, message, backupPath: null, delta };
  }

  let backupPath: string | null = null;
  if (existsSync(path)) {
    try {
      backupPath = takeBackup(path);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false, path, harness, dryRun,
        message: `could not back up ${path} before mutating it: ${reason} — refusing to touch it`,
        backupPath: null, delta: null,
      };
    }
  }

  const read = readSettingsFile(path);
  if (read.parseError) {
    return {
      ok: false, path, harness, dryRun,
      message: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}` +
        (backupPath ? `; backup copy at ${backupPath}.` : "."),
      backupPath, delta: null,
    };
  }

  const { action, before, newConfig } = computeRemovalDelta(read.parsed ?? {});
  const delta: HookDelta = { action, path, harness, before, after: null };

  if (action === "noop") {
    return { ok: true, path, harness, dryRun, message: `no Flair SessionStart hook found in ${path} — nothing to remove`, backupPath, delta };
  }

  writeFileSync(path, JSON.stringify(newConfig, null, 2) + "\n");
  return { ok: true, path, harness, dryRun, message: `removed the Flair SessionStart hook from ${path}`, backupPath, delta };
}

// ── status ───────────────────────────────────────────────────────────────

export interface HookStatusResult {
  harness: Harness;
  path: string;
  wired: boolean;
  /** True only when the matched hook entry is exactly the shape we write:
   *  type "command", command containing the full expected invocation — not
   *  just a loose marker substring match (a hand-edited/partial entry still
   *  counts as `wired` for doctor-compat purposes but not `correctShape`). */
  correctShape: boolean;
  agentId?: string;
  flairUrl?: string;
  command?: string;
  parseError: string | null;
}

/** Read-only report: is the hook wired, does it look right, and which agent
 *  / Flair instance does it point at (recovered from the wired command). */
export function hookStatus(homeDir: string, harness: Harness): HookStatusResult {
  const path = hookSettingsPath(homeDir, harness);
  const read = readSettingsFile(path);
  if (read.parseError) {
    return { harness, path, wired: false, correctShape: false, parseError: read.parseError };
  }

  const config = read.parsed ?? {};
  const existing = findHookEntry(config);
  if (!existing) {
    return { harness, path, wired: false, correctShape: false, parseError: null };
  }

  const hookEntry = config.hooks.SessionStart[existing.groupIndex].hooks[existing.hookIndex];
  const command: string = typeof hookEntry?.command === "string" ? hookEntry.command : "";
  const correctShape = hookEntry?.type === "command" && command.includes(`npx -y @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`);
  const env = parseHookCommandEnv(command);
  return { harness, path, wired: true, correctShape, agentId: env.agentId, flairUrl: env.flairUrl, command, parseError: null };
}
