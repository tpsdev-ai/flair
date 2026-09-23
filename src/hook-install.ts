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
//   5. Silent-fast degradation — SPLIT, deliberately, since flair#1007.
//      session-start-hook.ts owns it once the binary is running (hard
//      timeout, no-op-on-any-failure). It cannot own the case where the
//      binary never runs at all — an orphaned global install after a Node
//      runtime change — because in that case its guard is behind the door it
//      is meant to guard. That half is owned by the command string this
//      module writes, which is built by doctor-client.ts's
//      buildSessionStartHookCommand (see its section doc for the shell
//      analysis and why the wrapper is `sh -c`, not a bare fragment).
//   6. Size-budgeted payload — also owned by session-start-hook.ts, which
//      reuses bootstrap's own maxTokens machinery.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SESSION_START_HOOK_MARKER,
  buildSessionStartHookCommand,
  buildContinuityCaptureHookCommand,
  checkContinuityCaptureHooks,
  computeContinuityHookInstall,
  computeContinuityHookRemoval,
  hookCommandIsSilenced,
  hookCommandDiscardsStderr,
  isFlairHookCommand,
  isHookCommandValueSafe,
  isSessionStartHookInvocation,
  readClientMcpBlock,
  type ContinuityCaptureHookReport,
  type ContinuityHookEvent,
  type ContinuityMutationAction,
} from "./doctor-client.js";
import { FLAIR_MCP_PACKAGE, flairCliVersion, mcpServerSpec } from "./lib/mcp-spec.js";
import { decidePinWrite, type PinWriteDecision } from "./lib/pin-write-guard.js";
import { withConfigCriticalSection } from "./lib/config-critical-section.js";
import {
  backupBytesTo,
  encodeConfig,
  hookBackupPath,
  parseSettingsBytes,
  type ReadSettingsResult,
} from "./lib/settings-bytes.js";

// flair#1778 2c-i-c: the bytes-level helpers (parse / encode / backup) moved to
// the shared leaf `./lib/settings-bytes.js` so this module and
// src/doctor-client.ts cannot drift. Re-exported here because `hookBackupPath`
// was a public export of this module and callers still import it from here.
export { hookBackupPath };

// ── harness registry ────────────────────────────────────────────────────────

/** SessionStart hook harnesses. A second harness is an additive registry
 *  entry, not a rewrite (Kern's #719 verdict: "a switch statement... is
 *  fine until we have 3+ harnesses"). Codex writes the same JSON hook
 *  schema Claude Code uses, into `~/.codex/hooks.json` (flair#1148). */
export const SUPPORTED_HARNESSES = ["claude-code", "codex"] as const;
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
    case "codex":
      return join(homeDir, ".codex", "hooks.json");
  }
}

/** Continuity capture (PostToolUse + Stop) is Claude Code only. The matcher
 *  is Claude tool names; writing it into another harness looks enabled and
 *  never journals (flair#1148 Bugbot). SessionStart stays per-harness. */
export function harnessSupportsContinuity(harness: Harness): boolean {
  return harness === "claude-code";
}

/** Status/doctor hint for `flair hook install`. Claude Code stays the bare
 *  default; every other harness is named so the hint cannot silently write
 *  the wrong file (flair#1148 Bugbot). */
export function hookInstallHint(harness: Harness, extraFlags = ""): string {
  const parts = ["flair hook install"];
  if (extraFlags) parts.push(extraFlags);
  if (harness !== "claude-code") parts.push(`--harness ${harness}`);
  return parts.join(" ");
}

/** Agent id for a hook install: flag, env, this harness's MCP block, then
 *  Claude Code's block as a last resort (same agent is often shared). */
export function resolveHookAgentId(
  opts: { agent?: string; agentId?: string },
  homeDir: string,
  harness: Harness,
): string | undefined {
  return (
    opts.agent ||
    opts.agentId ||
    process.env.FLAIR_AGENT_ID ||
    readClientMcpBlock(harness, homeDir).agentId ||
    (harness !== "claude-code" ? readClientMcpBlock("claude-code", homeDir).agentId : undefined) ||
    undefined
  );
}

// `hookBackupPath` lives in `./lib/settings-bytes.js` now (re-exported above).

// ── the hook command itself ─────────────────────────────────────────────────

/** The exact `command` string written into the SessionStart hook entry.
 *  Always carries both FLAIR_AGENT_ID and FLAIR_URL (see module doc above)
 *  and always contains SESSION_START_HOOK_MARKER verbatim, so doctor's
 *  existing checkSessionStartHook recognizes it unchanged.
 *
 *  Since flair#1007 this is a thin wrapper over doctor-client.ts's
 *  buildSessionStartHookCommand — ONE builder for every path that writes this
 *  string (`flair hook install`, `flair doctor --fix`, `flair init`'s hint),
 *  so the invocation's failure behaviour is defined and tested in one place
 *  instead of drifting across three literals. Throws when agentId/flairUrl
 *  cannot be represented safely; installHook() checks first and reports. */
export function buildHookCommand(agentId: string, flairUrl: string, harness: Harness = "claude-code"): string {
  return buildSessionStartHookCommand(agentId, flairUrl, { harness });
}

const CODEX_REAPPROVAL =
  "Codex requires re-approval in /hooks before the change takes effect";

