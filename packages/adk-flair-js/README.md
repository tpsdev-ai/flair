# adk-flair — Flair memory backend for Google ADK (JS/TS)

`@tpsdev-ai/adk-flair` is a TypeScript memory service that backs
[Google ADK](https://github.com/google/adk-js) agents with
[Flair](https://github.com/tpsdev-ai/flair) — a self-hosted, federated
semantic memory engine. Keep your agent memory yours.

## Quickstart

```bash
# 1. Install Flair and initialise it
npm i -g @tpsdev-ai/flair
flair init

# 2. Provision an Ed25519 identity for your ADK app
flair agent add my-adk-app
# → writes ~/.flair/keys/my-adk-app.key

# 3. Install adk-flair
npm install @tpsdev-ai/adk-flair

# 4. Set environment variables
export FLAIR_URL=http://localhost:19926
export FLAIR_AGENT_ID=my-adk-app
export FLAIR_KEYFILE=~/.flair/keys/my-adk-app.key
export GOOGLE_API_KEY=...   # or GEMINI_API_KEY, to run the agent
```

Then swap the memory service in your ADK agent (illustrative — `agent` and
`sessionService` are your own, see the runnable example below for the full
wiring):

```typescript
import { FlairMemoryService } from "@tpsdev-ai/adk-flair";
import { Agent, Runner, InMemorySessionService, PRELOAD_MEMORY } from "@google/adk";

const memoryService = new FlairMemoryService({
  url: process.env.FLAIR_URL,          // http://localhost:19926
  agentId: process.env.FLAIR_AGENT_ID, // my-adk-app
  keyfile: process.env.FLAIR_KEYFILE,  // ~/.flair/keys/my-adk-app.key (~ is expanded)
});

const agent = new Agent({
  model: "gemini-2.5-flash",
  name: "my_agent",
  instruction: "You are a helpful assistant with memory.",
  tools: [PRELOAD_MEMORY],             // pulls past memories into the prompt
});

const runner = new Runner({
  agent,
  appName: "my-app",
  sessionService: new InMemorySessionService(),
  memoryService,
});
```

### Run it end to end

A complete, copy-paste-runnable demo lives at
[`examples/quickstart.ts`](./examples/quickstart.ts). After the steps above:

```bash
bun run examples/quickstart.ts
```

It plants a fact in session 1, waits for Flair to make it searchable, then
asks for it back in a fresh session 2 and prints whether the fact was recalled.

### Dev UI (AdkApiServer)

```typescript
import { AdkApiServer } from "@google/adk";

const server = new AdkApiServer({
  memoryService: new FlairMemoryService(),
});
server.start();
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `FLAIR_URL` | No | `http://localhost:19926` | Flair HTTP endpoint |
| `FLAIR_AGENT_ID` | Yes | — | Flair agent identity |
| `FLAIR_KEYFILE` | Yes | — | Path to the Ed25519 keyfile from `flair agent add` (raw seed; base64/PEM also accepted). A leading `~` is expanded. |
| `FLAIR_ALLOW_REMOTE_URL` | No | — | Set to `1` to allow non-localhost URLs |

All values can also be passed directly to the constructor.

Hosted Flair (non-localhost `FLAIR_URL`) uses the same Ed25519 triple as the
Python package — agent id, keyfile, server-side `Agent` row with a matching
public key. A 404 on `GET`/`PUT /Memory/{id}` is fail-closed ownership, not
an existence signal. Walkthrough:
[docs/integrations.md — Hosted Flair auth](../../docs/integrations.md#hosted-flair-auth--your-agent-got-a-404).

## Architecture

### Scope model

Each ADK app authenticates as **one Flair agent** (its service identity).
Per-user isolation is enforced by a **compound tag** — `adk:<app_name>:<user_id>`
— attached to every record and filtered on every search. Reserved characters
(`%`, `:`, `_`) in `app_name` or `user_id` are percent-encoded so distinct
identities never collide and the `:` delimiter stays unambiguous.

### Search path

- `user_id` is mandatory — empty/missing returns empty, never searches unscoped
- Every hit is re-verified against the compound tag before mapping to `MemoryEntry`
- Timeout budget: 2s total (connect 500ms, read 1500ms), one attempt, no retry
- Search failures degrade silently with a structured warning (host, elapsed, phase)

### Write path

- Deterministic record IDs: `app:user:session:eventId` — re-ingestion upserts.
  Direct `addMemory()` writes use the entry's `id` when supplied, else the
  first 32 hex chars of the content's SHA-256 (re-adds replace, not duplicate)
- Creates ride `POST /Memory/` (the create verb) with the id in the body; a
  `409` (record already exists) falls back to `PUT /Memory/{id}`, preserving
  replace semantics — a PUT-shaped create 404s on Harper deployments where
  PUT is update-only (flair#1336)
- Write failures log a structured warning (session id, event count, HTTP status)
- No-text events are filtered (Vertex parity)

## Security

### Raw text is sent to the configured Flair instance

All memory content — session transcripts, user messages, agent responses —
is transmitted as raw text to the Flair instance at the configured URL.
The Flair operator (which may be you) has full access to this data.
Do not point `FLAIR_URL` at an instance you do not trust.

### Metadata-level isolation, not cryptographic isolation

All users of one ADK app share one Flair principal. Per-user isolation is
enforced by tag-based server-side filtering, not cryptographic key separation.
A bug in that filter would leak cross-user memories. For key-level isolation,
use per-org Flair principals (the org layer).

## API

### `FlairMemoryService`

Implements `BaseMemoryService` from `@google/adk`.

#### Required methods (called by ADK)

- **`addSessionToMemory(session)`** — batch-write session events to Flair
- **`searchMemory(request)`** — semantic search with compound-tag scoping

#### Extra methods (Vertex parity, not called by ADK)

- **`addEventsToMemory(appName, userId, events, sessionId, customMetadata?)`** — incremental per-turn writes
- **`addMemory(appName, userId, memories, customMetadata?, opts?)`** — direct
  memory writes. `opts`: `{ subject?, durability?, visibility? }`
- **`listMemories(appName, userId, { limit?, offset? })`** — Flair-specific
  browsing extension (NOT part of `BaseMemoryService`)

### Custom metadata & subject

`customMetadata` (an arbitrary JSON-serializable object) is stored on every
record a write call produces, as an opaque blob on the record's `metadata`
field, and round-trips back on `FlairMemoryEntry.customMetadata` from
`searchMemory` / `listMemories`.

**Store-and-return only** — ADK's contract: no key inside the blob has ANY
server-side effect. `{"visibility": "shared"}` in the blob does **not** share
the memory; use the explicit `opts.visibility` for that. Caps (throw before
any write; reject, never truncate): 64KB serialized, nesting depth ≤ 16,
≤ 512 total keys. Non-JSON-serializable values skip that key with a warning.

`subject` is a short human-readable title (≤ 512 chars) promoted to the
record's top-level indexed `subject` column — supplied via `opts.subject` or
`customMetadata.subject` (the explicit option is authoritative when both are
present), never auto-extracted from content. On read it surfaces both as
`entry.subject` and `customMetadata["subject"]` (the column is authoritative
over a divergent blob key; the `customMetadata` channel matches the Python
package's return shape exactly).

Read-path notes: `searchMemory` opts into `/SemanticSearch`'s
`includeMetadata` projection flag; a malformed stored blob fails soft to `{}`
with a warning naming the record id (a corrupt blob never takes recall down).
Returned entries also carry the record `id`, `author` (the writing Flair
agent id), and `timestamp` (the record's `createdAt`).

### listMemories

Lists an app+user's memories newest-first (`createdAt` DESC) with the full
projection — no query needed. Scope is the compound tag AND the service's
agent identity, both pushed down server-side and re-verified client-side.
`limit` is 1..200 — over-cap **rejects** (never silently clamps); `offset` is
positional over a point-in-time snapshot, not a live cursor. Unlike
`searchMemory` (whose swallow-to-empty contract is ADK's), transport and HTTP
failures **propagate** — a browsing UI must be able to tell "no memories"
from "Flair is down".

## License

Apache-2.0
