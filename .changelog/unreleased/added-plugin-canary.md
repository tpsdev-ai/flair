- **The post-publish canary now installs published flair-mcp and flair-client and asserts a tool-call.**

  After the installed CLI boots, the canary installs `@tpsdev-ai/flair-mcp` and
  `@tpsdev-ai/flair-client` at the exact dispatched version from the public
  registry, writes the documented host config, and drives a real
  `memory_store` → `memory_get` round-trip against that instance. A missing
  package, an unreachable host, or any other unmeasurable result fails the
  canary — it is never skipped. `latest` still moves only after a full PASS.

  > **Heads-up:** a canary that cannot resolve or drive the published adapters
  > is a FAIL. Do not promote from a run that did not complete that step.
