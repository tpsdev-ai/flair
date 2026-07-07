// ─── Doctor: client integration checks (flair#588) ──────────────────────────────
//
// `flair doctor` diagnosed the SERVER side only (Harper port, keys, config,
// embeddings, data dir). It had zero visibility into whether the CLIENT
// integration — the MCP wiring an agent like Claude Code actually uses — is
// working. A real incident found users with partial setups (MCP block wired
// but no CLAUDE.md line; or no SessionStart hook) that silently no-op, with
// no way to tell "is Flair working for my agent?" short of an incident.
//
// This module is pure filesystem logic (no network, no crypto) so it's fast
// and fully unit-testable in isolation — mirrors test/unit/client-wiring.test.ts's
// technique of overriding process.env.HOME to a temp dir. The two
// network-dependent checks (reachability + agent registration) live in
// src/cli.ts alongside authFetch/resolveKeyPath, which they reuse.
//
// Every read here is try/catch-wrapped: a missing or malformed config file is
// "not present", never a thrown error — doctor must never crash or hang on a
// broken client config.

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
          return { present: true, path };
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
          command: `FLAIR_AGENT_ID=${agentId} npx -y @tpsdev-ai/flair-mcp flair-session-start`,
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
              command: `FLAIR_AGENT_ID=${agentId} npx -y @tpsdev-ai/flair-mcp flair-session-start`,
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
