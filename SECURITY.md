# Flair Security Model

## Overview

Flair uses cryptographic identity (Ed25519) for agent authentication. Within
an org, memory reads are open — agents see each other's non-private memories —
while writes are isolated per agent and private memories restrict non-admin
reads to their owner. The hard access boundary is the federation edge (cross-instance).

## Authentication

### Agent Authentication (Ed25519)

Every request includes an `Authorization` header:

```
TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>
```

The signature covers `agentId:timestamp:nonce:METHOD:/path?query` using the
agent's Ed25519 private key. The server verifies against the agent's
registered public key.

- **Replay window:** 30 seconds
- **Nonce deduplication:** Prevents replay within the window. Each nonce is
  recorded once per instance, in a table every Harper worker thread shares,
  before the request takes effect; if that record cannot be written, the
  request is refused
- **No shared secrets:** Each agent has its own key pair

### Admin Authentication

Admin operations (agent management, backup, restore) use Harper's
built-in HTTP Basic auth:

```
Authorization: Basic <base64(admin:password)>
```

The admin password is generated on `flair init` and stored at
`~/.flair/admin-pass` (mode `0600`, owner-only) — it can also be set
explicitly via `--admin-pass-file`, `FLAIR_ADMIN_PASS`, or
`HDB_ADMIN_PASSWORD`. It is never printed to the console. See
[docs/secrets-and-keys.md](docs/secrets-and-keys.md) for the full
precedence and rotation model.

