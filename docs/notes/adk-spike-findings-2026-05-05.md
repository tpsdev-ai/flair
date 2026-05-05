# Google ADK Spike — Plugin Contract Findings

**Date:** 2026-05-05
**Investigator:** Ember
**Scope:** Verify plugin contract for a `flair-adk-py` adapter

---

## Q1: ADK Basics — Exists? Open-source? Python?

**Yes.** Google ADK is a real, open-source, Python-first framework.

| Field | Value |
|---|---|
| **Package** | `google-adk` on PyPI |
| **Current version** | 1.32.0 (released 2026-04-30) |
| **Repo** | https://github.com/google/adk-python |
| **License** | Apache 2.0 |
| **Docs** | https://google.github.io/adk-docs/ |
| **Language** | Python (primary). Java, Go, and TypeScript ports exist at `google/adk-java`, `google/adk-go`, `waldzellai/adk-typescript` |
| **Samples** | https://github.com/google/adk-samples |

From `pyproject.toml`:
```toml
name = "google-adk"
```

---

## Q2: Memory Contract — Abstract Class for Custom Backends

ADK defines `BaseMemoryService(ABC)` in `google/adk/memory/base_memory_service.py`. This is the contract custom memory backends implement — equivalent to LangChain's `BaseChatMemory` or n8n's `BaseListChatMessageHistory`.

### Interface signature

```python
class BaseMemoryService(ABC):
    """Base class for memory services."""

    # --- REQUIRED (abstract) methods ---

    @abstractmethod
    async def add_session_to_memory(self, session: Session) -> None:
        """Ingest a full session's events into memory.
        
        Called periodically or on-demand to persist conversation history.
        Session may be added multiple times during its lifetime.
        """

    @abstractmethod
    async def search_memory(
        self, *,
        app_name: str,
        user_id: str,
        query: str,
    ) -> SearchMemoryResponse:
        """Semantic/text search over ingested memories for a user.
        
        Returns SearchMemoryResponse containing list[MemoryEntry].
        """

    # --- OPTIONAL (default: raise NotImplementedError) ---

    async def add_events_to_memory(
        self, *,
        app_name: str,
        user_id: str,
        events: Sequence[Event],
        session_id: str | None = None,
        custom_metadata: Mapping[str, object] | None = None,
    ) -> None:
        """Incremental delta: add a subset of events, not the full session.
        
        Implementations should treat `events` as incremental, not replacing
        the full session. custom_metadata keys are service-specific.
        """

    async def add_memory(
        self, *,
        app_name: str,
        user_id: str,
        memories: Sequence[MemoryEntry],
        custom_metadata: Mapping[str, object] | None = None,
    ) -> None:
        """Direct write: add explicit MemoryEntry objects (not from events).
        
        For services that support writing memory facts directly.
        """
```

### Key data types

```python
class MemoryEntry(BaseModel):
    """Represent one memory entry."""
    content: types.Content          # google.genai.types.Content (parts: text, inline_data, etc.)
    custom_metadata: dict[str, Any] = Field(default_factory=dict)
    id: Optional[str] = None
    author: Optional[str] = None
    timestamp: Optional[str] = None   # ISO 8601 preferred

class SearchMemoryResponse(BaseModel):
    memories: list[MemoryEntry] = Field(default_factory=list)

class Session(BaseModel):
    id: str
    app_name: str
    user_id: str
    state: dict[str, Any]
    events: list[Event]          # conversation events
    last_update_time: float
```

### Scoping model

All memory operations are scoped to `(app_name, user_id)`. There is no global memory. `session_id` is an optional partition within `add_events_to_memory`.

### How memory is consumed by agents

ADK ships two built-in memory tools:

- **`LoadMemoryTool`** — reactive. The model decides when to call `load_memory(query)`, which calls `tool_context.search_memory(query)`. Only available when `FeatureName.JSON_SCHEMA_FOR_FUNC_DECL` is enabled.
- **`PreloadMemoryTool`** — automatic. On every LLM request, searches memory using the user's query text and prepends a `<PAST_CONVERSATIONS>` system instruction block. No model decision needed.

