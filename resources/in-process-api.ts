/**
 * ─── Public in-process API (flair#956) ───────────────────────────────────────
 *
 * The facade that hides four internal implementation details a Harper engineer
 * should never have to learn:
 *
 *   1. A deep import path into our dist/
 *   2. That server.resources is keyed by REST path with no leading slash
 *   3. That the registry entry wraps the class in .Resource
 *   4. That creates need collectionResource() while reads do not
 *
 * And collapses the agentId double-pass (context + body) into one.
 *
 * ```ts
 * import { Flair } from "@tpsdev-ai/flair";
 * const flair = new Flair(server);
 * const planner = flair.as("planner");
 * await planner.memory.write("deploy runs at 0200 UTC");
 * ```
 *
 * The facade does NOT hide the security boundary. In-process identity is
 * asserted, not verified — co-location IS the grant. flair.as(id) requires a
 * non-empty id (runtime throw). flair.admin and flair.internal are separate,
 * greppable properties. The docs say plainly: build the context from your own
 * server-side state, never from request data.
 *
 * ── Internal implementation ─────────────────────────────────────────────────
 * Every operation delegates to the existing primitives in ./in-process.js
 * (agentContext, adminContext, internalContext, collectionResource). The facade
 * is additive — existing code using the raw seam continues to work.
 */

import type { Server } from "harper";
import {
  agentContext,
  adminContext,
  internalContext,
  collectionResource,
  InProcessContextError,
  type CallContext,
} from "./in-process.js";

// ─── Re-export for the "./server" entry point ────────────────────────────────
export { agentContext, adminContext, internalContext, collectionResource, InProcessContextError };
export type { CallContext };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemoryWriteOptions {
  durability?: "standard" | "persistent" | "permanent" | "ephemeral";
  visibility?: "private" | "shared";
  tags?: string[];
  type?: string;
  id?: string;
}

export interface MemorySearchOptions {
  tags?: string[];
  limit?: number;
  type?: string;
  durability?: string;
  visibility?: string;
  since?: string;
  asOf?: string;
}

export interface RecallOptions {
  limit?: number;
  includeTrust?: boolean;
  abstain?: boolean;
  scoring?: "raw" | "composite";
  minScore?: number;
  since?: string;
  asOf?: string;
  tag?: string;
  subject?: string;
  subjects?: string[];
}

export interface RegisterAgentOptions {
  publicKey?: string;
  displayName?: string;
  runtime?: string;
  admin?: boolean;
}

export interface MemoryRecord {
  id: string;
  agentId: string;
  content: string;
  durability: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  agentId: string;
  [key: string]: unknown;
}

// ─── Resource resolution ─────────────────────────────────────────────────────

/**
 * Resolve a Flair resource class from the Harper server registry.
 * Throws with a helpful message listing available resources if not found.
 */
function resolveResource(server: Server, name: string): any {
  const entry = (server.resources as any).get?.(name) ?? server.resources.getMatch?.(name);
  if (!entry?.Resource) {
    const keys = [...(server.resources as any).keys()].sort();
    const available = keys.length > 0 ? keys.join(", ") : "(none)";
    throw new Error(
      `Flair is not loaded in this Harper instance.\n` +
        `The '${name}' resource was not found in the registry.\n` +
        `Available: [${available}]\n` +
        `Make sure @tpsdev-ai/flair is installed as a component of this instance.`,
    );
  }
  return entry.Resource;
}

// ─── AgentHandle ─────────────────────────────────────────────────────────────

/**
 * A handle that carries agent identity and scopes every operation to that agent.
 *
 * Returned by {@link Flair.as}. The agentId is validated at construction time
 * (runtime, not types) — missing, empty, blank, or non-string throws
 * {@link InProcessContextError}.
 *
 * **Security:** in-process identity is asserted, not verified. Build the
 * agentId from your own server-side state, never from request data.
 */
export class AgentHandle {
  readonly agentId: string;
  #server: Server;
  #ctx: CallContext;

  constructor(server: Server, agentId: string) {
    this.#server = server;
    this.agentId = agentId;
    // Throws InProcessContextError on missing/empty/blank id — see
    // resources/in-process.ts's safety-design block for why this is
    // not merely defensive.
    this.#ctx = agentContext(agentId);
  }

