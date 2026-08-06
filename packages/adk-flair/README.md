# adk-flair — Flair memory backend for Google ADK

[Flair](https://github.com/tpsdev-ai/flair) is the open-source memory + identity
layer for agents. `adk-flair` makes Flair the durable memory backend for
[Google ADK](https://github.com/google/adk-python) agents — self-hosted,
federated, portable to your non-ADK agents.

Drop-in for ADK's `InMemoryMemoryService`. The same memories your ADK agent
writes are then visible to every other Flair-enabled harness:

- Claude Code / Gemini CLI / Codex CLI (via `@tpsdev-ai/flair-mcp`)
- Hermes (via `hermes-flair`)
- OpenClaw (via `@tpsdev-ai/openclaw-flair`)
- n8n (via `@tpsdev-ai/n8n-nodes-flair`)
- LangGraph (via `@tpsdev-ai/langgraph-flair`)

## Why Flair underneath ADK

Vertex AI Memory Bank is the managed `memory.load(userId)` — the assumption we
position against. ADK's memory layer is a **designed third-party seam**
(`BaseMemoryService` + a documented `services.py`/`services.yaml` scheme
registry), and Google's maintainers have ruled that non-Google backends live
outside core. `adk-flair` makes the pitch concrete: run your agent on Google's
stack, keep your memory yours — self-hosted, federated, portable. Consolidation
belongs to the memory, not the vendor.

## Quickstart

```bash
# 1. Install Flair
npm i -g @tpsdev-ai/flair
flair init

# 2. Provision an Ed25519 identity for your ADK app
flair agent add my-adk-app
# → writes ~/.flair/keys/my-adk-app.key (PKCS8 base64)

# 3. Install adk-flair
pip install adk-flair

# 4. Set environment variables
export FLAIR_URL=http://localhost:19926
export FLAIR_AGENT_ID=my-adk-app
export FLAIR_KEYFILE=$HOME/.flair/keys/my-adk-app.key

# 5. Use in your agent
#    from adk_flair import FlairMemoryService
#    memory_service = FlairMemoryService()
#    agent = LlmAgent(..., memory_service=memory_service)

# 6. Or via the CLI / dev UI (requires services.py — see below)
adk web --memory_service_uri="flair://localhost:19926"
```

## Configuration

| Setting          | Env var            | Default                       | Notes                                    |
|------------------|--------------------|-------------------------------|------------------------------------------|
| Server URL       | `FLAIR_URL`        | `http://localhost:19926`      | Must be localhost unless opt-in (below)  |
| Agent ID         | `FLAIR_AGENT_ID`   | (required)                    | Must match `flair agent add <id>`        |
| Private key path | `FLAIR_KEYFILE`    | (required)                    | PKCS8 base64 Ed25519 key                 |
| Allow remote URL | `FLAIR_ALLOW_REMOTE_URL` | (unset)                 | Set to `1` to allow non-localhost URLs   |

All settings can also be passed as constructor arguments:

```python
FlairMemoryService(
    url="http://localhost:19926",
    agent_id="my-adk-app",
    keyfile="/home/agent/.flair/keys/my-adk-app.key",
)
```

## services.py registration

To use `adk-flair` via the `flair://` URI scheme (CLI, dev UI, eval harness),
add a `services.py` to your agent directory:

```python
from adk_flair import register
register()
```

Or use `services.yaml`:

```yaml
services:
  - scheme: flair
    type: memory
    class: adk_flair.memory_service.FlairMemoryService
```

Then:

```bash
adk web --memory_service_uri="flair://localhost:19926"
```

## Remote Flair URLs

By default, `adk-flair` only allows localhost URLs (`localhost`, `127.0.0.1`,
`::1`, `[::1]`). This prevents a typo'd `FLAIR_URL` from silently shipping
every user query to a stranger.

To connect to a remote Flair instance, set `FLAIR_ALLOW_REMOTE_URL=1`:

```bash
export FLAIR_ALLOW_REMOTE_URL=1
export FLAIR_URL=https://flair.example.com:19926
```

The resolved URL is logged once at WARNING on the first request.

## Security

### Per-user isolation

All users of one ADK app share one Flair principal. Per-user isolation is
enforced by tag-based server-side filtering, not cryptographic key separation.
A bug in that filter would leak cross-user memories. For key-level isolation,
use per-org Flair principals (the org layer).

### Tag encoding

The compound scope tag uses `:` as a delimiter (`adk:<app_name>:<user_id>`).
Colons in `app_name` or `user_id` are replaced with `_` to prevent delimiter
ambiguity. A `user_id` of `org:admin` becomes the tag segment `org_admin`.

### Key safety

The Ed25519 private key never leaves the host. Only signed requests cross the
wire. The keyfile is parsed and validated in the constructor — a missing or
invalid key raises `ValueError` immediately, never deferring the failure to
first use (where ADK's exception-swallowing search path would turn it into
permanent silent empty recall).

### URL safety

Non-localhost URLs refuse to construct unless `FLAIR_ALLOW_REMOTE_URL=1` is
set. The error message names the exact URL it refused. This is a control, not
just documentation — a typo'd `FLAIR_URL` cannot silently exfiltrate queries.

## Timeouts

The search path has a 2s total budget covering the full lifecycle including DNS:

- Connect: 0.5s
- Read: 1.5s
- Write: 1.0s
- Pool: 0.5s

One attempt, no retry on the turn path. A hung Flair will never add seconds to
every turn. Write paths use the same timeout budget and log structured warnings
on failure (session id, event count, HTTP status).

## Scope mapping

ADK scopes everything by `{app_name, user_id}`. Flair's model is agentId-keyed.
The adapter bridges this with a **compound tag** — `adk:<app_name>:<user_id>` —
on every record, filtered on every search.

- `user_id` is **mandatory** in the search path — missing/empty returns empty,
  never searches unscoped.
- The adapter **re-verifies the compound tag on every search hit** before
  mapping it out — defense-in-depth against filter bypass.
- `user_id` comes from ADK's session context, never from caller-supplied input.

## MemoryEntry mapping

Search hits are mapped to ADK's `MemoryEntry` type:

```python
MemoryEntry(
    id=record["id"],
    content=types.Content(role="model", parts=[types.Part(text=record["content"])]),
    author=record.get("author"),
    timestamp=record.get("createdAt"),  # ISO 8601
)
```

## Idempotent writes

Record ids are deterministic: `{app_name}:{user_id}:{session_id}:{event.id}`.
Re-ingestion upserts the same record, statelessly. Flair's REM consolidates
content; it never sees duplicates.

## custom_metadata

`custom_metadata` keys are not supported by `adk-flair`. Passing unsupported
keys logs a warning once per session — a user setting TTL must not believe it
worked.

## What this adapter deliberately doesn't do

- **No consolidation logic.** Flair's REM (nightly) owns consolidation — the
  adapter stays small.
- **No `retrieve_profiles` parity.** Phase 2.
- **No TTL/revision semantics.** Phase 2.
- **No per-user Flair principals.** One Flair agent per ADK app. Per-user
  principals are key sprawl at user cardinality.
- **No Flair server changes.** This adapter works against any existing Flair
  deployment.

## License

Apache 2.0 — same as Flair and Google ADK.
