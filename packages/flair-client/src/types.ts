import type { KeyObject } from "node:crypto";

export type { KeyObject };

/**
 * Memory durability levels.
 *
 * Retention, decay and bootstrap ordering by tier:
 * permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays; bootstrap considers the bootstrapping agent's own permanent memories before recent rows, subject to scope, expiry/closure and the token budget.
 * persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it).
 * standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.
 * ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.
 * No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.
 */
export type Durability = "permanent" | "persistent" | "standard" | "ephemeral";

/** Memory type classification. */
export type MemoryType = "session" | "lesson" | "decision" | "preference" | "fact" | "goal";

/**
 * Writer-controlled sharing intent. "private" — owner only,
 * never returned to another agent even if that agent holds a MemoryGrant.
 * "shared" — visible to owner + any grant-holder (subject to the grant's
 * scope). When unset on write, the server defaults it from `durability`:
 * permanent/persistent → shared, standard/ephemeral/absent → private. An
 * explicit value here always overrides the server default.
 */
export type Visibility = "private" | "shared";

/**
 * A host-object pointer (flair#1940): the host object the writer CLAIMS as a
 * memory's source (a run, a launch, a turn). The value shape the server
 * validates, stores and returns is versioned JSON `{ v: 1, host, kind, id, url? }`.
 * `memory.write()` applies `v: 1` when the caller omits it, so a writer may pass
 * the pointer as `{ host, kind, id, url? }`.
 *
 * On a read, `hostSource` is either this object or the string `"withheld"` (the
 * server withholds a pointer from a reader who may see the record but not the
 * pointer). It is a writer's claim, not verified host authorship.
 */
export interface HostSource {
  /** Pointer schema version. `write()` applies `1` when omitted. */
  v?: 1;
  /** Host the object lives on, from the server's closed set (e.g. "openclaw", "cursor", "codex"). */
  host: string;
  /** Object kind, from the server's closed set (e.g. "run", "launch", "turn"). */
  kind: string;
  id: string;
  /** https URL of the host object, if any. */
  url?: string;
}

/** A memory record. */
export interface Memory {
  id: string;
  agentId: string;
  content: string;
  type: MemoryType;
  durability: Durability;
  tags: string[];
  subject?: string;
  metadata?: string | null;
  /**
   * flair#1940 — the host-source pointer joined into this record for the
   * reader, or the string `"withheld"` when the reader may read the record but
   * not its pointer. Absent when the record carries no pointer a reader may
   * know about. `agentId` is the record's author.
   */
  hostSource?: HostSource | "withheld";
  /** flair#1940 — the originating session id, when the writer set one. */
  sessionId?: string;
  /**
   * Server JSON `{ v, verified: { agentId, timestamp, receivedAt }, claimed? }`,
   * same shape as {@link Relationship.provenance}. `verified.*` is server-derived;
   * `claimed.*` is the caller's unverified claim. Absent on rows written before
   * the field existed.
   */
  provenance?: string;
  /** Writer-controlled sharing intent. Absent on records written before this
   *  field existed — the server treats absence as "shared" (migration-
   *  invariant: an existing memory keeps reading to exactly whoever holds a
   *  grant today), never as "private". */
  visibility?: Visibility;
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

/**
 * An entity-to-entity relationship triple (subject/predicate/object), with
 * temporal validity and per-owner canonical dedup (see RelationshipApi.write()
 * in client.ts for the canonical-id scheme). Free-text, lowercased on write —
 * NOT the attention-plane `type:value` entity vocabulary, NOT memory-id FKs.
 */
export interface Relationship {
  id: string;
  agentId: string;
  subject: string;
  predicate: string;
  object: string;
  /** ISO timestamp — when this relationship became true. */
  validFrom?: string;
  /** ISO timestamp — when it ended (absent/null = still active). */
  validTo?: string;
  /** 0.0–1.0, how certain (1.0 = explicitly stated). Defaults server-side to 1.0. */
  confidence?: number;
  /** Where this was learned (memory ID, conversation, etc.). */
  source?: string;
  createdAt: string;
  updatedAt?: string;
  /** JSON blob, same shape as Memory.provenance — { v, verified: { agentId,
   *  timestamp, receivedAt }, claimed?: { createdAt, model, client } }.
   *  `verified.*` is server-derived (timestamp and receivedAt are the server
   *  write instant); `claimed.*` is the caller's unverified claim (the record's
   *  own `createdAt` is the claimed creation time). Absent on rows written before this
   *  field existed (migration-equivalence: additive/nullable). */
  provenance?: string;
  /** Always true after a successful write() — the server never suppresses a
   *  relationship write. */
  written?: boolean;
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
  /** flair#1940 — the record's author id (the server's `agentId`). */
  author?: string;
  /** flair#1940 — the joined host-source pointer, or `"withheld"`; see {@link Memory.hostSource}. */
  hostSource?: HostSource | "withheld";
  /** flair#1940 — the originating session id, when the writer set one. */
  sessionId?: string;
  /** flair#1940 — the server-stamped provenance JSON; see {@link Memory.provenance}. */
  provenance?: string;
}

/** Bootstrap response — formatted context block. */
export interface BootstrapResult {
  context: string;
  memoryCount: number;
  soulCount: number;
  tokenEstimate: number;
  /** flair#1182/#2067 — resolved caller identity and read scope. Present on a
   *  live server; a caller that needs it (the action-recall refresh) treats an
   *  absent scope as "no cache". */
  scope?: { agentId?: string; isAdmin?: boolean; reads?: string };
}

/** One team-directory entry — an active agent-kind principal with an
 *  published tps-mail contact (flair#2141 S3a). */
export interface TeamDirectoryEntry {
  /** Stable Agent ID. */
  agentId: string;
  /** Display label (the agent's name, else its id). */
  name: string;
  /** The published channel platform (`tps-mail`). */
  platform: string;
  /** The published address. */
  email: string;
  /** The stored publication time, normalized to ISO. */
  publishedAt: string;
  /** The entry's home instance id — the instance that published this entry's
   *  contact; null when it is not resolvable. */
  homeInstanceId: string | null;
}

/** A page of the team directory (flair#2141 S3a). */
export interface TeamDirectoryResult {
  entries: TeamDirectoryEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Server-stamped freshness of this page. */
  generatedAt: string;
}

/** Client configuration. */
export interface FlairClientConfig {
  /** Flair server URL. Default: http://localhost:19926 */
  url?: string;
  /** Agent ID for authentication and data scoping. Uses FLAIR_AGENT_ID only when omitted. */
  agentId?: string;
  /** "basic" disables Ed25519 key resolution. Default: "auto". */
  authMode?: "auto" | "basic";
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
  /**
   * flair#718 authorship-provenance: a label identifying WHICH CLIENT this
   * process is (e.g. "claude-code", "codex", "gemini", "cursor") — recorded
   * as unverified `provenance.claimed.client` on memory writes, distinct from
   * `agentId` (ownership) and ungoverned by any authority (never enters
   * read-scope, attribution, or dedup decisions — server-enforced in
   * resources/provenance.ts). Falls back to the `FLAIR_CLIENT` env var.
   * Absent (both here and in the env) = omitted entirely; zero behavior
   * change for existing installs.
   */
  claimedClient?: string;
}
