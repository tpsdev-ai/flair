/**
 * OpenClaw-specific identity resolution.
 *
 * Key path and private key loading are now handled by @tpsdev-ai/flair-client.
 * This file only contains resolveAgentId() which reads OpenClaw config — something
 * the generic flair-client shouldn't know about.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve agent ID when not explicitly configured.
 * Priority: FLAIR_AGENT_ID env > OpenClaw config file > null
 */
export function resolveAgentId(): string | null {
  // 1. Explicit env var
  const envId = process.env.FLAIR_AGENT_ID;
  if (envId) return envId;

  // 2. Read from OpenClaw config — first agent name
  try {
    const configPath = resolve(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const agents = config?.agents?.list;
    if (Array.isArray(agents) && agents.length > 0) {
      const name = agents[0]?.name;
      if (typeof name === "string" && name) return name.toLowerCase();
    }
  } catch {
    // Config unreadable — fall through
  }

  return null;
}
