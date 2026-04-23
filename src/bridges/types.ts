/**
 * Types for the Flair memory bridge plugin system.
 *
 * Mirrors the contract in specs/FLAIR-BRIDGES.md. These types are the
 * public surface a bridge author (human or agent) targets.
 *
 * IMPORTANT: the YAML bridge format (shape A) also conforms to these types
 * after parsing — the runtime normalizes YAML descriptors into the same
 * shape a code plugin (shape B) exports.
 */

// ─── Memory record ────────────────────────────────────────────────────────────

export interface BridgeMemory {
  // Identity
  id?: string;
  foreignId?: string;

  // Content
  content: string;
  subject?: string;
  tags?: string[];
  visibility?: "private" | "shared" | "public";

  // Durability & lifecycle
  durability?: "ephemeral" | "standard" | "persistent" | "permanent";
  createdAt?: string;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;

  // Ownership
  agentId?: string;

  // Provenance
  source?: string;
  derivedFrom?: string[];
}

// Fields a bridge MUST NOT set — computed by Flair on ingest.
export const FLAIR_RESERVED_FIELDS = [
  "contentHash",
  "embedding",
  "embeddingModel",
  "retrievalCount",
  "lastRetrieved",
  "promotionStatus",
  "_safetyFlags",
  "createdBy",
  "updatedBy",
  "archivedBy",
] as const;

// ─── Plugin shape ─────────────────────────────────────────────────────────────

export type BridgeKind = "file" | "api";

export interface BridgeOptionSpec {
  /** Environment variable to source the value from if not passed explicitly. */
  env?: string;
  /** Default value when neither flag nor env is provided. */
  default?: string | number | boolean;
  /** Required for the command to run. */
  required?: boolean;
  /** Short description surfaced in `--help`. */
  description?: string;
}

export interface BridgeContext {
  /** Instrumented, rate-limited fetch. Code plugins MUST use this instead of global fetch. */
  fetch: typeof fetch;
  /** Structured logger. Use for progress output an operator can redirect. */
  log: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Per-bridge KV cache. Survives across invocations on the same machine. */
  cache: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
    del: (key: string) => Promise<void>;
  };
}

export interface MemoryBridge {
  name: string;
  version: number;
  kind: BridgeKind;
  /** Describes CLI/env options the bridge accepts. */
  options?: Record<string, BridgeOptionSpec>;

  /** Import memories INTO Flair from the foreign system. */
  import?: (
    opts: Record<string, unknown>,
    ctx: BridgeContext,
  ) => AsyncIterable<BridgeMemory>;

  /** Export memories OUT of Flair to the foreign system. */
  export?: (
    memories: AsyncIterable<BridgeMemory>,
    opts: Record<string, unknown>,
    ctx: BridgeContext,
  ) => Promise<void>;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export type BridgeSource =
  | "builtin"          // shipped inside @tpsdev-ai/flair
  | "project-yaml"     // .flair-bridge/*.yaml in CWD
  | "user-yaml"        // ~/.flair/bridges/*.yaml
  | "npm-package";     // node_modules/flair-bridge-* or @scope/flair-bridge-*

export interface DiscoveredBridge {
  name: string;
  kind: BridgeKind;
  source: BridgeSource;
  /** Absolute path to the descriptor (yaml) or package root (npm). */
  path: string;
  /** Short human-readable description parsed from the descriptor, when available. */
  description?: string;
  version?: number;
}

// ─── Parsed YAML descriptor (Shape A) ─────────────────────────────────────────
//
// Runtime representation of the YAML in `.flair-bridge/<name>.yaml`. The
// loader normalizes the raw YAML into this shape and validates required
// fields; downstream runtime code deals only in the typed object.

export type YamlFormat = "jsonl" | "json" | "yaml" | "markdown-frontmatter";

/**
 * A mapping expression.
 *
 * Slice 2 supports only JSONPath-like lookups against the parsed record:
 *   - "$.field"          → root-level field
 *   - "$.nested.field"   → dotted access
 *   - "$.array[*]"       → iterate array
 *   - string literal (no $ prefix)   → treat as constant
 *
 * Slice 3 will extend with expressions (`foreignId ?? id`, etc.).
 */
export type MapExpression = string;

export interface YamlSourceTarget {
  path: string;
  format: YamlFormat;
  /** Optional filter expression evaluated over BridgeMemory fields. */
  when?: string;
  /** Field-to-expression mapping. Keys are BridgeMemory fields. */
  map: Record<string, MapExpression>;
}

export interface YamlBridgeDescriptor {
  name: string;
  version: number;
  kind: "file";
  description?: string;
  detect?: {
    anyExists?: string[];
    allExist?: string[];
  };
  import?: {
    sources: YamlSourceTarget[];
  };
  export?: {
    targets: YamlSourceTarget[];
  };
}

// ─── Structured errors ────────────────────────────────────────────────────────

export interface BridgeError {
  bridge: string;
  op: "list" | "scaffold" | "test" | "import" | "export";
  path?: string;
  record?: number;
  field?: string;
  expected?: string;
  got?: string;
  hint: string;
}

export class BridgeRuntimeError extends Error {
  readonly detail: BridgeError;
  constructor(detail: BridgeError) {
    super(`${detail.bridge}:${detail.op} — ${detail.hint}`);
    this.detail = detail;
  }
}
