/**
 * trust-block.ts — the opt-in, inline trust-evidence block surfaced on recall
 * results (flair#744 slice 1: "surface what we already record at the point of
 * decision").
 *
 * ─── What this is ────────────────────────────────────────────────────────────
 * A PURE, Harper-free assembler: `buildTrustBlock(record)` maps a single
 * Memory record's ALREADY-STORED fields into a compact, self-contained trust
 * block that `search` (SemanticSearch), `get` (Memory.get), and `bootstrap`
 * (BootstrapMemories) attach to each result WHEN THE CALLER OPTS IN. No new
 * computation, no cross-record lookups, no DB access — every field below is
 * read straight off the record the recall path already resolved. That is the
 * whole point of slice 1: the memory layer already records per-fact trust
 * evidence at write time; this surfaces it at read time, where the consuming
 * agent actually decides what to repeat.
 *
 * ─── The zero-authority invariant (flair#744 Sherlock condition 2 / #735) ────
 * The trust block INFORMS THE READER ONLY. It is assembled AFTER read-scope
 * resolution, purely for the response, and MUST NEVER enter an authority /
 * scope / attribution / dedup decision anywhere — the same discipline as the
 * `claimed.*` zero-authority guard (flair#735). Two things keep that true:
 *   1. This module is pure and side-effect-free: buildTrustBlock NEVER mutates
 *      its input record (it only reads), so assembling a block can never alter
 *      a record a later decision reads.
 *   2. No authority-decision module imports it. That is structurally enforced
 *      by test/unit/trust-block-zero-authority-tripwire.test.ts (the #735-style
 *      source scan): record-type-kit.ts, memory-read-scope.ts, Memory.ts's
 *      dedup gates, RecordUsage.ts, mcp-handler.ts, and the retrieval/scoping
 *      core (semantic-retrieval-core.ts) never reference the trust block — it
 *      is assembled strictly DOWNSTREAM of scope resolution, in the response
 *      tail of each recall wrapper.
 *
 * ─── `claimed.*` is surfaced as a BOOLEAN only ──────────────────────────────
 * `hasClaimedProvenance` reports only WHETHER the record carries a self-
 * reported `claimed` sub-object — never its content. Raw `claimed.model` /
 * `claimed.client` values are self-reported and unverified (resources/
 * provenance.ts); exposing them as authoritative trust evidence would defeat
 * the verified-vs-claimed distinction the block exists to draw. The advisory
 * "there is a self-report here" bit is enough for the reader to weight it.
 *
 * ─── Tier is DEFERRED to a later slice (flair#744 Sherlock condition 1) ─────
 * The block deliberately does NOT carry a derived trust `tier`. A tier is not
 * a field on the Memory record — it lives on the AUTHOR's Agent/OAuthClient
 * principal record (`defaultTrustTier`), so surfacing it would require a
 * per-author lookup on the hot recall path (exactly the read-path cost the
 * flair#744 design round ruled out) AND the scope-gate Sherlock's condition 1
 * mandates ("include tier only when reader.scope == author.scope"). That
 * scope-gate needs an org/scope boundary primitive that does not yet exist in
 * flair's single-tenant "open-within-org" read model. Both are more than
 * trivial for slice 1, so per the spec's explicit allowance the tier field is
 * deferred whole — the scope-gate ships WITH it, when it ships. Everything
 * else in the block (provenance, author principal, usage, freshness,
 * supersession) is on the Memory record itself and ships now.
 */

const MS_PER_DAY = 86_400_000;

export interface TrustBlock {
  /**
   * Author principal — ALWAYS included (the record's own `agentId`). Not new
   * disclosure: a reader can already `get` any record it can recall, and the
   * principal is on the stored row (flair#744 Sherlock condition 1).
   */
  author: string | null;

  /**
   * Provenance status — "verified" iff the record's stored `provenance` blob
   * carries a server-attested `verified.agentId` (resources/provenance.ts);
   * "unattributed" for legacy rows (provenance = null) or internal writes
   * (verified.agentId = null).
   */
  provenanceStatus: "verified" | "unattributed";
  /** `provenance.verified.agentId` — the server-attested author, or null. */
  verifiedAuthor: string | null;
  /** `provenance.verified.timestamp` — server-clock write time, or null. */
  verifiedAt: string | null;
  /**
   * Whether the record carries a self-reported `provenance.claimed` sub-object
   * (model/client). ADVISORY ONLY, zero authority — the content is never
   * surfaced here (see module doc).
   */
  hasClaimedProvenance: boolean;

  /** Verified-USE signal (flair#683 `usageCount`). Absent reads as 0. */
  usageCount: number;

