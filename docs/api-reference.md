# API & schema reference

Consolidated catalog of Flair's HTTP surface, per-resource auth, and GraphQL
table schemas. Narrative lives in the topic docs; this page is the map so an
adopter does not have to read `resources/` or `schemas/` to see what is
callable.

- **Auth model:** [docs/auth.md](auth.md), [SECURITY.md](../SECURITY.md)
- **Access invariant:** [DESIGN.md](../DESIGN.md) — open within the org, closed
  at the federation edge
- **Federation pairing and sync:** [docs/federation.md](federation.md)
- **Source of truth for tables:** [`schemas/*.graphql`](../schemas/)
- **Source of truth for policy:** [`resources/record-types.ts`](../resources/record-types.ts)

The [docs-freshness gate](../scripts/docs-freshness-check.mjs) (`api-reference-schema-coverage`)
fails when a GraphQL `@table` type is missing from this file, so a new table
cannot land undocumented.

Default REST port is `19926` (`DEFAULT_PORT` in `src/cli.ts`). Override with
`--port` / `HTTP_PORT`. Sign remote requests as
`agentId:timestamp:nonce:METHOD:/path?query` and send
`Authorization: TPS-Ed25519 <agentId>:<ts>:<nonce>:<sig>`. Protocol detail is
in [SECURITY.md](../SECURITY.md).

## How Harper maps resources to URLs

Flair is a Harper application. Two things become HTTP paths:

1. **`@table @export` in GraphQL** — Harper generates REST CRUD at
   `/<TypeName>` and `/<TypeName>/<id>` (GET collection / GET by id / POST /
   PUT / PATCH / DELETE). Flair resource classes override those verbs to add
   identity gates, read-scope, and write policy.
2. **`export class Foo extends Resource`** in `resources/` — Harper mounts the
   class name as `/Foo`. Custom verbs are whatever the class implements
   (`post()` for actions, `get()` for reads).

In-process callers use `server.resources.get("Memory")` (no leading slash).
See [docs/embedding-in-a-harper-app.md](embedding-in-a-harper-app.md).

`@table` types **without** `@export` have no REST surface. They are listed in
the schema section so the catalog is complete.

## Auth classes

| Class | Credential | Typical grant |
|-------|------------|---------------|
| **Public** | none | Discovery, health, OAuth well-known, Presence roster (field-allowlisted) |
| **Ed25519 agent** | `TPS-Ed25519` header | Default agent path. Writes as self only. Reads follow the resource's read-scope (below). |
| **Admin Basic** | Harper `HDB_ADMIN_PASSWORD` / `FLAIR_ADMIN_PASSWORD` | Whole-instance operator. Bypasses agent scoping, including `private` memory. Used by the web admin and `n8n-nodes-flair`. |
| **Operator / internal** | Admin Basic, or a deliberate `internalContext()` call inside the process | Soul mutations and `AgentSeed`. Agent Ed25519 keys — including admin-agent keys — cannot author Soul. |
| **Federation body-sig** | Ed25519 over the request body + timestamp/nonce; pairing uses a one-time token | `/FederationPair`, `/FederationSync`. Harper role gate is open; the handler is the auth boundary. |
| **OAuth bearer** | Access token from Flair's AS or `@harperfast/oauth` | `/mcp` only, and only when `FLAIR_MCP_OAUTH=true` plus a public issuer. Off by default (path 404s). |

Anonymous HTTP is denied on every agent-facing table. A by-id miss and a
by-id deny both return **404**, never 403, so ids are not an existence oracle.

### Read-scope vocabulary

From `RECORD_TYPES` in `resources/record-types.ts`:

| Scope | Meaning | Tables |
|-------|---------|--------|
| **open-within-org** | Own rows (any visibility) plus every other agent's non-private rows | Memory |
| **owner-only** | Only the owning agent (plus admin / internal) | Relationship, WorkspaceState, Asset, MemoryCandidate |
| **none** | Any verified agent reads every row; no visibility field | Soul, OrgEvent |

