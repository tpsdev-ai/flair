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
}

/** A soul entry (persistent personality/values). */
export interface SoulEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
  createdAt: string;
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
  /** Flair server URL. Default: http://localhost:9926 */
  url?: string;
  /** Agent ID for authentication and data scoping. Falls back to FLAIR_AGENT_ID env var. */
  agentId?: string;
  /** Path to Ed25519 private key file. Auto-resolved if omitted. */
  keyPath?: string;
  /** Request timeout in ms. Default: 10000 */
  timeoutMs?: number;
}
