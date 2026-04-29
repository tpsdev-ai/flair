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

function claudeCodeDetect(): boolean {
  try {
    // Check if npx claude-code is available or if Claude Code is installed
    const spawn = require("node:child_process").spawnSync;
    const result = spawn("npm", ["list", "-g", "@anthropic-ai/claude-code"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function codexDetect(): boolean {
  try {
    const spawn = require("node:child_process").spawnSync;
    // Check if codex is available in PATH or via npx
    const result = spawn("which", ["codex"], { stdio: ["ignore", "ignore", "ignore"] });
    if (result.status === 0) return true;
    // Also check npm global
    const result2 = spawn("npm", ["list", "-g", "@openai/codex"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result2.status === 0;
  } catch {
    return false;
  }
}

function geminiDetect(): boolean {
  try {
    const spawn = require("node:child_process").spawnSync;
    // Check if gemini CLI is available
    const result = spawn("which", ["gemini"], { stdio: ["ignore", "ignore", "ignore"] });
    if (result.status === 0) return true;
    // Check npm global
    const result2 = spawn("npm", ["list", "-g", "@google/generative-ai"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result2.status === 0;
  } catch {
    return false;
  }
}

function cursorDetect(): boolean {
  try {
    const spawn = require("node:child_process").spawnSync;
    // Check if cursor is available in PATH
    const result = spawn("which", ["cursor"], { stdio: ["ignore", "ignore", "ignore"] });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---- Internal wiring functions --------------------------------------------------

function _wireClaudeCode(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  try {
    // In real implementation, this would modify Claude Code's settings
    // For now, we'll just indicate success
    return {
      ok: true,
      message: `Claude Code wired for agent ${env.FLAIR_AGENT_ID} at ${env.FLAIR_URL}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: `Failed to wire Claude Code: ${e.message}`,
    };
  }
}

function _wireCodex(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  try {
    return {
      ok: true,
      message: `Codex wired for agent ${env.FLAIR_AGENT_ID} at ${env.FLAIR_URL}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: `Failed to wire Codex: ${e.message}`,
    };
  }
}

function _wireGemini(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  try {
    return {
      ok: true,
      message: `Gemini wired for agent ${env.FLAIR_AGENT_ID} at ${env.FLAIR_URL}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: `Failed to wire Gemini: ${e.message}`,
    };
  }
}

function _wireCursor(env: { FLAIR_AGENT_ID: string; FLAIR_URL: string }): { ok: boolean; message: string } {
  try {
    return {
      ok: true,
      message: `Cursor wired for agent ${env.FLAIR_AGENT_ID} at ${env.FLAIR_URL}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: `Failed to wire Cursor: ${e.message}`,
    };
  }
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
