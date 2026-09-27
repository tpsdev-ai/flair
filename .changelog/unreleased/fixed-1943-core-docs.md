- **Corrects documentation claims that the code contradicts (README, integrations, OpenClaw, Claude Code pages).**

  `README.md`: native `/mcp` endpoint exposes 17 tools (not 12), references `/tools/list`; n8n nodes use `Tool` and `Main` connections per their actual inputs/outputs.

  `docs/integrations.md`: reads "identity and read-scope rules" with signed per-agent writes and per-agent read scope; Pi wiring requires an agent to be registered; splits ADK Python (which reads `FLAIR_HTTP_TIMEOUT`) from ADK JS (reads constructor `timeoutMs`); LangGraph reads only `config.keyPath`.

  `docs/openclaw.md`: removes `allowConversationAccess` from the example (auto-capture's permission only, not needed when `autoCapture: false`).

  `docs/claude-code.md`: dedup reports collisions rather than suppressing writes; uses cosine ≥ 0.95 / Jaccard ≥ 0.5, not 0.7.

  (Refs #1943)