These three scopes are **not** in `RECORD_TYPES`. Each is hand-implemented on its
own resource:

| Scope | Meaning | Table | Enforced in |
|-------|---------|-------|-------------|
| **party** | Sender or recipient only | Message | `resources/Message.ts` |
| **own-ledger** | Only the contributing agent's rows | MemoryUsage | `resources/MemoryUsage.ts` |
| **owner-or-grantee** | Either party on the grant | MemoryGrant | `resources/MemoryGrant.ts` |

Writes stamp `agentId` (or `authorId` / `from`) from the authenticated
principal. A body that names a different owner is rejected or overwritten
per the table's attribution mode — never trusted.

Federation sync currently pushes **Memory** (non-`private`), **Soul**,
**Agent**, and **Relationship**. `Message` has a classifier policy for a later
cross-host slice; it is not in today's spoke push list. Everything else is
instance-local.

---

## Endpoints

Paths are the Harper class / table name. Collection GET is `GET /Name`; by-id
is `GET /Name/<id>` unless noted.

### Public and health

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/Health`, `/health` | Public | Liveness. `searchReady` is always present; HTTP 503 / `ok: false` when search cannot be served. |
| GET | `/HealthDetail` | Ed25519 | Rich stats (counts, agents, migration). |
| GET | `/AgentCard/<agentId>` | Public | A2A agent-card; field-allowlisted. |
| GET | `/a2a`, `/A2AAdapter` | Public | A2A discovery. |
| POST | `/a2a`, `/A2AAdapter` | Ed25519 | JSON-RPC actions (writes OrgEvents, reads tasks). GET-only is public; POST is not. |

### Identity — Agent, Presence, Soul

| Method | Path | Auth | Read / write |
|--------|------|------|--------------|
| GET | `/Agent`, `/Agent/<id>` | Ed25519 | Any verified agent may read principals (discovery). |
| POST | `/Agent` | Admin Basic | Create principal. Also `POST /AgentSeed` (operator/internal only — not an admin-agent key). |
| PUT / PATCH | `/Agent/<id>` | Ed25519 | An agent updates **only its own** record. |
| DELETE | `/Agent/<id>` | Admin Basic | Deprovision. |
| GET | `/Presence` | Public | Roster, field-allowlisted. `currentTask` is null for anonymous callers; verified agents see the text. |
| POST | `/Presence` | Ed25519 | Heartbeat. Agent writes only its own row (403 cross-agent). Stamps `flairVersion` / `harperVersion`. |
| PUT / DELETE | `/Presence/<id>` | Ed25519 | Own row only. Collection PUT is not a public bypass. |
| GET | `/Soul`, `/Soul/<id>` | Ed25519 | Any verified agent; unscoped (identity/discovery). |
| POST / PUT / PATCH / DELETE | `/Soul` | **Operator / internal** | Not Ed25519. Learned Memory text cannot be copied in as Soul. See [docs/auth.md](auth.md#soul-authorship). |
| POST | `/FeedSouls` | Ed25519 | Soul change feed (verified). |

`Credential` (GET/POST verified; extra credentials for a principal) and
`Integration` (legacy 0.x platform rows; verified, prefer Credential) sit on
the same identity plane.

### Memory, search, bootstrap

| Method | Path | Auth | Read / write |
|--------|------|------|--------------|
| GET | `/Memory`, `/Memory/<id>` | Ed25519 | open-within-org. By-id deny = 404. |
| POST / PUT / PATCH | `/Memory` | Ed25519 | Own `agentId` only. Auto-embed on write. Visibility defaults from durability (`permanent`/`persistent` → `shared`, `standard`/`ephemeral` → `private`). |
| DELETE | `/Memory/<id>` | Ed25519 | Owner or admin. `permanent` owner-delete is allowed. |
| POST | `/SemanticSearch` | Ed25519 | Hybrid semantic + lexical. Same read-scope as Memory. Default scoring is `raw`. |
| POST | `/BootstrapMemories` | Ed25519 | Cold-start context (soul + predicted memories + optional org events). |
| POST | `/RecordUsage` | Ed25519 | Cross-agent usage signal (`Memory.usageCount`). No ownership requirement; no existence oracle in the response. Prefer this over writing `/MemoryUsage` directly. |
| GET | `/MemoryUsage` | Ed25519 | Own ledger rows only. PUT/DELETE are admin/internal — agents must not delete their row to re-count. |
| GET / write | `/MemoryGrant` | Ed25519 | Read: owner or grantee. Write/delete: owner only (you share your own memories). |
| GET / write | `/Asset` | Ed25519 | Owner-only blobs linked by `memoryId`. No MCP and no federation in this slice. |
| GET / write | `/MemoryCandidate` | Ed25519 | Owner-only REM drafts. Never auto-promoted except the narrow ADK path. |
| POST | `/PromoteMemoryCandidate` | Ed25519 | Promote/reject with required rationale. |
| POST | `/AutoPromoteCandidates` | Ed25519 | ADK per-user auto-promote only. |
| POST | `/FeedMemories` | Ed25519 | Ingest path; `agentId` stamped from the caller (`stamp-strict`). |
| POST | `/MemoryArchive` | Ed25519 | Basement / restore (`memory_basement` / `memory_restore` on `/mcp`). |
| POST | `/MemoryMaintenance` | Ed25519 or admin | Hygiene: expire ephemeral, archive old standard. Agent-scoped unless admin. |
| POST | `/MemoryReindex` | Admin / verified per handler | Embedding / HNSW rebuild. |
| POST | `/MemoryConsolidate` | Ed25519 | Dedup / consolidate. |
| POST | `/MemoryReflect` | Ed25519 | REM distill → MemoryCandidate. |
| POST | `/MemoryDedupStats` | Admin Basic | Dedup diagnostics. Fleet-wide sweep; `allowCreate` is `allowAdmin`. |
| POST | `/SkillScan` | Ed25519 | Skill-tag scan on Memory writes. |

Skill-tagged Memory rows embed from `trigger` (the recall signal), not
`content`. MCP tools: `skill_store`, `skill_search`, `skill_get`.

### Relationships, workspace, org events, attention

| Method | Path | Auth | Read / write |
|--------|------|------|--------------|
| GET / PUT | `/Relationship` | Ed25519 | Owner-only. Upsert via PUT; provenance stamped server-side. |
| GET / POST / PUT | `/WorkspaceState` | Ed25519 | Owner-only. POST stamps `agentId`; PUT rejects a mismatch. |
| GET | `/WorkspaceLatest` | Ed25519 | Latest workspace row for the caller. |
| GET / POST / PUT | `/OrgEvent` | Ed25519 | Any verified agent reads every event. Writes stamp `authorId`. |
| GET / POST | `/OrgEventCatchup` | Ed25519 | Catch-up feed for the caller. `since` is optional (defaults to the per-agent watermark). GET pages; POST acks `{ position }` (advance-on-ack). |
| GET / POST | `/AgentReadPosition` | Ed25519 | Owner-only watermark (`stream`, default `org-event`). Foundation for light-comms catch-up. |
| POST | `/OrgEventMaintenance` | Ed25519 / admin | Expire / sweep org events. |
| POST | `/AttentionQuery` | Ed25519 | Cross-table “what touches entity E”. Entity strings: [docs/entity-vocabulary.md](entity-vocabulary.md). |

### Federation

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/FederationInstance` | Admin Basic | Local instance identity (CLI / admin). Peers do not call this during pair. |
| POST | `/FederationPair` | Pairing token + body-sig | Public at the Harper role gate. Handler validates token, signature, anti-replay. Response includes `instance {id, publicKey}` when this hub has an Instance row; `instance` is null if it does not (flair#839). The spoke CLI must not store an empty hub key (flair#822). Fabric uses the bootstrap-user triple from `flair federation token`. |
| POST | `/FederationSync` | Peer body-sig | Public at the role gate. Merge Memory / Soul / Agent / Relationship (and classifier-ready Message). Originator + per-record signature checks. |
| GET | `/FederationPeers` | Admin Basic | Known peers. |
| GET / write | `/Instance` | Read: Ed25519. Write: admin | Instance row (`flair_…` id, role hub/spoke). |
| GET / write | `/Peer` | Admin Basic | Pinned peer keys and sync cursors. |
| GET / write | `/PairingToken` | Admin Basic | One-time tokens; default TTL 1 hour. |

`Nonce` and `SyncLog` are **not** `@export` — no agent REST. Nonce is the
anti-replay store; SyncLog is the operator audit trail.

### Messaging (Flair Relay)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET / POST | `/Message` | Ed25519 | POST sends (signed envelope). GET is party-scoped (`from` or `to`). Direct PUT is admin/internal. |
| GET | `/MessageInbox` | Ed25519 | Inbox for the caller. |
| POST | `/MessageAck` | Ed25519 | Consume a delivered message. |
| GET | `/MessageDeadLetter` | Ed25519 | Visible failures for the sender (`deadline`, `inbox_full`, …). |
| GET / POST | `/MessageSweep` | Ed25519 / admin | Deadline sweep. Messages never arrive at a silent drop. |

### OAuth, MCP, XAA

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/.well-known/oauth-authorization-server`, `/OAuthMetadata` | Public | RFC 8414. CORS `*`. |
| GET | `/.well-known/oauth-protected-resource`, `…/mcp` | Public | RFC 9728. |
| POST | `/OAuthRegister` | `X-Flair-Initial-Access-Token` | DCR. **Off** unless `FLAIR_OAUTH_DCR_TOKEN` is set (32–508 chars). Rate-limited. |
| GET / POST | `/OAuthAuthorize` | Public (user consent) | Authorization code + PKCE. |
| POST | `/OAuthToken` | Public (client + code/assertion) | Token + `jwt-bearer` (XAA). |
| POST | `/OAuthRevoke` | Public (token) | Revocation. |
| GET / POST | `/mcp` | OAuth bearer | Curated tools. **Unmounted** until `FLAIR_MCP_OAUTH=true` and an issuer. |
| GET / write | `/OAuthClient` | Admin Basic | Durable client rows. |
| GET / write | `/IdpConfig` | Admin Basic | XAA IdP registration (`flair idp add`). |
| GET | `/MCPClientMetadata` | Public / handler-gated | CIMD documents for allowed hosts. |

`OAuthAuthCode`, `OAuthToken`, and `IdJagReplay` are internal tables (no
`@export`). They hold codes, hashed tokens, and used `jti` values.

OAuth rate limits and env vars: [docs/auth.md](auth.md#rate-limiting).

### Admin UI

All `/Admin*` routes require **Admin Basic**.

| Path | Purpose |
|------|---------|
| `/Admin`, `/AdminDashboard` | Server-rendered console |
| `/AdminPrincipals` | Agents / users: view, promote, disable |
| `/AdminConnectors` | OAuth clients and sessions |
| `/AdminIdp` | IdP configuration |
| `/AdminMemory` | Browse / search memory as operator |
| `/AdminInstance` | Federation status, peers, instance |

---

## `/mcp` tools

Mounted only when OAuth MCP is on. Each tool wraps a resource above; identity
comes from the token `sub`, never from tool arguments.

| Tool | Wraps |
|------|-------|
| `memory_search` | `POST /SemanticSearch` |
| `memory_store` | `POST /Memory` |
| `memory_update` | Memory read-modify-write (in-place or `supersedes` version) |
| `memory_get` | `GET /Memory/<id>` |
| `memory_delete` | `DELETE /Memory/<id>` |
| `memory_basement` | `POST /MemoryArchive` (archive) |
| `memory_restore` | `POST /MemoryArchive` (restore) |
| `skill_store` / `skill_search` / `skill_get` | Skill-tagged Memory |
| `bootstrap` | `POST /BootstrapMemories` |
| `soul_get` | `GET /Soul` |
| `soul_set` | Soul write — still operator-gated on the resource |
| `flair_workspace_set` | `POST /WorkspaceState` |
| `flair_orgevent` | `POST /OrgEvent` |
| `attention` | `POST /AttentionQuery` |
| `record_usage` | `POST /RecordUsage` |

The stdio package `@tpsdev-ai/flair-mcp` is a separate HTTP client, not this
handler. It talks Ed25519 REST via `flair-client`.

---

## Schema

Fields below are the GraphQL attributes. Server-stamped columns are **not**
client-writable even if a client sends them. Full comments live in
`schemas/*.graphql`.

### Presence (`schemas/schema.graphql`)

| Field | Type | Notes |
|-------|------|-------|
| `agentId` | ID PK | One row per agent |
| `lastHeartbeatAt` | BigInt | Unix ms; refreshed every heartbeat |
| `currentTask` | String | Free text; verified-agent read only |
| `activity` | String | `coding` \| `reviewing` \| `planning` \| `debugging` \| `idle` |
| `activityUpdatedAt` | BigInt | When activity/task were asserted |
| `flairVersion` | String | Serving `@tpsdev-ai/flair` version |
| `harperVersion` | String | Serving Harper version |

### Memory (`schemas/memory.graphql`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | ID PK | |
| `agentId` | String! | Owner; no-forge |
| `content` | String! | Embedded text (non-skill) |
| `contentHash` | String | Near-duplicate key |
| `trigger` | String | Skill “when to use”; skill rows embed from this |
| `visibility` | String | `shared` \| `private` (durability default if omitted) |
| `embedding` | [Float] | HNSW, M:16 |
| `embeddingModel` | String | Stamp of the model that produced the vector |
| `tags` | [String] | |
| `durability` | String | `permanent` \| `persistent` \| `standard` \| `ephemeral` |
| `source` | String | |
| `createdAt` / `updatedAt` | String | |
| `expiresAt` | String | Ephemeral TTL |
| `retrievalCount` / `lastRetrieved` | | Search-hit counters (weak signal). Incremented on `MemoryHitStat` and overlaid on Memory reads — search no longer rewrites the Memory row. |
| `usageCount` | Int | Verified-use signal; only `RecordUsage` / citations increment |
| `promotionStatus` / `promotedAt` / `promotedBy` | | REM promotion |
| `archived` / `archivedAt` / `archivedBy` | | Basement |
| `parentId` / `derivedFrom` / `sessionId` / `lastReflected` | | Learning pipeline |
| `supersedes` | String | Version chain |
| `subject` / `summary` | String | Compression: subject → summary → content |
| `validFrom` / `validTo` | String | Temporal validity; expired rows drop out of search |
| `_safetyFlags` | [String] | Content-safety scan |
| `provenance` | String | Server JSON `{ v, verified, claimed? }` |
| `originatorInstanceId` | String | Write-time instance id; preserved across sync |
| `metadata` | String | Client JSON blob; opaque to the server |
| `entities` | [String] | Attention-plane `type:value` strings |

### Soul

| Field | Type | Notes |
|-------|------|-------|
| `id` | ID PK | Typically `agentId:key` |
| `agentId` | String! | Owner |
| `key` / `value` | String | Personality / procedure entry |
| `priority` | String | `critical` \| `high` \| `standard` \| `low` |
| `metadata` | String | JSON (skill governance, etc.) |
| `provenance` | String | Operator/internal author + `sourceClass` |
| `durability` | String | Default `permanent` |
| `createdAt` / `updatedAt` | String | |
| `originatorInstanceId` | String | Federation origin |

### Agent (Principal)

The Agent table **is** the Principal table. Pre-1.0 rows without `kind` are
agents.

| Field | Type | Notes |
|-------|------|-------|
| `id` | ID PK | Agent id |
| `name` | String! | |
| `role` / `type` | String | Legacy; `role` reconciles with `admin` |
| `kind` | String | `human` \| `agent` |
| `displayName` | String | |
| `status` | String | `active` \| `deactivated` |
| `publicKey` | String! | Ed25519 public key |
| `defaultTrustTier` | String | `endorsed` \| `corroborated` \| `unverified` |
| `admin` | Boolean | Principal-table admin bit |
| `runtime` / `runtimeEndpoint` | String | How to reach the principal |
| `subjects` | [String] | Soul-level interests |
| `createdAt` / `updatedAt` | String | |
| `originatorInstanceId` | String | Federation origin |

Related: **Credential** (`principalId`, `kind` webauthn / bearer-token /
ed25519 / idp) and **Integration** (legacy platform connection).

### Federation tables (`schemas/federation.graphql`)

| Type | REST? | Purpose |
|------|-------|---------|
| **Instance** | yes | One row per Flair instance (`id`, `publicKey`, `role` hub/spoke, `fabricEndpoint`, `status`) |
| **PairingToken** | yes | One-time token (`expiresAt`, `consumedBy`) |
| **Peer** | yes | Pinned peer (`publicKey`, `endpoint`, `status`, `lastSyncAt` / `lastMergeAt`, `lastSyncCursor`, `relayOnly`) |
| **Nonce** | no | Body-sig anti-replay; PK is the nonce string |
| **SyncLog** | no | Per-sync audit (`peerId`, `direction`, counts, `skippedReasons`, `status`) |

### Other tables

| Type | File | REST? | Role |
|------|------|-------|------|
| **Relationship** | memory.graphql | yes | `subject` / `predicate` / `object` + temporal bounds + provenance |
| **MemoryGrant** | memory.graphql | yes | `ownerId`, `granteeId`, `scope`, `filter` |
| **MemoryUsage** | memory.graphql | yes | Dedup ledger; PK `${agentId}:${memoryId}` |
| **MemoryHitStat** | memory.graphql | no | Search-hit ledger (`retrievalCount`, `lastRetrieved`); overlaid onto Memory reads |
| **MemoryCandidate** | memory.graphql | yes | REM draft (`claim`, `status`, `scopeTag`, visibility ruling) |
| **Asset** | memory.graphql | yes | Blob (`contentType`, `data`) owned by `agentId`, linked by `memoryId` |
| **WorkspaceState** | workspace.graphql | yes | Current work (`ref`, `provider`, `phase`, `entities`) |
| **OrgEvent** | event.graphql | yes | Org-visible event (`authorId`, `kind`, `summary`, `entities`) |
| **AgentReadPosition** | agent.graphql | no | Per-agent watermark (`agentId`, `stream`, `position`). HTTP via `/AgentReadPosition`, not raw-table REST. |
| **Message** | message.graphql | yes | Signed envelope (`from`, `to`, `threadId`, `seq`, `state`, `signature`) |
| **OAuthClient** | oauth.graphql | yes | Registered OAuth clients |
| **OAuthAuthCode** | oauth.graphql | no | Single-use codes + PKCE |
| **OAuthToken** | oauth.graphql | no | Hashed access/refresh tokens |
| **IdpConfig** | oauth.graphql | yes | XAA IdP (`issuer`, `jwksUri`, `requiredDomain`) |
| **IdJagReplay** | oauth.graphql | no | Used ID-JAG `jti` values |

---

## See also

- [docs/auth.md](auth.md) — Ed25519, OAuth 2.1, XAA, Soul authorship
- [docs/federation.md](federation.md) — pairing, sync, CLI
- [docs/rem.md](rem.md) — MemoryCandidate promote/reject
- [docs/entity-vocabulary.md](entity-vocabulary.md) — `entities` grammar
- [docs/embedding-in-a-harper-app.md](embedding-in-a-harper-app.md) — in-process API
- [`packages/flair-client/README.md`](../packages/flair-client/README.md) — typed HTTP client
