- **The README, integrations, OpenClaw and Claude Code pages say what the code does.**

   `README.md`: the native `/mcp` endpoint no longer states a stale tool count; its tools are what the JSON-RPC `tools/list` method returns. The n8n nodes are described with their real port types.

   `docs/integrations.md`: integrations that sign with a per-agent Ed25519 key follow the same identity and read-scope rules, and n8n, which uses the Harper admin password, is named as the exception. Pi is wired by a `flair init --agent <id>` run that selects pi. ADK Python reads `FLAIR_HTTP_TIMEOUT`; ADK JS reads the constructor's `timeoutMs`. LangGraph takes `config.keyPath` or the client's automatic key candidates, and does not read `FLAIR_KEY_PATH`.

   `docs/openclaw.md`: the example leaves out `allowConversationAccess`, which is required to enable auto-capture.

   `docs/claude-code.md`: dedup reports a match and never suppresses a write that passes validation; its default thresholds can be overridden by the writer.

   `packages/adk-flair-js/README.md`: search uses one abort timer set by `timeoutMs`.

   (Refs #1943)
