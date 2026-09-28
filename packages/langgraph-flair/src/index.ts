/**
 * FlairStore — LangGraph BaseStore implementation backed by Flair.
 *
 * FlairStore stores JSON items in Flair under a configured agent identity.
 * Requests use Ed25519 when a key resolves, or configured administrator
 * Basic authentication when no key resolves. Other Flair clients can
 * retrieve the items when authorized; new items default to private and are
 * excluded from federation.
 *
 * FlairStore defines get, put, delete, search, batch, and listNamespaces. The first four dispatch directly; batch dispatches concurrently through Promise.all; listNamespaces builds and submits a batch operation.
 *
 * # Mapping
 *
 *   LangGraph                    Flair
 *   ---------                    -----
 *   namespace: string[]          tags: ["lg-ns:<encoded labels joined by />"]  (one tag)
 *   key: string                  id suffix (full id: "lg:<agentId>:<encoded labels joined by />:<key>")
 *   value: object                content: JSON.stringify(value)
 *   search.query                 SemanticSearch q
 *   search.filter (eq/gt/lt)     applied client-side after retrieval
 *   put(value=null)              DELETE
 *
 * A namespace is stored in ONE form. Each label is escaped, then the labels
 * are joined by `/`, and that string is the whole `lg-ns:` tag and the middle
 * of the id. LangGraph forbids `.` in namespace labels, so `.` is the escape
 * character: `/` is written `.2F` and `:` is written `.3A`, and every other
 * character is unchanged. Earlier items under valid labels without `/` or `:`
 * retain their IDs and tags and need no migration. A label that is empty, or
 * that contains `.`, is invalid and is refused before any id or tag is built.
 * Both search paths filter on the client: the queryless path lists the agent's full item set and matches the
 * requested namespace PREFIX against the stored tag, and the semantic path
 * post-filters the namespace parsed from each id.
 *
 * # Limitations (v1)
 *
 * - FlairStore exposes no IndexConfig option and ignores the per-item index
 *   argument. It sends each value as JSON content to Flair, which attempts
 *   server-side embedding using its configured backend. To store fields
 *   separately, extract them into separate items before calling put.
 * - `search.filter` operators ($eq/$ne/$gt/$gte/$lt/$lte) are applied
 *   client-side after retrieving candidates. Filtering follows one backend
 *   request, so large candidate sets can increase transfer and local processing.
 * - Namespace enumeration derives namespaces from the agent's newest 1,000
 *   memories, applies match conditions and maxDepth, and paginates the
 *   distinct results. Namespaces without stored items cannot be enumerated,
 *   and namespaces represented only outside that scan can be missed.
 *
 * # Auth
 *
 * FlairStore composes FlairClient, which signs requests with Ed25519 when a
 * key resolves and otherwise uses configured administrator Basic credentials
 * from adminUser/adminPassword or FLAIR_ADMIN_USER/FLAIR_ADMIN_PASSWORD.
 */

import { FlairClient } from "@tpsdev-ai/flair-client";
// Type-only: `Operation` and `OperationResults` appear only in `batch`'s public
// signature, so this adds nothing at runtime and the peer package stays an
// optional runtime dependency.
import type { Operation, OperationResults } from "@langchain/langgraph-checkpoint";

// Item types are declared locally; the operation types in `batch`'s signature
// come from the peer package as TYPE-ONLY imports (above). This module imports
// FlairClient and does not import or extend BaseStore.

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

type FlairOperation =
  | GetOperation
  | SearchOperation
  | PutOperation
  | ListNamespacesOperation;

const NS_SEP = "/"; // separator between encoded labels
const TAG_PREFIX_FULL = "lg-ns:";
const ESCAPE = "."; // LangGraph forbids "." in labels, so it is our escape character

/**
 * A namespace label is valid only when it is a non-empty string that does not
 * contain `.` (LangGraph's own rule — `.` is reserved as the escape char).
 */
function isInvalidLabel(label: unknown): boolean {
  return typeof label !== "string" || label.length === 0 || label.includes(ESCAPE) || !isWellFormed(label);
}

// An unpaired UTF-16 surrogate cannot be percent-encoded into a request path,
// so a label or key containing one could never reach the server. (Written as a
// regex rather than String.prototype.isWellFormed, which needs Node 20.)
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isWellFormed(s: string): boolean {
  return !UNPAIRED_SURROGATE.test(s);
}

/** A key is usable only when it is a well-formed string. */
function isInvalidKey(key: unknown): boolean {
  return typeof key !== "string" || !isWellFormed(key);
}

/**
 * Escape one namespace label for storage: `/` → `.2F`, `:` → `.3A`; every
 * other character is unchanged. A valid label contains no `.`, so the result
 * is unambiguous and decodeLabel reverses it exactly.
 */
