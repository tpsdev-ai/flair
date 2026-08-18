- **cursor-flair pre-publish: plugin re-pinned to `flair-mcp@0.44.13` + doc
  fixes.** `packages/cursor-flair/mcp.json` now pins `@tpsdev-ai/flair-mcp@0.44.13`,
  picking up the interpolation-literal guard (#1253) so an unsubstituted
  `${FLAIR_URL}` cannot break the default install. `docs/quickstart-fabric.md`
  step 3 gains the step-0 secret-hygiene note for remote `agent add` (#1255),
  and the plugin README adds a factual "Flair vs Cursor's built-in Memories"
  contrast.
