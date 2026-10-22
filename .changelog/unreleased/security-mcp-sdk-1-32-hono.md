- **`@tpsdev-ai/flair-mcp` now depends on `@modelcontextprotocol/sdk` 1.32.0, the fixed release for four SDK advisories.**
  GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw and GHSA-rvq5-wwqv-78pq
  affect SDK releases below 1.32.0. flair-mcp imports only the SDK's server, stdio transport
  and type modules. The root `overrides` entry moves the SDK copies that other workspace
  dependencies pull in to the same release. The root `hono` override, now exact at 4.13.11,
  resolves the fixed release for GHSA-5r4p-p66f-jhc7 in the workspace, where `hono` arrives
  only through the SDK. Once this release is published, a fresh install of flair-mcp resolves
  SDK 1.32.0 and a fixed `hono` from the SDK's own range, as an install of the flair-mcp
  package packed from this change does. An install of the `@tpsdev-ai/flair` package
  includes neither package. Nothing to do on upgrade.
