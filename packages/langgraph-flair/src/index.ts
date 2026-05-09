/**
 * FlairStore — LangGraph BaseStore implementation backed by Flair.
 *
 * Lets a LangGraph agent persist long-term memory ("Store" in LangGraph
 * vocabulary) into a Flair instance, getting crypto-pinned per-agent
 * identity, federated peer-to-peer sync, and cross-orchestrator portability
 * for free. The same memories are then visible to any other Flair-enabled
 * harness (Claude Code via flair-mcp, OpenClaw via openclaw-flair, n8n via
 * n8n-nodes-flair, Hermes via hermes-flair, Pi via pi-flair).
 *
 * The adapter implements the abstract `batch()` method that every BaseStore
 * subclass must provide. The base class's concrete `get/put/search/delete/
 * listNamespaces` helpers all funnel through `batch()`, so we get the full
 * surface from one entry point.
 *
 * # Mapping
 *
 *   LangGraph                    Flair
 *   ---------                    -----
 *   namespace: string[]          tags: ["lg-ns:<joined>", "lg-ns-part:<each>"]
 *   key: string                  id suffix (full id: "lg:<agentId>:<ns>:<key>")
 *   value: object                content: JSON.stringify(value)
 *   search.query                 SemanticSearch q
 *   search.filter (eq/gt/lt)     applied client-side after retrieval
 *   put(value=null)              DELETE
 *
 * Namespace fan-out: each namespace label gets its own tag prefixed with
 * `lg-ns-part:` so search filters can match prefixes, plus the full joined
 * namespace as `lg-ns:` for exact lookups. (LangGraph forbids periods in
 * labels, so we use `/` as the separator.)
 *
 * # Limitations (v1)
 *
 * - LangGraph's `IndexConfig` (custom embedding model + per-field indexing)
 *   is ignored. Flair has its own embedding pipeline (nomic-embed-text-v1.5)
 *   and embeds the full content blob. If you need per-field embedding,
 *   pre-extract the fields and put them as separate items.
 * - `search.filter` operators ($eq/$ne/$gt/$gte/$lt/$lte) are applied
 *   client-side after retrieving the namespace prefix, so filter-heavy
 *   workloads can incur a network round-trip per matching memory. Tag-based
 *   pre-filtering (the namespace prefix) keeps this bounded in practice.
 * - `listNamespaces` returns namespaces seen in the agent's stored memories.
 *   It can't enumerate empty namespaces.
 *
 * # Auth
 *
 * Inherits from FlairClient — Ed25519 keypair if available (preferred), or
 * Basic auth via FLAIR_ADMIN_PASS for standalone deployments.
 */

import { FlairClient } from "@tpsdev-ai/flair-client";

// We import only the types we need from langgraph-checkpoint. The actual
// BaseStore class is extended below; we cast to any when needed because the
// upstream package may not be installed at type-check time (it's a peer dep).