  /** Memory operations scoped to this agent. */
  get memory(): AgentMemory {
    return new AgentMemory(this.#server, this.#ctx, this.agentId);
  }

  /**
   * Semantic search scoped to this agent.
   *
   * ```ts
   * const hits = await planner.recall("deploy schedule", { limit: 5 });
   * ```
   */
  async recall(query: string, opts?: RecallOptions): Promise<SearchResult[]> {
    const Cls = resolveResource(this.#server, "SemanticSearch");
    const h = new Cls(undefined, this.#ctx);
    const body: Record<string, unknown> = { q: query, limit: opts?.limit ?? 5 };
    if (opts?.includeTrust === true) body.includeTrust = true;
    if (opts?.abstain === true) body.abstain = true;
    if (opts?.scoring) body.scoring = opts.scoring;
    if (opts?.minScore !== undefined) body.minScore = opts.minScore;
    if (opts?.since) body.since = opts.since;
    if (opts?.asOf) body.asOf = opts.asOf;
    if (opts?.tag) body.tag = opts.tag;
    if (opts?.subject) body.subject = opts.subject;
    if (opts?.subjects) body.subjects = opts.subjects;
    return unwrap(await h.post(body));
  }
}

// ─── AgentMemory (per-agent memory operations) ───────────────────────────────

class AgentMemory {
  #server: Server;
  #ctx: CallContext;
  #agentId: string;

  constructor(server: Server, ctx: CallContext, agentId: string) {
    this.#server = server;
    this.#ctx = ctx;
    this.#agentId = agentId;
  }

  /**
   * Write a memory as this agent.
   *
   * The agentId is stamped from the handle's context — the caller never
   * passes it, and any agentId in opts is overwritten. This collapses the
   * double-pass (context + body) into one.
   */
  async write(content: string, opts?: MemoryWriteOptions): Promise<MemoryRecord> {
    const Cls = resolveResource(this.#server, "Memory");
    const h: any = await collectionResource(Cls, this.#ctx);
    const body: Record<string, unknown> = {
      agentId: this.#agentId,
      content,
    };
    if (opts?.durability) body.durability = opts.durability;
    if (opts?.visibility) body.visibility = opts.visibility;
    if (opts?.tags) body.tags = opts.tags;
    if (opts?.type) body.type = opts.type;
    if (opts?.id) body.id = opts.id;
    return unwrap(await h.post(body));
  }

  /** Get a memory by id, scoped to this agent. */
  async get(id: string): Promise<MemoryRecord | null> {
    const Cls = resolveResource(this.#server, "Memory");
    const h = new Cls(undefined, this.#ctx);
    return unwrap(await h.get(id));
  }

  /**
   * Search memories scoped to this agent.
   *
   * Delegates to Memory.search() which applies the agent's read scope
   * (own memories + granted owners' shared memories).
   */
  async search(opts?: MemorySearchOptions): Promise<MemoryRecord[]> {
    const Cls = resolveResource(this.#server, "Memory");
    const h = new Cls(undefined, this.#ctx);
    const conditions: any[] = [];
    if (opts?.tags) {
      for (const tag of opts.tags) {
        conditions.push({ search_attribute: "tags", search_type: "contains", search_value: tag });
      }
    }
    if (opts?.type) {
      conditions.push({ search_attribute: "type", search_type: "equals", search_value: opts.type });
    }
    if (opts?.durability) {
      conditions.push({ search_attribute: "durability", search_type: "equals", search_value: opts.durability });
    }
    if (opts?.visibility) {
      conditions.push({ search_attribute: "visibility", search_type: "equals", search_value: opts.visibility });
    }
    const query = conditions.length > 0 ? { conditions, operator: "and" } : undefined;
    return unwrap(await h.search(query));
  }
}

// ─── AdminHandle ─────────────────────────────────────────────────────────────

/**
 * Flair-admin operations — unfiltered reads, cross-agent writes.
 *
 * **This is a root shell.** Every call site is greppable via
 * `git grep "flair.admin"`. Use for provisioning and maintenance only,
 * never as a request handler's default.
 *
 * The admin agentId is validated at construction time (same guard as
 * {@link AgentHandle}).
 */
export class AdminHandle {
  readonly agentId: string;
  #server: Server;
  #ctx: CallContext;

  constructor(server: Server, agentId: string) {
    this.#server = server;
    this.agentId = agentId;
    this.#ctx = adminContext(agentId);
  }

  /**
   * Register an agent through the Agent resource (full Principal shape).
   *
   * ```ts
   * await flair.admin.registerAgent("planner", { publicKey: "pending" });
   * ```
   */
  async registerAgent(id: string, opts?: RegisterAgentOptions): Promise<Record<string, unknown>> {
    const Cls = resolveResource(this.#server, "Agent");
    const h: any = await collectionResource(Cls, this.#ctx);
    const body: Record<string, unknown> = {
      id,
      name: id,
      displayName: opts?.displayName ?? id,
      publicKey: opts?.publicKey ?? "pending",
      runtime: opts?.runtime ?? "headless",
    };
    if (opts?.admin === true) body.admin = true;
    return unwrap(await h.post(body));
  }

  /** Memory operations with admin authority (unfiltered reads, cross-agent writes). */
  get memory(): AdminMemory {
    return new AdminMemory(this.#server, this.#ctx, this.agentId);
  }
}

// ─── AdminMemory ─────────────────────────────────────────────────────────────

class AdminMemory {
  #server: Server;
  #ctx: CallContext;
  #agentId: string;

  constructor(server: Server, ctx: CallContext, agentId: string) {
    this.#server = server;
    this.#ctx = ctx;
    this.#agentId = agentId;
  }

  /** Read any memory by id, unfiltered. */
  async get(id: string): Promise<MemoryRecord | null> {
    const Cls = resolveResource(this.#server, "Memory");
    const h = new Cls(undefined, this.#ctx);
    return unwrap(await h.get(id));
  }

  /**
   * Write a memory attributed to another agent.
   *
   * ```ts
   * await flair.admin.memory.write("researcher", "provisioned memory", { visibility: "shared" });
   * ```
   */
  async write(asAgentId: string, content: string, opts?: MemoryWriteOptions): Promise<MemoryRecord> {
    const Cls = resolveResource(this.#server, "Memory");
    // Use adminContext for the acting admin, but stamp the target agentId
    // on the body so the memory is owned by the target agent.
    const h: any = await collectionResource(Cls, this.#ctx);
    const body: Record<string, unknown> = {
      agentId: asAgentId,
      content,
    };
    if (opts?.durability) body.durability = opts.durability;
    if (opts?.visibility) body.visibility = opts.visibility;
    if (opts?.tags) body.tags = opts.tags;
    if (opts?.type) body.type = opts.type;
    if (opts?.id) body.id = opts.id;
    return unwrap(await h.post(body));
  }
}

// ─── InternalHandle ──────────────────────────────────────────────────────────

/**
 * Trusted, unattributed, unfiltered operations — Flair's `internal` verdict.
 *
 * Reads see every agent's private records; writes are owned by nobody.
 * This exists for work that is genuinely infrastructure: provisioning a
 * principal, a migration, a maintenance sweep.
 *
 * Every call site is greppable via `git grep "flair.internal"`.
 */
export class InternalHandle {
  #server: Server;
  #ctx: CallContext;

  constructor(server: Server) {
    this.#server = server;
    this.#ctx = internalContext();
  }

  /** Raw Agent table access for provisioning. */
  get agentTable(): InternalAgentTable {
    return new InternalAgentTable(this.#server, this.#ctx);
  }
}

// ─── InternalAgentTable ──────────────────────────────────────────────────────

class InternalAgentTable {
  #server: Server;
  #ctx: CallContext;

  constructor(server: Server, ctx: CallContext) {
    this.#server = server;
    this.#ctx = ctx;
  }

  /** Write directly to the Agent resource (bypasses admin gate via internal context). */
  async put(record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const Cls = resolveResource(this.#server, "Agent");
    const h: any = await collectionResource(Cls, this.#ctx);
    return unwrap(await h.post(record));
  }
}

// ─── Flair (the facade) ──────────────────────────────────────────────────────

/**
 * The public in-process API for Flair embedded in a Harper app.
 *
 * One handle per Harper instance. Resolves resources lazily on first use.
 *
 * ```ts
 * import { Flair } from "@tpsdev-ai/flair";
 * const flair = new Flair(server);
 * const planner = flair.as("planner");
 * await planner.memory.write("deploy runs at 0200 UTC");
 * ```
 *
 * **Security:** In-process identity is asserted, not verified — co-location
 * IS the grant. Build the agentId from your own server-side state, never
 * from request data. `flair.as(id)` requires a non-empty id (runtime throw).
 * `flair.admin` and `flair.internal` are separate, greppable properties for
 * deliberate escalation.
 */
export class Flair {
  #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  /**
   * Return a handle that acts as the given agent.
   *
   * The agentId is runtime-validated: missing, empty, blank, or non-string
   * throws {@link InProcessContextError}. Build it from your own server-side
   * state, never from request data.
   */
  as(agentId: string): AgentHandle {
    return new AgentHandle(this.#server, agentId);
  }

  /**
   * Admin operations — unfiltered reads, cross-agent writes.
   *
   * **This is a root shell.** Every call site is greppable via
   * `git grep "flair.admin"`. Use for provisioning and maintenance only.
   */
  get admin(): AdminHandle {
    // AdminHandle requires an agentId for attribution. We use a sentinel
    // that makes the admin identity visible in audit logs. The caller
    // should use a real admin agent id when possible.
    return new AdminHandle(this.#server, "_admin");
  }

  /**
   * Internal operations — trusted, unattributed, unfiltered.
   *
   * Every call site is greppable via `git grep "flair.internal"`.
   * Use for infrastructure work only: provisioning, migrations, maintenance.
   */
  get internal(): InternalHandle {
    return new InternalHandle(this.#server);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Unwrap a handler return value into a plain object.
 * Handlers may return a `Response` (the 401/403/400 guards) — surface its
 * JSON body so the caller sees the structured error rather than an opaque object.
 */
async function unwrap(value: any): Promise<any> {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    try {
      const body = await value.json();
      return { error: body?.error ?? "request failed", status: (value as any).status, ...body };
    } catch {
      return { error: "request failed", status: (value as any).status };
    }
  }
  return value;
}
