// ─── Doctor: client integration checks (flair#588) ──────────────────────────────
//
// `flair doctor` diagnosed the SERVER side only (Harper port, keys, config,
// embeddings, data dir). It had zero visibility into whether the CLIENT
// integration — the MCP wiring an agent like Claude Code actually uses — is
// working. A real incident found users with partial setups (MCP block wired
// but no CLAUDE.md line; or no SessionStart hook) that silently no-op, with
// no way to tell "is Flair working for my agent?" short of an incident.
//
// This module is filesystem logic (no network, no crypto) so it's fast and
// fully unit-testable in isolation — mirrors test/unit/client-wiring.test.ts's
// technique of overriding process.env.HOME to a temp dir. The two
// network-dependent checks (reachability + agent registration) live in
// src/cli.ts alongside authFetch/resolveKeyPath, which they reuse. The one
// exception to "filesystem only" is probeSessionStartHookCommand (flair#1007),
// which spawns a bounded subprocess — it takes an injectable runner so every
// caller in the test suite stays hermetic.
//
// Every read here is try/catch-wrapped: a missing or malformed config file is
// "not present", never a thrown error — doctor must never crash or hang on a
// broken client config.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientConfigPath, type ClientId } from "./install/clients.js";

// The exact substring `flair init` writes into CLAUDE.md (src/cli.ts, the
// `init` action) and that the doctor check + fix both key off of.
export const CLAUDE_MD_BOOTSTRAP_MARKER = "mcp__flair__bootstrap";
const CLAUDE_MD_BOOTSTRAP_LINE = "At the start of every session, run mcp__flair__bootstrap before responding.";

// The exact substring identifying a Flair SessionStart hook command (see
// docs/mcp-clients.md "Auto-recall on session start").
export const SESSION_START_HOOK_MARKER = "flair-session-start";

// ── the canonical SessionStart hook command (flair#1007) ───────────────────
//
// ONE builder, three call sites: `flair doctor --fix` (fixSessionStartHook),
// `flair init`'s copy-paste hint (sessionStartHookHint), and `flair hook
// install` (src/hook-install.ts's buildHookCommand, which delegates here).
// Before #1007 each of those carried its own literal copy of the string, so a
// change to the invocation's failure behaviour had to be made in three places
// and could be tested in none of them.
//
// WHY THE INVOCATION IS WRAPPED
// -----------------------------
// The hook runs `npx -y -p @tpsdev-ai/flair-mcp flair-session-start`: it resolves
// a package binary through whatever Node runtime the user's shell happens to
// expose. Under a Node version manager, globally installed packages are
// per-runtime-version, so a routine and entirely unrelated runtime upgrade
// orphans that binary. The command then stops resolving and the harness
// reports a hook error on EVERY session, indefinitely, in wording that names
// neither Flair nor a remedy. It also outlives Flair itself: uninstalling the
// CLI does not remove the hook, so the error survives the tool it exists to
// serve (flair#1007).
//
// packages/flair-mcp/src/session-start-hook.ts already guarantees
// no-op-on-any-failure — but that guarantee lives INSIDE the binary which, in
// this failure, never runs. The guard is behind the door it is meant to guard.
// The only layer that still exists when the binary does not is the command
// string itself, so that is where the silence has to be enforced.
//
// WHY `sh -c '...'` RATHER THAN A BARE FRAGMENT
// ---------------------------------------------
// Claude Code runs a `type: "command"` hook as `/bin/sh -c "<command>"` — it
// spawns with `shell: true` and never consults $SHELL (verified against the
// 2.1.220 bundle; the settings schema's claim that `"shell": "bash"` uses your
// $SHELL is not what the code does on POSIX). So a bare POSIX fragment would
// in fact be enough for the one harness we support today.
//
// It is still wrapped, because this string is not private to that harness:
// SUPPORTED_HARNESSES (src/hook-install.ts) is a registry meant to grow, and
// docs/mcp-clients.md publishes this exact command for hand-wiring. Measured
// across sh, bash, zsh, dash, ksh, fish and tcsh:
//   - the wrapped form is uniform — stdout passed through byte-for-byte on
//     success; empty stdout, empty stderr and exit 0 on every failure;
//   - a bare `out=$(...) && ... || true` fragment is a SYNTAX ERROR in fish and
//     csh/tcsh — silent on some shells, LOUDER than before on others, which is
//     not a fix;
//   - the unwrapped pre-#1007 command is already broken outright in csh/tcsh
//     ("FLAIR_AGENT_ID=me: Command not found."), which the wrapper fixes.
// The cost is one extra process at session start; the benefit is that the
// silence is a property of the string rather than of who runs it.
//
// WHY STDOUT IS CAPTURED, NOT JUST STDERR DISCARDED
// -------------------------------------------------
// Exit code alone is not the whole surface. In the same bundle, a SessionStart
// hook's stdout is consumed two ways EVEN AT EXIT 0:
//   - stdout that does not start with `{` is injected into the model's context
//     verbatim, as a `<hook> hook success: <stdout>` meta message;
//   - stdout that starts with `{` but fails to parse/validate is reported as a
//     hook error — at exit 0, presented as exit 1.
// So a failing resolver that happens to print on stdout would either become
// silently injected context or produce the exact error class this issue is
// about, no matter what the exit code says. Capturing stdout and emitting it
// only on success closes both; discarding stderr alone would close neither.

/**
 * Values interpolated into the hook command are constrained by a strict
 * allow-list rather than escaped. The command is a single-quoted `sh -c`
 * argument and correct single-quote escaping is NOT uniform across the shells
 * above (fish and csh disagree with POSIX), so "cannot contain a quote" is
 * enforced by shape instead of handled by quoting. This is also strictly
 * safer than the pre-#1007 command, where an agent id containing a space or a
 * `;` was a command injection into the user's settings file.
 */
const HOOK_VALUE_SAFE_RE = /^[A-Za-z0-9._:/-]+$/;

export function isHookCommandValueSafe(value: string): boolean {
  return typeof value === "string" && HOOK_VALUE_SAFE_RE.test(value);
}

/**
 * Build the exact `command` string to register as a SessionStart hook.
 * Throws (rather than emitting a quoted approximation) when a value cannot be
 * represented safely — see HOOK_VALUE_SAFE_RE.
 */
