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
import { loadPrivateKey, resolveKeyPath, signRequest } from "./auth.js";
import type {
  FlairClientConfig,
  Memory,
  MemoryType,
  Durability,
  SoulEntry,
  SearchResult,
  BootstrapResult,
} from "./types.js";

const DEFAULT_URL = "http://localhost:19926";
const DEFAULT_TIMEOUT = 10_000;

export class FlairClient {
  readonly url: string;
  readonly agentId: string;
  readonly memory: MemoryApi;
  readonly soul: SoulApi;

  private privateKey: KeyObject | null = null;
  private keyResolved = false;
  private keyPath: string | undefined;
  private timeoutMs: number;
  private basicAuth: string | null = null;

  constructor(config: FlairClientConfig) {
    this.url = (config.url ?? process.env.FLAIR_URL ?? DEFAULT_URL).replace(/\/$/, "");
    this.agentId = config.agentId || process.env.FLAIR_AGENT_ID || "";
    this.keyPath = config.keyPath;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    // Basic auth fallback for standalone deployments without Ed25519 keys
    const adminUser = config.adminUser ?? process.env.FLAIR_ADMIN_USER;
    const adminPass = config.adminPassword ?? process.env.FLAIR_ADMIN_PASSWORD;
    if (adminUser && adminPass) {
      this.basicAuth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
    }
    this.memory = new MemoryApi(this);
    this.soul = new SoulApi(this);
  }

  private resolveKey(): KeyObject | null {
    if (this.keyResolved) return this.privateKey;
    this.keyResolved = true;
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
  async bootstrap(opts: { maxTokens?: number } = {}): Promise<BootstrapResult> {
    return this.request("POST", "/BootstrapMemories", {
      agentId: this.agentId,
      maxTokens: opts.maxTokens ?? 4000,
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

  /** Write a memory. Optionally checks for near-duplicates before writing. */
  async write(content: string, opts: {
    id?: string;
    type?: MemoryType;
    durability?: Durability;
    tags?: string[];
    subject?: string;
    /** Check for similar existing memories before writing. If a near-duplicate
     *  is found (score >= threshold), returns it instead of creating a new one.
     *  Default: false (no dedup check). */
    dedup?: boolean;
    /** Similarity threshold for dedup. Default: 0.95 */
    dedupThreshold?: number;
  } = {}): Promise<Memory> {
    // Near-duplicate check — skip for very short content where similarity
    // is unreliable (e.g., "ok", "thanks" would match each other)
    if (opts.dedup && content.length >= 20) {
      const threshold = opts.dedupThreshold ?? 0.95;
      // Use raw scoring to avoid retrieval-boost feedback loop where repeated
      // dedup checks inflate scores above the threshold.
      const existing = await this.search(content, { limit: 1, minScore: threshold, scoring: "raw" });
      if (existing.length > 0) {
        // Return the existing memory instead of creating a duplicate
        const match = await this.get(existing[0].id);
        if (match) return match;
      }
    }

    const id = opts.id ?? `${this.client.agentId}-${crypto.randomUUID()}`;
    const record = {
      id,
      agentId: this.client.agentId,
      content,
      type: opts.type ?? "session",
      durability: opts.durability ?? "standard",
      tags: opts.tags ?? [],
      subject: opts.subject,
      createdAt: new Date().toISOString(),
    };
    await this.client.request("PUT", `/Memory/${id}`, record);
    // Harper PUT returns {} — return the record we constructed
    return record as Memory;
  }

  /** Search memories by meaning. */
  async search(query: string, opts: { limit?: number; minScore?: number; scoring?: "composite" | "raw" } = {}): Promise<SearchResult[]> {
    const result = await this.client.request<{ results?: unknown[] }>(
      "POST", "/SemanticSearch",
      { agentId: this.client.agentId, q: query, limit: opts.limit ?? 5, scoring: opts.scoring },
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

  /** List recent memories. */
  async list(opts: { limit?: number; type?: MemoryType; durability?: Durability } = {}): Promise<Memory[]> {
    const params = new URLSearchParams();
    params.set("agentId", this.client.agentId);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.type) params.set("type", opts.type);
    if (opts.durability) params.set("durability", opts.durability);
    return this.client.request("GET", `/Memory?${params}`);
  }

  /** Delete a memory. */
  async delete(id: string): Promise<void> {
    await this.client.request("DELETE", `/Memory/${id}`);
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
