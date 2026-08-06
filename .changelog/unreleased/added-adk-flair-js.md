- **New `@tpsdev-ai/adk-flair` package — Flair memory backend for Google ADK (JS/TS).**
  Implements `BaseMemoryService` from `@google/adk` with Ed25519 request signing,
  compound-tag scoping (`adk:<app>:<user>`), and silent-degrade health warnings.
  Ports the Python `adk-flair` design to TypeScript with the same conformance
  suite (explain-plan, portability, quickstart-parity).