export function buildSessionStartHookCommand(agentId: string, flairUrl?: string): string {
  if (!isHookCommandValueSafe(agentId)) {
    throw new Error(
      `agent id '${agentId}' contains characters that cannot be safely written into a shell hook command (allowed: letters, digits, . _ : / -)`,
    );
  }
  if (flairUrl != null && flairUrl !== "" && !isHookCommandValueSafe(flairUrl)) {
    throw new Error(
      `Flair URL '${flairUrl}' contains characters that cannot be safely written into a shell hook command (allowed: letters, digits, . _ : / -)`,
    );
  }
  const env = flairUrl ? `FLAIR_AGENT_ID=${agentId} FLAIR_URL=${flairUrl}` : `FLAIR_AGENT_ID=${agentId}`;
  const invocation = `${env} npx -y -p @tpsdev-ai/flair-mcp ${SESSION_START_HOOK_MARKER}`;
  return `sh -c 'out=$(${invocation} 2>/dev/null) && printf %s "$out" || true'`;
}

/**
 * Does this command absorb a failure instead of surfacing it? Checked as two
 * independent PROPERTIES (stderr discarded, non-zero exit absorbed) rather
 * than by string equality with what we currently emit, so a hand-rolled
 * command that genuinely achieves both is not nagged about.
 */
