export function resolveAgentId() {
    const envId = process.env.FLAIR_AGENT_ID;
    if (envId)
        return envId;
    return null;
}
