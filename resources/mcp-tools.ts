/**
 * mcp-tools.ts — the 12 curated flair tools for the Model-2 custom /mcp handler.
 *
 * Curated BY CONSTRUCTION: this module implements a fixed set of tools, each a
 * thin wrapper over the existing flair Resource handler. No business logic is
 * re-implemented — the wrapped handlers (Memory / SemanticSearch /
 * BootstrapMemories / Soul / WorkspaceState / OrgEvent / AttentionQuery /
 * RecordUsage) enforce per-agent scoping/ownership via
 * `resolveAgentAuth(getContext())` (or, for `attention`, AttentionQuery's own
 * per-source scoping — see resources/AttentionQuery.ts's module doc), so the
 * MCP surface inherits the SAME security model as the signed-REST path. There
 * is no raw CRUD surface — the only way to reach the datastore through /mcp is
 * via one of these 12 semantic tools.
 *
 *   memory_search · memory_store · memory_update · memory_get · memory_delete ·
 *   bootstrap · soul_set · soul_get · flair_workspace_set · flair_orgevent ·
 *   attention · record_usage
 *
 * ── The scoping seam ────────────────────────────────────────────────────────
 * The /mcp handler resolves the OAuth token's `sub` → a flair `Agent` id, then
 * calls a tool with a `ResolvedAgent { agentId, isAdmin }`. Each tool builds a
 * flair-shaped Resource context (`delegationContext`) carrying `request.tpsAgent`
 * + `request.tpsAgentIsAdmin`, so the wrapped handler scopes to the verified
 * agent exactly as an Ed25519-signed REST call would. Identity ALWAYS comes from
 * the resolved agent, never from the tool arguments — an agent can only act as
 * itself (no forging of agentId / authorId in the body).
 *
 * NOTE (flair#677 scope call): the legacy `@tpsdev-ai/flair-mcp` stdio proxy
 * (packages/flair-mcp) is a SEPARATE, independently-published package that
 * talks to flair over HTTP via `FlairClient` — it is not wired through this
 * registry at all (its own tool list is hardcoded in packages/flair-mcp/src/
 * index.ts). Per the zero-install north star (retiring flair-mcp in favor of
 * this native /mcp handler), `attention` is added HERE only, not mirrored into
 * the legacy stdio proxy — adding it there would mean a separate package
 * version bump + a new FlairClient method, out of scope for this query-only
 * slice.
 */

/**
 * The delegated handler classes, held in a mutable registry, LAZILY loaded on
 * first use. Two reasons for the indirection:
 *
 *   1. Tests inject capture doubles via `__setHandlers` WITHOUT `mock.module`-ing
 *      the shared `resources/*.ts` files (a process-global bun mock that leaks
 *      into every other test file).
 *   2. The handler classes statically `import { Resource, databases } from
 *      "@harperfast/harper"`. Importing them lazily (dynamic import on first tool
 *      call, not at module top) keeps `mcp-tools`/`mcp-handler` free of a
 *      top-level Harper link, so importing the /mcp handler in a unit test never
 *      requires the full Harper module surface up front.
 *
 * Prod: first tool call loads the real classes against a fully-real Harper.
 */
type HandlerKey = "SemanticSearch" | "Memory" | "BootstrapMemories" | "Soul" | "WorkspaceState" | "OrgEvent" | "AttentionQuery" | "RecordUsage";
const H: Partial<Record<HandlerKey, any>> = {};

const LOADERS: Record<HandlerKey, () => Promise<any>> = {
  SemanticSearch: async () => (await import("./SemanticSearch.js")).SemanticSearch,
  Memory: async () => (await import("./Memory.js")).Memory,
  BootstrapMemories: async () => (await import("./MemoryBootstrap.js")).BootstrapMemories,
  Soul: async () => (await import("./Soul.js")).Soul,
  WorkspaceState: async () => (await import("./WorkspaceState.js")).WorkspaceState,
  OrgEvent: async () => (await import("./OrgEvent.js")).OrgEvent,
  AttentionQuery: async () => (await import("./AttentionQuery.js")).AttentionQuery,
  RecordUsage: async () => (await import("./RecordUsage.js")).RecordUsage,
};