export function hookCommandIsSilenced(command: string): boolean {
  if (typeof command !== "string") return false;
  const discardsStderr = command.includes("2>/dev/null") || command.includes("2>&-");
  const absorbsFailure = /\|\|\s*(?:true|:)(?:\s|'|$)/.test(command) || /;\s*(?:true|:)\s*'?\s*$/.test(command);
  return discardsStderr && absorbsFailure;
}

/**
 * The EXACT unwrapped shape Flair wrote before #1007. Recognising it precisely
 * (not "anything containing the marker") is what lets `flair doctor --fix`
 * upgrade a hook we know we authored while never rewriting one a user placed
 * or edited themselves.
 */
const LEGACY_SESSION_START_HOOK_RE =
  /^FLAIR_AGENT_ID=([^\s'"]+)(?: FLAIR_URL=([^\s'"]+))? npx -y @tpsdev-ai\/flair-mcp flair-session-start$/;

export function parseLegacySessionStartHookCommand(command: string): { agentId: string; flairUrl?: string } | null {
  if (typeof command !== "string") return null;
  const m = command.trim().match(LEGACY_SESSION_START_HOOK_RE);
  if (!m) return null;
  return { agentId: m[1]!, flairUrl: m[2] };
}

/** Does this command invoke the Flair adapter at all (pinned or not)? Only
 *  such a command is ever probed or rewritten. */
export function isFlairHookCommand(command: string): boolean {
  return typeof command === "string" && command.includes("@tpsdev-ai/flair-mcp") && command.includes(SESSION_START_HOOK_MARKER);
}

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Run `fn` with process.env.HOME temporarily pointed at `homeDir`, then
 * restore it. clientConfigPath() (src/install/clients.ts) resolves the home
 * dir via HOME/USERPROFILE at call time (not cached), so this lets us reuse
 * that single source of truth for per-client config paths while keeping
 * doctor-client's own functions parameterized by an explicit homeDir for
 * tests — no test ever touches the real ~/.claude.json etc. The override is
 * synchronous and restored before this function returns, so it's safe even
 * though process.env is process-global.
 */
function withHome<T>(homeDir: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ── check 1: MCP server block present + configured ─────────────────────────

export interface ClientMcpBlockResult {
  present: boolean;
  configPath: string;
  agentId?: string;
  flairUrl?: string;
}

/**
 * Read the Flair MCP server block from `clientId`'s config file. `present`
 * is true only when the block exists AND both FLAIR_AGENT_ID and FLAIR_URL
 * are set (non-empty) — a half-wired block (e.g. block present, env missing)
 * counts as absent for the pass/fail check, but agentId/flairUrl are still
 * returned when partially found so callers can use whatever is known.
 */
export function readClientMcpBlock(clientId: ClientId, homeDir: string): ClientMcpBlockResult {
  const configPath = withHome(homeDir, () => clientConfigPath(clientId));
  return clientId === "codex" ? readCodexFlairBlock(configPath) : readJsonFlairBlock(configPath);
}

function readJsonFlairBlock(configPath: string): ClientMcpBlockResult {
  const raw = readTextFile(configPath);
  if (!raw || !raw.trim()) return { present: false, configPath };
  try {
    const config = JSON.parse(raw);
    const flair = config?.mcpServers?.flair;
    if (!flair || typeof flair !== "object") return { present: false, configPath };
    const agentId: string | undefined = typeof flair.env?.FLAIR_AGENT_ID === "string" && flair.env.FLAIR_AGENT_ID ? flair.env.FLAIR_AGENT_ID : undefined;
    const flairUrl: string | undefined = typeof flair.env?.FLAIR_URL === "string" && flair.env.FLAIR_URL ? flair.env.FLAIR_URL : undefined;
    return { present: !!agentId && !!flairUrl, configPath, agentId, flairUrl };
  } catch {
    // Malformed JSON — treat as "not present", never throw.
    return { present: false, configPath };
  }
}

/**
 * Codex's config is TOML, and this repo carries no TOML parser (see the
 * comment on _wireCodex in src/install/clients.ts) — so this is a lightweight
 * string scan, matching the exact shape _wireCodex/tomlSnippet() produce:
 *
 *   [mcp_servers.flair]
 *   command = "npx"
 *   args = ["-y", "@tpsdev-ai/flair-mcp"]
 *
 *   [mcp_servers.flair.env]
 *   FLAIR_AGENT_ID = "..."
 *   FLAIR_URL = "..."
 *
 * We locate the `[mcp_servers.flair]` header, then collect lines until a
 * header that is NOT part of this table (i.e. doesn't start with
 * "[mcp_servers.flair") — deliberately does NOT stop at the nested
 * `[mcp_servers.flair.env]` sub-table, since that's where the two env keys
 * actually live.
 */
function readCodexFlairBlock(configPath: string): ClientMcpBlockResult {
  const raw = readTextFile(configPath);
  if (!raw) return { present: false, configPath };
  const scanned = scanCodexFlairBlock(raw);
  return { present: scanned.present, configPath, agentId: scanned.agentId, flairUrl: scanned.flairUrl };
}

function scanCodexFlairBlock(raw: string): { present: boolean; agentId?: string; flairUrl?: string } {
  const startMatch = raw.match(/^\[mcp_servers\.flair\]\s*$/m);
  if (!startMatch || startMatch.index === undefined) return { present: false };

  const rest = raw.slice(startMatch.index);
  const lines = rest.split("\n");
  const blockLines: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[mcp_servers.flair")) break;
    blockLines.push(lines[i]);
  }
  const block = blockLines.join("\n");

  const agentMatch = block.match(/^\s*FLAIR_AGENT_ID\s*=\s*"([^"]*)"/m);
  const urlMatch = block.match(/^\s*FLAIR_URL\s*=\s*"([^"]*)"/m);
  const agentId = agentMatch?.[1] || undefined;
  const flairUrl = urlMatch?.[1] || undefined;
  return { present: !!agentId && !!flairUrl, agentId, flairUrl };
}

// ── check 2: FLAIR_URL to use when (re-)wiring a client (flair#727) ────────

/**
 * Pick the FLAIR_URL to feed a wire() call when `doctor --fix` re-wires a
 * client whose block was judged "not present" (readClientMcpBlock — missing
 * FLAIR_AGENT_ID and/or FLAIR_URL). A pre-existing config can still carry a
 * `flairUrl` fragment (e.g. `present:false` because FLAIR_AGENT_ID is empty,
 * but FLAIR_URL scanned fine) — and that fragment can itself be malformed: a
 * bare host with no scheme/port (`"127.0.0.1"`), left over from an older
 * Flair version or a hand-edited config. Blindly reusing it perpetuates the
 * corruption into the freshly suggested block (flair#727 — a real dogfood
 * run printed exactly `FLAIR_URL = "127.0.0.1"`, unusable if pasted).
 *
 * Only trust `existingFlairUrl` when it parses as an absolute http(s) URL;
 * otherwise fall back to `baseUrl` — the live, authoritative URL `doctor`
 * already computed from the same port source as its "Config: ... (port:
 * NNNNN)" line (resolveHttpPort / readPortFromConfig, with live-port
 * discovery layered on top).
 */
export function resolveWireFlairUrl(existingFlairUrl: string | undefined, baseUrl: string): string {
  if (existingFlairUrl) {
    try {
      const parsed = new URL(existingFlairUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return existingFlairUrl;
    } catch {
      // Not an absolute URL (e.g. a bare host like "127.0.0.1") — fall through.
    }
  }
  return baseUrl;
}

// ── check 3: CLAUDE.md bootstrap instruction (claude-code only) ────────────

export interface ClaudeMdCheckResult {
  present: boolean;
  path: string | null;
}

/**
 * Pass when EITHER the project-scoped `${cwd}/CLAUDE.md` or the user-level
 * `~/.claude/CLAUDE.md` contains the bootstrap marker — Claude Code loads
 * both. Checks cwd first (the convention docs/claude-code.md documents and
 * what `flair init` tells users to edit).
 */
export function checkClaudeMdBootstrap(cwd: string, homeDir: string): ClaudeMdCheckResult {
  const cwdPath = join(cwd, "CLAUDE.md");
  const cwdContent = readTextFile(cwdPath);
  if (cwdContent && cwdContent.includes(CLAUDE_MD_BOOTSTRAP_MARKER)) {
    return { present: true, path: cwdPath };
  }

  const homePath = join(homeDir, ".claude", "CLAUDE.md");
  const homeContent = readTextFile(homePath);
  if (homeContent && homeContent.includes(CLAUDE_MD_BOOTSTRAP_MARKER)) {
    return { present: true, path: homePath };
  }

  return { present: false, path: null };
}

/**
 * Append the bootstrap instruction to `${cwd}/CLAUDE.md` (creating it if
 * absent). Idempotent — safe to call twice; a second call is a no-op that
 * still reports ok:true.
 */
export function fixClaudeMdBootstrap(cwd: string): { ok: boolean; path: string; message: string } {
  const path = join(cwd, "CLAUDE.md");
  try {
    const existing = readTextFile(path) ?? "";
    if (existing.includes(CLAUDE_MD_BOOTSTRAP_MARKER)) {
      return { ok: true, path, message: `already present in ${path}` };
    }
    const separator = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    const block = `${separator}## Flair memory\n\n${CLAUDE_MD_BOOTSTRAP_LINE}\n`;
    writeFileSync(path, existing + block);
    return { ok: true, path, message: `added bootstrap instruction to ${path}` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, path, message: `could not write ${path}: ${reason}` };
  }
}

// ── check 4: settings.json SessionStart hook (claude-code only) ────────────

export interface SessionStartHookCheckResult {
  present: boolean;
  path: string;
  /** The registered command, when one was found. Additive since #1007 — the
   *  hook's PRESENCE was never the problem; whether the command it names can
   *  still execute is, and answering that needs the command itself. */
  command?: string;
}

/**
 * Pass when ~/.claude/settings.json exists, parses as JSON, and ANY hook
 * command anywhere under hooks.SessionStart[*].hooks[*].command contains the
 * flair-session-start marker (see docs/mcp-clients.md for the exact shape).
 */
export function checkSessionStartHook(homeDir: string): SessionStartHookCheckResult {
  const path = join(homeDir, ".claude", "settings.json");
  const raw = readTextFile(path);
  if (!raw || !raw.trim()) return { present: false, path };
  try {
    const config = JSON.parse(raw);
    const groups = config?.hooks?.SessionStart;
    if (!Array.isArray(groups)) return { present: false, path };
    for (const group of groups) {
      const hooks = group?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (typeof hook?.command === "string" && hook.command.includes(SESSION_START_HOOK_MARKER)) {
          return { present: true, path, command: hook.command };
        }
      }
    }
    return { present: false, path };
  } catch {
    return { present: false, path };
  }
}

/**
 * Merge-safe insert of a Flair SessionStart hook group into
 * ~/.claude/settings.json — creates the file/array if absent, preserves any
 * other existing hooks/keys (read-parse-merge-write, mirroring wireJsonMcp's
 * merge safety in src/install/clients.ts; never a blind overwrite). Dedupes:
 * a no-op (ok:true) if a matching hook is already present, so it's safe to
 * call twice.
 */
export function fixSessionStartHook(homeDir: string, agentId: string | undefined): { ok: boolean; path: string; message: string } {
  const path = join(homeDir, ".claude", "settings.json");
  if (!agentId) {
    return {
      ok: false,
      path,
      message: "no agent id known — pass --agent <id> (or set FLAIR_AGENT_ID) so doctor knows which agent to wire the hook to",
    };
  }
  if (!isHookCommandValueSafe(agentId)) {
    return {
      ok: false,
      path,
      message: `agent id '${agentId}' contains characters that cannot be safely written into a shell hook command (allowed: letters, digits, . _ : / -)`,
    };
  }
  try {
    let config: any = {};
    const raw = readTextFile(path);
    if (raw && raw.trim()) config = JSON.parse(raw);

    config.hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};
    config.hooks.SessionStart = Array.isArray(config.hooks.SessionStart) ? config.hooks.SessionStart : [];

    const alreadyPresent = config.hooks.SessionStart.some(
      (group: any) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(SESSION_START_HOOK_MARKER)),
    );
    if (alreadyPresent) {
      return { ok: true, path, message: `already present in ${path}` };
    }

    config.hooks.SessionStart.push({
      hooks: [
        {
          type: "command",
          command: buildSessionStartHookCommand(agentId),
        },
      ],
    });

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    return { ok: true, path, message: `added SessionStart hook to ${path} (agent '${agentId}')` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, path, message: `could not write ${path}: ${reason}` };
  }
}