Both are `tools` added to an agent's `tool_executor`, not part of the `BaseMemoryService` interface.

### Memory is wired through `InvocationContext`

```python
class InvocationContext(BaseModel):
    # ...
    memory_service: Optional[BaseMemoryService] = None
    # ...
```

And agents access it via `Context` (the tool/tool call context):

```python
# In agent tools / callbacks:
ctx = Context(...)  # = ToolContext
await ctx.search_memory("what did user ask yesterday?")
await ctx.add_session_to_memory()
await ctx.add_events_to_memory(events=[...])
await ctx.add_memory(memories=[MemoryEntry(...)])
```

---

## Q3: Persistence Contract — "Memory" vs "Knowledge" / "Session"

**Yes, ADK explicitly separates these concepts into two distinct abstractions:**

### Session Service — `BaseSessionService`

Location: `google/adk/sessions/base_session_service.py`

Handles **conversation history** (ordered events within a session). Think "chat transcript".

```python
class BaseSessionService(abc.ABC):
    @abc.abstractmethod
    async def create_session(self, *, app_name, user_id, state=None, session_id=None) -> Session
    @abc.abstractmethod
    async def get_session(self, *, app_name, user_id, session_id, config=None) -> Optional[Session]
    @abc.abstractmethod
    async def list_sessions(self, *, app_name, user_id=None) -> ListSessionsResponse
    @abc.abstractmethod
    async def delete_session(self, *, app_name, user_id, session_id) -> None
    
    # non-abstract: append_event (adds events in-memory, updates session state)
```

Shipped implementations:
- `InMemorySessionService` — volatile, for prototyping
- `SqliteSessionService` — file-based SQLite
- `DatabaseSessionService` — generic SQL (supports PostgreSQL, MySQL)
- `VertexAiSessionService` — stores sessions in Vertex AI

### Memory Service — `BaseMemoryService`

Location: `google/adk/memory/base_memory_service.py`

Handles **searchable, cross-session knowledge** derived from conversation events. Think "vector store / RAG".

```python
class BaseMemoryService(ABC):
    @abstractmethod
    async def add_session_to_memory(self, session: Session) -> None
    @abstractmethod
    async def search_memory(self, *, app_name, user_id, query) -> SearchMemoryResponse
    # + optional add_events_to_memory, add_memory (see Q2)
```

Shipped implementations:
- `InMemoryMemoryService` — keyword matching, prototyping only
- `VertexAiMemoryBankService` — Google Cloud's managed Memory Bank (vector + LLM-summarized)
- `VertexAiRagMemoryService` — Vertex AI RAG corpora

### Retrieval tools — `BaseRetrievalTool`

A third concern: **external knowledge retrieval** (files, RAG corpora, databases).

Location: `google/adk/tools/retrieval/base_retrieval_tool.py`

This is a `Tool` (callable by the agent model), not a service. Shipped implementations:
- `FilesRetrieval` — local file-based retrieval
- `LlamaIndexRetrieval` — LlamaIndex-backed retrieval
- `VertexAiRagRetrieval` — Vertex AI RAG as a tool

**Summary:** ADK has a clean 3-way split:
1. **Sessions** = ordered conversation history (persist per-session)
2. **Memory** = searchable, cross-session knowledge (persist per-user)
3. **Retrieval** = external document/knowledge access (tool-based)

---

## Q4: Reference Implementations — Shipped & Community

### Shipped with ADK (in `google.adk.memory`)

| Implementation | Source | Description |
|---|---|---|
| `InMemoryMemoryService` | `google/adk/memory/in_memory_memory_service.py` | Keyword matching, thread-safe, dev/testing only |
| `VertexAiMemoryBankService` | `google/adk/memory/vertex_ai_memory_bank_service.py` | Google Cloud Memory Bank — uses `memories.ingest_events` + `memories.generate` + `memories.retrieve`. Supports TTL, revision tracking, metadata consolidation |
| `VertexAiRagMemoryService` | `google/adk/memory/vertex_ai_rag_memory_service.py` | Vertex AI RAG corpora — uploads session events as temp JSON files, retrieves via `rag.retrieval_query` |

### Community packages