/** Resolve a handler class — from the test override if set, else lazy-load + cache. */
async function handler(key: HandlerKey): Promise<any> {
  if (H[key]) return H[key];
  const cls = await LOADERS[key]();
  H[key] = cls;
  return cls;
}

/** TEST-ONLY: override the delegated handler classes. Returns a restore fn. */
export function __setHandlers(overrides: Partial<Record<HandlerKey, any>>): () => void {
  const prev = { ...H };
  Object.assign(H, overrides);
  return () => {
    for (const k of Object.keys(H) as HandlerKey[]) delete H[k];
    Object.assign(H, prev);
  };
}

/** The verified agent identity for an MCP tool call (resolved from the token sub). */
export interface ResolvedAgent {
  agentId: string;
  isAdmin: boolean;
}

/** MCP tool descriptor as returned by tools/list. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Build a flair-shaped Resource context for a delegated handler call. The
 * handlers read identity via `resolveAgentAuth(getContext())`, which checks
 * `context.request.tpsAgent` / `tpsAgentIsAdmin`. We construct exactly that shape
 * so the wrapped handler scopes to the verified agent — identical to the
 * signed-REST path. `headers.get("x-tps-agent")` is provided for handler paths
 * that read the header directly (e.g. MemoryBootstrap fallback).
 *
 * Critically: `tpsAnonymous` is NOT set and no Authorization header is present,
 * so `resolveAgentAuth` takes the `tpsAgent` annotation branch — a verified
 * agent, never anonymous, never a header re-verify.
 */
function delegationContext(agent: ResolvedAgent): any {
  return {
    request: {
      tpsAgent: agent.agentId,
      tpsAgentIsAdmin: agent.isAdmin,
      headers: {
        get: (k: string) => (k.toLowerCase() === "x-tps-agent" ? agent.agentId : undefined),
      },
    },
    user: undefined,
  };
}

/**
 * Unwrap a handler return value into a plain object/string for the MCP result.
 * Handlers may return a `Response` (the 401/403/400 guards) — surface its JSON
 * body (and status) so the client sees the structured error rather than an
 * opaque object. A thrown handler error propagates to the caller (the handler
 * maps it to a JSON-RPC error).
 */
async function unwrap(value: any): Promise<any> {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    try {
      const body = await value.json();
      return { error: body?.error ?? "request failed", status: value.status, ...body };
    } catch {
      return { error: "request failed", status: (value as any).status };
    }
  }
  return value;
}

// ── Tool implementations (thin wrappers over existing handlers) ──────────────
//
// Each takes the resolved agent + the parsed tool arguments and returns a plain
// JSON-serializable value. Identity is taken from `agent`, never from `args`.

async function memorySearch(agent: ResolvedAgent, args: any) {
  const Cls = await handler("SemanticSearch");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.post({ q: args?.query, limit: args?.limit ?? 5 }));
}

async function memoryStore(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const h = new Cls(undefined, delegationContext(agent));
  (h as any).isCollection = true;
  // agentId is the RESOLVED agent — Memory.post also re-checks ownership via
  // resolveAgentAuth, so a mismatched body agentId would 403 anyway; we set it
  // to the verified id so the write is correctly owned.
  return unwrap(await h.post({
    agentId: agent.agentId,
    content: args?.content,
    type: args?.type ?? "session",
    durability: args?.durability ?? "standard",
    tags: args?.tags,
  }));
}