  /**
   * Freshness / validity from the record's temporal window:
   *   - "expired": `validTo` is set and in the past (fact stopped being true,
   *     or the record was closed by the server supersede path).
   *   - "future": `validFrom` is set and in the future (fact not yet in effect).
   *   - "valid": otherwise.
   */
  validityStatus: "valid" | "expired" | "future";
  /** Raw `validFrom` (when this fact became true), or null. */
  validFrom: string | null;
  /** Raw `validTo` (when this fact stopped being true; null = still valid). */
  validTo: string | null;
  /** Raw `createdAt` (server-clock write time), or null. */
  createdAt: string | null;
  /** Whole days since `createdAt` (freshness), or null when unavailable. */
  ageDays: number | null;

  /**
   * Supersession — the forward pointer `supersedes` (the id of the memory this
   * record replaces; null when it supersedes nothing). The reverse ("is THIS
   * record superseded") needs a reverse-index pass and is deferred with
   * corroboration to the nightly REM slice — no hot-path reverse lookup here.
   * The "no longer the current truth" signal is carried by validityStatus /
   * validTo instead.
   */
  supersedes: string | null;
}

/** A record shape narrow enough for the assembler — callers pass whatever
 *  Memory row (or select-projected result) they hold. */
export interface TrustableRecord {
  agentId?: string | null;
  provenance?: string | null;
  usageCount?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  createdAt?: string | null;
  supersedes?: string | null;
}

function parseTime(value: string | null | undefined): number {
  if (typeof value !== "string" || value.length === 0) return NaN;
  return Date.parse(value);
}

/**
 * Assemble the trust block for one Memory record. Pure: reads only, NEVER
 * mutates `record`. `now` is injectable for deterministic tests (defaults to
 * the current wall clock).
 */
export function buildTrustBlock(record: TrustableRecord, now: number = Date.now()): TrustBlock {
  // ── Provenance (verified vs claimed) ──────────────────────────────────────
  let verifiedAuthor: string | null = null;
  let verifiedAt: string | null = null;
  let hasClaimedProvenance = false;
  if (typeof record.provenance === "string" && record.provenance.length > 0) {
    try {
      const p = JSON.parse(record.provenance);
      if (p && typeof p === "object") {
        if (p.verified && typeof p.verified === "object") {
          verifiedAuthor = typeof p.verified.agentId === "string" ? p.verified.agentId : null;
          verifiedAt = typeof p.verified.timestamp === "string" ? p.verified.timestamp : null;
        }
        // Boolean only — the self-reported content is deliberately NOT surfaced.
        hasClaimedProvenance = p.claimed != null && typeof p.claimed === "object";
      }
    } catch {
      // Malformed provenance → treated as unattributed, never throws.
    }
  }

  // ── Freshness / validity ──────────────────────────────────────────────────
  const validFrom = typeof record.validFrom === "string" ? record.validFrom : null;
  const validTo = typeof record.validTo === "string" ? record.validTo : null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;

  const validToMs = parseTime(validTo);
  const validFromMs = parseTime(validFrom);
  let validityStatus: TrustBlock["validityStatus"] = "valid";
  if (Number.isFinite(validToMs) && validToMs <= now) {
    validityStatus = "expired";
  } else if (Number.isFinite(validFromMs) && validFromMs > now) {
    validityStatus = "future";
  }

  const createdMs = parseTime(createdAt);
  const ageDays = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((now - createdMs) / MS_PER_DAY))
    : null;

  return {
    author: typeof record.agentId === "string" ? record.agentId : null,
    provenanceStatus: verifiedAuthor ? "verified" : "unattributed",
    verifiedAuthor,
    verifiedAt,
    hasClaimedProvenance,
    usageCount: typeof record.usageCount === "number" ? record.usageCount : 0,
    validityStatus,
    validFrom,
    validTo,
    createdAt,
    ageDays,
    supersedes: typeof record.supersedes === "string" ? record.supersedes : null,
  };
}

/**
 * Opt-in attach: the single primitive `search`/`get` use to layer the trust
 * block onto a result. `includeTrust === false` (the default) returns the
 * EXACT SAME record reference untouched — the clean-migration guarantee that a
 * consumer who doesn't request the block sees a byte-identical response. When
 * true, returns a shallow copy with `trust` added (never mutates the input).
 */
export function attachTrust<T extends TrustableRecord>(
  record: T,
  includeTrust: boolean,
  now?: number,
): T {
  if (!includeTrust) return record;
  return { ...record, trust: buildTrustBlock(record, now) } as T;
}
