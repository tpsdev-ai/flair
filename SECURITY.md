# Flair Security Model

## Overview

Flair uses cryptographic identity (Ed25519) for agent authentication and
collection-level scoping to enforce data isolation between agents.

## Authentication

### Agent Authentication (Ed25519)

Every request includes an `Authorization` header:

```
TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>
```

The signature covers `agentId:timestamp:nonce:METHOD:/path` using the
agent's Ed25519 private key. The server verifies against the agent's
registered public key.

- **Replay window:** 30 seconds
- **Nonce deduplication:** Prevents replay within the window
- **No shared secrets:** Each agent has its own key pair

### Admin Authentication

Admin operations (agent management, backup, restore) use Harper's
built-in HTTP Basic auth:

```
Authorization: Basic <base64(admin:password)>
```

The admin password is set via `HDB_ADMIN_PASSWORD` environment variable
at Harper startup. **It is never stored on the filesystem by Flair.**

## Data Scoping

### Memory Isolation

Each agent can only read and write its own memories. This is enforced at
the database layer (Harper resource `search()` override), not application
logic:

- `GET /Memory/` — returns only the authenticated agent's memories
- `POST /Memory` — writes with the authenticated agent's ID
- `POST /MemorySearch` — searches only the authenticated agent's memories

### Cross-Agent Access

Explicit grants allow one agent to read another's memories:

```
MemoryGrant { fromAgentId, toAgentId, scope: "read" }
```

Grants are created by admin or by the granting agent.

### Admin Bypass

Admin-authenticated requests bypass agent scoping. Admin can read all
memories, all souls, and all agent records. SQL and GraphQL endpoints
are restricted to admin-only.

## Key Management

### Key Storage

Private keys are stored at `~/.flair/keys/<agentId>.key` with `0600`
permissions (owner read/write only). Legacy path `~/.tps/secrets/flair/`
is supported with deprecation warnings.

### Key Generation

Keys are generated during `flair agent add` using Ed25519 (via tweetnacl).
The 32-byte seed is stored; the full 64-byte secret key is derived at
runtime.

### Key Rotation

`flair agent rotate-key <id>` generates a new key pair, updates the
public key in Flair, and backs up the old key as `<agentId>.key.bak`.

## Threat Model

### Threats Mitigated

- **Agent impersonation:** Ed25519 signatures prevent one agent from
  acting as another without possessing the private key.
- **Cross-agent data leakage:** Collection-level scoping ensures agents
  can only query their own data.
- **Replay attacks:** 30-second window + nonce deduplication.
- **Privilege escalation via SQL:** SQL and GraphQL endpoints blocked
  for non-admin agents.
- **Admin token theft from filesystem:** Admin credentials are only in
  process environment, never on disk.

### Threats NOT Mitigated (Runtime Responsibility)

- **Same-OS-user key theft:** If multiple agents run as the same OS user,
  file permissions alone don't prevent key access. Use process-level
  sandboxing (nono, Docker, separate users) to isolate agents.
- **Memory dumps:** Private keys exist in process memory. A compromised
  process could extract them.
- **Network sniffing:** Flair uses HTTP by default. Use HTTPS in
  production or restrict to localhost.

## Recommendations

1. **Use HTTPS** for any non-localhost deployment
2. **Sandbox agents** with nono, Docker, or separate OS users
3. **Rotate keys** periodically with `flair agent rotate-key`
4. **Back up** with `flair backup` — backup files contain memory content
   and should be treated as sensitive
5. **Monitor** with `flair status` — warns about key permission issues