// ── check 4b: does the registered hook command still execute? (flair#1007) ──
//
// Presence was never the problem. In the reported failure the settings entry
// was perfectly well-formed — what changed was the environment around it, and
// nothing checked that the command it names can still run. These three
// functions are that check, split so the decision logic stays hermetic:
//
//   probeSessionStartHookCommand — spawns the command (injectable runner)
//   classifyHookProbe            — pure: probe outcome -> verdict
//   upgradeSessionStartHookCommand — the ONE repair doctor is willing to make
//
// The probe runs the command with FLAIR_HOOK_PROBE=1, which
// packages/flair-mcp/src/session-start-hook.ts honours by printing its inert
// output and exiting immediately — no network, no presence write, no memory
// read. An adapter too old to know that variable still answers the only
// question being asked (it prints SOMETHING and exits 0), it just does a real
// bootstrap first, so the two short timeouts below bound that case too.
//
// The verdict keys off a property the adapter guarantees and a broken
// resolution cannot fake: the adapter ALWAYS writes a non-empty payload (at
// minimum its inert `{}`) and always exits 0. So "exit 0 with empty stdout" is
// precisely the signature of the silenced wrapper swallowing a command that
// never ran — which is why the wrapper does not make this failure less
// diagnosable, it makes it MORE so.

/** Bounded outcome of running a registered hook command once. */
export interface HookProbeOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the probe process could not be started at all. */
  spawnError: string | null;
}

export type HookExecutionState = "runs" | "broken" | "unknown";

export interface HookProbeVerdict {
  execution: HookExecutionState;
  detail?: string;
}

/** Injectable so unit tests never spawn a shell. */
export type HookProbeRunner = (command: string, timeoutMs: number) => HookProbeOutcome;

/** Default probe budget. Generous: a cold `npx` may have to reach the registry
 *  before it can answer, and a slow answer must never be reported as a broken
 *  hook — that is what the "unknown" verdict is for. */
export const HOOK_PROBE_TIMEOUT_MS = 20_000;

/** Package-manager chatter that is never the reason a hook failed. The harness
 *  itself reports the FIRST stderr line, which on a modern npm is one of these
 *  — so doctor deliberately does better than repeating the symptom back. */
const NOISE_LINE_RE = /^(?:npm|yarn|pnpm|bun)\s+(?:notice|warn|info|http|verb)\b/i;

/** The most informative single line of a failed probe's output. */
export function evidenceLine(s: string, max = 200): string {
  const lines = (s || "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.find((l) => !NOISE_LINE_RE.test(l)) ?? lines[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const defaultProbeRunner: HookProbeRunner = (command, timeoutMs) => {
  // `/bin/sh -c` is not a guess: it is exactly how Claude Code runs a
  // `type: "command"` hook (spawn with `shell: true`, $SHELL never consulted).
  // Probing through any other shell would answer a question the user never
  // asked.
  const res = spawnSync("/bin/sh", ["-c", command], {
    input: "",
    encoding: "utf-8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Tell a #1007-or-later adapter to answer without side effects.
      FLAIR_HOOK_PROBE: "1",
      // Bound an OLDER adapter, which will do a real bootstrap + presence
      // heartbeat because it has never heard of FLAIR_HOOK_PROBE.
      FLAIR_HOOK_TIMEOUT_MS: "1500",
      FLAIR_PRESENCE_TIMEOUT_MS: "500",
    },
  });
  const timedOut = (res as { signal?: string | null }).signal === "SIGTERM" && res.status === null;
  return {
    exitCode: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut,
    spawnError: res.error && !timedOut ? res.error.message : null,
  };
};

/**
 * Run a registered hook command once, bounded, with probe-mode env set.
 * Only ever called for commands isFlairHookCommand() recognises — doctor does
 * not execute a stranger's hook to find out what it does.
 */
export function probeSessionStartHookCommand(
  command: string,
  opts: { timeoutMs?: number; runner?: HookProbeRunner } = {},
): HookProbeOutcome {
  const timeoutMs = opts.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  const runner = opts.runner ?? defaultProbeRunner;
  try {
    return runner(command, timeoutMs);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: reason };
  }
}

/** Pure: probe outcome -> verdict. See the section doc for why "exit 0, no
 *  output" is a definite failure rather than an ambiguous one. */
