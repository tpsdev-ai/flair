# adk-flair — Flair memory backend for Google ADK (JS/TS)

`@tpsdev-ai/adk-flair` is a TypeScript memory service that backs
[Google ADK](https://github.com/google/adk-js) agents with
[Flair](https://github.com/tpsdev-ai/flair) — a self-hosted, federated
semantic memory engine. Keep your agent memory yours.

```bash
npm install @tpsdev-ai/adk-flair
```

## Quickstart

Swap the memory service in your ADK agent:

```typescript
import { FlairMemoryService } from "@tpsdev-ai/adk-flair";
import { Runner } from "@google/adk";

const memoryService = new FlairMemoryService({
  url: "http://localhost:19926",
  agentId: "my-adk-app",
  keyfile: "~/.flair/keys/my-adk-app.key",
});

const runner = new Runner({
  agent,
  appName: "my-app",
  sessionService,
  memoryService,
});
```

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
| `FLAIR_KEYFILE` | Yes | — | Path to Ed25519 PKCS8 base64 keyfile |
| `FLAIR_ALLOW_REMOTE_URL` | No | — | Set to `1` to allow non-localhost URLs |

All values can also be passed directly to the constructor.

## Architecture

### Scope model

Each ADK app authenticates as **one Flair agent** (its service identity).
Per-user isolation is enforced by a **compound tag** — `adk:<app_name>:<user_id>`
— attached to every record and filtered on every search. Colons in `app_name`
or `user_id` are replaced with underscores to prevent delimiter breakage.

### Search path

- `user_id` is mandatory — empty/missing returns empty, never searches unscoped
- Every hit is re-verified against the compound tag before mapping to `MemoryEntry`
- Timeout budget: 2s total (connect 500ms, read 1500ms), one attempt, no retry
- Search failures degrade silently with a structured warning (host, elapsed, phase)

### Write path

- Deterministic record IDs: `app:user:session:eventId` — re-ingestion upserts
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

- **`addEventsToMemory(appName, userId, events, sessionId)`** — incremental per-turn writes
- **`addMemory(appName, userId, memories)`** — direct memory writes

## License

Apache-2.0