export function encodeLabel(label: string): string {
  return label.replace(/\//g, ".2F").replace(/:/g, ".3A");
}

/** Decodes the output of encodeLabel for valid namespace labels. */
export function decodeLabel(encoded: string): string {
  return encoded.replace(/\.2F/g, "/").replace(/\.3A/g, ":");
}

/** Encode each label, then join with `/` — the one stored form. */
function encodeNamespace(namespace: string[]): string {
  return namespace.map(encodeLabel).join(NS_SEP);
}

/** Throw if any label is not a non-empty string without `.` (LangGraph's rule). */
function assertValidNamespace(namespace: string[]): void {
  namespace.forEach((label, i) => {
    if (isInvalidLabel(label)) {
      throw new Error(
        `FlairStore: refusing namespace label at index ${i}: LangGraph forbids "." in namespace labels, and every label must be a non-empty, well-formed string (no unpaired surrogate). No id or tag was written.`,
      );
    }
  });
}

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
  return [`${TAG_PREFIX_FULL}${encodeNamespace(namespace)}`];
}

/**
 * flair#1939 — does a stored full-namespace tag match this namespace PREFIX?
 * The prefix labels are encoded (the same one stored form), then
 * `lg-ns:<encoded>` matches when the encoded prefix equals the tag's encoded
 * namespace or is a COMPONENT prefix of it (`lg-ns:a/b` matches a prefix of
 * `("a","b")` and `("a","b","c")`, but NOT `("a","bc")`, and a single label
 * `"a/b"` encodes to `a.2Fb` and does not match `("a",)`). An EMPTY prefix
 * matches every `lg-ns:` item, and a prefix with an invalid label matches
 * nothing. Earlier items under valid labels without `/` or `:` retain their
 * IDs and tags and need no migration.
 */
export function namespaceTagMatches(tags: unknown, prefix: string[]): boolean {
  if (!Array.isArray(tags)) return false;
  if (prefix.some(isInvalidLabel)) return false;
  const joined = encodeNamespace(prefix);
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX_FULL)) continue;
    const ns = tag.slice(TAG_PREFIX_FULL.length);
    if (joined.length === 0) return true; // empty prefix: every lg-ns item
    if (ns === joined || ns.startsWith(joined + NS_SEP)) return true;
  }
  return false;
}

function memoryId(agentId: string, namespace: string[], key: string): string {
  return `lg:${agentId}:${encodeNamespace(namespace)}:${key}`;
}

/**
 * flair#1939 — does a decoded namespace satisfy one listNamespaces match
 * condition? Mirrors LangGraph's own store: `matchType` is `prefix` or
 * `suffix`, and `path` is the label pattern (a `*` element matches any label).
 */
export function namespaceMatchesCondition(condition: any, namespace: string[]): boolean {
  const { matchType, path } = condition ?? {};
  if (matchType !== "prefix" && matchType !== "suffix") {
    throw new Error(`listNamespaces: unsupported match type: ${matchType}`);
  }
  if (!Array.isArray(path) || path.length > namespace.length) return false;
  // Validate condition labels before comparing them with decoded stored
  // namespaces; an invalid condition matches nothing.
  if (path.some((label: unknown) => label !== "*" && isInvalidLabel(label))) return false;
  const start = matchType === "prefix" ? 0 : namespace.length - path.length;
  return path.every((label: unknown, i: number) => label === "*" || namespace[start + i] === label);
}

