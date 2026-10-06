- **The workspace lockfile resolves proxy-addr 2.0.8, outside the vulnerable range of GHSA-jqcg-44mw-7w3h (>=1.1.0 <2.0.8).** A root
  `overrides` entry sets the floor. Installs of the published `@tpsdev-ai/flair` package do not
  include proxy-addr; the workspace copy arrives through express, a dependency of the MCP SDK, the
  ADK and OpenClaw. Nothing to do on upgrade.
