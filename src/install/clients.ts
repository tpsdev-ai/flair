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

function claudeCodeDetect(): boolean {
  try {
    // Check if npx claude-code is available or if Claude Code is installed
    const result = spawnSync("npm", ["list", "-g", "@anthropic-ai/claude-code"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function codexDetect(): boolean {
  try {
    // Check if codex is available in PATH or via npx
    const whichResult = spawnSync("which", ["codex"], { stdio: ["ignore", "ignore", "ignore"] });
    if (whichResult.status === 0) return true;
    // Also check npm global
    const npmResult = spawnSync("npm", ["list", "-g", "@openai/codex"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return npmResult.status === 0;
  } catch {
    return false;
  }
}

function geminiDetect(): boolean {
  try {
    // Check if gemini CLI is available
    const whichResult = spawnSync("which", ["gemini"], { stdio: ["ignore", "ignore", "ignore"] });
    if (whichResult.status === 0) return true;
    // Check npm global
    const npmResult = spawnSync("npm", ["list", "-g", "@google/generative-ai"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return npmResult.status === 0;
  } catch {
    return false;
  }
}

function cursorDetect(): boolean {
  try {
    // Check if cursor is available in PATH
    const result = spawnSync("which", ["cursor"], { stdio: ["ignore", "ignore", "ignore"] });
    return result.status === 0;
  } catch {
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

export const ALL_CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detected: claudeCodeDetect(),
    wire: _wireClaudeCode,
  },
  {
    id: "codex",
    label: "Codex",
    detected: codexDetect(),
    wire: _wireCodex,
  },
  {
    id: "gemini",
    label: "Gemini",
    detected: geminiDetect(),
    wire: _wireGemini,
  },
  {
    id: "cursor",
    label: "Cursor",
    detected: cursorDetect(),
    wire: _wireCursor,
  },
];

export function detectClients(): typeof ALL_CLIENTS {
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
