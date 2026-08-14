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
