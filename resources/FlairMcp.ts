/**
 * FlairMcp.ts — the curated native-MCP surface (FLAIR-NATIVE-MCP, slice 1).
 *
 * This is the ONE flair Resource intentionally exposed to Harper's native MCP
 * "application" profile. It is NOT `static hidden` (every other flair Resource
 * is — see mcp-curation.ts). It exposes EXACTLY the 9 curated tools, mirroring
 * the existing `@tpsdev-ai/flair-mcp` stdio proxy's tool surface:
 *
 *   memory_search · memory_store · memory_get · memory_delete · bootstrap ·
 *   soul_set · soul_get · flair_workspace_set · flair_orgevent
 *
 * Each tool WRAPS the existing handler resource (Memory / SemanticSearch /
 * BootstrapMemories / Soul / WorkspaceState / OrgEvent) — no business logic is
 * re-implemented. The handlers enforce per-agent scoping/ownership via
 * `resolveAgentAuth(getContext())`, so the curated surface inherits the SAME
 * security model as the signed-REST path.
 *
 * ── Auth (slice 1) ──────────────────────────────────────────────────────────
 * The Bearer verifier that maps an inbound OAuth token → `request.tpsAgent` is
 * slice 2/3 (HarperFast/oauth#86). It is NOT built here. Until it lands, every
 * MCP tool call has NO verified flair agent on its context, so each tool REJECTS
 * with `authentication required`. That is the intended slice-1 contract: the
 * surface mounts, `tools/list` returns the 9, and every `tools/call` is rejected
 * unauthed. When the verifier lands it sets the agent identity on the request/
 * user (slice 2/3) and these same tools begin delegating to the handlers — no
 * change to this file's tool wiring required.
 *
 * Harper invokes a custom mcpTool as:
 *   const instance = new FlairMcp(undefined, buildContext(context.user));
 *   await instance[method](args, mcpContext);
 * so `this.getContext()` returns `{ user, authorize, checkPermission }` and the
 * forwarded second arg (`mcpContext`) carries `{ user, profile, sessionId, ... }`.
 */

import { Resource, databases } from "@harperfast/harper";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MCP_HIDDEN } from "./mcp-curation.js";
import { SemanticSearch } from "./SemanticSearch.js";
import { Memory } from "./Memory.js";
import { BootstrapMemories } from "./MemoryBootstrap.js";
import { Soul } from "./Soul.js";
import { WorkspaceState } from "./WorkspaceState.js";
import { OrgEvent } from "./OrgEvent.js";

/** Raised when a tool is called without a verified flair agent (slice-1 default). */
class McpAuthRequired extends Error {
  constructor() {
    super("authentication required");
    this.name = "McpAuthRequired";
  }
}

/**
 * The verified flair-agent identity for an MCP call, derived from the request
 * context the (future) Bearer verifier annotates. Returns null when no verified
 * agent is present — which, in slice 1 (no verifier), is ALWAYS.
 *
 * We look for the canonical flair markers the verifier sets (`tpsAgent` /
 * `tpsAgentIsAdmin`) on the request first, then on the user object Harper
 * forwards into the MCP context (`mcpContext.user` / `getContext().user`).
 * We deliberately do NOT treat a bare super_user/admin or an anonymous local
 * request as authorized for the MCP surface — MCP is an external-client surface
 * and must carry an explicit, verified agent identity.
 */
function resolveMcpAgent(
  selfContext: any,
  mcpContext: any,
): { agentId: string; isAdmin: boolean } | null {
  // The verifier (slice 2/3) sets request.tpsAgent + request.tpsAgentIsAdmin.
  const req = selfContext?.request ?? selfContext;
  const fromReq = req?.tpsAgent ?? mcpContext?.tpsAgent;
  if (fromReq) {
    const isAdmin =
      req?.tpsAgentIsAdmin === true || mcpContext?.tpsAgentIsAdmin === true;
    return { agentId: String(fromReq), isAdmin };
  }
  // Forward-compat: the verifier may instead annotate the user object it builds.
  const user = mcpContext?.user ?? selfContext?.user;
  if (user && user.tpsAgent) {
    return { agentId: String(user.tpsAgent), isAdmin: user.tpsAgentIsAdmin === true };
  }
  return null;
}

/**
 * Build a flair-shaped Resource context for a delegated handler call. The handlers
 * read identity via `resolveAgentAuth(getContext())`, which checks
 * `context.request.tpsAgent` / `tpsAgentIsAdmin`. We construct exactly that shape
 * so the wrapped handler scopes to the verified agent — identical to the
 * signed-REST path. `headers` carries `x-tps-agent` for the handler paths that
 * read it (e.g. MemoryBootstrap fallback).
 */
function delegationContext(agent: { agentId: string; isAdmin: boolean }, user: any): any {
  return {
    request: {
      tpsAgent: agent.agentId,
      tpsAgentIsAdmin: agent.isAdmin,
      headers: { get: (k: string) => (k.toLowerCase() === "x-tps-agent" ? agent.agentId : undefined) },
    },
    user,
  };
}