The Harper **operations API** is the admin/management surface. Network
requests to it require admin Basic auth: Flair ships with
`authorizeLocal: false`, so an unauthenticated loopback request is
rejected (`401`) instead of being auto-elevated to super_user. The same
API is also reachable over a Unix **domain socket**
(`~/.flair/data/operations-server`), which Harper
treats as an inherent local-admin channel — a request over the socket is
authorized as super_user **without** credentials. This is by design (the
admin-password rotation flow relies on it). CLI `init`, `start`, `restart` and
launchd repair attempt parent/socket modes `0700`/`0600` (or `0750`/`0660` with
`FLAIR_SOCKET_GROUP`, changing the socket's group); unattended macOS launchd
spawns use `Umask 077` (`0700` socket, since Darwin does not retain `0600` on
Unix sockets) without reapplying the CLI posture.

## Data Scoping

### Memory Read/Write Model

Reads are open **within an org**; writes are isolated per agent. Enforced at
the database layer (Harper resource `search()` override via a single
centralized read-scope rule), not application logic:

- `GET /Memory/` — applies the owner/visibility base scope and omits retained
  closed skill payloads that fail the non-admin reader's current-authority check
- `POST /SemanticSearch` — applies the owner/visibility read scope
- `POST /Memory` — writes are attributed to the authenticated agent; an
  agent cannot write as another (write isolation)

Non-admin memory reads restrict `visibility: private` to its author.

On `POST /Memory` and `PUT /Memory` creates, omitted visibility defaults by
durability: `permanent`/`persistent` → `shared`, `standard`/`ephemeral` → `private`.
Durability defaults to `standard`. Explicit visibility overrides this default;
ephemeral memories require `private`, and grant-authorized `supersedes` writes
keep the predecessor's visibility, including when visibility is omitted.

### Record Ownership on Writes

For a verified non-admin agent's HTTP write to an owner-scoped table served by
a resource that extends that table (Memory, Relationship, Soul, Credential,
Integration, Asset, MemoryCandidate, MemoryGrant, MemoryUsage, Message,
OrgEvent, WorkspaceState, Presence):

- The middleware can return
  `403 forbidden: cannot modify <Table> owned by another principal` before the
  table guard runs on a request target of exactly `/<Table>/<id>` (two
  non-empty path segments, no `.` in the decoded id), for which Harper resolves
  the same record id. Other addressed forms are left to the guard, which uses
  Harper's resolved id.
- If reached, the guard checks the body `id` on POST/PUT/PATCH first, then
  stored ownership (the same owner refusal), using Harper's resolved record id.
  An absent, null or matching body `id` passes the body-id check; a differing
  string or number `id` gets `403 write_id_not_addressed`, and a present,
  non-null `id` of any other type that is not the addressed key gets
  `400 id_target_mismatch`. Each
  object element of an array body is checked the same way. OrgEvent and Memory
  bind an addressed POST's missing body `id` to the addressed id.
- For a collection PUT, PATCH or DELETE, if reached, the table guard returns
  `403 forbidden: a non-admin write to <Table> must address one record by its id`;
  existing DELETE middleware may refuse earlier.

A refusal by this guard leaves its target row unchanged and carries no record
content. A POST to a collection is delegated to each resource's own
POST handling — its create and attribution rules (for example, an OrgEvent
collection POST that names an existing event owned by another agent reaches
OrgEvent's ownership check and is refused, one that names the caller's own
existing event can update it when OrgEvent's other checks pass (a changed
`createdAt` is refused with 409), and a
Presence heartbeat writes the caller's own row). Routes served
by a custom resource rather than a table-backed one are outside this table
guard and apply their own rules; `/AgentReadPosition`, for example, enforces
its own ownership rule.
The guard exempts administrator and in-process calls. OrgEvent POST id
selection also applies to administrator and in-process calls.

Credential records are owner-scoped by `principalId`: non-admin callers read and
modify only their own records, and administrators and trusted internal callers
are unscoped. Anonymous HTTP access is refused.

### Cross-Agent Access (within an org)

Within an org, non-private memories pass the base read-scope check without a
grant; non-admin by-id and collection reads of retained closed skills
additionally require readable current authority. This is deliberate: the goal
is relevance (surface what's useful to the org) over secrecy. A writer keeps something private by marking it
`visibility: private`, which restricts non-admin reads to its author. The access boundary
that stays hard is the **federation edge** (cross-instance / cross-org), not
within-org reads.

### Admin Bypass

Admin-authenticated requests bypass agent scoping. Admin can read all
memories, all souls, and all agent records. SQL and GraphQL endpoints
are restricted to admin-only.

## Key Management

### Key Storage

Private keys at `~/.flair/keys/<agentId>.key` are created owner-only
(`0600`) from the first byte on POSIX by `flair agent add`, `flair init` (local
and remote agent provisioning), `flair principal add`, `flair import` and
`flair agent rotate-key` (which stages the replacement before it updates Flair
and renames it over the current key once Flair holds its public key). On
POSIX the keys directory is requested with mode `0700` (the umask may make it
narrower), and an owned directory with group or world bits is tightened to
`0700`; on the create and reuse paths an existing key with group or world
bits is refused with `chmod 600 <path>`, while rotation reports it. A successful
rotation replaces the file; a failed update leaves it. `flair doctor` warns
about an existing agent key file with group or world bits, and `flair status`
warns about it for a local target; both name the path, its mode and
`chmod 600 <path>`, and neither changes the file. The check covers the standard
`resolveKeyPath` locations: `$FLAIR_KEY_DIR/<agentId>.key` when that variable is
set, `~/.flair/keys/<agentId>.key`, and the legacy
`~/.tps/secrets/flair/<agentId>-priv.key`; explicit key paths (such as `--key`)
are outside this scan. A symlinked agent key is
reported as not checked. On Windows mode bits
do not establish owner-only.

`flair export --include-key` publishes its output through a `0600` temp file
renamed over the target, so an existing output file's wider mode does not apply
to the new contents. The keystore seed file is replaced the same way.
A generated passphrase is published at `0600` if its path is absent. When used
(`FLAIR_KEY_PASSPHRASE` unset), an existing generated passphrase file with group
or world bits is refused unchanged before reading, with `chmod 600 <path>`. On Windows the mode bits do not apply.

### Key Generation

Keys are generated during `flair agent add` using Ed25519 (via tweetnacl).
The 32-byte seed is stored; the full 64-byte secret key is derived at
runtime.

### Key Rotation

`flair agent rotate-key <id>` generates a new key pair, stages the new private
key owner-only (`0600`) from creation on POSIX, updates the public key in
Flair, reads the row back to confirm the stored key, then renames the staged
key over the current one. The old key is backed up as a new
`<agentId>.key.bak.<UTC timestamp>`; an existing backup is left untouched.

## Threat Model

### Threats Mitigated

- **Agent impersonation:** Ed25519 signatures prevent one agent from
  acting as another without possessing the private key.
- **Private-memory leakage:** non-admin reads of `visibility: private` memories
  are restricted to their author. Non-private
  memories are intentionally readable within the org (by design, not
  leakage); the cross-instance boundary is the federation edge.
- **Write forgery:** writes are attributed to the authenticated agent —
  an agent cannot write memories as another.
- **Replay attacks:** 30-second window + nonce deduplication.
- **Privilege escalation via SQL:** SQL and GraphQL endpoints blocked
  for non-admin agents.

### Threats NOT Mitigated (Runtime Responsibility)

- **Same-OS-user key theft:** If multiple agents run as the same OS user,
  file permissions alone don't prevent key access. Use process-level
  sandboxing (nono, Docker, separate users) to isolate agents.
- **Memory dumps:** Private keys exist in process memory. A compromised
  process could extract them.
- **Network sniffing:** Flair uses HTTP by default. Use HTTPS in
  production or restrict to localhost.
- **Local ops-API socket access:** the operations-API domain socket
  (`operations-server`) grants local admin access, restricted by the
  directory and socket modes above. Isolate untrusted workloads to separate
  OS users outside any configured `FLAIR_SOCKET_GROUP`.

## Recommendations

1. **Use HTTPS** for any non-localhost deployment
2. **Sandbox agents** with nono, Docker, or separate OS users
3. **Rotate keys** periodically with `flair agent rotate-key`
4. **Back up** with `flair backup` — backup files contain memory content
   and should be treated as sensitive
5. **Monitor** with `flair status`
