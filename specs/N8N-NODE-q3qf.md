# Spec: `@tpsdev-ai/n8n-nodes-flair` (ops-q3qf)

**Goal:** ship a community-published n8n node package that lets n8n workflows use Flair as their AI-Agent memory backend, plus a worked-example workflow. The 1.0 narrative move: orchestrator-agnostic memory across Claude Code / OpenClaw / n8n.

**Status:** spec ready. Federation flow proven (rockit↔Fabric, post-PR-#299), PR #314 merged (federation reachability/prune/verify CLI), PR #315 merged (flair-mcp parent-exit watcher). Gates open.

**Bead:** `ops-q3qf` (priority P1).

---

## 1. Spike findings — what shaped the spec

n8n memory connectors do NOT implement an n8n-owned interface. They implement LangChain's `BaseChatMessageHistory` and wrap it in `BufferMemory` / `BufferWindowMemory`. Reference: `MemoryPostgresChat.node.ts` returns `{ response: logWrapper(memory, this) }` where `memory = new BufferWindowMemory({ chatHistory: pgChatHistory, ... })`.

**Implication:** to plug into n8n's AI Agent Memory port we MUST implement the conversation-buffer shape — there's no escape hatch for "knowledge-shape memory." That's not a problem; it's a clarification:

**We ship two nodes, not one.** The differentiation lives in their composition.

| Node | Slot | Shape | Role |
|---|---|---|---|
| `FlairChatMemory` | AI Agent's `Memory` port | Conversation buffer (LangChain `BaseChatMessageHistory`) | Per-session chat history, persisted in Flair, federated across instances |
| `FlairSearch` | AI Agent's `Tool` port (or workflow data node) | Knowledge search | Agent-callable: search memories by tag, semantic query, time range — surfaces structured Flair memory into the agent's reasoning |

The Memory node alone delivers *portability + identity + federation*. The Memory + Search pair delivers the full "knowledge-shaped memory across orchestrators" story.

---

## 2. Package layout

```
packages/n8n-nodes-flair/        # new workspace package in ops/flair/packages/
├── package.json                 # name: @tpsdev-ai/n8n-nodes-flair
├── credentials/
│   └── FlairApi.credentials.ts  # base URL + admin token (v1) | Ed25519 (post-1.0, separate)
├── nodes/
│   ├── FlairChatMemory/
│   │   ├── FlairChatMemory.node.ts
│   │   ├── FlairChatMessageHistory.ts   # LangChain BaseChatMessageHistory adapter
│   │   └── flair.svg                    # 24×24 monochrome
│   └── FlairSearch/
│       ├── FlairSearch.node.ts          # tool node — search memories
│       └── flair.svg
├── README.md
└── tsconfig.json
```

`@tpsdev-ai/flair-client@^0.7.0` is a dep. The node never talks to Harper directly — every call goes through `FlairClient`.

---

## 3. Credential — `FlairApi`

V1 = simple admin token. Ed25519 per-agent identity is a separate follow-up Bead (`ops-q3qf-followup`).

```ts
export class FlairApi implements ICredentialType {
  name = 'flairApi';
  displayName = 'Flair API';
  documentationUrl = 'https://github.com/tpsdev-ai/flair#n8n';

  properties: INodeProperties[] = [
    { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'http://localhost:9926', required: true },
    { displayName: 'Agent ID', name: 'agentId', type: 'string', default: '', required: true,
      description: 'Logical identity used as the memory owner. n8n workflows that share an agentId share memory ownership.' },
    { displayName: 'Admin Token', name: 'adminToken', type: 'string',
      typeOptions: { password: true }, default: '', required: true,
      description: 'Flair admin token. For Ed25519 per-agent auth, see post-1.0 follow-up.' },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.adminToken}}' } },
  };

  test: ICredentialTestRequest = {
    request: { baseURL: '={{ $credentials.baseUrl }}', url: '/' },
  };
}
```

Note: Flair Bearer tokens go in the `Authorization` header normally — but per memory `Harper claims Bearer Authorization`, internal Flair custom tokens use a non-Authorization header. The admin token IS Harper's admin auth, which DOES use `Authorization: Bearer`. That's fine for v1.

---

## 4. `FlairChatMemory` node

Returns a LangChain `BufferWindowMemory` whose `chatHistory` is our `FlairChatMessageHistory`.

### 4.1 Node properties
- `subject` (string, default `={{ $workflow.name }}`) — Flair's per-workflow scope. Replaces n8n's `sessionKey`.
- `sessionIdOption` + `sessionKeyProperty` from `../descriptions` — n8n's standard session-key controls. Maps to a sub-key under `subject` if user wants per-execution isolation: actual Flair subject becomes `<configured subject>:<n8n-resolved sessionId>`.
- `contextWindowLength` (number, default 10) — passed to `BufferWindowMemory.k`.

### 4.2 `FlairChatMessageHistory` adapter

```ts
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, AIMessage, HumanMessage, SystemMessage, mapStoredMessagesToChatMessages, mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { FlairClient } from '@tpsdev-ai/flair-client';

export class FlairChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['n8n-nodes', 'flair'];

  constructor(
    private client: FlairClient,
    private subject: string,         // pre-composed subject
    private windowK: number = 10,
  ) { super(); }

  async getMessages(): Promise<BaseMessage[]> {
    // Flair memory list: by subject, ordered by createdAt ASC, limit windowK*2
    // (each turn is two messages — user + AI)
    const memories = await this.client.memory.list({
      subject: this.subject,
      type: 'session',
      limit: this.windowK * 2,
      order: 'createdAt-asc',
    });
    return memories.map(m => {
      const stored = JSON.parse(m.content);
      return mapStoredMessagesToChatMessages([stored])[0];
    });
  }

  async addMessage(message: BaseMessage): Promise<void> {
    const stored = mapChatMessagesToStoredMessages([message])[0];
    await this.client.memory.write(JSON.stringify(stored), {
      type: 'session',
      durability: 'ephemeral',   // chat-buffer entries are short-lived by default
      subject: this.subject,
      tags: ['n8n-chat', `role:${stored.type}`],
    });
  }
}
```

### 4.3 `supplyData`

```ts
async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
  const credentials = await this.getCredentials<FlairCredentials>('flairApi');
  const subject = this.getNodeParameter('subject', itemIndex) as string;
  const sessionId = getSessionId(this, itemIndex);   // optional sub-scope
  const k = this.getNodeParameter('contextWindowLength', itemIndex, 10) as number;

  const composedSubject = sessionId ? `${subject}:${sessionId}` : subject;

  const flair = new FlairClient({
    baseUrl: credentials.baseUrl,
    agentId: credentials.agentId,
    adminToken: credentials.adminToken,
  });

  const history = new FlairChatMessageHistory(flair, composedSubject, k);
  const memory = new BufferWindowMemory({
    memoryKey: 'chat_history',
    chatHistory: history,
    returnMessages: true,
    inputKey: 'input',
    outputKey: 'output',
    k,
  });

  return { response: logWrapper(memory, this) };
}
```

---

## 5. `FlairSearch` node (tool node)

Standalone tool node — agent calls it during reasoning to search Flair by semantic query / tag / time range. Output goes into the agent's tool-call response.

### 5.1 Operations
- `Search` — semantic query, returns top-N memories with content + score + tags + subject + createdAt.
- `Get By Tag` — filter by tag (exact match), returns N most-recent.
- `Get By Subject` — filter by subject, returns N most-recent. (Same surface that backs `FlairChatMessageHistory.getMessages` but exposed for agents.)

Each returns an array of `{ id, content, score?, tags, subject, createdAt }` records.

### 5.2 Properties
- Operation (dropdown of three above)
- Query (string, conditional on Operation = Search)
- Tag (string, conditional on Operation = Get By Tag)
- Subject (string, conditional on Operation = Get By Subject)
- Limit (number, default 5)
- As-Of (date, optional — uses Flair's `validFrom`/`validTo` temporal querying)

### 5.3 Implementation note
This is a regular n8n Action node (not a sub-node), so it implements `INodeType.execute()` and returns `INodeExecutionData[]`. Agents bind it via the AI Agent's Tool socket using n8n's standard tool-binding pattern.

---

## 6. flair-client gap to close BEFORE implementation

`FlairChatMessageHistory.getMessages()` and `FlairSearch.Get By Subject`/`Get By Tag` need `client.memory.list({ subject?, type?, tags?, limit, order })`.

Today the client exposes `search(semantic)`, `get(id)`, `write()`, `delete(id)` — no list-by-conditions surface. Implementer's first task: add `list()` to `MemoryClient` that wraps `POST /Memory/search` with `conditions` (or whatever the canonical Memory list path is — verify against current `resources/Memory.ts`).

This is a **prereq PR** in the flair monorepo, not in `n8n-nodes-flair`. Suggest naming: `feat(flair-client): memory.list() with conditions` — small scope, K&S ensemble standard. After it lands, the n8n node can dep on `@tpsdev-ai/flair-client@^0.7.1`.

---

## 7. Worked-example workflow

Two flavors, both shipped as exportable JSON in the package's `examples/` dir:

1. **Chat-buffer demo** — Webhook trigger → AI Agent (Claude as model, FlairChatMemory as memory) → Respond to Webhook. The same workflow run twice via the same subject reuses memory. Demonstrates the conversation-buffer use case, identical surface to MemoryPostgresChat from the operator's view.
2. **Knowledge-search demo** — Schedule trigger → AI Agent (FlairChatMemory + FlairSearch as tool) → action. Agent asked to summarize a topic; uses FlairSearch to pull tagged memories before answering. Demonstrates the structured-knowledge-search use case.

Both workflows must work with a default Flair install — no setup beyond credential entry.

---

## 8. Docs

`docs/n8n.md` in the flair repo:
- Why-Flair-vs-Postgres section (one paragraph each: shape, portability, federation, identity)
- 5-minute setup: install community node, create credential, drop into AI Agent
- Subject/sessionId guidance — "shared assistant memory" vs "per-execution isolation" patterns
- Screenshot of each worked-example workflow

Link from main README under "Integrations."

---

## 9. Implementation sequence (suggested PR slicing)

1. **PR-1 (flair-client):** add `MemoryClient.list({ subject, type, tags, limit, order })`. Tests.
2. **PR-2 (n8n-nodes-flair scaffold):** workspace package, credential, package.json, README. No node code yet — just the buildable shell.
3. **PR-3 (FlairChatMemory):** the Memory node + FlairChatMessageHistory adapter + tests against a local Flair.
4. **PR-4 (FlairSearch):** the tool node + tests.
5. **PR-5 (worked-examples + docs):** examples/*.json + docs/n8n.md.
6. **PR-6 (publish):** version bump, CHANGELOG, npm-publish via `release.sh` (Nathan's hand for the publish step).

Each PR: K&S ensemble, CI green.

---

## 10. Anti-patterns (from the bead — keep visible)

- **Don't ship before federation is proven.** Done — gate met.
- **Don't reinvent flair-client.** Both nodes go through `FlairClient`. Only escape hatch is the `list()` method we add as PR-1.
- **Don't conflate shape vs duration.** Postgres-as-memory IS persistent. Differentiation is shape + portability + identity.
- **Don't gate on agentic-stack abstractions.** Match n8n's node API conventions, not ours.

---

## 11. Owner / next step

Spec ready. Implementer (Anvil or Ember, Flint's call) starts with PR-1 (`flair-client.memory.list()`). K&S ensemble per usual.