/**
 * Unwrap a handler return value into a plain object/string for the MCP result.
 * Handlers may return a `Response` (the 401/403/400 guards) — surface its JSON
 * body so the LLM/client sees the structured error rather than an opaque object.
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

export class FlairMcp extends Resource {
  // NOTE: FlairMcp is deliberately the ONE resource that is NOT hidden — it is
  // the curated MCP surface. (Every other flair Resource sets `static hidden`.)
  // It has no get/search/post/put/delete verb methods on its prototype, so the
  // native verb-tool generator registers NOTHING for it; only the explicit
  // `static mcpTools` below are exposed.
  static description =
    "Flair durable agent memory — curated MCP surface (memory, soul, bootstrap, coordination).";

  // ── The 9 curated tools (mirrors @tpsdev-ai/flair-mcp) ────────────────────
  static mcpTools = [
    {
      name: "memory_search",
      description:
        "Search memories by meaning. Understands temporal queries like 'what happened today'. Scoped to your agent's own + granted memories.",
      method: "memorySearch",
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
    {
      name: "memory_store",
      description:
        "Save information to persistent memory. Use for lessons, decisions, preferences, facts. Attributed to your authenticated agent.",
      method: "memoryStore",
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
    {
      name: "memory_get",
      description: "Retrieve a specific memory by ID.",
      method: "memoryGet",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID" } },
        required: ["id"],
      },
    },
    {
      name: "memory_delete",
      description: "Delete a memory by ID. You can only delete your own memories.",
      method: "memoryDelete",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID to delete" } },
        required: ["id"],
      },
    },
    {
      name: "bootstrap",
      description:
        "Get session context: soul + memories + predicted context. Run at session start. Pass subjects for predictive loading.",
      method: "bootstrap",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          maxTokens: { type: "number", description: "Max tokens in output (default 4000)" },
          currentTask: { type: "string", description: "Current task — enables semantic search for relevant memories" },
          channel: { type: "string", description: "Channel name (discord, tps-mail, claude-code)" },
          surface: { type: "string", description: "Surface name (tps-build, tps-review, cli-session)" },
          subjects: { type: "array", items: { type: "string" }, description: "Entity names to preload context for" },
        },
      },
    },
    {
      name: "soul_set",
      description: "Set a personality or project context entry. Included in every bootstrap.",
      method: "soulSet",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entry key (e.g. 'role', 'standards', 'project')" },
          value: { type: "string", description: "Entry value" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "soul_get",
      description: "Get a personality or project context entry.",
      method: "soulGet",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "Entry key" } },
        required: ["key"],
      },
    },
    {
      name: "flair_workspace_set",
      description:
        "Set your agent's current workspace state in the Office Space coordination layer. Attributed to you — you can only write your own state.",
      method: "workspaceSet",
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
    {
      name: "flair_orgevent",
      description:
        "Publish an org-wide coordination event (claim/release/status) to the Office Space. Attributed to you — you cannot publish as another agent.",
      method: "orgEvent",
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
  ];

  /** Resolve the verified agent or throw the slice-1 auth rejection. */
  private requireAgent(mcpContext: any): { agentId: string; isAdmin: boolean } {
    const agent = resolveMcpAgent((this as any).getContext?.(), mcpContext);
    if (!agent) throw new McpAuthRequired();
    return agent;
  }

  // ── Tool method implementations (thin wrappers over existing handlers) ─────

  async memorySearch(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (SemanticSearch as any)(undefined, ctx);
    const result = await handler.post({ q: args?.query, limit: args?.limit ?? 5 });
    return unwrap(result);
  }

  async memoryStore(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (Memory as any)(undefined, ctx);
    (handler as any).isCollection = true;
    const result = await handler.post({
      agentId: agent.agentId,
      content: args?.content,
      type: args?.type ?? "session",
      durability: args?.durability ?? "standard",
      tags: args?.tags,
    });
    return unwrap(result);
  }

  async memoryGet(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (Memory as any)(undefined, ctx);
    const result = await handler.get(args?.id);
    return unwrap(result);
  }

  async memoryDelete(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (Memory as any)(undefined, ctx);
    const result = await handler.delete(args?.id);
    return unwrap(result);
  }

  async bootstrap(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (BootstrapMemories as any)(undefined, ctx);
    const result = await handler.post({
      agentId: agent.agentId,
      maxTokens: args?.maxTokens ?? 4000,
      currentTask: args?.currentTask,
      channel: args?.channel,
      surface: args?.surface,
      subjects: args?.subjects,
    });
    return unwrap(result);
  }

  async soulSet(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (Soul as any)(undefined, ctx);
    (handler as any).isCollection = true;
    const result = await handler.post({ agentId: agent.agentId, key: args?.key, value: args?.value });
    return unwrap(result);
  }

  async soulGet(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (Soul as any)(undefined, ctx);
    const result = await handler.get(`${agent.agentId}:${args?.key}`);
    return unwrap(result);
  }

  async workspaceSet(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (WorkspaceState as any)(undefined, ctx);
    (handler as any).isCollection = true;
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
    const result = await handler.post(body);
    return unwrap(result);
  }

  async orgEvent(args: any, mcpContext: any) {
    const agent = this.requireAgent(mcpContext);
    const ctx = delegationContext(agent, mcpContext?.user);
    const handler = new (OrgEvent as any)(undefined, ctx);
    (handler as any).isCollection = true;
    const body: Record<string, unknown> = { kind: args?.kind, summary: args?.summary };
    if (args?.detail) body.detail = args.detail;
    if (args?.scope) body.scope = args.scope;
    if (Array.isArray(args?.targets) && args.targets.length > 0) body.targetIds = args.targets;
    const result = await handler.post(body);
    return unwrap(result);
  }
}

