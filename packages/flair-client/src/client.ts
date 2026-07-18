/**
 * Flair client — lightweight, zero-dep HTTP client for Flair.
 *
 * Usage:
 *   const flair = new FlairClient({ agentId: 'my-agent' })
 *   await flair.memory.write('learned something')
 *   const results = await flair.memory.search('that thing')
 *   const ctx = await flair.bootstrap({ maxTokens: 4000 })
 */

import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey } from "node:crypto";
import { loadPrivateKey, resolveKeyPath, signRequest } from "./auth.js";
import type {
  FlairClientConfig,
  Memory,
  MemoryType,
  Durability,
  Visibility,
  SoulEntry,
  SearchResult,
  BootstrapResult,
  Relationship,
} from "./types.js";

const DEFAULT_URL = "http://localhost:19926";
const DEFAULT_TIMEOUT = 30_000;

export class FlairClient {
  readonly url: string;
  readonly agentId: string;
  readonly memory: MemoryApi;
  readonly relationship: RelationshipApi;
  readonly soul: SoulApi;
  /** flair#718 authorship-provenance — see FlairClientConfig.claimedClient's
   *  doc (types.ts). `undefined` when neither config nor FLAIR_CLIENT is set;
   *  MemoryApi reads this to (optionally) stamp memory write payloads. */
  readonly claimedClient: string | undefined;

  private privateKey: KeyObject | null = null;
  private keyResolved = false;
  private keyPath: string | undefined;
  private rawPrivateKey: string | KeyObject | undefined;
  private timeoutMs: number;
  private basicAuth: string | null = null;

  constructor(config: FlairClientConfig) {
    this.url = (config.url ?? process.env.FLAIR_URL ?? DEFAULT_URL).replace(/\/$/, "");
    this.agentId = config.agentId || process.env.FLAIR_AGENT_ID || "";
    this.keyPath = config.keyPath;
    if (config.privateKey !== undefined) {
      this.rawPrivateKey = config.privateKey;
    }
    this.claimedClient = config.claimedClient || process.env.FLAIR_CLIENT || undefined;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    // Basic auth fallback for standalone deployments without Ed25519 keys
    const adminUser = config.adminUser ?? process.env.FLAIR_ADMIN_USER;
    const adminPass = config.adminPassword ?? process.env.FLAIR_ADMIN_PASSWORD;
    if (adminUser && adminPass) {
      this.basicAuth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
    }
    this.memory = new MemoryApi(this);
    this.relationship = new RelationshipApi(this);
    this.soul = new SoulApi(this);
  }

  private resolveKey(): KeyObject | null {
    if (this.keyResolved) return this.privateKey;
    this.keyResolved = true;
    // In-memory key takes priority over file-based resolution.
    if (this.rawPrivateKey) {
      if (typeof this.rawPrivateKey === "string") {
        this.privateKey = createPrivateKey(this.rawPrivateKey);
      } else {
        this.privateKey = this.rawPrivateKey;
      }
      return this.privateKey;
    }
    const path = resolveKeyPath(this.agentId, this.keyPath);
    if (path) {
      // Key file exists — failure to parse is a hard error.
      // Silent fallback to unauthenticated would be a security risk.
      this.privateKey = loadPrivateKey(path);
    }
    return this.privateKey;
  }

  /** Make an authenticated request to Flair. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.resolveKey();
    if (key) {
      headers["Authorization"] = signRequest(this.agentId, key, method, path);
    } else if (this.basicAuth) {
      headers["Authorization"] = this.basicAuth;
    }
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FlairError(method, path, res.status, text.slice(0, 500));
    }
    const text = await res.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  /** Cold-start bootstrap — get soul + recent memories as a formatted context block. */
  async bootstrap(opts: {
    maxTokens?: number;
    currentTask?: string;
    channel?: string;
    surface?: string;
    subjects?: string[];
  } = {}): Promise<BootstrapResult> {
    return this.request("POST", "/BootstrapMemories", {
      agentId: this.agentId,
      maxTokens: opts.maxTokens ?? 4000,
      currentTask: opts.currentTask,
      channel: opts.channel,
      surface: opts.surface,
      subjects: opts.subjects,
    });
  }

  /** Health check. */
  async health(): Promise<{ status: string }> {
    return this.request("GET", "/Health");
  }
}

