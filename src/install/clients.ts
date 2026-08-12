// ─── Client Detection & Wiring ──────────────────────────────────────────────────────
//
// Detects locally installed MCP clients and wires them to Flair.
// Each client has:
//   - detect(): boolean - returns true if client is installed
//   - wire(options: { agentId: string; flairUrl: string }): { ok: boolean; message: string }
//
// Wiring contract (FIX 4 — onboarding dogfood round 1):
//   "wired" MUST mean a config file was actually written. A wire function returns
//   { ok: true } ONLY when it merged the Flair MCP server into the client's real
//   config file. If it cannot (unknown path, write error), it returns
//   { ok: false } with the correct per-OS snippet to paste — never a vague
//   "manual wiring required" while elsewhere the run claims the client is wired.
//   All paths are resolved cross-platform (Linux included) via standard
//   per-client locations under $HOME / $XDG_CONFIG_HOME.

export type ClientId = "claude-code" | "codex" | "gemini" | "cursor";

/**
 * The env block every wire function writes into a client's MCP server config.
 * `FLAIR_CLIENT` (flair#718 authorship-provenance) is OPTIONAL and additive —
 * when the caller sets it (flair init's per-client wiring sets it to the
 * client's own id, e.g. "codex"), the written env block records WHICH CLIENT
 * this config wires, so writes forwarded through it stamp
 * `provenance.claimed.client` server-side (resources/provenance.ts). Absent
 * entirely on an un-set call = omitted from the written config, byte-for-byte
 * the same output as before this field existed (flair doctor's --fix
 * re-wiring path deliberately does not set it — out of scope for this slice).
 */
export type WireEnv = { FLAIR_AGENT_ID: string; FLAIR_URL: string; FLAIR_CLIENT?: string };

export interface Client {
  id: ClientId;
  label: string;
  /** The executable that has to be on PATH for this client to be usable. */
  bin: string;
  detected: boolean;
  wire: (env: WireEnv) => { ok: boolean; message: string };
}

// ---- Detection helpers ----------------------------------------------------------

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mcpServerSpec } from "../lib/mcp-spec.js";

/**
 * Resolve the user's home dir. Prefer the live HOME/USERPROFILE env over
 * os.homedir(), which caches the value at process start and so ignores a
 * runtime HOME override — same convention as src/cli.ts ("so tests can
 * override"). Production behavior is unchanged (HOME is set on every OS).
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Check if a command exists in PATH (cross-platform alternative to `which`).
 * Does not spawn a child process — pure filesystem check.
 */
