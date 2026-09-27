- **Corrected documentation claims in README, auth, integrations, and claude-code guides.**

   `README.md`: `flair init` no longer asserts that semantic search "actually works" or that a smoke test always runs — those checks can be skipped or report degraded. The catalog pointer was corrected to an inline phrase. Auth claims now distinguish ordinary agent permissions from the broader authority of administrator agent roles and administrator Basic credentials.

   `docs/auth.md`: clarified that ordinary signed agents can write only their own records; administrator roles have broader authority. Fixed punctuation in the deployment shapes section.

   `docs/integrations.md`: n8n description updated to note that stdio MCP, Pi, LangGraph, and the wake runner can also use admin Basic auth when no signing key resolves. The Pi example now correctly distinguishes the pinned `flair init` package entry from the unpinned `npm:` source recorded by `pi install`.

   `docs/claude-code.md`: example wording corrected to not overstate agent passing.
