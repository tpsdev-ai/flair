<<<<<<< HEAD
- **Updates documentation for the native MCP endpoint, integrations, OpenClaw, Claude Code, and ADK JS.**

   `README.md`: the native `/mcp` endpoint no longer states a stale tool count; its tools are what the JSON-RPC `tools/list` method returns. The n8n nodes are described with their real port types.

   `docs/integrations.md`: integrations that sign with a per-agent Ed25519 key follow the same identity and read-scope rules, and n8n, which uses the Harper admin password, is named as the exception. With `--agent <id>` and wiring enabled, `flair init` attempts Pi wiring when Pi is explicitly selected or detected. ADK Python reads `FLAIR_HTTP_TIMEOUT`; ADK JS reads the constructor's `timeoutMs`. LangGraph requires `config.agentId` and can authenticate with an in-memory key, an explicit or automatically found keyfile, or Basic-auth fallback; its automatic lookup does not read `FLAIR_KEY_PATH`.

   `docs/openclaw.md`: the example leaves out `allowConversationAccess`, which is required to enable auto-capture.

   `docs/claude-code.md`: a successful write is not suppressed by a dedup match; eligible creates use writer-overridable match thresholds.
=======
- **The README, integrations, OpenClaw and Claude Code pages say what the code does.**

   `README.md`: the native `/mcp` endpoint no longer states a stale tool count; its tools are what the JSON-RPC `tools/list` method returns. The n8n nodes are described with their real port types.

   `docs/integrations.md`: integrations that sign with a per-agent Ed25519 key follow the same identity and read-scope rules, and n8n, which uses the Harper admin password, is named as the exception. Pi is wired by a `flair init --agent <id>` run that selects pi. ADK Python reads `FLAIR_HTTP_TIMEOUT`; ADK JS reads the constructor's `timeoutMs`. LangGraph takes `config.keyPath` or the client's automatic key candidates, and does not read `FLAIR_KEY_PATH`.

   `docs/openclaw.md`: the example leaves out `allowConversationAccess`, which is required to enable auto-capture.

   `docs/claude-code.md`: dedup reports a match and never suppresses a write that passes validation; its default thresholds can be overridden by the writer.
>>>>>>> c8f6e5facab898073cfd29cc1846fd5cdcedec33

   `packages/adk-flair-js/README.md`: search uses one abort timer set by `timeoutMs`.

   (Refs #1943)

