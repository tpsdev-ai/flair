/**
 * memory-id-checkpoint.ts — flair#2218 (slice 3 of #1244).
 *
 * A deploy guard. `src/replication-convergence.ts` compares COMPONENT state
 * (files, sizes, mtimes) and `flair fleet verify` compares version/health — neither
 * says anything about the DATA. A component tree can converge byte-for-byte while
 * a durable Memory row is gone.
 *
 * The guard is two operator commands around a planned cluster operation:
 *
 *   - checkpoint: read every Memory row's id and durability tier through the
 *     admin operations API (paged, never through recall) and write them to an
 *     operator-held file (mode 0600);
 *   - verify: read the same instance again and compare. A checkpointed id that is
 *     gone, or a durability-tier count that dropped, is an INTEGRITY FAILURE.
 *     Every checkpointed id still present is VERIFIED (new ids are fine). A read
 *     that cannot see the instance, a page, or the whole table is UNKNOWN — never
 *     verified.
 *
 * No Memory CONTENT is ever read, written to the checkpoint, or printed: the
 * admin read selects `id` and `durability` only, and the failure sample names ids.
 * The checkpoint covers every row in the Memory table (all four durability
 * tiers), so any Memory row that disappears between checkpoint and verify is
 * caught, not only a permanent/persistent one.
 *
 * The instance is addressed by its own origin (the way replication-convergence.ts
 * addresses a node), recorded in the checkpoint as `node`; verify refuses to
 * compare against a checkpoint taken from a different node address.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ALL_TIERS, normalizeTier, tallyByDurability, type MemoryRowLite, type Tier } from "./lib/memory-integrity.js";

export const CHECKPOINT_VERSION = 1;
/** Written 0600 (flair#2218): ids + tier counts are operator-held, not world-readable. */
export const CHECKPOINT_MODE = 0o600;
export const CHECKPOINT_FILENAME = "memory-id-checkpoint.json";

/** How many rows one operations-API page asks for (Harper's own page ceiling is 10_000). */
export const MEMORY_PAGE_SIZE = 10_000;
/** A hard page cap: 100 pages × 10_000 rows. Independent of any model output. */
export const MAX_MEMORY_PAGES = 100;
/** Per-request timeout for the admin read. Every operation is bounded. */
export const OPS_READ_TIMEOUT_MS = 30_000;
/** How many missing ids the failure report names. */
export const MISSING_SAMPLE_LIMIT = 10;

export interface MemoryCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  /** The instance's own origin (scheme://host[:port]) the checkpoint was read from. */
  node: string;
  /** The node's hostname, the way replication-convergence.ts addresses a node. */
  host: string;
  /** ISO timestamp of the read. */
  at: string;
  /** Every Memory id present, sorted. IDs only — never content. */
  ids: string[];
  /** Row count per durability tier at the checkpoint. */
  byDurability: Record<Tier, number>;
}

/** The default checkpoint location: the operator's Flair data directory. */
export function checkpointPath(home: string): string {
  return join(home, ".flair", CHECKPOINT_FILENAME);
}

// ─── Reading the instance (admin operations API, paged) ─────────────────────

