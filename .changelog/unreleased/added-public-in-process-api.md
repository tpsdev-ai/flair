- **Public in-process API (`new Flair(server)`).** A facade that hides internal
  implementation details (deep imports, `server.resources` keying, `.Resource`
  wrapping, `collectionResource()`, double-passing `agentId`) while preserving
  the security boundary. One handle per Harper instance, lazy resource
  resolution, agent-scoped handles via `flair.as(id)`, admin operations via
  `flair.admin`, and internal operations via `flair.internal`. The package now
  has `main` and `exports` fields so `import { Flair } from "@tpsdev-ai/flair"`
  resolves directly.