/**
 * memory_update — id-targeted, dedup-BYPASSED overwrite/version path (memory-
 * integrity fix). Mirrors flair-client's MemoryApi.update() (packages/
 * flair-client/src/client.ts), reimplemented against the resource instance
 * API instead of HTTP since this handler calls the Memory resource directly
 * (same pattern as memoryStore vs the flair-mcp stdio tool). Auth is enforced
 * by Memory.get()/Memory.put()/Memory.post()'s EXISTING ownership checks — no
 * parallel auth logic here.
 *
 * Default (preserveHistory unset/false): read the existing record, merge the
 * new content on top (Harper PUT is full-record replacement — never send a
 * bare partial), clear the stale embedding so the server regenerates it, and
 * PUT the merged record back to the SAME id.
 *
 * preserveHistory: true: write a NEW id with `supersedes: id`. Memory.post()
 * validates/authorizes the supersede (denying a cross-agent supersede without
 * a "write" MemoryGrant) and closes the old record's validTo AFTER the new
 * record is written (never the reverse — see resources/Memory.ts).
 */
async function memoryUpdate(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const h = new Cls(undefined, delegationContext(agent));
  const id = args?.id;
  const content = args?.content;
  const preserveHistory = args?.preserveHistory === true;

  const existing = await h.get(id);
  if (!existing) {
    return { error: "memory not found", status: 404 };
  }

  if (preserveHistory) {
    const newId = `${agent.agentId}-${crypto.randomUUID()}`;
    const record: Record<string, unknown> = {
      ...existing,
      id: newId,
      content,
      supersedes: id,
      createdAt: new Date().toISOString(),
    };
    delete record.updatedAt;
    delete record.embedding;
    delete record.embeddingModel;
    delete record.validFrom;
    delete record.validTo;
    delete record.archivedAt;
    (h as any).isCollection = true;
    return unwrap(await h.post(record));
  }

  const merged: Record<string, unknown> = { ...existing, content, updatedAt: new Date().toISOString() };
  delete merged.embedding;
  delete merged.embeddingModel;
  return unwrap(await h.put(merged));
}

async function memoryGet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.get(args?.id));
}

async function memoryDelete(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.delete(args?.id));
}

async function bootstrap(agent: ResolvedAgent, args: any) {
  const Cls = await handler("BootstrapMemories");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.post({
    agentId: agent.agentId,
    maxTokens: args?.maxTokens ?? 4000,
    currentTask: args?.currentTask,
    channel: args?.channel,
    surface: args?.surface,
    subjects: args?.subjects,
    entities: args?.entities,
  }));
}

async function soulSet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Soul");
  const h = new Cls(undefined, delegationContext(agent));
  // Soul records are keyed `id = agentId:key` (see flair-client SoulApi.set and
  // schemas/memory.graphql). Use PUT with the explicit id so soul_get's
  // `${agentId}:${key}` lookup finds it — a plain post() would mint a random id
  // and orphan the entry from get(). Soul.put enforces write ownership via
  // resolveAgentAuth (non-admin can only write agentId === self).
  const id = `${agent.agentId}:${args?.key}`;
  return unwrap(await h.put({
    id,
    agentId: agent.agentId,
    key: args?.key,
    value: args?.value,
  }));
}

async function soulGet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Soul");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.get(`${agent.agentId}:${args?.key}`));
}

async function workspaceSet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("WorkspaceState");
  const h = new Cls(undefined, delegationContext(agent));
  (h as any).isCollection = true;
  // No agentId in the body — WorkspaceState.post attributes the record to the
  // authenticated identity (from the context), never the body. Same no-forge
  // contract as the flair-mcp stdio tool.
  const body: Record<string, unknown> = {
    id: `${agent.agentId}:${args?.ref}`,
    ref: args?.ref,
    provider: args?.provider ?? "mcp",
    timestamp: new Date().toISOString(),
  };
  if (args?.label) body.label = args.label;
  if (args?.task) body.taskId = args.task;
  if (args?.phase) body.phase = args.phase;
  if (args?.summary) body.summary = args.summary;
  return unwrap(await h.post(body));
}

async function orgEvent(agent: ResolvedAgent, args: any) {
  const Cls = await handler("OrgEvent");
  const h = new Cls(undefined, delegationContext(agent));
  (h as any).isCollection = true;
  // No authorId in the body — OrgEvent.post attributes to the authenticated
  // identity, never the body (no forging as another agent).
  const body: Record<string, unknown> = { kind: args?.kind, summary: args?.summary };
  if (args?.detail) body.detail = args.detail;
  if (args?.scope) body.scope = args.scope;
  if (Array.isArray(args?.targets) && args.targets.length > 0) body.targetIds = args.targets;
  return unwrap(await h.post(body));
}

