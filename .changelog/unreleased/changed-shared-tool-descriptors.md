- **Shared MCP tool descriptors so the stdio adapter cannot drift from `/mcp`.**
  `@tpsdev-ai/flair-tool-descriptors` is the transport-agnostic source (name,
  description, inputSchema, output shape). The server binds native descriptors
  to Harper impls; `@tpsdev-ai/flair-mcp` derives its tool set from the same
  list and binds FlairClient HTTP. Adding a both-surface descriptor appears on
  both sides with zero hand-wiring (flair#1580).

  > **Heads-up:** `@tpsdev-ai/flair-tool-descriptors` is a new workspace package
  > and needs a one-time npm first-publish + Trusted Publisher registration
  > before the next release can stage it (see `docs/releasing.md`). Until then,
  > `@tpsdev-ai/flair` and `@tpsdev-ai/flair-mcp` tarballs **bundle** it
  > (`bundleDependencies`) so `npm install` of those tarballs does not 404.

  Stdio `inputSchema` omits native-only params FlairClient never forwards
  (`includeTrust`, `abstain`, `includeArchived`, `includeEmbedding`, `entities`,
  `includeContext`, `maxEvents`, `includeEventDetail`) so advertised tools match
  handler behavior.