function binInPath(name: string): boolean {
  try {
    const sep = process.platform === "win32" ? ";" : ":";
    const dirs = (process.env.PATH || "").split(sep);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [];
    for (const dir of dirs) {
      if (!dir) continue;
      const base = `${dir}/${name}`;
      try { accessSync(base, constants.X_OK); return true; } catch { /* not here */ }
      for (const ext of exts) {
        try { accessSync(`${base}${ext}`, constants.X_OK); return true; } catch { /* not here */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * A client is INSTALLED when its executable is on PATH. One rule for all four,
 * evaluated with filesystem calls only — detection never starts a subprocess.
 *
 * Claude Code, Codex and Gemini used to fall back to `npm list -g <pkg>` when
 * the binary was absent. That fallback was removed (flair#906 follow-up); it
 * was wrong in three separate directions and bought nothing:
 *
 *   1. UNBOUNDED AND SLOW ON AN INTERACTIVE PATH. `npm list -g <pkg>` walks the
 *      whole global tree, measured at ~0.8 s per call on a warm developer
 *      machine, with no `timeout` set. `flair init` calls detectClients(), so a
 *      user with none of these clients paid up to three of those walks — seconds
 *      of silent stall on first run — and on a loaded CI runner the same three
 *      calls blew past a 5 s test timeout.
 *
 *   2. FALSE POSITIVES. `npm list -g <pkg>` exits 0 when the package appears
 *      ANYWHERE in the global tree, including as a transitive dependency of an
 *      unrelated global package. Gemini was probed with `@google/generative-ai`
 *      — a library, not the CLI — so any globally installed tool that depended
 *      on it made Flair report Gemini "detected" and write ~/.gemini/settings.json
 *      for a CLI that was not on the machine.
 *
 *   3. FALSE NEGATIVES. It assumes npm's default global prefix, so it reports
 *      "not installed" for mise / fnm / nvm / volta users whose prefix lives
 *      elsewhere — the same defect already fixed for `flair upgrade`'s presence
 *      probes (see "Upgrade presence probes" in src/cli.ts).
 *
 * Nothing is lost by dropping it: an `npm install -g` links the package's bin
 * into the prefix's bin directory, which is on PATH by construction (it is where
 * `npm` itself is found from). A client whose binary is NOT on PATH is a client
 * the user cannot launch, and wiring an MCP config for it is at best a no-op.
 * `flair init --client <name>` still wires a client explicitly, bypassing
 * detection entirely, so an exotic install is never locked out.
 */
function detectBin(bin: string): boolean {
  try {
    return binInPath(bin);
  } catch (_e: unknown) {
    return false;
  }
}

// ---- Shared config shapes -------------------------------------------------------

/**
 * The standard MCP stdio server entry every client (except Codex TOML) uses.
 *
 * The spec comes from mcpServerSpec() and is therefore PINNED — this used to
 * hardcode the bare `@tpsdev-ai/flair-mcp`, so Gemini, Cursor and the Claude
 * Code array fallback were all wired unpinned while only the inline Claude
 * Code path in cli.ts got the pin it was documented to get (flair#907).
 */
function flairMcpEntry(env: WireEnv) {
  return {
    command: "npx",
    args: ["-y", mcpServerSpec()],
    env: {
      FLAIR_AGENT_ID: env.FLAIR_AGENT_ID,
      FLAIR_URL: env.FLAIR_URL,
      // flair#718 — only present when the caller set it; absent = omitted,
      // not written as FLAIR_CLIENT: undefined.
      ...(env.FLAIR_CLIENT ? { FLAIR_CLIENT: env.FLAIR_CLIENT } : {}),
    },
  };
}

/** Pretty-printed JSON `mcpServers.flair` snippet for copy-paste fallbacks. */
function jsonSnippet(env: WireEnv): string {
  return JSON.stringify({ mcpServers: { flair: flairMcpEntry(env) } }, null, 2);
}

/** TOML `[mcp_servers.flair]` snippet (Codex format). Exported for tests
 * (flair#727 — asserts the rendered template carries a full scheme+port URL).
 * Pinned via mcpServerSpec() — see flairMcpEntry above for why (flair#907). */
export function tomlSnippet(env: WireEnv): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${mcpServerSpec()}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${env.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${env.FLAIR_URL}"`,
    // flair#718 — only present when the caller set it (same rule as flairMcpEntry above).
    ...(env.FLAIR_CLIENT ? [`FLAIR_CLIENT = "${env.FLAIR_CLIENT}"`] : []),
  ].join("\n");
}

/**
 * True when `raw` TOML content already has a `[mcp_servers.flair]` header —
 * the same detection scanCodexFlairBlock (src/doctor-client.ts) uses to
 * decide whether the block is present. Pure string scan; no TOML parser
 * (see the comment on _wireCodex below for why).
 */
export function codexConfigHasFlairSection(raw: string): boolean {
  return /^\[mcp_servers\.flair\]\s*$/m.test(raw);
}

/**
 * Pure merge: append the Flair TOML snippet to existing raw config.toml
 * content. Callers MUST first confirm codexConfigHasFlairSection(raw) is
 * false — appending a second `[mcp_servers.flair]` table would shadow/
 * duplicate the first (TOML doesn't merge repeated table headers), so this
 * function does not re-check; it just appends safely with a newline
 * separator (mirrors fixClaudeMdBootstrap's separator logic in
 * src/doctor-client.ts — never runs the new block into the prior line).
 */
export function appendCodexFlairBlock(raw: string, env: WireEnv): string {
  const separator = raw.length === 0 ? "" : raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + separator + tomlSnippet(env) + "\n";
}

/**
 * flair#1135: does the existing `[mcp_servers.flair]` TOML section carry the
 * CURRENT pinned mcpServerSpec()? Pure string scan — no TOML parser needed
 * (same rationale as codexConfigHasFlairSection).
 */
function codexFlairSectionHasCurrentPin(raw: string): boolean {
  const idx = raw.indexOf("[mcp_servers.flair]");
  if (idx === -1) return false;
  const after = raw.slice(idx);
  // Find the end of the section: the next top-level [header] that is NOT a
  // sub-table of mcp_servers.flair (e.g. [mcp_servers.flair.env] is part of
  // the same logical section and must not terminate the scan).
  const nextHeader = after.slice("[mcp_servers.flair]".length).search(/\n\[(?!mcp_servers\.flair\.)/);
  const section = nextHeader === -1 ? after : after.slice(0, "[mcp_servers.flair]".length + nextHeader);
  return section.includes(mcpServerSpec());
}

/**
 * flair#1135: replace the existing `[mcp_servers.flair]` TOML section with a
 * fresh one carrying the current pin. Preserves everything else in the file.
 */
function replaceCodexFlairBlock(raw: string, env: WireEnv): string {
  const idx = raw.indexOf("[mcp_servers.flair]");
  if (idx === -1) return appendCodexFlairBlock(raw, env);
  const before = raw.slice(0, idx);
  const after = raw.slice(idx);
  const nextHeader = after.slice("[mcp_servers.flair]".length).search(/\n\[(?!mcp_servers\.flair\.)/);
  const rest = nextHeader === -1 ? "" : after.slice("[mcp_servers.flair]".length + nextHeader);
  const newBlock = tomlSnippet(env) + "\n";
  // Preserve the separator between the new block and whatever follows.
  const sep = rest.length === 0 ? "" : rest.startsWith("\n") ? "" : "\n";
  return before + newBlock + sep + rest;
}

/**
 * Merge the Flair MCP server into a JSON config file with an `mcpServers` map.
 * Creates the file (and parent dir) if absent; preserves existing servers and
 * any other top-level keys. Returns ok:true only when the file was written.
 */
function wireJsonMcp(
  configPath: string,
  label: string,
  env: WireEnv,
): { ok: boolean; message: string } {
  const home = resolveHome();
  const display = configPath.startsWith(home) ? "~" + configPath.slice(home.length) : configPath;
  try {
    let config: any = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8").trim();
      if (raw) config = JSON.parse(raw);
    }
    config.mcpServers = config.mcpServers || {};
    const existing = config.mcpServers.flair;
    const currentSpec = mcpServerSpec();
    const existingArgs = existing?.args;
    const argsMatch = Array.isArray(existingArgs) && existingArgs.includes(currentSpec);
    const urlAgentMatch = existing && existing.env?.FLAIR_URL === env.FLAIR_URL && existing.env?.FLAIR_AGENT_ID === env.FLAIR_AGENT_ID;
    // flair#1135: the pin in `args` must match the current mcpServerSpec().
    // A matching pin stays a no-op (idempotent); only a stale pin triggers a re-write.
    if (urlAgentMatch && argsMatch) {
      return { ok: true, message: `${label}: already wired in ${display}` };
    }
    config.mcpServers.flair = flairMcpEntry(env);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const action = urlAgentMatch ? "refreshed pin in" : "wired";
    return { ok: true, message: `${label}: ${action} ${display} (restart ${label} to pick it up)` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `${label}: manual wiring needed (could not write ${display}: ${reason}).\n` +
        `   Add this to ${display}:\n${indent(jsonSnippet(env))}`,
    };
  }
}

function indent(s: string): string {
  return s.split("\n").map((l) => `     ${l}`).join("\n");
}

// ---- Per-client config paths (cross-platform, Linux included) --------------------

/** Cursor: ~/.cursor/mcp.json on every OS. */
function cursorConfigPath(): string {
  return join(resolveHome(), ".cursor", "mcp.json");
}

/** Gemini CLI: ~/.gemini/settings.json on every OS. */
function geminiConfigPath(): string {
  return join(resolveHome(), ".gemini", "settings.json");
}

/** Codex CLI: ~/.codex/config.toml on every OS. */
function codexConfigPath(): string {
  return join(resolveHome(), ".codex", "config.toml");
}

/**
 * Single dispatcher for "where does this client's MCP config live" — used by
 * `flair doctor`'s client-integration checks (flair#588) to read the config
 * without duplicating the per-client path logic that already lives here.
 * Additive only: does not change existing wire/detect behavior.
 */
export function clientConfigPath(id: ClientId): string {
  switch (id) {
    case "claude-code":
      return join(resolveHome(), ".claude.json");
    case "codex":
      return codexConfigPath();
    case "gemini":
      return geminiConfigPath();
    case "cursor":
      return cursorConfigPath();
  }
}

// ---- Internal wiring functions --------------------------------------------------
//
// Claude Code wiring lives inline in src/cli.ts (it writes ~/.claude.json, the
// one client the CLI safely edits, cross-platform). _wireClaudeCode here is the
// fallback used when something calls the array form; it returns the snippet for
// ~/.claude.json so the message is unambiguous and correct on every OS.

function _wireClaudeCode(env: WireEnv): { ok: boolean; message: string } {
  // The real auto-wire is inline in cli.ts. If reached via the array, point at
  // the correct cross-platform path (~/.claude.json — same on macOS/Linux/Win)
  // and give the exact snippet. Never emit macOS-only paths here.
  return wireJsonMcp(join(resolveHome(), ".claude.json"), "Claude Code", env);
}

function _wireCodex(env: WireEnv): { ok: boolean; message: string } {
  // Codex uses TOML with a [mcp_servers.flair] table. We don't carry a TOML
  // parser, but appending a new top-level table at EOF is safe TOML when the
  // exact header isn't already present (flair#727) — so an existing file only
  // forces the manual-print fallback when it's genuinely unreadable/
  // unwritable (permissions, I/O error), never merely "exists".
  //
  // flair#1135: the "already wired" check is now version-aware — a section
  // with a stale pin triggers a re-write instead of a no-op.
  const path = codexConfigPath();
  const display = "~/.codex/config.toml";
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      if (codexFlairSectionHasCurrentPin(raw)) {
        return { ok: true, message: `Codex: already wired in ${display}` };
      }
      if (codexConfigHasFlairSection(raw)) {
        // Section exists but pin is stale — replace it.
        writeFileSync(path, replaceCodexFlairBlock(raw, env));
        return { ok: true, message: `Codex: refreshed pin in ${display} (restart Codex to pick it up)` };
      }
      writeFileSync(path, appendCodexFlairBlock(raw, env));
      return { ok: true, message: `Codex: wired ${display} (restart Codex to pick it up)` };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tomlSnippet(env) + "\n");
    return { ok: true, message: `Codex: wired ${display} (restart Codex to pick it up)` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Codex: manual wiring needed (could not write ${display}: ${reason}).\n` +
        `   Add this block to ${display}:\n${indent(tomlSnippet(env))}`,
    };
  }
}

function _wireGemini(env: WireEnv): { ok: boolean; message: string } {
  return wireJsonMcp(geminiConfigPath(), "Gemini", env);
}

function _wireCursor(env: WireEnv): { ok: boolean; message: string } {
  return wireJsonMcp(cursorConfigPath(), "Cursor", env);
}

// ---- Exported detection & wiring array ------------------------------------------

export const ALL_CLIENTS: Omit<Client, "detected">[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    wire: _wireClaudeCode,
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    wire: _wireCodex,
  },
  {
    id: "gemini",
    label: "Gemini",
    bin: "gemini",
    wire: _wireGemini,
  },
  {
    id: "cursor",
    label: "Cursor",
    bin: "cursor",
    wire: _wireCursor,
  },
];

// ---- End-of-run wiring summary (flair#906) --------------------------------

/** One client's outcome. `wired` means a config file was actually written. */
export interface WiringOutcome {
  client: string;
  message: string;
  wired: boolean;
}

/** A summary line, tagged with severity so the caller owns icon/colour. */
export interface SummaryLine {
  level: "heading" | "ok" | "error" | "warn" | "muted";
  text: string;
}

/**
 * The summary `flair init` prints LAST.
 *
 * Every fact here was already available mid-run — `wiringResults` has always
 * distinguished "wired ~/.claude.json" from "snippet printed (no
 * ~/.claude.json)". What was missing is a place where the difference is still
 * on screen once the command finishes: a not-wired client showed up only as a
 * snippet in the middle of a wall of output, *after* a success line, so
 * `--client all` read as having done all of it (flair#906). Pure so it can be
 * tested without running init.
 */
export function renderWiringSummary(
  results: WiringOutcome[],
  opts: {
    labels?: Map<string, string>;
    /** Clients `--client all` passed over because they aren't installed. */
    skippedUndetected?: string[];
    /** Command to suggest when nothing at all got wired. */
    rewireHint?: string;
    /** True when the written spec could not be pinned (flair#907). */
    unpinned?: boolean;
  } = {},
): SummaryLine[] {
  const label = (id: string) => opts.labels?.get(id) ?? id;
  const skipped = opts.skippedUndetected ?? [];
  const wired = results.filter(r => r.wired);
  const notWired = results.filter(r => !r.wired);

  if (results.length === 0 && skipped.length === 0) return [];

  const lines: SummaryLine[] = [{ level: "heading", text: "MCP clients" }];

  if (wired.length > 0) {
    lines.push({ level: "ok", text: `Wired: ${wired.map(r => label(r.client)).join(", ")}` });
  }
  // One line per NOT-wired client, naming the client and why — a count alone
  // ("1 client failed") sends the user back to scrollback to find which.
  for (const r of notWired) {
    lines.push({ level: "error", text: `NOT wired: ${label(r.client)} — ${r.message}` });
  }
  if (skipped.length > 0) {
    lines.push({ level: "muted", text: `Not installed, skipped: ${skipped.join(", ")}` });
  }
  if (wired.length === 0 && notWired.length === 0) {
    lines.push({
      level: "warn",
      text: opts.rewireHint
        ? `No MCP client was wired. Install a client, then re-run: ${opts.rewireHint}`
        : "No MCP client was wired.",
    });
  }
  if (notWired.length > 0) {
    lines.push({
      level: "warn",
      text: `${notWired.length} client(s) need manual wiring — see the config printed above, or docs/mcp-clients.md`,
    });
  }
  if (opts.unpinned) {
    lines.push({
      level: "warn",
      text: "MCP server wired UNPINNED (Flair could not read its own version) — see the warning above.",
    });
  }
  return lines;
}

/**
 * Detect every known client. One rule (`bin` on PATH) applied uniformly, so a
 * client added to ALL_CLIENTS is detected by declaring its executable — there is
 * no per-client branch here to forget to extend.
 */
export function detectClients(): Client[] {
  return ALL_CLIENTS.map((client) => ({
    ...client,
    detected: detectBin(client.bin),
  }));
}

export function wireClaudeCode(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireClaudeCode(env);
}

export function wireCodex(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireCodex(env);
}

export function wireGemini(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireGemini(env);
}

export function wireCursor(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireCursor(env);
}