// ─── Memory API ─────────────────────────────────────────────────────────────

class MemoryApi {
  constructor(private client: FlairClient) {}

  /**
   * Write a memory. NEVER suppresses the write — the record is always
   * created. `dedup`/`dedupThreshold` are passthrough HINTS forwarded to the
   * server, which runs a conservative (cosine + lexical) near-duplicate check
   * and, when a match is found, attaches a collision signal to the response
   * (`deduplicated`, `matchedId`, `matchConfidence`) instead of dropping the
   * new content. (Historical note: a near-duplicate previously short-circuited
   * this method to return the EXISTING record without writing — that silently
   * dropped distinct-but-similar content, e.g. flair#526. The check now lives
   * server-side in Memory.put()/Memory.post() and never suppresses a write.)
   */
  async write(content: string, opts: {
    id?: string;
    type?: MemoryType;
    durability?: Durability;
    tags?: string[];
    subject?: string;
    /** Writer-controlled sharing intent. Omit to let the
     *  server apply its durability-keyed default (permanent/persistent →
     *  shared, standard/ephemeral → private) — only forwarded when the
     *  caller explicitly sets it, so omitting this is a no-op change from
     *  today's behavior. */
    visibility?: Visibility;
    /** Ask the server to run its conservative near-duplicate check for this
     *  write and report a collision signal if found. Does NOT suppress the
     *  write either way. Default: false (server still applies its own
     *  default gate — this only requests the signal be computed/reported;
     *  see dedupThreshold to tune it). */
    dedup?: boolean;
    /** Cosine-similarity threshold hint for the server's dedup gate.
     *  Default (server-side): 0.95 */
    dedupThreshold?: number;
  } = {}): Promise<Memory> {
    const id = opts.id ?? `${this.client.agentId}-${crypto.randomUUID()}`;
    const record: Record<string, unknown> = {
      id,
      agentId: this.client.agentId,
      content,
      type: opts.type ?? "session",
      durability: opts.durability ?? "standard",
      tags: opts.tags ?? [],
      subject: opts.subject,
      createdAt: new Date().toISOString(),
    };
    // Forward visibility ONLY when the caller set it — an unset visibility
    // must reach the server as "absent" (not e.g. defaulted client-side) so
    // the server's durability-keyed default (Memory.post/put) is the one
    // source of truth for the default, never duplicated here.
    if (opts.visibility !== undefined) record.visibility = opts.visibility;
    // Passthrough hints — the server strips these before persisting; they are
    // never stored on the record itself.
    if (opts.dedup !== undefined) record.dedup = opts.dedup;
    if (opts.dedupThreshold !== undefined) record.dedupThreshold = opts.dedupThreshold;
    // flair#718 authorship-provenance: forward this process's claimed client
    // label (config.claimedClient / FLAIR_CLIENT env) only when set — the
    // server folds it into provenance.claimed.client and strips it from the
    // row (resources/Memory.ts). Absent = omitted, zero behavior change.
    if (this.client.claimedClient) record.claimedClient = this.client.claimedClient;

    const response = await this.client.request<Record<string, unknown>>("PUT", `/Memory/${id}`, record);
    // Merge the server response (deduplicated/matchedId/matchConfidence/
    // written, plus any echoed fields) over the locally-constructed record —
    // the write always happens, so `record` always reflects what was sent,
    // and the server's signal fields (if any) always come through.
    return { ...record, ...(response ?? {}) } as unknown as Memory;
  }