async function attention(agent: ResolvedAgent, args: any) {
  const Cls = await handler("AttentionQuery");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.post({ entity: args?.entity, days: args?.days }));
}

/**
 * record_usage (flair#683) — report that memory(ies) were actually used
 * (cited/grounded an answer or decision), driving the usage-feedback signal
 * (Memory.usageCount → usageBoost → compositeScore). Distinct from search:
 * calling memory_search does NOT count as usage — this tool is the explicit,
 * verified-use report resources/RecordUsage.ts's module doc describes.
 * Identity is the RESOLVED agent (delegationContext), never forgeable via
 * args — same no-forge contract as every other write tool here.
 */
async function recordUsage(agent: ResolvedAgent, args: any) {
  const Cls = await handler("RecordUsage");
  const h = new Cls(undefined, delegationContext(agent));
  const memoryIds = Array.isArray(args?.memoryIds)
    ? args.memoryIds
    : typeof args?.memoryId === "string" ? [args.memoryId] : undefined;
  return unwrap(await h.post({ memoryIds, attribution: args?.attribution }));
}

type ToolImpl = (agent: ResolvedAgent, args: any) => Promise<any>;

/**
 * The tool registry: definition (for tools/list) + implementation (for
 * tools/call), keyed by tool name. The single source of truth for BOTH the
 * advertised surface and the dispatch table — so tools/list and tools/call
 * cannot drift (a tool listed but not callable, or vice versa, is impossible).
 */
interface ToolEntry {
  def: McpToolDef;
  impl: ToolImpl;
}

