/**
 * The OAuth scope each native `/mcp` tool requires (flair#3076).
 *
 * `withMCPAuth` passes the access token's verified `scope` claim (a
 * space-separated string) to the handler as `request.mcp.scope`. A tools/call
 * runs only when that claim grants the scope this table lists for the tool. A
 * token with no `scope` claim grants no scope. A scope never widens a call: the
 * tool still runs as the token's mapped principal, with that principal's
 * authority.
 *
 * resources/mcp-tools.ts refuses to load when a tool has no entry here, or an
 * entry names a tool it does not serve.
 */

export type McpToolScope = "memory:read" | "memory:write" | "principal:read" | "principal:admin";

export const MCP_TOOL_SCOPES: Readonly<Record<string, McpToolScope>> = Object.freeze({
  // Reads and searches of memories and the caller's own context.
  memory_search: "memory:read",
  memory_get: "memory:read",
  skill_search: "memory:read",
  skill_get: "memory:read",
  bootstrap: "memory:read",
  soul_get: "memory:read",
  attention: "memory:read",
  // Writes, updates, archive changes and deletes.
  memory_store: "memory:write",
  memory_update: "memory:write",
  memory_delete: "memory:write",
  memory_basement: "memory:write",
  memory_restore: "memory:write",
  skill_store: "memory:write",
  flair_workspace_set: "memory:write",
  flair_orgevent: "memory:write",
  record_usage: "memory:write",
  // The principal list.
  team_directory: "principal:read",
  // A change to a principal's Soul, an operator action.
  soul_set: "principal:admin",
});

/**
 * The scopes `/mcp` asks a client to request: the 401 challenge names them, and
 * Flair's client metadata documents declare them. They cover every tool but
 * `soul_set`.
 */
export const MCP_REQUESTED_SCOPES: readonly McpToolScope[] = Object.freeze([
  "memory:read",
  "memory:write",
  "principal:read",
]);

/** The scope `tool` requires, or undefined for a name the table does not list. */
export function requiredToolScope(tool: string): McpToolScope | undefined {
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_SCOPES, tool) ? MCP_TOOL_SCOPES[tool] : undefined;
}

/** The scopes a token's `scope` claim grants. Anything but a string grants none. */
export function grantedScopes(claim: unknown): string[] {
  return typeof claim === "string" ? claim.split(/\s+/).filter(Boolean) : [];
}

// RFC 6749 section 3.3 scope-token characters. A granted value outside them is
// left out of a challenge header rather than quoted into it.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * The `scope` an insufficient_scope challenge names: the scopes the token was
 * granted, MCP_REQUESTED_SCOPES, and the scope the tool requires.
 */
export function challengeScope(granted: readonly string[], required: McpToolScope): string {
  const scopes = new Set<string>();
  for (const scope of [...granted, ...MCP_REQUESTED_SCOPES, required]) {
    if (SCOPE_TOKEN.test(scope)) scopes.add(scope);
  }
  return [...scopes].join(" ");
}
