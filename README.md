# 🎖️ Flair

**The only piece of flair your agent needs.**

Portable identity, persistent memory, and soul for AI agents. Built on [Harper](https://github.com/HarperFast/harper).

---

## What is Flair?

Flair gives AI agents a persistent, portable sense of self — independent of any specific runtime or framework.

- **Identity** — Ed25519-based agent identity with platform integrations (GitHub, Discord, etc.) and encrypted credentials.
- **Memory** — Cross-session, cross-channel knowledge store with typed documents, durability classes, and semantic search.
- **Soul** — Personality, procedures, and relationships that define how an agent thinks and communicates.

One [Harper](https://github.com/HarperFast/harper) instance. Any number of agents. Any runtime.

## Architecture

Flair is a native Harper v5 application. No external server frameworks required.

- **Unified Runtime** — Harper is the HTTP server, database (RocksDB), and logic runtime.
- **Schema-Driven API** — `@table @export` auto-generates REST CRUD from GraphQL definitions.
- **Custom Resources** — Table extensions for durability enforcement, TTL, and complex search.
- **Dual-Layer Auth** — Ed25519 request signing for agent-to-agent calls + Harper JWT for CLI/human access.

## Quick Start

```bash
# Install dependencies
bun install

# Build CLI
bun run build

# Register an agent (local key generation)
flair identity register --id flint --name "Flint"

# Save a permanent memory
flair memory add --agent flint --durability permanent --content "Always prioritize safety over speed."
```

## Security

- **Client-Side Encryption** — API never receives plaintext integration credentials.
- **Ed25519 Verification** — Request signatures verified against agent public keys with 30s replay window.
- **Durability Guards** — Permanent memories are protected from accidental deletion at the database level.
- **Backend Blindness** — Flair backend never sees or stores agent private keys.

## Development

```bash
bun install
bun run build
bun test
```

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

*If you could just go ahead and use the correct piece of flair, that'd be great.* ☕️