interface Item {
  value: Record<string, any>;
  key: string;
  namespace: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface SearchItem extends Item {
  score?: number;
}

interface GetOperation {
  namespace: string[];
  key: string;
}

interface SearchOperation {
  namespacePrefix: string[];
  filter?: Record<string, any>;
  limit?: number;
  offset?: number;
  query?: string;
}

interface PutOperation {
  namespace: string[];
  key: string;
  value: Record<string, any> | null;
  index?: false | string[];
}

interface ListNamespacesOperation {
  matchConditions?: any[];
  maxDepth?: number;
  limit: number;
  offset: number;
}

type Operation =
  | GetOperation
  | SearchOperation
  | PutOperation
  | ListNamespacesOperation;

const NS_SEP = "/"; // LangGraph forbids periods in namespace labels
const TAG_PREFIX_FULL = "lg-ns:";

/** Single namespace tag — the joined-path form (e.g. "lg-ns:users/profiles").
 *
 *  We previously also wrote per-segment tags (lg-ns-part:users, lg-ns-part:
 *  profiles) for "contains-label" queries, but LangGraph's BaseStore.search
 *  contract takes a `namespacePrefix` array — there's no surface for "items
 *  containing this label anywhere." The per-part tags inflated the Harper
 *  tag index with no read path. Dropped per Kern's review on #370.
 *
 *  If a future LangGraph extension exposes a "search by label" API, we can
 *  add a derived index then — until then, dead storage is worse than a
 *  documented gap. */
function nsTags(namespace: string[]): string[] {
  return [`${TAG_PREFIX_FULL}${namespace.join(NS_SEP)}`];
}

function memoryId(agentId: string, namespace: string[], key: string): string {
  return `lg:${agentId}:${namespace.join(NS_SEP)}:${key}`;
}

function isGet(op: Operation): op is GetOperation {
  return "key" in op && !("value" in op);
}
function isPut(op: Operation): op is PutOperation {
  return "key" in op && "value" in op;
}
function isSearch(op: Operation): op is SearchOperation {
  return "namespacePrefix" in op;
}
function isListNs(op: Operation): op is ListNamespacesOperation {
  return !("namespace" in op) && !("namespacePrefix" in op);
}

/**
 * Apply a single LangGraph filter operator. Mirrors BaseStore's documented
 * surface: $eq (default), $ne, $gt, $gte, $lt, $lte. Bare values are $eq.
 *
 * Exported for unit testing (Kern review on #370 — non-trivial logic with
 * 7 branches must have coverage).
 */
export function matchesFilter(value: any, condition: any): boolean {
  if (condition === null || typeof condition !== "object") {
    return value === condition;
  }
  for (const [op, cmp] of Object.entries(condition)) {
    switch (op) {
      case "$eq": if (value !== cmp) return false; break;
      case "$ne": if (value === cmp) return false; break;
      case "$gt": if (!(value > (cmp as any))) return false; break;
      case "$gte": if (!(value >= (cmp as any))) return false; break;
      case "$lt": if (!(value < (cmp as any))) return false; break;
      case "$lte": if (!(value <= (cmp as any))) return false; break;
      default: return value === condition; // unknown operator → bare-eq fallback
    }
  }
  return true;
}

/** Apply all field filters in a search request. Logical AND across fields. */
export function matchesAllFilters(value: Record<string, any>, filter: Record<string, any> | undefined): boolean {
  if (!filter) return true;
  for (const [field, condition] of Object.entries(filter)) {
    if (!matchesFilter(value[field], condition)) return false;
  }
  return true;
}

/**
 * Configuration for FlairStore. Same shape as FlairClient's config plus
 * one extra: `agentId` is required (LangGraph isn't agent-aware on its own,
 * so we pin it at construction time).
 */
export interface FlairStoreConfig {
  /** Required. The Flair agent identity to scope all memories under. */
  agentId: string;
  /** Flair URL. Defaults to FLAIR_URL env or http://localhost:19926. */
  url?: string;
  /** Path to Ed25519 private key file. Auto-resolved from agent id if omitted. */
  keyPath?: string;
  /** Or pass the key directly as PEM string. */
  privateKey?: string;
  /** Basic-auth fallback for standalone deployments without Ed25519. */
  adminUser?: string;
  adminPassword?: string;
  /** Request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

/**
 * FlairStore — drop-in replacement for LangGraph's `InMemoryStore` that
 * persists into Flair. Extends LangGraph's `BaseStore` interface
 * structurally without importing the abstract class directly (peer-dep
 * pattern keeps the package install-light if a host already has langgraph).
 *
 * Usage:
 *   import { FlairStore } from "@tpsdev-ai/langgraph-flair";
 *   const store = new FlairStore({ agentId: "my-agent" });
 *   const graph = new StateGraph(...).compile({ store });
 *
 * Or pass it to the agent directly:
 *   const agent = createReactAgent({ llm, tools, store });
 */
export class FlairStore {
  private client: FlairClient;
  private agentId: string;

  constructor(config: FlairStoreConfig) {
    if (!config.agentId) {
      throw new Error("FlairStore requires `agentId` — pin the agent identity at construction time.");
    }
    this.agentId = config.agentId;
    this.client = new FlairClient({
      agentId: config.agentId,
      url: config.url,
      keyPath: config.keyPath,
      privateKey: config.privateKey,
      adminUser: config.adminUser,
      adminPassword: config.adminPassword,
      timeoutMs: config.timeoutMs,
    });
  }

  /** The LangGraph-required entry point. All concrete operations funnel here. */
  async batch<Op extends Operation[]>(operations: Op): Promise<any[]> {
    return Promise.all(operations.map((op) => this.dispatch(op)));
  }

  // The same surface BaseStore exposes as concrete methods. Reproduced here
  // so callers don't have to subclass to get them.

  async get(namespace: string[], key: string): Promise<Item | null> {
    return this.dispatch({ namespace, key }) as Promise<Item | null>;
  }

  async put(
    namespace: string[],
    key: string,
    value: Record<string, any>,
    index?: false | string[],
  ): Promise<void> {
    await this.dispatch({ namespace, key, value, index });
  }

  async delete(namespace: string[], key: string): Promise<void> {
    await this.dispatch({ namespace, key, value: null });
  }

  async search(
    namespacePrefix: string[],
    options: { filter?: Record<string, any>; limit?: number; offset?: number; query?: string } = {},
  ): Promise<SearchItem[]> {
    return this.dispatch({ namespacePrefix, ...options }) as Promise<SearchItem[]>;
  }

  // ── private dispatch ─────────────────────────────────────────────────────

  private async dispatch(op: Operation): Promise<unknown> {
    if (isGet(op)) return this.doGet(op);
    if (isPut(op)) return this.doPut(op);
    if (isSearch(op)) return this.doSearch(op);
    if (isListNs(op)) return this.doListNamespaces(op);
    throw new Error("FlairStore: unknown operation");
  }

  private async doGet(op: GetOperation): Promise<Item | null> {
    const id = memoryId(this.agentId, op.namespace, op.key);
    const mem = await this.client.memory.get(id);
    if (!mem) return null;
    return memoryToItem(mem, op.namespace, op.key);
  }