  /**
   * Update an existing memory by id. Dedup-BYPASSED (this IS the intentional
   * overwrite/version path, not an ambiguous new write) — always writes.
   * Auth: the caller must own the memory (enforced server-side by the SAME
   * ownership check Memory.put()/Memory.post() already run — no parallel
   * check here).
   *
   * Default (`preserveHistory` unset/false): same-id overwrite via a
   * full-record PUT. Harper's PUT is FULL RECORD REPLACEMENT, so we read the
   * existing record first and merge the new content on top (never a bare
   * partial). The stale embedding is cleared so the server's existing
   * "generate embedding if missing" step recomputes it for the new content.
   *
   * `opts.preserveHistory: true`: write a NEW id with `supersedes: id`; the
   * server closes the old record's `validTo` afterward, write-new BEFORE
   * close-old (safe failure = two active records, never a lost write). If the
   * old record is owned by a DIFFERENT agent, the server requires a "write"
   * MemoryGrant from that owner — otherwise it denies the request (cross-agent
   * write).
   */
  async update(id: string, content: string, opts: { preserveHistory?: boolean } = {}): Promise<Memory> {
    const existing = await this.get(id);
    if (!existing) {
      throw new FlairError("PUT", `/Memory/${id}`, 404, `memory ${id} not found`);
    }

    if (opts.preserveHistory) {
      const newId = `${this.client.agentId}-${crypto.randomUUID()}`;
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
      delete record.deduped;
      // flair#718 authorship-provenance — see write()'s identical comment above.
      if (this.client.claimedClient) record.claimedClient = this.client.claimedClient;
      // The Memory schema does not expose a working HTTP POST route (see
      // resources/Memory.ts) — Memory.post() is only reachable in-process
      // (resources/mcp-tools.ts). So the supersede-link write goes through
      // the same PUT-with-explicit-(new)-id path as a normal create; the
      // server's Memory.put() validates/authorizes `supersedes`, writes this
      // new record, then closes the old one transactionally (write-new
      // BEFORE close-old — see resources/Memory.ts's closeSupersededIfNeeded).
      // `supersedes` being set also makes the server bypass the dedup gate
      // for this write (it's an intentional version link, not an ambiguous
      // new write).
      const response = await this.client.request<Record<string, unknown>>("PUT", `/Memory/${newId}`, record);
      return { ...record, ...(response ?? {}) } as unknown as Memory;
    }

    const merged: Record<string, unknown> = { ...existing, content, updatedAt: new Date().toISOString() };
    delete merged.embedding;
    delete merged.embeddingModel;
    delete merged.deduped;
    // flair#718 authorship-provenance — see write()'s identical comment above.
    if (this.client.claimedClient) merged.claimedClient = this.client.claimedClient;
    const response = await this.client.request<Record<string, unknown>>("PUT", `/Memory/${id}`, merged);
    return { ...merged, id, ...(response ?? {}) } as unknown as Memory;
  }

  /** Search memories by meaning. Optionally filter to facts valid at a specific point in time. */
  async search(query: string, opts: { limit?: number; minScore?: number; scoring?: "composite" | "raw"; asOf?: string } = {}): Promise<SearchResult[]> {
    const result = await this.client.request<{ results?: unknown[] }>(
      "POST", "/SemanticSearch",
      { agentId: this.client.agentId, q: query, limit: opts.limit ?? 5, scoring: opts.scoring, asOf: opts.asOf },
    );
    const minScore = opts.minScore ?? 0;
    return (result.results ?? [])
      .map((r: any) => ({
        id: r.id ?? r.memory?.id ?? "",
        content: r.content ?? r.memory?.content ?? "",
        score: r._score ?? r.score ?? r.similarity ?? 0,
        type: r.type ?? r.memory?.type,
        durability: r.durability ?? r.memory?.durability,
        tags: r.tags ?? r.memory?.tags,
        createdAt: r.createdAt ?? r.memory?.createdAt,
      }))
      .filter((r) => r.score >= minScore);
  }