function withCodexReapproval(harness: Harness, message: string): string {
  return harness === "codex" ? `${message} — ${CODEX_REAPPROVAL}` : message;
}

/**
 * Peel the installer `sh -c '...'` wrapper (and its `out=$(...)` capture)
 * so env assignments can be read from the inner invocation. Leaves a bare
 * command (legacy pre-#1007, hand-rolled) unchanged. Never throws.
 */
function unwrapInstallerHookCommand(command: string): string {
  const shc = command.match(/^sh\s+-c\s+(['"])([\s\S]*)\1\s*$/);
  const body = shc ? shc[2]! : command;
  // SessionStart installer: `out=$(<invocation> [2>/dev/null]) && printf ...`
  const captured = body.match(/^out=\$\((.*)\)\s*&&/);
  return captured ? captured[1]! : body;
}

/** Env values the installer interpolates are allow-listed (see
 *  isHookCommandValueSafe). Stop before whitespace or the shell
 *  metacharacters the `$(...)` wrapper can leave adjacent to a value. */
const HOOK_ENV_VALUE_RE = /[^\s'"$();|&<>]+/;

/** Best-effort recovery of the agentId/flairUrl a previously-wired hook
 *  command carries — used by `flair hook status`. Understands the
 *  installer-written `sh -c` wrapper (`flair init`, `flair hook install`,
 *  docs/mcp-clients.md) as well as a bare invocation. Pure string scan,
 *  never throws on an unexpected shape. A missing FLAIR_URL is not a
 *  parse failure: `flair init` / doctor's minimal shape omit it on
 *  purpose (the hook then uses flair-client's localhost default). */
export function parseHookCommandEnv(command: string): { agentId?: string; flairUrl?: string } {
  const source = unwrapInstallerHookCommand(command);
  const agentMatch = source.match(new RegExp(`FLAIR_AGENT_ID=(${HOOK_ENV_VALUE_RE.source})`));
  const urlMatch = source.match(new RegExp(`FLAIR_URL=(${HOOK_ENV_VALUE_RE.source})`));
  return { agentId: agentMatch?.[1], flairUrl: urlMatch?.[1] };
}

/** Printed by `flair hook status` only when the command is wired but its
 *  agent/URL really could not be recovered — never for the installer
 *  `sh -c` form that simply omits FLAIR_URL (flair#1325). */
export const HOOK_STATUS_UNPARSED = "(unknown — could not parse command)";

export interface HookStatusIdentityLine {
  label: "Agent" | "Flair URL";
  value: string;
}

/** Agent / Flair URL lines `flair hook status` prints under a wired hook.
 *  Recovered values are shown. The installer-no-URL omit (flair#1325) is
 *  allowed ONLY when agentId was parsed — that is the real `flair init`
 *  shape (`FLAIR_AGENT_ID` set, `FLAIR_URL` omitted). correctShape alone
 *  is not enough: it is an npx-invocation check and a wired correct-shape
 *  command with no env assignments must still show the unknown lines,
 *  not a silent all-clear. */
export function hookStatusIdentityLines(
  status: Pick<HookStatusResult, "agentId" | "flairUrl">,
): HookStatusIdentityLine[] {
  const lines: HookStatusIdentityLine[] = [];
  if (status.agentId) {
    lines.push({ label: "Agent", value: status.agentId });
  } else {
    lines.push({ label: "Agent", value: HOOK_STATUS_UNPARSED });
  }
  if (status.flairUrl) {
    lines.push({ label: "Flair URL", value: status.flairUrl });
  } else if (!status.agentId) {
    lines.push({ label: "Flair URL", value: HOOK_STATUS_UNPARSED });
  }
  return lines;
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

// `parseSettingsBytes`, `backupBytesTo` and `encodeConfig` live in
// `./lib/settings-bytes.js` now — imported above, shared with
// src/doctor-client.ts. `readSettingsFile` stays here: it is the READ-ONLY
// path's helper (dry-run / status), which never enters the critical section.

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
  harness: Harness,
): { action: HookDeltaAction; before: HookGroup | null; after: HookGroup; newConfig: any } {
  const command = buildHookCommand(agentId, flairUrl, harness);
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

  // The command is a single-quoted shell argument (flair#1007) and quoting
  // rules are not uniform across the shells a harness might use, so unsafe
  // values are REFUSED rather than escaped — checked before anything is
  // backed up or written, so a bad input never half-mutates the file.
  for (const [label, value] of [["agent id", agentId], ["Flair URL", flairUrl]] as const) {
    if (!isHookCommandValueSafe(value)) {
      return {
        ok: false, path, harness, dryRun,
        message: `${label} '${value}' contains characters that cannot be safely written into a shell hook command (allowed: letters, digits, . _ : / -) — refusing to write it`,
        backupPath: null, delta: null,
      };
    }
  }

  if (dryRun) {
    const read = readSettingsFile(path);
    if (read.parseError) {
      return {
        ok: false, path, harness, dryRun,
        message: `${read.parseError} — dry run: nothing would be written until this is fixed`,
        backupPath: null, delta: null,
      };
    }
    const { action, before, after } = computeInstallDelta(read.parsed ?? {}, agentId, flairUrl, harness);
    const delta: HookDelta = { action, path, harness, before, after };
    const message = action === "noop"
      ? withCodexReapproval(harness, `already correct in ${path} — no changes`)
      : withCodexReapproval(harness, `would ${action} the SessionStart hook in ${path} (dry run — nothing written)`);
    return { ok: true, path, harness, dryRun, message, backupPath: null, delta };
  }

  // Parent creation stays OUTSIDE the primitive: the primitive requires the
  // resolved parent to exist before it can observe an absent destination
  // (flair#1778 2c-i-b). Everything from here is ONE critical section.
  mkdirSync(dirname(path), { recursive: true });

  let delta: HookDelta | null = null;
  let parseRefused = false;

  const result = withConfigCriticalSection(
    path,
    (bytes) => {
      const read = parseSettingsBytes(bytes, path);
      if (read.parseError) {
        parseRefused = true;
        return {
          hold: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}.`,
        };
      }
      const { action, before, after, newConfig } = computeInstallDelta(read.parsed ?? {}, agentId, flairUrl, harness);
      delta = { action, path, harness, before, after };
      if (action === "noop") {
        return { noop: withCodexReapproval(harness, `SessionStart hook already correct in ${path}`) };
      }
      // flair#1778 2c-i-a3: the SessionStart command carries <pkg>@<spec> (the
      // pin from buildHookCommand), so the write consults the ONE never-lower
      // guard — on the IN-LOCK bytes, inside the critical section.
      const existingCommand =
        action === "update"
          ? (before?.hooks?.find(
              (h) => typeof h?.command === "string" && h.command.includes(SESSION_START_HOOK_MARKER),
            )?.command ?? null)
          : null;
      const decision = decidePinWrite({
        pkg: FLAIR_MCP_PACKAGE,
        entry: `SessionStart hook in ${path}`,
        existingText: existingCommand,
        runningVersion: flairCliVersion(),
      });
      if (decision.action !== "write") return { hold: decision.line! };
      return { write: encodeConfig(newConfig) };
    },
    { backup: (bytes) => backupBytesTo(path, bytes) },
  );

  const backupPath = result.backupPath ?? null;
  if (result.status === "written") {
    return {
      ok: true, path, harness, dryRun,
      message: withCodexReapproval(
        harness,
        `${(delta as HookDelta | null)?.action === "add" ? "added" : "updated"} the SessionStart hook in ${path}`,
      ),
      backupPath, delta,
    };
  }
  if (result.status === "noop") {
    return { ok: true, path, harness, dryRun, message: result.message, backupPath, delta };
  }
  if (result.status === "held") {
    return { ok: !parseRefused, path, harness, dryRun, message: result.message, backupPath, delta: parseRefused ? null : delta };
  }
  return { ok: false, path, harness, dryRun, message: result.message, backupPath, delta: null };
}

export interface HookRepinResult {
  ok: boolean;
  path: string;
  harness: Harness;
  /** "update" = re-pinned to the current spec; "noop" = already current;
   *  "skip" = nothing Flair may re-pin here (no hook); "hold" = a hook we will
   *  not touch (a shape Flair did not write, duplicate assignments, duplicate
   *  matching entries, unsupported metadata) — visible through A1's hold seam.
   *  `ok:false` is a fail-closed parse or backup error, never a silent pass. */
  action: "update" | "noop" | "skip" | "hold";
  message: string;
  backupPath: string | null;
}

/**
 * Every hook entry whose command carries the Flair marker — install/uninstall
 * mutate ONE by index, but re-pin must see them ALL: two matching entries are a
 * HOLD, not a silent pick of the first (flair#1834 PR-H).
 */
function findHookMatches(config: any): Array<{ groupIndex: number; hookIndex: number }> {
  const groups = config?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [];
  const out: Array<{ groupIndex: number; hookIndex: number }> = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const hooks = groups[gi]?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (let hi = 0; hi < hooks.length; hi++) {
      if (typeof hooks[hi]?.command === "string" && hooks[hi].command.includes(SESSION_START_HOOK_MARKER)) {
        out.push({ groupIndex: gi, hookIndex: hi });
      }
    }
  }
  return out;
}

/**
 * The three EXACT installer forms `buildSessionStartHookCommand` emits
 * (flair#1834 PR-H), anchored so the FULL command must match. `<id>`, `<url>`
 * and `<ver>` are the only free variables; everything else — quoting, the
 * wrapper, `2>/dev/null`, ordering — is the shape Flair itself wrote.
 *
 * The unanchored SESSION_START_HOOK_INVOCATION_RE stays only for status display.
 */
/**
 * The three EXACT installer forms `buildSessionStartHookCommand` emits
 * (flair#1834 PR-H), anchored so the FULL command must match. `<id>`, `<url>`
 * and `<ver>` are the only free variables; everything else — quoting, the
 * wrapper, `2>/dev/null`, ordering — is the shape Flair itself wrote.
 *
 * Literal regexes (no composed pattern): each form is a constant. The
 * unanchored SESSION_START_HOOK_INVOCATION_RE stays only for status display.
 * Capture groups: 1 = agent id, 2 = optional URL, 3 = the pinned package span.
 */
const HOOK_BARE_FORM_RE =
  /^FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@[^\s"')]+) flair-session-start$/;
const HOOK_CLAUDE_FORM_RE =
  /^sh -c 'out=\$\(FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@[^\s"')]+) flair-session-start 2>\/dev\/null\) && printf %s "\$out" \|\| true'$/;
const HOOK_CODEX_FORM_RE =
  /^sh -c 'out=\$\(FLAIR_HOOK_HARNESS=codex FLAIR_AGENT_ID=([^\s'"$();|&<>]+)(?: FLAIR_URL=([^\s'"$();|&<>]+))? npx -y -p (@tpsdev-ai\/flair-mcp@[^\s"')]+) flair-session-start\) && printf %s "\$out" \|\| true'$/;

export interface InstallerHookForm {
  /** The form's harness (the bare form is harness-agnostic). */
  harness: "claude-code" | "codex";
  agentId: string;
  flairUrl?: string;
  /** The exact `@tpsdev-ai/flair-mcp@<ver>` span (the only part re-pinned). */
  pkgSpec: string;
}

/**
 * Match a FULL hook command against the three installer forms, or null. This is
 * the strict replacement for the unanchored substring check: a duplicate
 * `FLAIR_AGENT_ID=`, an appended shell command, or an extra env var does not
 * match any form and is therefore a HOLD.
 */
export function parseInstallerHookForm(command: string): InstallerHookForm | null {
  if (typeof command !== "string") return null;
  let m = command.match(HOOK_CLAUDE_FORM_RE);
  if (m) return { harness: "claude-code", agentId: m[1]!, flairUrl: m[2], pkgSpec: m[3]! };
  m = command.match(HOOK_CODEX_FORM_RE);
  if (m) return { harness: "codex", agentId: m[1]!, flairUrl: m[2], pkgSpec: m[3]! };
  m = command.match(HOOK_BARE_FORM_RE);
  if (m) return { harness: "claude-code", agentId: m[1]!, flairUrl: m[2], pkgSpec: m[3]! };
  return null;
}

/**
 * Re-pin an ALREADY-WIRED Flair SessionStart hook to the current
 * mcpServerSpec(), preserving the agent id and Flair URL the entry already
 * carries.
 *
 * This is `flair upgrade`'s hook counterpart to refreshing the MCP client
 * pins (flair#1516). `flair upgrade` re-pins every wired client's MCP block
 * to the new @version but used to leave the SessionStart hook command on the
 * OLD one — so a user who upgraded by the documented path kept launching the
 * previous adapter on every session, silently, while `flair doctor` reported
 * the hook "still runs" without noticing the skew.
 *
 * NEVER adds a hook — a home with no Flair hook is a clean `skip`, not an
 * `add`: wiring a hook is `flair init` / `flair hook install`, an opt-in the
 * upgrade path must not make on the user's behalf. Only rewrites the exact
 * canonical `npx -y -p …` invocation Flair itself writes (pinned or the
 * pre-#1143 unpinned form); a hand-edited command is the user's and is left
 * untouched. Fail-closed on a malformed settings file and backs up before any
 * real write — the same Sherlock conditions installHook implements. Idempotent:
 * a second call is a `noop`.
 */
export function repinSessionStartHook(homeDir: string, harness: Harness): HookRepinResult {
  const path = hookSettingsPath(homeDir, harness);
  const skip = (ok: boolean, message: string): HookRepinResult => ({ ok, path, harness, action: "skip", message, backupPath: null });

  // Re-pin NEVER adds a hook and never creates the destination's parent — a
  // home with no Flair hook is a clean `skip`. If the parent is absent there
  // is nothing to observe, so return before the primitive (which requires a
  // resolved parent).
  if (!existsSync(dirname(path))) {
    return skip(true, `no Flair SessionStart hook in ${path} — nothing to re-pin`);
  }

  let refused = false;
  let outcome: { action: HookRepinResult["action"]; message: string } | null = null;
  const result = withConfigCriticalSection(
    path,
    (bytes) => {
      const read = parseSettingsBytes(bytes, path);
      if (read.parseError) {
        refused = true;
        outcome = { action: "skip", message: `${read.parseError} — refusing to re-pin a file we can't safely parse; left untouched` };
        return { hold: outcome.message };
      }
      const config = read.parsed ?? {};
      // flair#1834 PR-H: enumerate EVERY matching hook — two is a HOLD, not a
      // silent pick of the first (findHookEntry stays first-match for install/
      // uninstall, which splice ONE entry by index).
      const matches = findHookMatches(config);
      if (matches.length === 0) {
        outcome = { action: "skip", message: `no Flair SessionStart hook in ${path} — nothing to re-pin` };
        return { hold: outcome.message };
      }
      if (matches.length > 1) {
        outcome = { action: "hold", message: `${matches.length} Flair SessionStart hooks in ${path} match — re-pinning would change only one of them; left untouched` };
        return { hold: outcome.message };
      }
      const { groupIndex, hookIndex } = matches[0]!;
      const group = config.hooks.SessionStart[groupIndex];
      const entry = group?.hooks?.[hookIndex];
      // Unsupported hook metadata (anything Flair did not write). installHook
      // emits exactly `{ hooks: [{ type: "command", command }] }`.
      const groupKeys = group && typeof group === "object" ? Object.keys(group).sort().join(",") : "";
      const entryKeys = entry && typeof entry === "object" ? Object.keys(entry).sort().join(",") : "";
      if (groupKeys !== "hooks" || entryKeys !== "command,type" || entry.type !== "command") {
        outcome = { action: "hold", message: `SessionStart hook in ${path} carries fields Flair did not write — left untouched` };
        return { hold: outcome.message };
      }
      const current: string = entry.command ?? "";
      // Strict FULL-command validation against the three installer forms. A
      // duplicate assignment, an appended shell command or an extra env var
      // does NOT match a form — it is a HOLD, byte-preserved.
      const form = parseInstallerHookForm(current);
      if (!form) {
        outcome = { action: "hold", message: `SessionStart hook in ${path} is not one of the installer forms Flair writes — left untouched` };
        return { hold: outcome.message };
      }
      // Rebuild by substituting ONLY the pinned version — identity, URL and the
      // wire format are preserved by construction.
      const next = current.replace(form.pkgSpec, mcpServerSpec());
      if (next === current) {
        outcome = { action: "noop", message: `SessionStart hook in ${path} already pinned to ${mcpServerSpec()}` };
        return { noop: outcome.message };
      }
      // flair#1778 2c-i-a3: this EXPORTED raw writer consults the ONE
      // never-lower guard itself, so no caller can bypass it — on the in-lock
      // bytes, inside the critical section.
      const decision = decidePinWrite({
        pkg: FLAIR_MCP_PACKAGE,
        entry: `SessionStart hook in ${path}`,
        existingText: current,
        runningVersion: flairCliVersion(),
      });
      if (decision.action !== "write") {
        outcome = { action: "hold", message: decision.line! };
        return { hold: decision.line! };
      }
      const newConfig = deepClone(config);
      newConfig.hooks.SessionStart[groupIndex].hooks[hookIndex] = { type: "command", command: next };
      outcome = { action: "update", message: `re-pinned the SessionStart hook in ${path} to ${mcpServerSpec()}` };
      return { write: encodeConfig(newConfig) };
    },
    { backup: (bytes) => backupBytesTo(path, bytes) },
  );

  if (result.status === "written") {
    const oc = outcome as { action: HookRepinResult["action"]; message: string } | null;
    return {
      ok: true, path, harness, action: "update",
      message: oc?.message ?? `re-pinned the SessionStart hook in ${path} to ${mcpServerSpec()}`,
      backupPath: result.backupPath ?? null,
    };
  }
  const oc = outcome as { action: HookRepinResult["action"]; message: string } | null;
  if (result.status === "noop") {
    return { ok: true, path, harness, action: "noop", message: oc?.message ?? result.message, backupPath: result.backupPath ?? null };
  }
  return { ok: !refused, path, harness, action: oc?.action ?? "skip", message: oc?.message ?? result.message, backupPath: result.backupPath ?? null };
}

export interface UninstallHookOptions {
  homeDir: string;
  harness: Harness;
  dryRun?: boolean;
}

/** Symmetric removal — deletes ONLY our hook entry (found the same way
 *  install finds it: SESSION_START_HOOK_MARKER substring match), never
 *  touches unrelated hooks/keys. A no-op (ok:true, action "noop") when
 *  nothing is installed — never creates a file that didn't already exist.
 *
 *  NOT a version writer (flair#1778 2c-i-a3): it only SPLICES OUT our entry —
 *  no version-carrying spec is written, and every other byte (a sibling hook's
 *  pin included) is preserved — so it carries no version and cannot lower one,
 *  which is why it needs no guard. */
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

  // Removal never creates the destination's parent — if it is absent there is
  // nothing to remove and nothing to observe.
  if (!existsSync(dirname(path))) {
    return {
      ok: true, path, harness, dryRun,
      message: `no Flair SessionStart hook found in ${path} — nothing to remove`,
      backupPath: null, delta: { action: "noop", path, harness, before: null, after: null },
    };
  }

  let delta: HookDelta | null = null;
  let refused = false;
  const result = withConfigCriticalSection(
    path,
    (bytes) => {
      const read = parseSettingsBytes(bytes, path);
      if (read.parseError) {
        refused = true;
        return {
          hold: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}.`,
        };
      }
      const { action, before, newConfig } = computeRemovalDelta(read.parsed ?? {});
      delta = { action, path, harness, before, after: null };
      if (action === "noop") return { noop: `no Flair SessionStart hook found in ${path} — nothing to remove` };
      return { write: encodeConfig(newConfig) };
    },
    { backup: (bytes) => backupBytesTo(path, bytes) },
  );

  const backupPath = result.backupPath ?? null;
  if (result.status === "written") {
    return { ok: true, path, harness, dryRun, message: `removed the Flair SessionStart hook from ${path}`, backupPath, delta };
  }
  if (result.status === "noop") {
    return { ok: true, path, harness, dryRun, message: result.message, backupPath, delta };
  }
  if (result.status === "held") {
    return { ok: !refused, path, harness, dryRun, message: result.message, backupPath, delta: refused ? null : delta };
  }
  return { ok: false, path, harness, dryRun, message: result.message, backupPath, delta: null };
}

// ── status ───────────────────────────────────────────────────────────────

export type HookDeliveryState = "verified" | "unverified" | "absent";

export interface HookDeliveryVerdict {
  delivered: boolean;
  reason: string;
}

export interface HookStatusResult {
  harness: Harness;
  path: string;
  wired: boolean;
  /** True only when the matched hook entry is the `npx -y -p` invocation
   *  we write (pinned since flair#1143, or the older unpinned `-p` form) —
   *  not just a loose marker substring match (a hand-edited/partial entry
   *  still counts as `wired` for doctor-compat purposes but not `correctShape`). */
  correctShape: boolean;
  /** Does the wired command absorb its own failures, or would a command that
   *  stopped resolving print an error on every session start (flair#1007)?
   *  Since flair#1734 this is `|| true` (session still starts), not stderr
   *  discarded — Codex keeps stderr visible on purpose. */
  silenced: boolean;
  /** True when the command discards stderr (`2>/dev/null`). Codex must not. */
  stderrDiscarded: boolean;
  agentId?: string;
  flairUrl?: string;
  command?: string;
  parseError: string | null;
  /** What status verified, not what it configured (flair#1734). */
  delivery: HookDeliveryState;
  deliveryReasons: string[];
}

/** Injectable so `hook status` can classify a real run without unit tests spawning npx. */
export type HookDeliveryProbe = (command: string) => {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
  spawnError?: string | null;
};

export interface HookStatusOptions {
  deliveryProbe?: HookDeliveryProbe;
}

/**
 * Effect check: did the hook command produce SessionStart additionalContext?
 * Exit 0, inert `{}`, and empty stdout are not that. Do not treat
 * FLAIR_HOOK_PROBE's `{}` as success. This is not harness delivery.
 */
export function classifyHookDelivery(outcome: {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
  spawnError?: string | null;
}): HookDeliveryVerdict {
  if (outcome.timedOut) {
    return { delivered: false, reason: "not delivered: probe timed out" };
  }
  if (outcome.spawnError) {
    return { delivered: false, reason: `not delivered: probe spawn failed (${outcome.spawnError})` };
  }
  if (outcome.exitCode !== 0) {
    if (outcome.exitCode == null) {
      return { delivered: false, reason: "not delivered: probe did not exit" };
    }
    return { delivered: false, reason: `not delivered: exited ${outcome.exitCode}` };
  }
  const trimmed = (outcome.stdout ?? "").trim();
  if (!trimmed) {
    return { delivered: false, reason: "not delivered: empty stdout" };
  }
  if (trimmed === "{}") {
    return { delivered: false, reason: "not delivered: inert empty context" };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { additionalContext?: unknown };
    };
    const context = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof context === "string" && context.trim()) {
      return { delivered: true, reason: "the hook command produced additionalContext" };
    }
  } catch {
    // fall through — JSON-looking but not the documented contract
  }
  return { delivered: false, reason: "not delivered: no SessionStart additionalContext" };
}

/** Operator headline. Never an unqualified "wired" when delivery is unverified. */
export function hookStatusHeadline(status: HookStatusResult): string {
  if (!status.wired || status.delivery === "absent") return "not configured";
  if (status.delivery === "verified") return "configured; verified the hook command produced additionalContext";
  return "configured; delivery NOT verified";
}

interface CodexHookRuntime {
  hooksEnabled: boolean | undefined;
  mcpAgentId?: string;
  hasTrustedHash: boolean;
}

function readCodexConfigToml(homeDir: string): string | null {
  const configPath = join(homeDir, ".codex", "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    return readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
}

function scanCodexFeaturesHooksEnabled(raw: string): boolean | undefined {
  const header = raw.match(/^\[features\]\s*$/m);
  if (!header || header.index === undefined) return undefined;
  const rest = raw.slice(header.index);
  for (const line of rest.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    const match = trimmed.match(/^(?:hooks|codex_hooks)\s*=\s*(true|false)\b/);
    if (match) return match[1] === "true";
  }
  return undefined;
}

function readCodexHookRuntime(homeDir: string): CodexHookRuntime {
  const mcp = readClientMcpBlock("codex", homeDir);
  const raw = readCodexConfigToml(homeDir);
  if (raw == null) {
    return { hooksEnabled: undefined, mcpAgentId: mcp.agentId, hasTrustedHash: false };
  }
  return {
    hooksEnabled: scanCodexFeaturesHooksEnabled(raw),
    mcpAgentId: mcp.agentId,
    hasTrustedHash: /^\s*trusted_hash\s*=/m.test(raw),
  };
}

function assessDelivery(
  homeDir: string,
  harness: Harness,
  wired: boolean,
  agentId: string | undefined,
  correctShape: boolean,
  command: string | undefined,
  deliveryProbe?: HookDeliveryProbe,
): { delivery: HookDeliveryState; deliveryReasons: string[] } {
  if (!wired) return { delivery: "absent", deliveryReasons: [] };

  const blockers: string[] = [];
  const notes: string[] = [];
  if (harness === "codex") {
    const runtime = readCodexHookRuntime(homeDir);
    if (runtime.hooksEnabled === false) {
      blockers.push("Codex features.hooks is disabled — the harness will not run this hook");
    }
    if (runtime.mcpAgentId && agentId && runtime.mcpAgentId !== agentId) {
      blockers.push(`agent id drift: hook command is '${agentId}', MCP env is '${runtime.mcpAgentId}'`);
    }
    if (runtime.hasTrustedHash) {
      notes.push("trusted_hash is recorded but Flair cannot verify it matches the current definition");
    } else if (runtime.hooksEnabled !== false) {
      notes.push("Codex hook trust unread or untrusted — re-approval in /hooks required");
    }
  }

  if (deliveryProbe && command) {
    if (!isFlairHookCommand(command) || !correctShape) {
      return {
        delivery: "unverified",
        deliveryReasons: [
          ...blockers,
          "delivery not probed — command is not the Flair installer shape",
          ...notes,
        ],
      };
    }
    const verdict = classifyHookDelivery(deliveryProbe(command));
    if (verdict.delivered && blockers.length === 0) {
      return { delivery: "verified", deliveryReasons: [verdict.reason, ...notes] };
    }
    return { delivery: "unverified", deliveryReasons: [...blockers, verdict.reason, ...notes] };
  }

  return {
    delivery: "unverified",
    deliveryReasons: [
      ...blockers,
      "delivery not verified — no SessionStart additionalContext observed",
      ...notes,
    ],
  };
}

/** On-failure line for `flair hook status`. Codex keeps stderr visible. */
export function hookStatusFailureLine(status: Pick<HookStatusResult, "silenced" | "stderrDiscarded">): string {
  if (status.stderrDiscarded) return "silent (exit 0, no output)";
  if (status.silenced) return "session continues (exit 0); stderr is visible";
  return "prints an error on every session";
}

/** Read-only report: is the hook wired, does it look right, and which agent
 *  / Flair instance does it point at (recovered from the wired command). */
export function hookStatus(homeDir: string, harness: Harness, opts: HookStatusOptions = {}): HookStatusResult {
  const path = hookSettingsPath(homeDir, harness);
  const read = readSettingsFile(path);
  if (read.parseError) {
    return {
      harness, path, wired: false, correctShape: false, silenced: false, stderrDiscarded: false,
      parseError: read.parseError, delivery: "absent", deliveryReasons: [],
    };
  }

  const config = read.parsed ?? {};
  const existing = findHookEntry(config);
  if (!existing) {
    return {
      harness, path, wired: false, correctShape: false, silenced: false, stderrDiscarded: false,
      parseError: null, delivery: "absent", deliveryReasons: [],
    };
  }

  const hookEntry = config.hooks.SessionStart[existing.groupIndex].hooks[existing.hookIndex];
  const command: string = typeof hookEntry?.command === "string" ? hookEntry.command : "";
  const correctShape = hookEntry?.type === "command" && isSessionStartHookInvocation(command);
  const env = parseHookCommandEnv(command);
  const assessed = assessDelivery(
    homeDir, harness, true, env.agentId, correctShape, command, opts.deliveryProbe,
  );
  return {
    harness, path, wired: true, correctShape,
    silenced: hookCommandIsSilenced(command),
    stderrDiscarded: hookCommandDiscardsStderr(command),
    agentId: env.agentId, flairUrl: env.flairUrl, command, parseError: null,
    delivery: assessed.delivery, deliveryReasons: assessed.deliveryReasons,
  };
}

// ── continuity capture hooks (flair#1257 slice 2) ──────────────────────────
//
// The PostToolUse + Stop pair that auto-journals working state into the
// ephemeral Memory tier (see packages/flair-mcp/src/continuity.ts for the
// capture discipline). INSTALLING THIS PAIR IS THE OPT-IN — there is no env
// flag — so it gets the same standalone, symmetric, dry-run-able command
// surface as the SessionStart hook (`flair hook install|uninstall
// --continuity`, wired in src/cli.ts), sharing this module's Sherlock
// conditions: fail-closed on malformed settings.json, backup before any real
// mutation, idempotent merge that never touches unrelated hooks/keys,
// --dry-run computes the delta without writing (no backup either). The pure
// mutation cores (computeContinuityHookInstall / computeContinuityHookRemoval)
// live in src/doctor-client.ts next to the ONE command builder so `flair
// doctor --fix` and this family cannot drift apart.

/** Mirror of buildHookCommand for the continuity pair — delegates to the ONE
 *  builder in doctor-client.ts. Throws on unrepresentable values;
 *  installContinuityHooks() checks first and reports instead. */
export function buildContinuityHookCommand(agentId: string, flairUrl: string): string {
  return buildContinuityCaptureHookCommand(agentId, flairUrl);
}

export interface ContinuityMutationResult {
  ok: boolean;
  path: string;
  harness: Harness;
  dryRun: boolean;
  message: string;
  backupPath: string | null;
  /** Per-event outcome ("add"/"update"/"remove"/"noop"), null on refusal. */
  actions: Record<ContinuityHookEvent, ContinuityMutationAction | "remove"> | null;
}

/** Install (or repair to current form) the continuity capture pair. */
export function installContinuityHooks(opts: InstallHookOptions): ContinuityMutationResult {
  const { homeDir, harness, agentId, flairUrl } = opts;
  const dryRun = !!opts.dryRun;
  const path = hookSettingsPath(homeDir, harness);

  if (!harnessSupportsContinuity(harness)) {
    return {
      ok: false, path, harness, dryRun,
      message: `continuity capture is Claude Code only — ${harness} has no PostToolUse/Stop matcher Flair can journal (SessionStart is still ${hookInstallHint(harness)})`,
      backupPath: null, actions: null,
    };
  }

  for (const [label, value] of [["agent id", agentId], ["Flair URL", flairUrl]] as const) {
    if (!isHookCommandValueSafe(value)) {
      return {
        ok: false, path, harness, dryRun,
        message: `${label} '${value}' contains characters that cannot be safely written into a shell hook command (allowed: letters, digits, . _ : / -) — refusing to write it`,
        backupPath: null, actions: null,
      };
    }
  }

  if (dryRun) {
    const read = readSettingsFile(path);
    if (read.parseError) {
      return {
        ok: false, path, harness, dryRun,
        message: `${read.parseError} — dry run: nothing would be written until this is fixed`,
        backupPath: null, actions: null,
      };
    }
    const { changed, actions } = computeContinuityHookInstall(read.parsed ?? {}, agentId, flairUrl);
    const message = changed
      ? `would wire the continuity capture hooks (PostToolUse: ${actions.PostToolUse}, Stop: ${actions.Stop}) in ${path} (dry run — nothing written)`
      : `continuity capture hooks already current in ${path} — no changes`;
    return { ok: true, path, harness, dryRun, message, backupPath: null, actions };
  }

  // Parent creation stays OUTSIDE the primitive; the whole mutation is ONE
  // critical section.
  mkdirSync(dirname(path), { recursive: true });
  let actions: ContinuityMutationResult["actions"] = null;
  let refused = false;
  const result = withConfigCriticalSection(
    path,
    (bytes) => {
      const read = parseSettingsBytes(bytes, path);
      if (read.parseError) {
        refused = true;
        return {
          hold: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}.`,
        };
      }
      const res = computeContinuityHookInstall(read.parsed ?? {}, agentId, flairUrl);
      actions = res.actions;
      if (res.decision) return { hold: res.decision.line! };
      if (!res.changed) return { noop: `continuity capture hooks already current in ${path}` };
      return { write: encodeConfig(res.newConfig) };
    },
    { backup: (bytes) => backupBytesTo(path, bytes) },
  );

  const backupPath = result.backupPath ?? null;
  if (result.status === "written") {
    return {
      ok: true, path, harness, dryRun,
      message: `wired the continuity capture hooks (PostToolUse: ${actions!.PostToolUse}, Stop: ${actions!.Stop}) in ${path}`,
      backupPath, actions,
    };
  }
  if (result.status === "noop") {
    return { ok: true, path, harness, dryRun, message: result.message, backupPath, actions };
  }
  if (result.status === "held") {
    return { ok: !refused, path, harness, dryRun, message: result.message, backupPath, actions: refused ? null : actions };
  }
  return { ok: false, path, harness, dryRun, message: result.message, backupPath, actions: null };
}

/** Symmetric removal of the continuity pair — only ours, everything else in
 *  the file left untouched. A no-op when nothing is installed.
 *
 *  NOT a version writer (flair#1778 2c-i-a3): like uninstallHook it only
 *  deletes our entries and preserves every other byte, so it cannot lower a
 *  pin and needs no guard. */
export function uninstallContinuityHooks(opts: UninstallHookOptions): ContinuityMutationResult {
  const { homeDir, harness } = opts;
  const dryRun = !!opts.dryRun;
  const path = hookSettingsPath(homeDir, harness);

  if (dryRun) {
    const read = readSettingsFile(path);
    if (read.parseError) {
      return {
        ok: false, path, harness, dryRun,
        message: `${read.parseError} — dry run: nothing would be removed until this is fixed`,
        backupPath: null, actions: null,
      };
    }
    const { changed, actions } = computeContinuityHookRemoval(read.parsed ?? {});
    const message = changed
      ? `would remove the continuity capture hooks (PostToolUse: ${actions.PostToolUse}, Stop: ${actions.Stop}) from ${path} (dry run — nothing written)`
      : `no continuity capture hooks found in ${path} — nothing to remove`;
    return { ok: true, path, harness, dryRun, message, backupPath: null, actions };
  }

  if (!existsSync(dirname(path))) {
    return {
      ok: true, path, harness, dryRun,
      message: `no continuity capture hooks found in ${path} — nothing to remove`,
      backupPath: null, actions: { PostToolUse: "noop", Stop: "noop" },
    };
  }
  let actions: ContinuityMutationResult["actions"] = null;
  let refused = false;
  const result = withConfigCriticalSection(
    path,
    (bytes) => {
      const read = parseSettingsBytes(bytes, path);
      if (read.parseError) {
        refused = true;
        return {
          hold: `${read.parseError} — refusing to modify a file we can't safely parse. Original left untouched at ${path}.`,
        };
      }
      const res = computeContinuityHookRemoval(read.parsed ?? {});
      actions = res.actions;
      if (!res.changed) return { noop: `no continuity capture hooks found in ${path} — nothing to remove` };
      return { write: encodeConfig(res.newConfig) };
    },
    { backup: (bytes) => backupBytesTo(path, bytes) },
  );

  const backupPath = result.backupPath ?? null;
  if (result.status === "written") {
    return {
      ok: true, path, harness, dryRun,
      message: `removed the continuity capture hooks (PostToolUse + Stop) from ${path}`,
      backupPath, actions,
    };
  }
  if (result.status === "noop") {
    return { ok: true, path, harness, dryRun, message: result.message, backupPath, actions };
  }
  if (result.status === "held") {
    return { ok: !refused, path, harness, dryRun, message: result.message, backupPath, actions: refused ? null : actions };
  }
  return { ok: false, path, harness, dryRun, message: result.message, backupPath, actions: null };
}

/** Read-only continuity status for `flair hook status` — the same report
 *  doctor's check consumes, resolved through the harness's settings path. */
export function continuityHookStatus(homeDir: string, harness: Harness): ContinuityCaptureHookReport {
  return checkContinuityCaptureHooks(homeDir, hookSettingsPath(homeDir, harness));
}