  private async doPut(op: PutOperation): Promise<void> {
    const id = memoryId(this.agentId, op.namespace, op.key);
    if (op.value === null) {
      await this.client.memory.delete(id);
      return;
    }
    const tags = nsTags(op.namespace);
    const content = JSON.stringify(op.value);
    // Subject lets Flair index the namespace head for fast prefix filtering.
    const subject = op.namespace[0] ?? undefined;
    await this.client.memory.write(content, {
      id,
      tags,
      subject,
      durability: "standard",
    });
  }

  private async doSearch(op: SearchOperation): Promise<SearchItem[]> {
    const limit = op.limit ?? 10;
    const offset = op.offset ?? 0;

    let candidates: Array<{ id: string; content: string; score?: number; createdAt?: string; tags?: string[] }>;

    if (op.query) {
      // Semantic search via Flair, then filter by namespace prefix client-side.
      // Fetch a generous candidate pool so the post-filter still honors `limit`.
      const fetched = await this.client.memory.search(op.query, {
        limit: Math.max(limit + offset, 20) * 4,
      });
      candidates = fetched.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        createdAt: r.createdAt,
        tags: r.tags,
      }));
    } else {
      // Tag-based listing for the namespace prefix.
      const fullTag = `${TAG_PREFIX_FULL}${op.namespacePrefix.join(NS_SEP)}`;
      const fetched = await this.client.memory.list({
        tags: op.namespacePrefix.length > 0 ? [fullTag] : [],
        limit: Math.max(limit + offset, 20) * 4,
        order: "createdAt-desc",
      });
      candidates = fetched.map((r) => ({
        id: r.id,
        content: r.content,
        createdAt: r.createdAt,
        tags: r.tags,
      }));
    }

    const items: SearchItem[] = [];
    for (const c of candidates) {
      const parsed = parseStoredId(c.id, this.agentId);
      if (!parsed) continue;
      // Namespace prefix gate (always applied — semantic-search candidates
      // can come from any namespace).
      if (!hasNamespacePrefix(parsed.namespace, op.namespacePrefix)) continue;

      let value: Record<string, any>;
      try {
        value = JSON.parse(c.content);
      } catch {
        // Tolerate non-LG content under the same agent — skip.
        continue;
      }

      if (!matchesAllFilters(value, op.filter)) continue;

      items.push({
        namespace: parsed.namespace,
        key: parsed.key,
        value,
        createdAt: c.createdAt ? new Date(c.createdAt) : new Date(0),
        updatedAt: c.createdAt ? new Date(c.createdAt) : new Date(0),
        score: c.score,
      });
    }
    return items.slice(offset, offset + limit);
  }

  private async doListNamespaces(op: ListNamespacesOperation): Promise<string[][]> {
    // Best-effort: scan recent memories, derive distinct namespaces. Honors
    // `limit` and `offset` against the derived list. maxDepth truncates each
    // namespace to that many segments.
    const fetched = await this.client.memory.list({
      limit: 1000,
      order: "createdAt-desc",
    });
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const r of fetched) {
      const parsed = parseStoredId(r.id, this.agentId);
      if (!parsed) continue;
      let ns = parsed.namespace;
      if (op.maxDepth !== undefined && ns.length > op.maxDepth) ns = ns.slice(0, op.maxDepth);
      const key = ns.join(NS_SEP);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ns);
      if (out.length >= op.offset + op.limit) break;
    }
    return out.slice(op.offset, op.offset + op.limit);
  }
}

// ── helpers exported for testability ────────────────────────────────────────

export function parseStoredId(id: string, agentId: string): { namespace: string[]; key: string } | null {
  // id format: "lg:<agentId>:<ns-joined-by-/>:<key>"
  const expectedPrefix = `lg:${agentId}:`;
  if (!id.startsWith(expectedPrefix)) return null;
  const rest = id.slice(expectedPrefix.length);
  // The last `:` separates ns from key. Namespace can contain `/` but not `:`.
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const nsJoined = rest.slice(0, lastColon);
  const key = rest.slice(lastColon + 1);
  const namespace = nsJoined.length === 0 ? [] : nsJoined.split(NS_SEP);
  return { namespace, key };
}

export function hasNamespacePrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (namespace[i] !== prefix[i]) return false;
  }
  return true;
}

function memoryToItem(mem: any, namespace: string[], key: string): Item {
  let value: Record<string, any> = {};
  try {
    value = typeof mem.content === "string" ? JSON.parse(mem.content) : mem.content;
  } catch {
    value = { __raw: mem.content };
  }
  return {
    namespace,
    key,
    value,
    createdAt: mem.createdAt ? new Date(mem.createdAt) : new Date(0),
    updatedAt: mem.updatedAt ? new Date(mem.updatedAt) : (mem.createdAt ? new Date(mem.createdAt) : new Date(0)),
  };
}

// Re-export types for downstream consumers
export type { Item, SearchItem, GetOperation, PutOperation, SearchOperation, ListNamespacesOperation };
