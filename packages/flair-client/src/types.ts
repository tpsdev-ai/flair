import type { KeyObject } from "node:crypto";

export type { KeyObject };

/** Memory durability levels. */
export type Durability = "permanent" | "persistent" | "standard" | "ephemeral";

/** Memory type classification. */
export type MemoryType = "session" | "lesson" | "decision" | "preference" | "fact" | "goal";

/** A memory record. */
export interface Memory {
  id: string;
  agentId: string;
  content: string;
  type: MemoryType;
  durability: Durability;
  tags: string[];
  subject?: string;
  createdAt: string;
  updatedAt?: string;
  /** Always true after a successful write()/update() — the server never
   *  suppresses a write, so this is never false/absent on a real response. */
  written?: boolean;
  /** True when the server's conservative dedup gate found a near-duplicate.
   *  The new content was ALWAYS written regardless — this is a signal, not a
   *  suppression flag. See `matchedId` / `matchConfidence`. */
  deduplicated?: boolean;
  /** The id of the existing memory the server's dedup gate matched against,
   *  when `deduplicated` is true. */
  matchedId?: string;
  /** Confidence pair for the `matchedId` collision: raw cosine similarity and
   *  Jaccard token-overlap against the new content, both in [0, 1]. */
  matchConfidence?: { cosine: number; lexical: number };
  /**
   * @deprecated Historical field from the pre-fix client-side dedup gate,
   * which suppressed the write and returned the EXISTING record instead
   * (silently dropping distinct-but-similar content — flair#526). The gate is
   * now server-side and NEVER suppresses a write; use `deduplicated` instead.
   * No longer set by write()/update().
   */
  deduped?: boolean;
}

/** A soul entry (persistent personality/values). */
export interface SoulEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
  /**
   * Optional governance fields. These exist on the Harper `Soul` schema
   * (see schemas/memory.graphql) but are not set by `flair soul set`, so they
   * are absent on hand-authored entries. `priority` is reserved for skill
   * governance and is currently only ever written as "standard".
   */
  priority?: "critical" | "high" | "standard" | "low";
  durability?: Durability;
  /** JSON blob (skill governance: source, version, hash, etc.). */
  metadata?: string;
  createdAt: string;
  updatedAt?: string;
}

/** Semantic search result. */
export interface SearchResult {
  id: string;
  content: string;
  score: number;
  type?: MemoryType;
  durability?: Durability;
  tags?: string[];
  createdAt?: string;
}

/** Bootstrap response — formatted context block. */
export interface BootstrapResult {
  context: string;
  memoryCount: number;
  soulCount: number;
  tokenEstimate: number;
}

/** Client configuration. */
export interface FlairClientConfig {
  /** Flair server URL. Default: http://localhost:19926 */
  url?: string;
  /** Agent ID for authentication and data scoping. Falls back to FLAIR_AGENT_ID env var. */
  agentId?: string;
  /** Path to Ed25519 private key file. Auto-resolved if omitted. */
  keyPath?: string;
  /** In-memory Ed25519 private key (PEM string or pre-loaded KeyObject).
   *  Bypasses keyPath/file resolution. Wins over keyPath when both are supplied. */
  privateKey?: string | KeyObject;
  /** Request timeout in ms. Default: 10000 */
  timeoutMs?: number;
  /** Admin username for Basic auth fallback (standalone deployments). Falls back to FLAIR_ADMIN_USER env var. */
  adminUser?: string;
  /** Admin password for Basic auth fallback (standalone deployments). Falls back to FLAIR_ADMIN_PASSWORD env var. */
  adminPassword?: string;
}