export function classifyHookProbe(outcome: HookProbeOutcome): HookProbeVerdict {
  if (outcome.timedOut) {
    return { execution: "unknown", detail: "the command did not answer in time" };
  }
  if (outcome.spawnError) {
    return { execution: "unknown", detail: `could not run the command (${outcome.spawnError})` };
  }
  if (outcome.exitCode !== 0) {
    const evidence = evidenceLine(outcome.stderr) || evidenceLine(outcome.stdout);
    return {
      execution: "broken",
      detail: evidence ? `exited ${outcome.exitCode}: ${evidence}` : `exited ${outcome.exitCode}`,
    };
  }
  if (!outcome.stdout.trim()) {
    return {
      execution: "broken",
      detail: "the command produced no output — the flair-session-start binary never ran",
    };
  }
  return { execution: "runs" };
}

/** What doctor knows about the registered hook, beyond "is it there". */
export interface SessionStartHookCommandReport {
  path: string;
  present: boolean;
  command?: string;
  /** Does this command invoke the Flair adapter (so probing/repair applies)? */
  ours: boolean;
  /** Does it absorb its own failures? */
  silenced: boolean;
  /** Is it the exact unwrapped shape Flair itself wrote before #1007, and so
   *  safe for `--fix` to rewrite in place? */
  upgradable: boolean;
  execution: HookExecutionState | null;
  detail?: string;
}

/**
 * Full report for the registered hook: presence (as before), plus whether its
 * command still executes and whether it would fail quietly if it stopped.
 * `probe` is injectable and defaults to the real bounded spawn; pass a stub
 * (or null via `{ probe: false }`) to keep a caller hermetic.
 */
export function inspectSessionStartHook(
  homeDir: string,
  opts: { probe?: HookProbeRunner | false; timeoutMs?: number } = {},
): SessionStartHookCommandReport {
  const found = checkSessionStartHook(homeDir);
  if (!found.present || !found.command) {
    return { path: found.path, present: false, ours: false, silenced: false, upgradable: false, execution: null };
  }
  const command = found.command;
  const ours = isFlairHookCommand(command);
  const silenced = hookCommandIsSilenced(command);
  const upgradable = parseLegacySessionStartHookCommand(command) !== null;

  if (!ours || opts.probe === false) {
    return { path: found.path, present: true, command, ours, silenced, upgradable, execution: null };
  }

  const outcome = probeSessionStartHookCommand(command, {
    timeoutMs: opts.timeoutMs,
    runner: opts.probe || undefined,
  });
  const verdict = classifyHookProbe(outcome);
  return { path: found.path, present: true, command, ours, silenced, upgradable, execution: verdict.execution, detail: verdict.detail };
}

/**
 * Classify what a broken probe means for the operator, now that the shipped
 * config.yaml declares the @harperfast/oauth block (flair#1136).
 *
 * Two states share the same "broken" probe outcome:
 *
 *   not-yet-exercised — the hook is wired in its current (silenced) form
 *     but the adapter hasn't been fetched yet.  On a fresh install this is
 *     NORMAL: the npx cache is cold and no Claude Code session has run.
 *     Report as informational, never a warning, and never suggest reinstall.
 *
 *   genuinely-broken — the hook is in its legacy (unsilenced) form AND the
 *     probe failed.  The hook has been in place long enough that a cold cache
 *     is not the explanation.  This IS a failure: warn and name the actual
 *     state with a fitting remedy.
 *
 * Pure — no fs, no network, no spawn.  The caller (cli.ts) decides how to
 * render each readiness level.
 */
export type HookReadiness = "runs" | "not-yet-exercised" | "genuinely-broken" | "unverified" | "absent" | "custom";

export function classifyHookReadiness(report: SessionStartHookCommandReport): HookReadiness {
  if (!report.present) return "absent";
  if (!report.ours) return "custom";
  if (report.execution === "runs") return "runs";
  if (report.execution === "broken") {
    return report.silenced ? "not-yet-exercised" : "genuinely-broken";
  }
  return "unverified";
}

/**
 * Rewrite an existing Flair-authored hook command to the current canonical
 * form, in place, preserving the agent id and URL the entry already carries —
 * so this never needs --agent and never re-points a hook at a different agent.
 *
 * Deliberately narrow: it refuses unless the registered command is the EXACT
 * unwrapped string Flair used to write. A hook the user hand-wrote or pinned
 * is theirs; doctor reports on it and leaves it alone. And it never REMOVES a
 * hook — an unresolvable command is an environment that changed, not a
 * decision to un-wire ambient memory, and `flair hook uninstall` is the
 * command for that when the user does decide.
 */
export function upgradeSessionStartHookCommand(homeDir: string): { ok: boolean; path: string; message: string; changed: boolean } {
  const path = join(homeDir, ".claude", "settings.json");
  try {
    const raw = readTextFile(path);
    if (!raw || !raw.trim()) return { ok: false, path, changed: false, message: `no ${path} to update` };
    const config = JSON.parse(raw);
    const groups = config?.hooks?.SessionStart;
    if (!Array.isArray(groups)) return { ok: false, path, changed: false, message: `no SessionStart hooks in ${path}` };

    for (const group of groups) {
      const hooks = group?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (typeof hook?.command !== "string" || !hook.command.includes(SESSION_START_HOOK_MARKER)) continue;
        // Already absorbing its own failures — nothing to repair, whether we
        // wrote it or the user did. Checked BEFORE the legacy match so a second
        // run is a clean no-op rather than "that isn't the command we wrote".
        if (hookCommandIsSilenced(hook.command)) {
          return { ok: true, path, changed: false, message: `SessionStart hook in ${path} is already current` };
        }
        const legacy = parseLegacySessionStartHookCommand(hook.command);
        if (!legacy) {
          return {
            ok: false,
            path,
            changed: false,
            message: `the SessionStart hook in ${path} is not the command Flair wrote — leaving it untouched`,
          };
        }
        const next = buildSessionStartHookCommand(legacy.agentId, legacy.flairUrl);
        if (next === hook.command) return { ok: true, path, changed: false, message: `SessionStart hook in ${path} is already current` };
        hook.command = next;
        writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
        return { ok: true, path, changed: true, message: `rewrote the SessionStart hook in ${path} so a failure to resolve stays silent` };
      }
    }
    return { ok: false, path, changed: false, message: `no Flair SessionStart hook found in ${path}` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, path, changed: false, message: `could not update ${path}: ${reason}` };
  }
}

