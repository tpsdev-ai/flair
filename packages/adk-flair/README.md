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
# → writes ~/.flair/keys/my-adk-app.key

# 3. Install adk-flair (litellm powers the Gemini model in the example)
pip install adk-flair litellm

# 4. Set environment variables
export FLAIR_URL=http://localhost:19926
export FLAIR_AGENT_ID=my-adk-app
export FLAIR_KEYFILE=$HOME/.flair/keys/my-adk-app.key
export GOOGLE_API_KEY=...   # or GEMINI_API_KEY, to run the agent

# 5. Use in your agent
#    from adk_flair import FlairMemoryService
#    memory_service = FlairMemoryService()
#    agent = LlmAgent(..., memory_service=memory_service)

# 6. Or via the CLI / dev UI (requires services.py — see below)
adk web --memory_service_uri="flair://localhost:19926"
```

### Run it end to end

A complete, copy-paste-runnable demo lives at
[`examples/quickstart.py`](./examples/quickstart.py). After the steps above:

```bash
python examples/quickstart.py
```

It plants a fact in session 1, waits for Flair to make it searchable, then
asks for it back in a fresh session 2 and prints whether the fact was recalled.

## Configuration

| Setting          | Env var            | Default                       | Notes                                    |
|------------------|--------------------|-------------------------------|------------------------------------------|
| Server URL       | `FLAIR_URL`        | `http://localhost:19926`      | Must be localhost unless opt-in (below)  |
| Agent ID         | `FLAIR_AGENT_ID`   | (required)                    | Must match `flair agent add <id>`        |
| Private key path | `FLAIR_KEYFILE`    | (required)                    | Keyfile from `flair agent add` (raw seed; base64/PEM also accepted). A leading `~` is expanded. |
| Allow remote URL | `FLAIR_ALLOW_REMOTE_URL` | (unset)                 | Set to `1` to allow non-localhost URLs   |
| HTTP timeout     | `FLAIR_HTTP_TIMEOUT` | (unset — fail-fast defaults, read 1.5s) | Read/write timeout in seconds (float). Set for hosted Flair (below). |
| Connect timeout  | `FLAIR_HTTP_CONNECT_TIMEOUT` | (unset — derived)     | Connect/pool timeout in seconds (float). Rarely needed on its own. |

All settings can also be passed as constructor arguments:

```python
FlairMemoryService(
    url="http://localhost:19926",
    agent_id="my-adk-app",
    keyfile="/home/agent/.flair/keys/my-adk-app.key",
)
```

### Explicit durability and visibility (opt-in)

The `add_memory()` method accepts optional `durability` and `visibility` keyword
args that let application code control how memories persist and who can read them:

```python
await memory_service.add_memory(
    app_name="my-app",
    user_id="user-123",
    memories=[...],
    durability="persistent",     # permanent | persistent | standard | ephemeral
    visibility="shared",         # private | shared
)
```

- **Omitted (default)** -> `durability=standard`, **no visibility key** in the
  POST body. The server applies its durability-keyed default
  (standard/ephemeral -> `private`, permanent/persistent -> `shared`).
- **Supplied** -> included in the POST body verbatim. The server still validates
  against the allowed enum values (same set: `permanent`, `persistent`, `standard`,
  `ephemeral` for durability; `private`, `shared` for visibility).

These knobs are a **trust-anchor opt-in**: application code sets them, not the
LLM. If your adapter wraps `add_memory()` in an LLM-callable tool, **fix the
durability/visibility flags in the wrapper** -- the model should never choose them.

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

To connect to a remote Flair instance, set `FLAIR_ALLOW_REMOTE_URL=1` — and
raise the HTTP timeout, because the defaults are tuned for localhost fail-fast
(read 1.5s) and will time out ordinary searches over TLS/WAN latency:

```bash
export FLAIR_ALLOW_REMOTE_URL=1
export FLAIR_URL=https://flair.example.com:19926
export FLAIR_HTTP_TIMEOUT=30
```

Equivalently in code: `FlairMemoryService(timeout=30.0)` (float seconds), or
pass a full `httpx.Timeout` for per-phase control. The constructor argument
wins over the env var.

The resolved URL and the effective timeouts are logged once at WARNING on the
first request.

## Hosted Flair

If your ADK agent just got a 404 against a hosted Flair, read this before
changing verbs or pasting admin credentials into the environment.

