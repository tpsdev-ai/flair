- **DeepSeek Harness wiring doc + example overlay** (`docs/deepseek-harness.md`,
  `examples/deepseek-harness/flair.cordis.yml`). Zero-code path wiring
  `@tpsdev-ai/flair-mcp` into DeepSeek Harness through their first-party MCP
  bridge, with the two caveats that path carries documented prominently: the
  bridge scrubs credential-shaped and `DSH_*` env vars before spawning (Flair
  env must live in the overlay's `config.env`), and recall is reactive — the
  documented persona nudge is included, and true session-start auto-inject is
  the phase-2 native plugin tracked in flair#1289.