| Package | Source | Description |
|---|---|---|
| `google-adk-redis` (0.1.5) | https://github.com/redis-developer/adk-redis | Redis integration — implements Memory, Sessions, and Search tools |
| `google-adk-community` (0.4.1) | PyPI | Community extensions (specifics unknown without install) |

### Shipped session backends (for reference)

| Implementation | Source |
|---|---|
| `InMemorySessionService` | `google/adk/sessions/in_memory_session_service.py` |
| `SqliteSessionService` | `google/adk/sessions/sqlite_session_session_service.py` |
| `DatabaseSessionService` | `google/adk/sessions/database_session_service.py` |
| `VertexAiSessionService` | `google/adk/sessions/vertex_ai_session_service.py` |

---

## Q5: Auth / Config Conventions

### LLM configuration

ADK uses the `google-genai` SDK client for model calls. Config conventions:

```python
# Standard Gemini (AI Studio API key):
from google.adk.models.google_llm import Gemini
model = Gemini(model="gemini-2.5-flash")
# Needs: GOOGLE_API_KEY env var

# Vertex AI (project + location):
model = Gemini(model="gemini-2.5-flash")  # same constructor
# Needs: GOOGLE_GENAI_USE_VERTEXAI=true, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION env vars
# Or: google.auth default credentials (Application Default Credentials)
```

Key env vars:
| Env var | Purpose |
|---|---|
| `GOOGLE_API_KEY` | AI Studio API key (Express Mode) |
| `GOOGLE_GENAI_USE_VERTEXAI` | If `true`/`1`, routes to Vertex AI instead of AI Studio |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | GCP region for Vertex AI |
| `APIGEE_PROXY_URL` | Apigee proxy URL (for `ApigeeLlm`) |

### Memory service configuration

Services take explicit constructor params — no env var convention for memory backends:

```python
# VertexAiMemoryBankService — requires agent engine ID
from google.adk.memory import VertexAiMemoryBankService
memory = VertexAiMemoryBankService(
    project="my-project",
    location="us-central1",
    agent_engine_id="456",
)

# VertexAiRagMemoryService — requires RAG corpus
from google.adk.memory import VertexAiRagMemoryService
memory = VertexAiRagMemoryService(
    rag_corpus="projects/.../ragCorpora/my-corpus",
    similarity_top_k=5,
)
```

### Server wiring

In the ADK CLI web server (`adk web`), memory_service is injected at the server level:

```python
class FastApiAdkRunner:
    def __init__(
        self,
        *,
        agent_loader: BaseAgentLoader,
        session_service: BaseSessionService,
        memory_service: BaseMemoryService,      # <-- injected here
        artifact_service: BaseArtifactService,
        credential_service: BaseCredentialService,
        # ...
    ):
```

The runner then injects `memory_service` into each `InvocationContext`, making it available to all agents via `ctx.search_memory()`, `ctx.add_session_to_memory()`, etc.

### Session-scoped config

There is **no per-session memory config**. Memory is configured at the app/server level (one `BaseMemoryService` instance per runner). The `(app_name, user_id)` tuple in each call acts as the scope.

---

## Adapter Design Notes for `flair-adk-py`

Based on this investigation, a `flair-adk-py` adapter would:

1. **Subclass `BaseMemoryService`** — implement `add_session_to_memory()` and `search_memory()`. Optionally implement `add_events_to_memory()` and `add_memory()`.

2. **Handle `Event` → Flair event conversion** — ADK events use `google.genai.types.Content` (parts-based). Need to map `Content.parts[i].text` → Flair events.

3. **Handle Flair event → `MemoryEntry` conversion** — for `search_memory()`, return `SearchMemoryResponse(memories=[MemoryEntry(content=..., author=..., timestamp=...)])`.

4. **Inject via `InvocationContext`** — the adapter instance is passed as `memory_service=MyFlairMemoryService()` when constructing the runner.

5. **Scope mapping** — ADK scopes to `(app_name, user_id)`. Map `app_name` → Flair space, `user_id` → Flair user/agent.

6. **Session vs Memory** — ADK already handles session persistence separately via `BaseSessionService`. The adapter only needs to handle the memory/search side.

No implementation was done — this is a research report.
