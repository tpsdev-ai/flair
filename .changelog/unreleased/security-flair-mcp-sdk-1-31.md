- **`@tpsdev-ai/flair-mcp` now depends on `@modelcontextprotocol/sdk` 1.31.0, outside the affected range of GHSA-6qxp-vccf-f47h (>=1.12.0 <1.31.0).** The
  advisory concerns the SDK's OAuth client; flair-mcp imports only the SDK's server, stdio transport
  and type modules. A root `overrides` entry moves the SDK copies that other workspace dependencies
  pull in to the same release. Nothing to do on upgrade.