  /** Get a memory by ID. */
  async get(id: string): Promise<Memory | null> {
    try { return await this.client.request("GET", `/Memory/${id}`); }
    catch (e) {
      if (e instanceof FlairError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * List recent memories. All filters combine with AND.
   *
   * Uses Harper's `POST /Memory/search_by_conditions` endpoint with an
   * explicit conditions array. The Memory.search() override injects the
   * agentId scoping condition.
   *
   * Note: `order` is applied client-side after retrieval. Harper's
   * search_by_conditions does not accept a sort/order field in the body.
   */
  async list(opts: {
    tags?: string[];
    limit?: number;
    type?: MemoryType;
    durability?: Durability;
    /** Filter by subject (entity the memory is about). Indexed; efficient. */
    subject?: string;
    /** Chronological ordering applied client-side after retrieval.
     *  Server-side sort is not available via search_by_conditions. */
    order?: "createdAt-asc" | "createdAt-desc";
  } = {}): Promise<Memory[]> {
    // Build conditions array — agentId is always scoped
    const conditions: Array<{ search_attribute: string; search_type: string; search_value: unknown }> = [
      { search_attribute: "agentId", search_type: "equals", search_value: this.client.agentId },
    ];

    if (opts.subject) {
      conditions.push({ search_attribute: "subject", search_type: "equals", search_value: opts.subject });
    }
    for (const tag of opts.tags ?? []) {
      conditions.push({ search_attribute: "tags", search_type: "contains", search_value: tag });
    }
    if (opts.type) {
      conditions.push({ search_attribute: "type", search_type: "equals", search_value: opts.type });
    }
    if (opts.durability) {
      conditions.push({ search_attribute: "durability", search_type: "equals", search_value: opts.durability });
    }

    const body: Record<string, unknown> = {
      operator: "and",
      conditions,
      get_attributes: ["*"],
    };
    if (opts.limit) body.limit = opts.limit;

    const result = await this.client.request<unknown>("POST", "/Memory/search_by_conditions", body);
    // search_by_conditions returns either an array or { results: [...] }
    const memories: Memory[] = Array.isArray(result) ? result : ((result as { results?: Memory[] })?.results ?? []);

    // Client-side sort (Harper's search_by_conditions does not accept sort in body)
    if (opts.order) {
      const dir = opts.order === "createdAt-desc" ? -1 : 1;
      memories.sort((a, b) => dir * (a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0));
    }

    return memories;
  }

  /** Delete a memory. */
  async delete(id: string): Promise<void> {
    await this.client.request("DELETE", `/Memory/${id}`);
  }
}

// ─── Relationship API ───────────────────────────────────────────────────────

/**
 * Canonical, per-owner, deterministic Relationship id (relationship-write-path,
 * K&S-approved refinement) — `base64url(SHA-256(lowercased agentId+subject+
 * predicate+object))`, truncated to the first 16 bytes (22 base64url chars,
 * 128-bit collision resistance). A REAL cryptographic hash on purpose
 * (`crypto.createHash('sha256')`, NOT `Bun.hash` or any weak/platform-specific
 * hash) — Sherlock: blocks intentional collision attacks; Kern: portable if
 * flair ever runs on another runtime.
 *
 * Hashes ONLY the triple-identity fields (agentId + subject + predicate +
 * object) — deliberately EXCLUDES confidence/validFrom/validTo/source, so
 * re-asserting the SAME triple with different mutable fields always maps to
 * the SAME id. Because Relationship.put() is a PUT-by-primary-key (Harper
 * table semantics — see resources/Relationship.ts), writing to that same id
 * again is a natural upsert: mutable fields update, the id stays stable, no
 * pre-insert query and no race. Fields are joined with a NUL separator before
 * hashing (not naive string concatenation) so e.g. agentId="a"+subject="bc"
 * can never hash identically to agentId="ab"+subject="c" — free-text
 * subject/predicate/object have no natural delimiter of their own.
 *
 * `agentId` is folded into the hash so the canonical id is PER-OWNER — two
 * different agents asserting the identical (subject, predicate, object)
 * triple get two different ids, never a cross-agent collision/overwrite (the
 * write path also stamps `agentId` from the server-verified auth verdict,
 * never the body — see resources/Relationship.ts's put() — so even a
 * maliciously-crafted URL id can't make a foreign agent's row visible to the
 * wrong owner; it can only self-collide with the calling agent's own rows).
 *
 * Exported (not just used internally by RelationshipApi.write()) so the CLI's
 * mirrored implementation (src/cli.ts's `relationship add` command, which
 * cannot import this workspace package into the published `@tpsdev-ai/flair`
 * CLI bundle — same reasoning as its Memory-id-generation mirroring) can be
 * cross-checked against this one in tests, and so any other integration
 * package can compute the same id a relationship will land at without a
 * round-trip.
 */
export function canonicalRelationshipId(agentId: string, subject: string, predicate: string, object: string): string {
  const material = [agentId, subject, predicate, object].join("\u0000").toLowerCase();
  return createHash("sha256").update(material, "utf8").digest().subarray(0, 16).toString("base64url");
}

class RelationshipApi {
  constructor(private client: FlairClient) {}

  /**
   * Assert (write) a relationship triple: "record that <subject> <predicate>
   * <object>". Always writes to the canonical id (canonicalRelationshipId
   * above), so:
   *
   *   (a) Re-asserting the SAME triple (same subject/predicate/object, same
   *       agentId) UPSERTS the existing row — mutable fields (confidence,
   *       validFrom/validTo, source) update, the id and createdAt-derived
   *       identity stay stable. No duplicate rows from re-assertion.
   *   (b) A CONTRADICTING triple with the same subject/predicate/object but a
   *       different `validTo` OVERWRITES the prior row's validTo too (the
   *       old value is lost) — acceptable: the graph wants the CURRENT state
   *       of a relationship, not a full history chain (Memory's
   *       supersedes-chain is overkill here).
   *   (c) A DIFFERENT predicate (e.g. "nathan manages flair" superseded by
   *       "nathan advises flair") hashes to a DIFFERENT id — a NEW row, and
   *       the OLD triple is NOT auto-closed. To contradict a prior
   *       relationship under a different predicate, set its `validTo` (via a
   *       second write with the OLD subject/predicate/object) or delete it,
   *       THEN write the new one.
   *
   * Never suppresses the write (same invariant as MemoryApi.write() — see
   * flair#526's history for why "found something similar, don't write" is
   * the wrong default): dedup here is pure upsert-by-canonical-id, not a
   * near-duplicate signal.
   */
  async write(input: {
    subject: string;
    predicate: string;
    object: string;
    /** 0.0–1.0, how certain (1.0 = explicitly stated). Server default: 1.0. */
    confidence?: number;
    /** ISO timestamp — when this relationship became true. Server default: now. */
    validFrom?: string;
    /** ISO timestamp — when it ended. Leave unset for an active relationship;
     *  set it on a prior write to close out a relationship you're contradicting. */
    validTo?: string;
    /** Where this was learned (memory ID, conversation, etc.). */
    source?: string;
  }): Promise<Relationship> {
    const id = canonicalRelationshipId(this.client.agentId, input.subject, input.predicate, input.object);
    const record: Record<string, unknown> = {
      id,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
    };
    if (input.confidence !== undefined) record.confidence = input.confidence;
    if (input.validFrom !== undefined) record.validFrom = input.validFrom;
    if (input.validTo !== undefined) record.validTo = input.validTo;
    if (input.source !== undefined) record.source = input.source;

    const response = await this.client.request<Record<string, unknown>>("PUT", `/Relationship/${id}`, record);
    return { ...record, id, agentId: this.client.agentId, ...(response ?? {}) } as unknown as Relationship;
  }

  /** Get a relationship by canonical id (or any id, e.g. one openclaw wrote
   *  under its own convention). Returns null on 404 (not found / not yours). */
  async get(id: string): Promise<Relationship | null> {
    try { return await this.client.request("GET", `/Relationship/${id}`); }
    catch (e) {
      if (e instanceof FlairError && e.status === 404) return null;
      throw e;
    }
  }

  /** Delete a relationship by id. */
  async delete(id: string): Promise<void> {
    await this.client.request("DELETE", `/Relationship/${id}`);
  }
}

// ─── Soul API ───────────────────────────────────────────────────────────────

class SoulApi {
  constructor(private client: FlairClient) {}

  /** Set a soul entry (key-value personality/values). */
  async set(key: string, value: string): Promise<SoulEntry> {
    const id = `${this.client.agentId}:${key}`;
    return this.client.request("PUT", `/Soul/${encodeURIComponent(id)}`, {
      id,
      agentId: this.client.agentId,
      key,
      value,
      createdAt: new Date().toISOString(),
    });
  }

  /** Get a soul entry. */
  async get(key: string): Promise<SoulEntry | null> {
    const id = `${this.client.agentId}:${key}`;
    try { return await this.client.request("GET", `/Soul/${encodeURIComponent(id)}`); }
    catch (e) {
      if (e instanceof FlairError && e.status === 404) return null;
      throw e;
    }
  }

  /** List all soul entries. */
  async list(): Promise<SoulEntry[]> {
    const params = new URLSearchParams({ agentId: this.client.agentId });
    return this.client.request("GET", `/Soul?${params}`);
  }
}

// ─── Error ──────────────────────────────────────────────────────────────────

export class FlairError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Flair ${method} ${path} → ${status}: ${body}`);
    this.name = "FlairError";
  }
}
