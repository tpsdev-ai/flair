/**
 * OpenClaw-specific identity resolution.
 *
 * Key path and private key loading are now handled by @tpsdev-ai/flair-client.
 * This file only contains resolveAgentId() which reads environment variables —
 * something the generic flair-client shouldn't know about.
 */
/**
 * Resolve agent ID from environment when not explicitly configured.
 *
 * IMPORTANT: Does NOT read from openclaw.json agents list. On a multi-agent
 * gateway, the first agent in the list is NOT necessarily the current session's
 * agent. The plugin must get the real agentId from the session context via
 * before_agent_start, not from config guessing.
 *
 * Priority: FLAIR_AGENT_ID env > null (let session context provide it)
 */
export function resolveAgentId() {
    const envId = process.env.FLAIR_AGENT_ID;
    if (envId)
        return envId;
    return null;
}
