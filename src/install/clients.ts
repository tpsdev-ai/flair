// ─── Client Detection & Wiring ──────────────────────────────────────────────────────
//
// Detects locally installed MCP clients and wires them to Flair.
// Each client has:
//   - detect(): boolean - returns true if client is installed
//   - wire(options: { agentId: string; flairUrl: string }): { ok: boolean; message: string }
//

export type ClientId = "claude-code" | "codex" | "gemini" | "cursor";

export interface Client {
  id: ClientId;
  label: string;
  detected: boolean;
  wire: (env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }) => { ok: boolean; message: string };
}

// ---- Detection helpers ----------------------------------------------------------

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

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

// ---- Internal wiring functions --------------------------------------------------

function _wireClaudeCode(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  return {
    ok: false,
    message: `Manual wiring required for Claude Code:\n` +
             `1. Locate Claude Code's settings file (usually ~/Library/Application Support/Claude/settings.json on macOS or %APPDATA%/Claude/settings.json on Windows)\n` +
             `2. Add or update the "mcpServers" section:\n` +
             `   {\n` +
             `     "mcpServers": {\n` +
             `       "flair": {\n` +
             `         "command": "npx",\n` +
             `         "args": ["-y", "@tpsdev-ai/flair-mcp"],\n` +
             `         "env": {\n` +
             `           "FLAIR_AGENT_ID": "${env.FLAIR_AGENT_ID}",\n` +
             `           "FLAIR_URL": "${env.FLAIR_URL}"\n` +
             `         }\n` +
             `       }\n` +
             `     }\n` +
             `   }\n` +
             `3. Restart Claude Code\n` +
             `Note: This is a manual step - the Flair CLI cannot automatically modify Claude Code's settings due to security restrictions.`,
  };
}

function _wireCodex(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  return {
    ok: false,
    message: `Manual wiring required for Codex:\n` +
             `1. Locate Codex's configuration (check ~/.codex/config or similar)\n` +
             `2. Add the Flair MCP server configuration:\n` +
             `   {\n` +
             `     "mcpServers": {\n` +
             `       "flair": {\n` +
             `         "command": "npx",\n` +
             `         "args": ["-y", "@tpsdev-ai/flair-mcp"],\n` +
             `         "env": {\n` +
             `           "FLAIR_AGENT_ID": "${env.FLAIR_AGENT_ID}",\n` +
             `           "FLAIR_URL": "${env.FLAIR_URL}"\n` +
             `         }\n` +
             `       }\n` +
             `     }\n` +
             `   }\n` +
             `3. Restart Codex\n` +
             `Note: This is a manual step - the Flair CLI cannot automatically modify Codex's configuration due to security restrictions.`,
  };
}

function _wireGemini(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  return {
    ok: false,
    message: `Manual wiring required for Gemini:\n` +
             `1. Locate Gemini's configuration (check ~/.gemini/config or similar)\n` +
             `2. Add the Flair MCP server configuration:\n` +
             `   {\n` +
             `     "mcpServers": {\n` +
             `       "flair": {\n` +
             `         "command": "npx",\n` +
             `         "args": ["-y", "@tpsdev-ai/flair-mcp"],\n` +
             `         "env": {\n` +
             `           "FLAIR_AGENT_ID": "${env.FLAIR_AGENT_ID}",\n` +
             `           "FLAIR_URL": "${env.FLAIR_URL}"\n` +
             `         }\n` +
             `       }\n` +
             `     }\n` +
             `   }\n` +
             `3. Restart Gemini\n` +
             `Note: This is a manual step - the Flair CLI cannot automatically modify Gemini's configuration due to security restrictions.`,
  };
}

function _wireCursor(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  return {
    ok: false,
    message: `Manual wiring required for Cursor:\n` +
             `1. Locate Cursor's settings file (usually ~/.cursor/settings.json)\n` +
             `2. Add or update the "mcpServers" section:\n` +
             `   {\n` +
             `     "mcpServers": {\n` +
             `       "flair": {\n` +
             `         "command": "npx",\n` +
             `         "args": ["-y", "@tpsdev-ai/flair-mcp"],\n` +
             `         "env": {\n` +
             `           "FLAIR_AGENT_ID": "${env.FLAIR_AGENT_ID}",\n` +
             `           "FLAIR_URL": "${env.FLAIR_URL}"\n` +
             `         }\n` +
             `       }\n` +
             `     }\n` +
             `   }\n` +
             `3. Restart Cursor\n` +
             `Note: This is a manual step - the Flair CLI cannot automatically modify Cursor's settings due to security restrictions.`,
  };
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
  env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }
): { ok: boolean; message: string } {
  return _wireClaudeCode(env);
}

export function wireCodex(
  env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }
): { ok: boolean; message: string } {
  return _wireCodex(env);
}

export function wireGemini(
  env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }
): { ok: boolean; message: string } {
  return _wireGemini(env);
}

export function wireCursor(
  env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }
): { ok: boolean; message: string } {
  return _wireCursor(env);
}