// ── init integration: apply-or-report (flair#597) ──────────────────────────
//
// `flair init`'s claude-code wiring wrote the MCP server block into the
// client config but left the other two legs manual: the CLAUDE.md bootstrap
// line was only ever printed as a copy-paste hint, and the SessionStart hook
// wasn't mentioned by init at all. A field incident (2026-07-02 adopter
// retro) found real users with exactly those partial setups — MCP wired but
// no CLAUDE.md line, or no SessionStart hook — discovered only during an
// incident retrospective.
//
// These two functions are the shared "apply the fix, or (if skipped/failed)
// report exactly what's missing" logic `flair init` (src/cli.ts) calls for
// each leg, one call per leg, right after it wires the MCP block. Pure fs
// logic, parameterized by cwd/homeDir so it's unit-testable the same way as
// the rest of this module — no test ever touches the real environment.
//
// This mirrors init's existing MCP-block wiring shape: apply automatically
// by default (init already writes ~/.claude.json unprompted), with a
// --skip-<leg> flag as the opt-out — not doctor's TTY-gated confirmFix
// prompt, which is a different, appropriately heavier flow for "you already
// have a broken/partial setup, want me to fix it now" run after the fact.

export interface ApplyOrReportResult {
  /** True only when this call actually wrote a file (not "already present"). */
  applied: boolean;
  /** True when the leg ends in a good state — already present, or freshly fixed. */
  ok: boolean;
  /** Human-readable status line, e.g. for console.log. */
  message: string;
  /** Present only when skipped or the fix failed — exact copy-paste instructions. */
  hint?: string;
}

function indentLines(s: string): string {
  return s
    .split("\n")
    .map((l) => `     ${l}`)
    .join("\n");
}

/**
 * Apply-or-report for the CLAUDE.md bootstrap leg. Idempotent: a second call
 * after the line is present (whether from a prior call or already there)
 * reports ok:true, applied:false — safe to call on every `flair init`.
 */
export function applyOrReportClaudeMdBootstrap(cwd: string, homeDir: string, skip: boolean): ApplyOrReportResult {
  const existing = checkClaudeMdBootstrap(cwd, homeDir);
  if (existing.present) {
    return { applied: false, ok: true, message: `CLAUDE.md already has the bootstrap instruction (${existing.path})` };
  }

  const hint = `Add to your CLAUDE.md:\n${indentLines(CLAUDE_MD_BOOTSTRAP_LINE)}`;
  if (skip) {
    return { applied: false, ok: false, message: "CLAUDE.md bootstrap instruction skipped (--skip-claude-md)", hint };
  }

  const fix = fixClaudeMdBootstrap(cwd);
  return { applied: fix.ok, ok: fix.ok, message: fix.message, hint: fix.ok ? undefined : hint };
}

function sessionStartHookHint(agentId: string, path: string): string {
  const snippet = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: isHookCommandValueSafe(agentId)
                ? buildSessionStartHookCommand(agentId)
                : buildSessionStartHookCommand("me"),
            },
          ],
        },
      ],
    },
  };
  return `Add this to ${path}:\n${indentLines(JSON.stringify(snippet, null, 2))}`;
}

/**
 * Apply-or-report for the SessionStart hook leg. Idempotent: a second call
 * after the hook is present (whether from a prior call or already there)
 * reports ok:true, applied:false — safe to call on every `flair init`.
 */
export function applyOrReportSessionStartHook(homeDir: string, agentId: string, skip: boolean): ApplyOrReportResult {
  const existing = checkSessionStartHook(homeDir);
  if (existing.present) {
    return { applied: false, ok: true, message: `SessionStart hook already wired in ${existing.path}` };
  }

  const hint = sessionStartHookHint(agentId, existing.path);
  if (skip) {
    return { applied: false, ok: false, message: "SessionStart hook skipped (--skip-hook)", hint };
  }

  const fix = fixSessionStartHook(homeDir, agentId);
  return { applied: fix.ok, ok: fix.ok, message: fix.message, hint: fix.ok ? undefined : hint };
}

// ── check 5: per-agent iteration for verified-read sections (flair#722) ────
//
// `doctor`'s Fleet presence and Migrations sections need a signed (Ed25519)
// request to reveal server-verified fields (flairVersion/harperVersion,
// migration state) — previously that meant passing --agent explicitly, even
// though doctor already enumerates every key in ~/.flair/keys (the "Keys
// found: N agent(s)" line above). A real dogfood run found the #720
// halted-migration warning visible via `flair status --agent local` but
// invisible in the default `doctor` run the same user ran minutes later.
//
// These two functions are the pure decision logic for iterating and
// rendering per agent — no fs, no network, no crypto — so they're
// unit-testable the same way as the rest of this module. The actual signed
// fetches (which reuse authFetch/checkAgentRegistered, private to cli.ts)
// stay in src/cli.ts and call these to decide who to iterate and how a given
// agent's registration-gate outcome should render.

/**
 * Decide which agent ids the verified-read sections should iterate over.
 *   - `agentFlag` given -> exactly that one id (a plain filter — unchanged
 *     pre-#722 semantics: doctor still tries a single signed identity, it
 *     just doesn't widen to "every key"). Doesn't require the id to already
 *     have a key on disk; the registration gate reports "no local key" for
 *     that case rather than silently expanding the search.
 *   - no `agentFlag` -> every id in `keyAgentIds` (the ~/.flair/keys
 *     enumeration doctor's own "Keys found" check already did), sorted for
 *     deterministic, reproducible output across runs.
 */
export function planAgentIterations(keyAgentIds: string[], agentFlag: string | undefined): string[] {
  if (agentFlag) return [agentFlag];
  return [...keyAgentIds].sort();
}

// ── `doctor --fix` agent-id inference (flair#802b) ─────────────────────────
//
// `doctor` suggested `flair doctor --fix` to auto-wire an unconfigured MCP
// client, but running that exact command failed — "no agent id known — pass
// --agent <id>" — whenever the client had never been wired before (so there
// was no existing block to read an agent id from) and neither --agent nor
// FLAIR_AGENT_ID was set. The suggested fix didn't work as suggested. Two
// pure decisions fix that without adding any new network/crypto surface:
//
//   1. inferSoleAgentId — when exactly one locally-keyed agent exists (the
//      same keyAgentIds pool planAgentIterations already draws from, i.e.
//      doctor's own "Keys found" enumeration), --fix can use it without
//      being told: there's no other candidate it could mean. Two or more
//      keys, or zero, are genuinely ambiguous/unanswerable and still require
//      an explicit --agent (or registering one first) — this never guesses
//      in either of those cases.
//   2. fixCommandAgentHint — the *printed suggestion* (before --fix ever
//      runs) splices in a concrete `--agent <id>` so the command a user
//      copy-pastes actually works, using the first (sorted) known key id as
//      the example. Only relevant when the id isn't already resolvable some
//      other way (explicit --agent, FLAIR_AGENT_ID, or an id read off an
//      already-wired client) — the caller checks that before calling this.

