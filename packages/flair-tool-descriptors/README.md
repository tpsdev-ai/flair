# @tpsdev-ai/flair-tool-descriptors

Transport-agnostic MCP tool descriptors for [Flair](https://tps.dev/#flair).

This package is **pure data and types**: tool name, description, JSON Schema
`inputSchema`, output shape, and reviewed surface flags. It imports neither
Harper nor FlairClient. The Flair server binds each native descriptor to its
Harper implementation; `@tpsdev-ai/flair-mcp` binds each stdio descriptor to a
FlairClient HTTP call. Both tool sets are derived from this list, so a new
descriptor appears on every listed surface with zero hand-wiring (flair#1580).

## Install

```bash
npm install @tpsdev-ai/flair-tool-descriptors
```

## Surfaces

`native` and `stdio` default to true. Set either to `false` for a reviewed
one-sided tool (`attention` is native-only; `relationship_store` is
stdio-only). The #1578 exemption list is derived from those flags.