The same identity model applies to every Ed25519 adapter. The shared write-up
is [docs/integrations.md — Hosted Flair auth](../../docs/integrations.md#hosted-flair-auth--your-agent-got-a-404).
This section is the ADK-shaped version.

### Identity is three things that must match

`adk-flair` signs every request with an Ed25519 key. The hosted instance
accepts the request only when all three line up:

1. **`FLAIR_AGENT_ID`** — the id inside the signature. Must be the id you
   registered, not a display name and not a different agent's id.
2. **`FLAIR_KEYFILE`** — the private key on **this** machine (the one running
   ADK). `flair agent add` writes `~/.flair/keys/<id>.key`. A leading `~` is
   expanded. The private key never leaves the host.
3. **A server-side `Agent` row on the instance at `FLAIR_URL`** whose
   `publicKey` matches that keyfile. Registration is per instance. A key
   minted by local `flair init` / `flair agent add` (no `--target`) is not
   registered on Fabric.

```bash
export FLAIR_ALLOW_REMOTE_URL=1
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com
export FLAIR_AGENT_ID=my-adk-app
export FLAIR_KEYFILE=$HOME/.flair/keys/my-adk-app.key
export FLAIR_HTTP_TIMEOUT=30   # defaults are localhost fail-fast; see above

# Register THIS id against THAT instance (ops URL is not data-port − 1 on Fabric)
flair agent add my-adk-app \
  --target "$FLAIR_URL" \
  --ops-target <ops-url> \
  --admin-pass-file ~/.flair/fabric-admin-pass
```

The full Fabric registration sequence, including the ops port trap and
`--admin-pass-file`, is [docs/quickstart-fabric.md](../../docs/quickstart-fabric.md).
Do not leave the Fabric admin password in the agent's standing env — it is
for registration, once.

### The three failure shapes

| Shape | What is true | What you see | What to do |
|---|---|---|---|
| **Record missing** | No `Agent` row for `FLAIR_AGENT_ID` on this `FLAIR_URL` | `401 {"error":"unknown_agent"}` on every signed call (`add_memory`, search, list) | `flair agent add` with `--target` / `--ops-target` as above. `flair agent list` is localhost-only — it cannot see the hosted registry. |
| **Key mismatch** | The id exists; the public key on the server is not the key in `FLAIR_KEYFILE` | `401 {"error":"invalid_signature"}` | Same id, wrong file — copied from another host, rotated on one side only, or `FLAIR_KEYFILE` pointing at a different agent's key. Point `FLAIR_KEYFILE` at the key that matches this instance, or re-seed the hosted row from this machine's key (`flair agent add my-adk-app --target "$FLAIR_URL" --ops-target <ops-url> --admin-pass-file <path>` reuses the local file). `flair agent rotate-key` is localhost-only. Restart the ADK process so it reloads the key. |
| **Config wrong** | Identity may be fine; you are not hitting the Flair you think | Timeouts, `ConnectError`, or **404 from Harper's catch-all** | Confirm `FLAIR_ALLOW_REMOTE_URL=1`, a raised `FLAIR_HTTP_TIMEOUT`, and a `FLAIR_URL` with **no path prefix**. Cloud-agent localhost is the VM, not your laptop. `/Health` can be 200 while `/Memory` is still 404 if the Flair app is not loaded yet. |

Clock skew is a fourth, rarer 401: `timestamp_out_of_window`.

### 404 on by-id routes is not an existence signal

`GET /Memory/{id}` and `PUT /Memory/{id}` return **404** both when the id is
absent **and** when the record exists but this principal may not see it
(another agent's `private` memory, or outside the read scope). Same status,
same body. That is fail-closed ownership
([flair#1264](https://github.com/tpsdev-ai/flair/issues/1264)) — a 403 would
confirm the id exists and can name the owner.

**Do not treat that 404 as "the record is missing, so create it" or "Harper
rejected the verb."** This package already creates via `POST /Memory/` (id
in the body) and falls back to PUT only on 409. A by-id 404 after a write
usually means you are not the owner the server thinks you are — the three
shapes above — not that you should switch POST for PUT.

`search_memory` swallows transport failures to empty (ADK's contract).
`list_memories` and the write path raise `FlairRequestError` with
`.status_code` — read that status before guessing.

## Security

### Per-user isolation

All users of one ADK app share one Flair principal. Per-user isolation is
enforced by tag-based server-side filtering, not cryptographic key separation.
A bug in that filter would leak cross-user memories. For key-level isolation,
use per-org Flair principals (the org layer).

### Tag encoding

The compound scope tag uses `:` as a delimiter (`adk:<app_name>:<user_id>`).
Reserved characters (`:`, `_`, `%`) are percent-encoded so distinct inputs never
collide: `user_id = "alice:admin"` → `alice%3Aadmin` (not `alice_admin`).
This is a reversible, collision-free encoding.

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
    author=record.get("agentId"),       # the writing Flair agent
    timestamp=record.get("createdAt"),  # ISO 8601
    custom_metadata={...},              # parsed metadata blob; see below
)
```

`author` is the Flair agent id that wrote the record. `custom_metadata` is the
stored metadata blob parsed back to a dict (see the custom_metadata section);
when the record carries a top-level `subject`, it is surfaced as
`custom_metadata["subject"]` — `MemoryEntry` has no subject attribute, so the
dict is its return channel.

## Idempotent writes

Record ids are deterministic: `{app_name}:{user_id}:{session_id}:{event.id}`.
Re-ingestion upserts the same record, statelessly. Flair's REM consolidates
content; it never sees duplicates.

## custom_metadata

`custom_metadata` is **stored and returned** (flair#1332): the dict you pass to
`add_memory()` / `add_events_to_memory()` is serialized to JSON, stored on the
Flair record's `metadata` field, and round-trips back on
`MemoryEntry.custom_metadata` from `search_memory()` and `list_memories()` —
nesting and typing preserved.

```python
await memory_service.add_memory(
    app_name="my-app",
    user_id="user-123",
    memories=[...],
    custom_metadata={
        "merchant": "acme",
        "price": {"amount": 12.5, "currency": "EUR"},
        "media_url": "s3://receipts/2026-08/acme.jpg",
    },
)
```

**Store-and-return only.** That is ADK's own contract for the field (no ADK
implementation filters searches by `custom_metadata`), and Flair honors it
strictly: the blob is opaque to the server — never parsed, never queried, and
**no key in it has any server-side effect**. `{"visibility": "shared"}` inside
`custom_metadata` does not share the memory; use the explicit `visibility`
parameter for that. You also cannot filter searches by a metadata key; if a
key needs filtering, that's a schema promotion (like `subject` below), not a
blob read.

Caps — violations **reject with `ValueError` before anything is written**
(never truncated: a silently truncated blob would corrupt the round-trip
guarantee):

- 64KB serialized JSON
- nesting depth ≤ 16
- ≤ 512 total keys

A value that isn't JSON-serializable skips **that key** with a WARNING naming
the session — the rest of the blob is stored. Malformed JSON encountered on
read fails soft: that entry's `custom_metadata` is `{}` and a WARNING names
the record id.

### subject

A short human-readable title (≤ 512 chars), promoted to the Flair record's
top-level indexed `subject` column — cleanly queryable and usable by UIs,
unlike a blob key. Two ways to set it; the explicit parameter wins when both
are present. It is **never** auto-extracted from content.

```python
await memory_service.add_memory(
    app_name="my-app", user_id="user-123", memories=[...],
    subject="Receipt: Acme Groceries",          # explicit param (authoritative)
    # or: custom_metadata={"subject": "..."}    # promoted from the blob
)
```

On read, the stored column value is surfaced as `custom_metadata["subject"]`
(the column is authoritative over a divergent blob key).

### Security caveat

Memory content **and metadata** are untrusted input to the consuming agent's
context — treat every retrieved value like any retrieved document: render,
don't execute; quote, don't trust. The adapter deliberately does **no**
sanitization of metadata values: sanitization of free-form JSON is lossy (it
corrupts the round-trip the field exists for) and gives false safety (no
blocklist anticipates the consuming context). The boundary that matters is
yours: whatever reads these values back must treat them as data.

## list_memories

`list_memories()` is a **Flair-specific extension** — it is *not* part of
ADK's `BaseMemoryService` (which specifies only `search_memory`). Use it for
memory review UIs, dashboards, or agent browsing where there's no query to
search with:

```python
entries = await memory_service.list_memories(
    app_name="my-app",
    user_id="user-123",
    limit=50,    # 1..200 — over the cap raises ValueError (never clamps)
    offset=0,    # positional skip from the newest record
)
```

- Returns `List[MemoryEntry]`, newest first (`createdAt` descending), with the
  full projection: content, `author`, `timestamp`, `custom_metadata`
  (including `subject`).
- Scoped exactly like `search_memory`: the `adk:<app>:<user>` compound tag AND
  the service's own agent identity, both pushed down server-side and
  re-verified client-side on every row.
- **Pagination is a point-in-time snapshot** — `offset` is positional, not a
  live cursor. Writes between two page fetches shift positions, so a record
  can appear twice or be skipped across page boundaries; dedupe by `id` if you
  page a moving corpus.
- Unlike `search_memory` (whose swallow-to-empty posture is ADK's contract),
  `list_memories` **raises** on transport/server failure — a browsing UI must
  be able to tell "no memories" from "Flair is down".

## Agent tools

Pre-built tool functions so the model itself can store and recall memories —
no boilerplate tool authoring:

```python
from adk_flair import FlairMemoryService, create_flair_tools

memory_service = FlairMemoryService()
agent = LlmAgent(
    model="gemini-2.5-flash",
    name="assistant",
    tools=create_flair_tools(memory_service, app_name="my-app", user_id="user-123"),
)
```

`create_flair_tools()` returns three plain async functions —
`store_memory(subject, description, tags=None, custom_metadata=None)`,
`search_memory(query, limit=5)` and `list_memories(limit=20, offset=0)` —
which ADK wraps in `FunctionTool` automatically and turns into Gemini function
declarations from their signatures and docstrings. Everything is explicit
injection: the service and the `app_name`/`user_id` scope are arguments you
pass at creation time, so the wiring stays auditable and the model can never
pick its own memory scope (no ambient identity, no env-var or registry
discovery). Create one tool set per user/session. `tags` are stored inside
the memory's `custom_metadata` under `"tags"` — descriptive labels that
round-trip on search and list, never part of the record's scope-tag array.

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