export const TOOLS: Record<string, ToolEntry> = {
  memory_search: {
    def: {
      name: "memory_search",
      description:
        "Search memories by meaning. Understands temporal queries like 'what happened today'. Scoped to your agent's own + granted memories.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — natural language, semantic matching" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
    impl: memorySearch,
  },
  memory_store: {
    def: {
      name: "memory_store",
      description:
        "Save information to persistent memory. Use for lessons, decisions, preferences, facts. Attributed to your authenticated agent.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "What to remember" },
          type: { type: "string", enum: ["session", "lesson", "decision", "preference", "fact", "goal"], description: "Memory type (default session)" },
          durability: { type: "string", enum: ["permanent", "persistent", "standard", "ephemeral"], description: "permanent > persistent > standard > ephemeral (default standard)" },
          tags: { type: "array", items: { type: "string" }, description: "Tag strings" },
        },
        required: ["content"],
      },
    },
    impl: memoryStore,
  },
  memory_update: {
    def: {
      name: "memory_update",
      description:
        "Update an existing memory by ID. Dedup-bypassed (this is an intentional overwrite, not a new write). " +
        "Default: overwrites the same id in place. Pass preserveHistory=true to instead write a new version " +
        "linked via `supersedes`, closing the old one's validity window.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID of the memory to update" },
          content: { type: "string", description: "New content" },
          preserveHistory: { type: "boolean", description: "Write a new version (supersedes-linked) instead of overwriting in place (default false)" },
        },
        required: ["id", "content"],
      },
    },
    impl: memoryUpdate,
  },
  memory_get: {
    def: {
      name: "memory_get",
      description: "Retrieve a specific memory by ID.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID" } },
        required: ["id"],
      },
    },
    impl: memoryGet,
  },
  memory_delete: {
    def: {
      name: "memory_delete",
      description: "Delete a memory by ID. You can only delete your own memories.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID to delete" } },
        required: ["id"],
      },
    },
    impl: memoryDelete,
  },
  bootstrap: {
    def: {
      name: "bootstrap",
      description:
        "Get session context: soul + memories + predicted context. Run at session start. Pass subjects for predictive loading.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          maxTokens: { type: "number", description: "Max tokens in output (default 4000)" },
          currentTask: { type: "string", description: "Current task — enables semantic search for relevant memories" },
          channel: { type: "string", description: "Channel name (discord, tps-mail, claude-code)" },
          surface: { type: "string", description: "Surface name (tps-build, tps-review, cli-session)" },
          subjects: { type: "array", items: { type: "string" }, description: "Entity names to preload context for" },
          entities: {
            type: "array",
            items: { type: "string" },
            description:
              "Your declared attention-plane vocabulary strings (e.g. \"issue:owner/repo#123\") for collision surfacing's 'Others in the room' block — teammates with overlapping active work. Falls back to your own most-recent workspace-state entities when omitted.",
          },
        },
      },
    },
    impl: bootstrap,
  },
  soul_set: {
    def: {
      name: "soul_set",
      description: "Set a personality or project context entry. Included in every bootstrap.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entry key (e.g. 'role', 'standards', 'project')" },
          value: { type: "string", description: "Entry value" },
        },
        required: ["key", "value"],
      },
    },
    impl: soulSet,
  },
  soul_get: {
    def: {
      name: "soul_get",
      description: "Get a personality or project context entry.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "Entry key" } },
        required: ["key"],
      },
    },
    impl: soulGet,
  },
  flair_workspace_set: {
    def: {
      name: "flair_workspace_set",
      description:
        "Set your agent's current workspace state in the Office Space coordination layer. Attributed to you — you can only write your own state.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Workspace ref — branch, worktree, or task ref" },
          label: { type: "string", description: "Human-readable label" },
          provider: { type: "string", description: "Provider/runtime (default mcp)" },
          task: { type: "string", description: "Task/issue id" },
          phase: { type: "string", description: "Current phase (design, implement, review)" },
          summary: { type: "string", description: "Short summary of current state" },
        },
        required: ["ref"],
      },
    },
    impl: workspaceSet,
  },
  flair_orgevent: {
    def: {
      name: "flair_orgevent",
      description:
        "Publish an org-wide coordination event (claim/release/status) to the Office Space. Attributed to you — you cannot publish as another agent.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Event kind (coord.claim, coord.release, status)" },
          summary: { type: "string", description: "Short summary of the event" },
          detail: { type: "string", description: "Longer detail payload" },
          scope: { type: "string", description: "Scope (an agent id, repo, or 'org')" },
          targets: { type: "array", items: { type: "string" }, description: "Recipient agent ids" },
        },
        required: ["kind", "summary"],
      },
    },
    impl: orgEvent,
  },
  attention: {
    def: {
      name: "attention",
      description:
        "What's touching entity E in the last N days? A unified, grouped-by-source view across memories, " +
        "relationships, active work (WorkspaceState), teammate presence, and org events. Entity must be a " +
        "vocabulary string (e.g. 'repo:owner/name', 'issue:owner/repo#123', 'subsystem:embeddings').",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Vocabulary string, exact match (type:value — e.g. 'repo:tpsdev-ai/flair')" },
          days: { type: "number", description: "Window size in days (default 7)" },
        },
        required: ["entity"],
      },
    },
    impl: attention,
  },
  record_usage: {
    def: {
      name: "record_usage",
      description:
        "Report that one or more memories were actually USED — cited or relied on to ground an answer or decision. " +
        "Distinct from search (surfacing a memory is not usage). Drives the recall-quality usage signal; dedup'd " +
        "(you can only count once per memory) and rate-limited.",
      inputSchema: {
        type: "object",
        properties: {
          memoryIds: { type: "array", items: { type: "string" }, description: "IDs of the memories that were used (max 20 per call)" },
          memoryId: { type: "string", description: "Convenience alias for a single memory id (use memoryIds for multiple)" },
          attribution: { type: "string", description: "Optional free-text note on what used it (opaque — stored for audit only, max 500 chars)" },
        },
      },
    },
    impl: recordUsage,
  },
};

/** The tool definitions for a tools/list response (exactly the 9 curated tools). */
export function listToolDefs(): McpToolDef[] {
  return Object.values(TOOLS).map((t) => t.def);
}
