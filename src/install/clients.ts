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
  detected: boolean;
  wire: (env: WireEnv) => { ok: boolean; message: string };
}

// ---- Detection helpers ----------------------------------------------------------

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

function claudeCodeDetect(): boolean {
  try {
    const result = spawnSync("npm", ["list", "-g", "@anthropic-ai/claude-code"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch (_e: unknown) {
    return false;
  }
}

function codexDetect(): boolean {
  try {
    if (binInPath("codex")) return true;
    const npmResult = spawnSync("npm", ["list", "-g", "@openai/codex"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return npmResult.status === 0;
  } catch (_e: unknown) {
    return false;
  }
}

function geminiDetect(): boolean {
  try {
    if (binInPath("gemini")) return true;
    const npmResult = spawnSync("npm", ["list", "-g", "@google/generative-ai"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return npmResult.status === 0;
  } catch (_e: unknown) {
    return false;
  }
}

function cursorDetect(): boolean {
  try {
    return binInPath("cursor");
  } catch (_e: unknown) {
    return false;
  }
}

// ---- Shared config shapes -------------------------------------------------------

/** The standard MCP stdio server entry every client (except Codex TOML) uses. */
function flairMcpEntry(env: WireEnv) {
  return {
    command: "npx",
    args: ["-y", "@tpsdev-ai/flair-mcp"],
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
 * (flair#727 — asserts the rendered template carries a full scheme+port URL). */
export function tomlSnippet(env: WireEnv): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "@tpsdev-ai/flair-mcp"]`,
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
    if (existing && existing.env?.FLAIR_URL === env.FLAIR_URL && existing.env?.FLAIR_AGENT_ID === env.FLAIR_AGENT_ID) {
      return { ok: true, message: `${label}: already wired in ${display}` };
    }
    config.mcpServers.flair = flairMcpEntry(env);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return { ok: true, message: `${label}: wired ${display} (restart ${label} to pick it up)` };
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
  // unwritable (permissions, I/O error), never merely "exists". A file that
  // already has the section is reported already-wired, matching the JSON
  // clients' idempotency (wireJsonMcp above).
  const path = codexConfigPath();
  const display = "~/.codex/config.toml";
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      if (codexConfigHasFlairSection(raw)) {
        return { ok: true, message: `Codex: already wired in ${display}` };
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
    wire: _wireClaudeCode,
  },
  {
    id: "codex",
    label: "Codex",
    wire: _wireCodex,
  },
  {
    id: "gemini",
    label: "Gemini",
    wire: _wireGemini,
  },
  {
    id: "cursor",
    label: "Cursor",
    wire: _wireCursor,
  },
];

export function detectClients(): Client[] {
  return ALL_CLIENTS.map((client) => ({
    ...client,
    detected:
      client.id === "claude-code"
        ? claudeCodeDetect()
        : client.id === "codex"
          ? codexDetect()
          : client.id === "gemini"
            ? geminiDetect()
            : client.id === "cursor"
              ? cursorDetect()
              : false,
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