/**
 * The one case `doctor --fix` can safely infer an agent id without being
 * told: exactly one locally-keyed agent. Zero keys (nothing to infer) or two
 * or more (genuinely ambiguous — which one?) both return undefined; the
 * caller must fall back to an explicit error telling the user what to do
 * (register one, or pass --agent).
 */
export function inferSoleAgentId(keyAgentIds: string[]): string | undefined {
  return keyAgentIds.length === 1 ? keyAgentIds[0] : undefined;
}

/**
 * Build the ` --agent <id>` fragment to splice into a suggested
 * `flair doctor --fix ...` command so the printed suggestion is actually
 * copy-pasteable rather than guaranteed to fail the moment nothing else
 * (explicit --agent, FLAIR_AGENT_ID, an already-wired client's agent id) can
 * supply one. Uses the first (sorted) known local key id as a concrete
 * example. Returns "" when no agent id is known at all — the caller should
 * tell the user to register one first rather than print a `--fix` suggestion
 * that has nothing to work with either way.
 */
export function fixCommandAgentHint(keyAgentIds: string[]): string {
  if (keyAgentIds.length === 0) return "";
  return ` --agent ${[...keyAgentIds].sort()[0]}`;
}

/** checkAgentRegistered's (src/cli.ts) result states — duplicated here as a
 *  type only (no import) to keep this module network/crypto-free.
 *
 *  "key-unreadable" (flair#1023) is deliberately its own member rather than a
 *  flavour of "unreachable": the two have opposite locations (their disk vs
 *  the network), opposite remedies, and — because signing precedes the
 *  request — are never ambiguous at the point they are raised. */
export type AgentGateState = "registered" | "not-registered" | "unreachable" | "no-key" | "key-unreadable";

/** Why verifySemanticSearch (src/cli.ts) returned `skipped` — duplicated here
 *  as a type only (no import), same convention as AgentGateState. */
export type SemanticSkipReason = "no-agent" | "no-key" | "key-load" | "probe-failed";

/**
 * The remedy line to print under doctor's "Embeddings: not verified" warning,
 * or null when no remedy applies (flair#1023 requirement 4).
 *
 * doctor used to print "Pass --agent <id> ..." for EVERY skip reason. That
 * sentence only fixes the two cases where no agent identity was resolved. It
 * cannot fix a key that will not decode — following it produces the identical
 * error — and it cannot fix an HTTP failure from the probe itself. Printing a
 * remedy that provably will not change the outcome spends the operator's time
 * and is worse than printing nothing, so those cases now print nothing.
 */
export function embeddingsSkipRemedy(reason: SemanticSkipReason): string | null {
  switch (reason) {
    case "no-agent":
    case "no-key":
      return "Pass --agent <id> (or set FLAIR_AGENT_ID) so doctor can run a real semantic round-trip.";
    case "key-load":
    case "probe-failed":
      return null;
  }
}

/** AgentGateState minus "unreachable", for the parts of the surface (like
 *  classifyKeyFile below) that only ever see it once instance reachability
 *  is already settled — a caller that has confirmed the instance IS
 *  reachable never has "unreachable" left to hand back here. */
export type PruneRegistrationState = "registered" | "not-registered" | "no-key";

export interface AgentGateFinding {
  icon: "warn" | "error";
  message: string;
  fixHint?: string;
  /** Whether this finding counts toward doctor's found/fixed/remaining
   *  summary (flair#721). True only for the actionable "not-registered"
   *  state — fixable either by registering (`flair agent add <id>`) or, if
   *  the key is a stale/leftover test artifact instead, by removing it
   *  (`flair keys prune`, flair#734) — a transient or missing-key finding is
   *  surfaced but not counted, matching how doctor already treats "could not
   *  verify agent registration" elsewhere (Client integration section) — no
   *  --fix action exists for either non-issue case. */
  isIssue: boolean;
}

/**
 * What the run has already established about the instance, at the moment this
 * finding is rendered (flair#1023).
 *
 * `instanceReachable: true` means an earlier check in the SAME run got a
 * response — the state doctor is in whenever it reaches the agent gates at
 * all, since it only enumerates agents when Harper answered. Passing it makes
 * the contradiction in flair#1023 unrepresentable rather than merely fixed:
 * no arrangement of inputs can produce a message claiming the instance is
 * unreachable underneath a tick saying it responded.
 */
export interface RunReachability {
  instanceReachable?: boolean;
}

/**
 * Render decision for one agent's registration-gate outcome, ahead of a
 * verified-read section (Fleet presence / Migrations). Returns null when the
 * agent is registered — the caller should proceed with its actual signed
 * read for that agent. Otherwise returns the finding to print for THAT
 * agent's subsection; the caller must still move on to the next agent
 * (failure isolation, flair#722) rather than aborting the whole section.
 */
