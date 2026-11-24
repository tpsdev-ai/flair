- **Each native `/mcp` tool requires the OAuth scope its operation needs.** A tool call whose access token does not grant that scope gets HTTP 403
  with a JSON-RPC `insufficient_scope` error naming the scope, and the tool does
  not run. A token with no `scope` claim grants no scope. The 401 challenge and
  Flair's client metadata documents name `memory:read memory:write
  principal:read`, and `docs/auth.md` lists the scope each tool requires
  (flair#3076).

  > **Heads-up:** a refreshed token keeps the scope of its sign-in. Each tool
  > call is refused when its required scope is missing from that sign-in, before
  > and after a refresh, until the client signs in again requesting it.
