# 🎖️ Flair

**The only piece of flair your agent needs.**

Portable identity, persistent memory, and soul for AI agents. Built on [Harper](https://github.com/HarperFast/harper).

---

## What is Flair?

Flair gives AI agents a persistent, portable sense of self — independent of any specific runtime or framework.

- **Identity** — Ed25519-based agent identity with platform integrations (GitHub, Discord, etc.) and encrypted credentials
- **Memory** — Cross-session, cross-channel knowledge store with typed documents and semantic search
- **Soul** — Personality, procedures, and relationships that define how an agent thinks and communicates

One [Harper](https://github.com/HarperFast/harper) instance. Any number of agents. Any runtime.

## Why?

AI agents today have amnesia. Every session starts fresh. Move an agent to a new machine and it forgets everything. Talk to it on Discord, then on CLI — it's like meeting a stranger twice.

Flair fixes this. An agent's identity, memories, and personality live in a service, not in flat files tied to a workspace. Export the data, hand the agent its key, and it's fully operational anywhere.

## Architecture

```
Harper v5 instance (one per location)
└── Flair (Harper application)
    ├── Identity — Ed25519 auth, platform integrations, encrypted credentials
    ├── Memory — typed knowledge store, semantic search, private + shared spaces
    └── Soul — personality, procedures, relationships (system prompt source)

Any runtime:
  tps-agent  → native client (built-in)
  OpenClaw   → skill/tool (HTTP client)
  Your thing → REST API
```

## Runtime Agnostic

Flair doesn't care what runs your agent. It exposes a REST + WebSocket API that any framework can use. Your agent's brain is a service, not a file system convention.

## Quick Start

> 🚧 **Coming soon** — Flair is under active development. Phase 1 (Identity Service) shipping first.

```bash
# Install
npm install @tpsdev-ai/flair

# Start the Flair service
flair start

# Register an agent
flair identity register --name "MyAgent"

# Save a memory
flair memory save my-agent --type decision "We chose PostgreSQL for the main database"

# Search memories
flair memory search my-agent "database choice"

# Export (portable backup)
flair export my-agent > my-agent-backup.jsonl
```

## Security

- **Agent-generated Ed25519 keypairs** — the key IS the agent's identity
- **Client-side credential encryption** — the Flair service never sees plaintext secrets
- **Signed + nonce-protected API requests** — replay-resistant authentication on every call
- **Private memory spaces** — enforced at the application layer, not just convention
- **Encrypted exports** — Argon2id KDF for passphrase-based backup encryption

## Built on Harper

Flair is a [Harper](https://github.com/HarperFast/harper) application. Harper is an open-source Node.js platform that unifies database, cache, application logic, and messaging into a single in-memory runtime.

- 🔗 [Harper GitHub](https://github.com/HarperFast/harper)
- 🔗 [Harper Docs](https://docs.harperdb.io)
- 🔗 [Harper Discord](https://harper.fast/discord)

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Contributing

Flair is built by the [TPS](https://github.com/tpsdev-ai) team. Issues and PRs welcome.

## Phase 2 Security Notes

- All Memory and Soul endpoints require Ed25519 auth middleware.
- Memory `content` is stored plaintext in Phase 2 (encryption-at-rest planned for Phase 3).
- Soul keys should avoid direct PII by convention (e.g. use role/relationship labels, not personal identifiers).