/** POST one operations-API body at an instance origin, with Basic auth. */
export type OpsPost = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * Build an admin operations-API caller for an instance addressed by its own
 * origin — the same addressing replication-convergence.ts uses (a node's own
 * hostname, the deploy's admin Basic auth). The credential is never logged and
 * an error body is never folded into a thrown message.
 */
export function buildOpsPost(
  target: string,
  user?: string,
  password?: string,
  timeoutMs = OPS_READ_TIMEOUT_MS,
): OpsPost {
  const base = `${target.replace(/\/+$/, "")}/`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (user && password) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  }
  return async (body: Record<string, unknown>) => {
    const res = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`operations API read returned HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
}

function asRows(body: unknown): any[] | null {
  if (Array.isArray(body)) return body;
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) ? results : null;
}

/**
 * Read every Memory id + durability via the admin operations API, one page at a
 * time (search_by_conditions with limit/offset — Harper's own page ceiling is
 * 10_000). Never through recall. A page that is not a row array, a duplicate id
 * across pages, or running past the hard page cap is a read failure (throw) —
 * the caller reports UNKNOWN.
 *
 * `expected` is the table's own exact row count; a mismatch means this read did
 * not see every row (a drifting table, or a condition that hid one), which is
 * also a read failure rather than a short list that looks complete.
 */
export async function readMemoryRowsPaged(
  opsPost: OpsPost,
  opts: { pageSize?: number; maxPages?: number; expected?: number } = {},
): Promise<MemoryRowLite[]> {
  const pageSize = opts.pageSize ?? MEMORY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_MEMORY_PAGES;
  const rows: MemoryRowLite[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const body = await opsPost({
      operation: "search_by_conditions",
      database: "flair",
      table: "Memory",
      operator: "and",
      conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
      get_attributes: ["id", "durability"],
      limit: pageSize,
      offset: page * pageSize,
    });
    const batch = asRows(body);
    if (batch === null) throw new Error("Memory search returned a body that is neither a row array nor { results: [...] }");
    for (const r of batch) {
      if (!r || typeof r.id !== "string" || r.id.length === 0) {
        throw new Error("Memory search returned a row without a usable id");
      }
      if (seen.has(r.id)) throw new Error(`Memory search returned duplicate id ${r.id} across pages`);
      seen.add(r.id);
      rows.push({ id: r.id, durability: typeof r.durability === "string" ? r.durability : "standard" });
    }
    if (batch.length < pageSize) break;
    if (page === maxPages - 1) {
      throw new Error(`Memory read exceeded ${maxPages} pages; refusing to treat a truncated read as the whole table`);
    }
  }

  if (opts.expected !== undefined && rows.length !== opts.expected) {
    throw new Error(
      `Memory read saw ${rows.length} row(s) but the table reports ${opts.expected} — the read did not see every row`,
    );
  }
  return rows;
}

/** The instance's own exact Memory row count (describe_table, exact_count). */
export async function readMemoryRowCount(opsPost: OpsPost): Promise<number> {
  const body = (await opsPost({ operation: "describe_table", database: "flair", table: "Memory", exact_count: true })) as any;
  const n = body?.record_count;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("Memory row count via the operations API: response carried no record_count");
  }
  return n;
}

// ─── Build / compare ────────────────────────────────────────────────────────

/** Reduce a row set to a checkpoint (sorted ids, tier counts, node identity, time). */
export function buildCheckpoint(input: {
  node: string;
  at: string;
  rows: readonly MemoryRowLite[];
}): MemoryCheckpoint {
  const host = hostOf(input.node);
  const ids = input.rows.map((r) => r.id).slice().sort();
  return {
    version: CHECKPOINT_VERSION,
    node: input.node,
    host,
    at: input.at,
    ids,
    byDurability: tallyByDurability(input.rows),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type VerifyOutcome = "verified" | "integrity-failure" | "unknown";

/** Documented exit codes for `flair memory verify --help`. */
export const VERIFY_EXIT_CODES: Record<VerifyOutcome, number> = {
  verified: 0,
  "integrity-failure": 2,
  unknown: 3,
};

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Present for `unknown`: why the check could not be made. */
  reason?: string;
  /** Rows read now (0 when unknown). */
  totalRows: number;
  /** Checkpointed ids absent now, sorted. IDs only — never content. */
  missing: string[];
  /** Tiers whose count dropped since the checkpoint. */
  tierDrops: { tier: Tier; dropped: number }[];
  /** One-line operator summary. */
  detail: string;
}

/** UNKNOWN — a check that could not be made is never verified. */
export function unknownVerify(reason: string): VerifyResult {
  return { outcome: "unknown", reason, totalRows: 0, missing: [], tierDrops: [], detail: `unknown — ${reason}` };
}

/**
 * Compare the live rows against the checkpoint.
 *
 *  - a checkpointed id that is gone  → integrity failure;
 *  - a durability-tier count that dropped → integrity failure;
 *  - every checkpointed id still present (new ids are fine) → verified.
 */
export function compareCheckpoint(checkpoint: MemoryCheckpoint, rows: readonly MemoryRowLite[]): VerifyResult {
  const present = new Set(rows.map((r) => r.id));
  const missing = checkpoint.ids.filter((id) => !present.has(id)).sort();

  const counts = tallyByDurability(rows);
  const tierDrops: { tier: Tier; dropped: number }[] = [];
  for (const tier of ALL_TIERS) {
    const dropped = (checkpoint.byDurability[tier] ?? 0) - counts[tier];
    if (dropped > 0) tierDrops.push({ tier, dropped });
  }

  if (missing.length > 0 || tierDrops.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      const sample = missing.slice(0, MISSING_SAMPLE_LIMIT);
      parts.push(
        `${missing.length} of ${checkpoint.ids.length} checkpointed Memory id(s) missing` +
          ` (sample: ${sample.join(", ")}${missing.length > sample.length ? ", …" : ""})`,
      );
    }
    for (const d of tierDrops) parts.push(`${d.tier} tier dropped by ${d.dropped}`);
    return {
      outcome: "integrity-failure",
      totalRows: rows.length,
      missing,
      tierDrops,
      detail: `INTEGRITY FAILURE — ${parts.join("; ")}`,
    };
  }

  return {
    outcome: "verified",
    totalRows: rows.length,
    missing: [],
    tierDrops: [],
    detail: `verified — all ${checkpoint.ids.length} checkpointed Memory id(s) present across ${ALL_TIERS.map((t) => `${t} ${counts[t]}`).join(", ")}`,
  };
}

/** Normalise a raw row's durability, exposed for callers that build rows themselves. */
export { normalizeTier };

// ─── Checkpoint file (mode 0600, atomic) ────────────────────────────────────

export type CheckpointRead =
  | { kind: "absent" }
  | { kind: "ok"; checkpoint: MemoryCheckpoint }
  | { kind: "unreadable"; reason: string };

/**
 * Read a checkpoint. A missing file is `absent`; a present-but-unreadable or
 * malformed file is `unreadable` — UNKNOWN, never treated as "no checkpoint".
 */
export function readCheckpointFile(path: string): CheckpointRead {
  try {
    statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as MemoryCheckpoint;
    if (
      !parsed || parsed.version !== CHECKPOINT_VERSION ||
      typeof parsed.node !== "string" || parsed.node.length === 0 ||
      typeof parsed.host !== "string" || parsed.host.length === 0 ||
      typeof parsed.at !== "string" || parsed.at.length === 0 ||
      !Array.isArray(parsed.ids) || !parsed.ids.every((id) => typeof id === "string" && id.length > 0) ||
      !parsed.byDurability || !ALL_TIERS.every((t) => Number.isSafeInteger(parsed.byDurability[t]) && parsed.byDurability[t] >= 0)
    ) {
      return { kind: "unreadable", reason: "checkpoint is not a version-1 memory id checkpoint" };
    }
    return { kind: "ok", checkpoint: parsed };
  } catch (err) {
    return { kind: "unreadable", reason: `checkpoint is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Write the checkpoint atomically: a 0600 temp file beside it, then rename. A
 * failure throws — the caller never claims a checkpoint landed.
 */
export function writeCheckpointFile(path: string, checkpoint: MemoryCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { mode: CHECKPOINT_MODE });
    chmodSync(tmp, CHECKPOINT_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// ─── End-to-end helper (used by the verify command and the deploy report) ────

export interface VerifyOptions {
  checkpoint: MemoryCheckpoint;
  target: string;
  user?: string;
  password?: string;
  opsPost?: OpsPost;
}

/**
 * Read the live instance and compare it against the checkpoint. Any read
 * failure (unreachable instance, a page, or a short read) is UNKNOWN.
 */
export async function verifyCheckpoint(opts: VerifyOptions): Promise<VerifyResult> {
  const targetHost = hostOf(opts.target);
  if (targetHost !== opts.checkpoint.host) {
    return unknownVerify(
      `checkpoint was taken from node ${opts.checkpoint.host} but this target is ${targetHost} — refusing to compare across instances`,
    );
  }
  try {
    const opsPost = opts.opsPost ?? buildOpsPost(opts.target, opts.user, opts.password);
    const expected = await readMemoryRowCount(opsPost);
    const rows = await readMemoryRowsPaged(opsPost, { expected });
    return compareCheckpoint(opts.checkpoint, rows);
  } catch (err) {
    return unknownVerify(err instanceof Error ? err.message : String(err));
  }
}

/** Human-readable verify report. IDs only — never content. */
export function renderVerifyHuman(result: VerifyResult, checkpointPathShown: string): string {
  const lines: string[] = [];
  lines.push(`Memory id checkpoint verify: ${result.outcome.toUpperCase()}`);
  lines.push(`  checkpoint: ${checkpointPathShown}`);
  if (result.outcome === "unknown") {
    lines.push(`  ⚠️  UNKNOWN — ${result.reason ?? "the check could not be made"}; NOT verified`);
    return lines.join("\n");
  }
  lines.push(`  rows read now: ${result.totalRows}`);
  if (result.outcome === "integrity-failure") {
    if (result.missing.length > 0) {
      lines.push(`  ❌ ${result.missing.length} checkpointed Memory id(s) missing; sample (up to ${MISSING_SAMPLE_LIMIT}):`);
      for (const id of result.missing.slice(0, MISSING_SAMPLE_LIMIT)) lines.push(`    - ${id}`);
    }
    for (const d of result.tierDrops) lines.push(`  ❌ ${d.tier} tier dropped by ${d.dropped}`);
  } else {
    lines.push(`  ✓ every checkpointed Memory id present`);
  }
  return lines.join("\n");
}
