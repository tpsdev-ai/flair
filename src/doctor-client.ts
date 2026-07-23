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
 *  type only (no import) to keep this module network/crypto-free. */
export type AgentGateState = "registered" | "not-registered" | "unreachable" | "no-key";

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
 * Render decision for one agent's registration-gate outcome, ahead of a
 * verified-read section (Fleet presence / Migrations). Returns null when the
 * agent is registered — the caller should proceed with its actual signed
 * read for that agent. Otherwise returns the finding to print for THAT
 * agent's subsection; the caller must still move on to the next agent
 * (failure isolation, flair#722) rather than aborting the whole section.
 */
export function describeAgentGateFinding(agentId: string, state: AgentGateState, detail?: string): AgentGateFinding | null {
  switch (state) {
    case "registered":
      return null;
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

export type KeyPruneClass = "keep" | "stale" | "invalid" | "ignored";

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
    return { class: "invalid", reason: "not a parseable Ed25519 private key seed" };
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
