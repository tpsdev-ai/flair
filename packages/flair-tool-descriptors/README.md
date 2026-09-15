# @tpsdev-ai/flair-tool-descriptors

Transport-agnostic MCP tool descriptors for [Flair](https://tps.dev/#flair).

This package is **pure data and types**: tool name, description, JSON Schema
`inputSchema`, output shape, and reviewed surface flags. It imports neither
Harper nor FlairClient. The Flair server binds each native descriptor to its
Harper implementation; `@tpsdev-ai/flair-mcp` binds each stdio descriptor to a
FlairClient HTTP call. Both tool sets are derived from this list, so a new
descriptor appears on every listed surface with zero hand-wiring (flair#1580).

## Install

This package is **never published**. It is a **build-time source**, vendored at
prebuild into the two packages that consume it — `@tpsdev-ai/flair`
(`resources/tool-descriptors/`) and `@tpsdev-ai/flair-mcp`
(`packages/flair-mcp/src/tool-descriptors/`) — by
`scripts/vendor-tool-descriptors.mjs`. Both import the vendored copy by relative
path, which is the only specifier that resolves inside a packed tarball.
Install one of those instead.

Do **not** add this package to any `dependencies` or `bundleDependencies`:
the source here is the input, the vendored copy is the artifact. Listing it as a
dependency 404s a fresh install (it is not on npm), and bundling it is what broke
`npm install -g @tpsdev-ai/flair` in 0.54.1 (flair#1681 → #1683).

## Surfaces

`native` and `stdio` default to true. Set either to `false` for a reviewed
one-sided tool (`attention` is native-only; `relationship_store` is
stdio-only). The #1578 exemption list is derived from those flags.
