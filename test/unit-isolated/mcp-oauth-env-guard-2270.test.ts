import { afterAll, expect, spyOn, test } from "bun:test";
const saved = process.env.FLAIR_MCP_NO_AUTOSTART;
process.env.FLAIR_MCP_NO_AUTOSTART = "1";
const { runMcpOAuthEnvGuard, mcpOAuthDegraded, mcpOAuthProviderReadiness } = await import("../../resources/mcp-oauth-env-guard.ts");
afterAll(() => {
  if (saved === undefined) delete process.env.FLAIR_MCP_NO_AUTOSTART;
  else process.env.FLAIR_MCP_NO_AUTOSTART = saved;
});
test("repeated guard invocation retains the degraded boot result", () => {
  const env = { OAUTH_GITHUB_CLIENT_ID: "fixture-id", OAUTH_GITHUB_CLIENT_SECRET: "fixture-secret", FLAIR_MCP_OAUTH: "false" };
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    const first = runMcpOAuthEnvGuard(env);
    expect(first.degraded).toBe(true);
    expect(runMcpOAuthEnvGuard(env)).toEqual(first);
    expect(mcpOAuthDegraded()).toEqual(first);
    expect(mcpOAuthProviderReadiness()).toEqual({ credentialsPresent: true, redirectPresent: false });
    expect(logger).toHaveBeenCalledTimes(1);
  } finally { logger.mockRestore(); }
});