export function describeAgentGateFinding(
  agentId: string,
  state: AgentGateState,
  detail?: string,
  reachability?: RunReachability,
): AgentGateFinding | null {
  // Self-inconsistency guard. "unreachable" is a legitimate state — a bare
  // 500, a timeout — but it must never be ASSERTED after this run has already
  // watched the instance answer. When it is, report the honest thing: the
  // check failed, and we know it was not connectivity.
  if (state === "unreachable" && reachability?.instanceReachable === true) {
    // Strip the caller's own "instance unreachable:" prefix before quoting the
    // detail — that prefix IS the claim being disclaimed, and leaving it in
    // would reassert it in the same sentence that denies it.
    const raw = detail?.replace(/^instance unreachable:\s*/i, "").trim();
    return {
      icon: "warn",
      message:
        `could not verify agent '${agentId}' registration — the instance responded to this run, ` +
        `so this is not a connectivity problem${raw ? ` (${raw})` : ""}`,
      isIssue: false,
    };
  }
  switch (state) {
    case "registered":
      return null;
    case "key-unreadable":
      return {
        icon: "warn",
        // Names the file and the operation. No cause is invented and no fix
        // hint is offered: the failure classes that land here (a corrupt key,
        // a file that is not an agent key at all) have different remedies and
        // we cannot tell them apart from the bytes. A remedy we cannot stand
        // behind is the flair#1023 defect, not a fix for it.
        message: `could not verify agent '${agentId}' registration — ${detail ?? "its signing key could not be loaded"}`,
        isIssue: false,
      };
    case "no-key":
      return {
        icon: "warn",
        message: `no local key for '${agentId}' — skipping${detail ? ` (${detail})` : ""}`,
        isIssue: false,
      };
    case "not-registered":
      return {
        icon: "error",
        message: `agent '${agentId}' has a local key but is NOT registered on this Flair instance`,
        // Two ways out, both actionable — register it if it should exist, or
        // (flair#734) clean it up if it's a stale/leftover key. `flair keys
        // prune` never touches a key that IS registered, so it's always a
        // safe suggestion here even when the right fix is actually `agent add`.
        fixHint: `flair agent add ${agentId} (if it should be registered) — or flair keys prune (if it's a stale/leftover key)`,
        isIssue: true,
      };
    case "unreachable":
      return {
        icon: "warn",
        message: `could not verify agent '${agentId}' registration${detail ? ` (${detail})` : ""}`,
        isIssue: false,
      };
  }
}

// ── check 6: `flair keys prune` classification (flair#734) ─────────────────
//
// Follow-up to #731's doctor agent-iteration, which made previously-invisible
// stale keys visible (each renders as a "not registered" gate finding, check
// 5 above) but shipped no command to act on it — every doctor run just
// re-reported the same noise. `flair keys prune` (src/cli.ts) walks the key
// dir and moves anything it can positively classify as prunable into
// `<keysDir>/.pruned/<date>/` — never deletes. The network-dependent half
// (is this agentId actually registered?) reuses checkAgentRegistered
// (src/cli.ts), the exact same signed GET /Agent/:id check 5's gate uses.
// This module only owns the PURE decision — given a file's seed-validity and
// (if checked) registration state, what class is it and why — plus two
// path/naming helpers pure enough to live here (no crypto, no network).

/** Name of the archive subdirectory prune moves prunable files into —
 *  `<keysDir>/.pruned/<date>/`. Also the one directory name the scanner
 *  itself must skip when walking the key dir (never re-classify prune's own
 *  archive as a candidate). */
export const PRUNED_DIR_NAME = ".pruned";

/** `YYYY-MM-DD`, UTC — the `<date>` component of the archive path. UTC (not
 *  local time) so a single prune run always lands in exactly one date
 *  bucket regardless of the host's timezone. */
export function pruneDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Pick a collision-free destination filename for a move into an archive
 * directory that may already hold a file of the same name (e.g. two prune
 * runs on the same UTC day). Preserves the original name whenever possible;
 * on collision appends `.2`, `.3`, ... until free. Pure — the caller supplies
 * the set of names already present (or about to be present, within the same
 * run) at the destination; no fs access happens here.
 */
export function resolveCollisionSafeName(existingNames: Iterable<string>, filename: string): string {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames);
  if (!existing.has(filename)) return filename;
  let n = 2;
  while (existing.has(`${filename}.${n}`)) n++;
  return `${filename}.${n}`;
}

export type KeyPruneClass = "keep" | "stale" | "invalid" | "unidentified" | "ignored";

export interface KeyPruneDecision {
  class: KeyPruneClass;
  /** Human-readable reason — rendered next to the filename in prune's report. */
  reason: string;
}

/**
 * Classify one `.key` file given whether its seed parsed (`seedValid`) and,
 * if it did, the registration-gate result checkAgentRegistered (src/cli.ts)
 * returned for it — the SAME check doctor's "not registered" finding above
 * is built from. Pure — no fs/crypto/network; the caller (classifyKeysDir,
 * src/cli.ts) does the actual file read, seed parse, and signed registration
 * check, and only calls this to decide what the result means.
 *
 * `registration` is ignored (pass null) when `seedValid` is false — an
 * unparseable seed can't be signed with, so it was never checked against the
 * instance, regardless of what agentId its filename implies.
 *
 * Deliberately has no case for "unreachable": classifyKeysDir aborts the
 * WHOLE run before classifying anything once the instance is confirmed
 * unreachable (never classify offline) — this function is only ever called
 * once that's already been ruled out.
 */
export function classifyKeyFile(
  agentId: string,
  seedValid: boolean,
  registration: { state: PruneRegistrationState; detail?: string } | null,
  baseUrl: string,
): KeyPruneDecision {
  if (!seedValid) {
    // NOT "invalid", and therefore NOT prunable. "I could not parse this" and
    // "this is a stale agent key" are different findings, and only the second
    // is safe to act on. `~/.flair/keys/<id>.key` is a namespace shared by two
    // writers: plaintext Ed25519 seeds, and AES-256-GCM keystore blobs written
    // by FileKeyStore (flair#1026). A keystore blob is unparseable AS A SEED
    // while being a LIVE federation key — classifying it "invalid" moved a key
    // that was in use. An unidentified file is reported for a human and left
    // exactly where it is.
    return {
      class: "unidentified",
      reason:
        "not a parseable Ed25519 private key seed — may be a keystore blob or another format; " +
        "left in place, inspect it before removing anything (flair#1026)",
    };
  }
  if (registration?.state === "registered") {
    return { class: "keep", reason: `agent '${agentId}' is registered on ${baseUrl} — never pruned` };
  }
  // "not-registered", "no-key", or (defensively) no registration result at
  // all — every one of those means we could not confirm this agent is
  // registered, so it's prunable. "no-key" is not expected in practice here
  // (the file we just parsed a valid seed FROM is itself the key
  // checkAgentRegistered would sign with), but is handled the same way
  // rather than left as an unclassified gap.
  return {
    class: "stale",
    reason: `agent '${agentId}' is not registered on ${baseUrl}${registration?.detail ? ` (${registration.detail})` : ""}`,
  };
}