// ─── Suppress auto-generated VERB tools for FlairMcp itself ──────────────────
//
// Harper's native MCP `detectVerbs` registers a `create_*`/`get_*`/... verb tool
// for any enumerated Resource whose prototype has the matching method — and the
// base `Resource.prototype` defines `post` (→ `create_FlairMcp`), etc. FlairMcp
// is enumerated (it's the one non-hidden surface) and has NO REST/table verb
// surface of its own — it exposes ONLY the 9 curated `static mcpTools`. So we
// strip the inherited verb methods from FlairMcp's prototype: `detectVerbs` then
// returns all-false and NO `create_FlairMcp`/`get_FlairMcp` mutator leaks into
// `tools/list`. (Defense beyond `makeVisibleTo`, which would merely hide them
// from non-super users — we want them to not exist at all.)
for (const verb of ["get", "search", "post", "put", "patch", "delete", "update"] as const) {
  if (typeof (FlairMcp.prototype as any)[verb] === "function") {
    (FlairMcp.prototype as any)[verb] = undefined;
  }
}

// Reference MCP_HIDDEN so the curation contract is imported into this file's
// module graph and the relationship to mcp-curation.ts is explicit. FlairMcp is
// the sole NON-hidden flair Resource; this assertion documents that invariant.
void MCP_HIDDEN;

// ─── WORKAROUND for a Harper 5.1.14 native-MCP timing gap ────────────────────
//
// Harper's native MCP "application" profile builds its tool registry
// (registerApplicationTools) when the `mcp:` component's handleApplication runs,
// and re-runs (refreshApplicationTools) ONLY on a schema-graph change. A
// jsResource-authored `static mcpTools` (like FlairMcp's) is registered by the
// jsResource loader AFTER that pass and does NOT emit a schema-change event, so
// FlairMcp's 9 tools are never enumerated — `tools/list` would return [].
// (Repro: boot flair with mcp.application configured; without this nudge the log
// shows "considered N resource(s), registered 0 tool(s)" and /FlairMcp registers
// only afterward.) This is a Harper gap to be filed upstream (repro-first); see
// the PR body / CHANGELOG. Workaround: after this module loads, re-run the
// application-tool registration so the now-registered FlairMcp is enumerated.
//
// Gated on FLAIR_MCP_ENABLED so it is a zero-cost no-op (no import, no timer)
// when the surface is off — preserving the byte-identical / no-side-effects
// default-off contract. The refresh is imported by absolute path (Harper's
// package `exports` map blocks the subpath, but an absolute require bypasses it),
// fully guarded so a Harper internal-path change degrades to "no tools" rather
// than crashing flair boot. Idempotent + cheap, so the double schedule (a
// microtask-ish 0ms + a 300ms straggler catch) is safe and covers slow async
// jsResource loads.
function nudgeMcpToolRegistration(): void {
  const raw = (process.env.FLAIR_MCP_ENABLED ?? "").trim().toLowerCase();
  if (!(raw === "1" || raw === "true" || raw === "yes" || raw === "on")) return;
  const run = () => {
    try {
      // ESM module: no global `require`. Build one from import.meta.url. The
      // absolute path bypasses Harper's package `exports` map (which blocks the
      // subpath import) and resolves to the SAME module instance Harper loaded
      // (same realpath → same cache entry), so refreshApplicationTools rebuilds
      // the registry Harper actually serves.
      const req = createRequire(import.meta.url);
      const harperMain = req.resolve("@harperfast/harper");
      const appPath = join(dirname(harperMain), "components", "mcp", "tools", "application.js");
      const mod = req(appPath);
      if (typeof mod.registerApplicationTools === "function") {
        // registerApplicationTools (not refresh) — refresh early-returns until the
        // profile registered once; register always rebuilds from the current
        // registry, which now includes FlairMcp. Idempotent (Map.set semantics).
        mod.registerApplicationTools();
      }
    } catch {
      // Harper internals moved or unavailable — degrade to "FlairMcp not listed"
      // (the integration test is the backstop). Never crash flair boot.
    }
  };
  try {
    setTimeout(run, 0);
    setTimeout(run, 300);
  } catch {
    /* no timers available — nothing to schedule */
  }
}

nudgeMcpToolRegistration();