function isGet(op: FlairOperation): op is GetOperation {
  return "key" in op && !("value" in op);
}
function isPut(op: FlairOperation): op is PutOperation {
  return "key" in op && "value" in op;
}
function isSearch(op: FlairOperation): op is SearchOperation {
  return "namespacePrefix" in op;
}
function isListNs(op: FlairOperation): op is ListNamespacesOperation {
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
 * FlairStoreConfig requires agentId and exposes url, keyPath, a PEM-string
 * privateKey, adminUser, adminPassword, and timeoutMs; these values are
 * forwarded to the composed FlairClient.
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
 * FlairStore implements LangGraph's `BaseStore` interface and persists items
 * into Flair. It satisfies the interface structurally without importing the
 * abstract class directly (peer-dep pattern keeps the package install-light
 * if a host already has langgraph).
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

  /** Dispatches the supplied operations concurrently and returns their results in input order. */
  // The signature uses the peer package's `Operation`/`OperationResults`
  // (type-only imports), exactly as `BaseStore.batch` declares them, so the
  // published return type stays precise instead of `any`. The single cast is
  // confined to the dispatcher result: `dispatch` returns `unknown` because its
  // branches produce different shapes, and the mapped `OperationResults<Op>` is
  // determined by the input operations.
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    return Promise.all(operations.map((op) => this.dispatch(op))) as OperationResults<Op>;
  }
  // Convenience methods for get, put, delete, and search; each calls the
  // private dispatcher directly. `listNamespaces`, `start`, and `stop` are
  // public too (see below).

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

  /**
   * List namespaces seen in the agent's stored memories. `prefix` and `suffix`
   * become match conditions, exactly as LangGraph's `BaseStore.listNamespaces`
   * builds them; `limit` defaults to 100 and `offset` to 0.
   */
  async listNamespaces(
    options: { prefix?: string[]; suffix?: string[]; maxDepth?: number; limit?: number; offset?: number } = {},
  ): Promise<string[][]> {
    const { prefix, suffix, maxDepth, limit = 100, offset = 0 } = options;
    const matchConditions: any[] = [];
    if (prefix) matchConditions.push({ matchType: "prefix", path: prefix });
    if (suffix) matchConditions.push({ matchType: "suffix", path: suffix });
    return (await this.batch([
      {
        matchConditions: matchConditions.length ? matchConditions : undefined,
        maxDepth,
        limit,
        offset,
      },
    ]))[0];
  }

  /** FlairStore has no background work to start, so this is a no-op. */
  start(): void {}

  /** FlairStore has no background work to stop, so this is a no-op. */
  stop(): void {}

  // ── private dispatch ─────────────────────────────────────────────────────

  private async dispatch(op: FlairOperation): Promise<unknown> {
    if (isGet(op)) return this.doGet(op);
    if (isPut(op)) return this.doPut(op);
    if (isSearch(op)) return this.doSearch(op);
    if (isListNs(op)) return this.doListNamespaces(op);
    throw new Error("FlairStore: unknown operation");
  }

  private async doGet(op: GetOperation): Promise<Item | null> {
    if (op.namespace.some(isInvalidLabel) || isInvalidKey(op.key)) return null;
    const id = memoryId(this.agentId, op.namespace, op.key);
    const mem = await this.client.memory.get(id);
    if (!mem) return null;
    return memoryToItem(mem, op.namespace, op.key);
  }

  private async doPut(op: PutOperation): Promise<void> {
    assertValidNamespace(op.namespace);
    if (isInvalidKey(op.key)) {
      throw new Error(
        "FlairStore: refusing key: it must be a well-formed string (no unpaired surrogate), because it is sent in a request path. No id was written.",
      );
    }
    const id = memoryId(this.agentId, op.namespace, op.key);
    if (op.value === null) {
      await this.client.memory.delete(id);
      return;
    }
    const tags = nsTags(op.namespace);
    const content = JSON.stringify(op.value);
    // Stores the namespace's first label as subject; current store searches do not send it as a backend filter.
    const subject = op.namespace[0] ?? undefined;
    await this.client.memory.write(content, {
      id,
      tags,
      subject,
      durability: "standard",
    });
  }

  private async doSearch(op: SearchOperation): Promise<SearchItem[]> {
    if (op.namespacePrefix.some(isInvalidLabel)) return [];
    const limit = op.limit ?? 10;
    const offset = op.offset ?? 0;

    let candidates: Array<{ id: string; content: string; score?: number; createdAt?: string; tags?: string[] }>;

    if (op.query) {
      // Semantic search via Flair, then filter by namespace prefix client-side.
      // Extra candidates can reduce short pages after filtering but do not guarantee a full page.
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
      // flair#1939: prefix match on the stored full-namespace tag. The listing
      // is NOT filtered to the exact tag, so items stored under DESCENDANT
      // namespaces are candidates; `namespaceTagMatches` selects by
      // tag-component prefix (component boundary, existing items covered). The
      // full agent-scoped set is fetched (no candidate cap), so a search never
      // returns a short page when more matches exist.
      const fetched = await this.client.memory.list({ order: "createdAt-desc" });
      candidates = fetched
        .filter((r) => namespaceTagMatches(r.tags, op.namespacePrefix))
        .map((r) => ({
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
    // A condition with an invalid label matches nothing: answer before any request.
    const conditionHasInvalidLabel = (op.matchConditions ?? []).some(
      (c) => Array.isArray(c?.path) && c.path.some((label: unknown) => label !== "*" && isInvalidLabel(label)),
    );
    if (conditionHasInvalidLabel) return [];
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
      if (op.matchConditions && op.matchConditions.length > 0) {
        if (!op.matchConditions.every((c) => namespaceMatchesCondition(c, ns))) continue;
      }
      if (op.maxDepth !== undefined && ns.length > op.maxDepth) ns = ns.slice(0, op.maxDepth);
      const key = JSON.stringify(ns); // de-dup on the label list, not a `/` join
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
  // id format: "lg:<agentId>:<encoded labels joined by />:<key>". An encoded
  // namespace never contains a raw `:`, so the FIRST `:` after the prefix is
  // the separator; the key may itself contain `:` and `/`.
  const expectedPrefix = `lg:${agentId}:`;
  if (!id.startsWith(expectedPrefix)) return null;
  const rest = id.slice(expectedPrefix.length);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;
  const nsJoined = rest.slice(0, firstColon);
  const key = rest.slice(firstColon + 1);
  const namespace = nsJoined.length === 0 ? [] : nsJoined.split(NS_SEP).map(decodeLabel);
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
