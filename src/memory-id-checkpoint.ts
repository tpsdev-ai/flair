/** Memory id and tier-count checks around a planned cluster operation. */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ALL_TIERS, normalizeTier, tallyByDurability, type MemoryRowLite, type Tier } from "./lib/memory-integrity.js";

export const CHECKPOINT_VERSION = 1;
/** Written 0600 (flair#2218): ids + tier counts are operator-held, not world-readable. */
export const CHECKPOINT_MODE = 0o600;
export const CHECKPOINT_FILENAME = "memory-id-checkpoint.json";

/** Rows requested per operations-API page. */
export const MEMORY_PAGE_SIZE = 10_000;
/** Hard page-walk bound. */
export const MAX_MEMORY_PAGES = 100;
/** Per-request timeout for the admin read. Every operation is bounded. */
export const OPS_READ_TIMEOUT_MS = 30_000;
/** How many missing ids the failure report names. */
export const MISSING_SAMPLE_LIMIT = 10;

/** A read inconsistent with the exact count of the same range: a duplicate id or a size that differs. */
export class InconsistentReadError extends Error {}

export interface MemoryCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  /** Operations API origin (scheme://host[:port]) read for this checkpoint. */
  node: string;
  /** The node's host and port. */
  host: string;
  /** ISO timestamp of the read. */
  at: string;
  /** Sorted ids from the checkpoint read. */
  ids: string[];
  /** Row count per durability tier at the checkpoint. */
  byDurability: Record<Tier, number>;
}

/** The default checkpoint file is under ~/.flair/. */
export function checkpointPath(home: string): string {
  return join(home, ".flair", CHECKPOINT_FILENAME);
}

// ─── Reading the instance (admin operations API, paged) ─────────────────────

/** POST one operations-API body at an instance origin, with Basic auth. */
export type OpsPost = (body: Record<string, unknown>) => Promise<unknown>;

/** Build a Basic-auth operations caller; omit response bodies from errors. */
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

function asTime(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The parameters of one keyset page walk over `flair.<table>`. */
export interface KeysetReadOptions {
  /** Unqualified table name inside the `flair` database. */
  table: string;
  /** Projected columns, `id` first (e.g. "id, durability"). */
  select: string;
  /** An extra SQL predicate ANDed with the keyset cursor, or omitted for none. */
  filter?: string;
  /** Exact row count over the same range; a read of any other size refuses. */
  expected: number;
  /** Rows per page (default MEMORY_PAGE_SIZE). */
  pageSize?: number;
  /** Hard page cap (default MAX_MEMORY_PAGES). */
  maxPages?: number;
  /** Builds the error a read size that differs from `expected` raises. */
  mismatch?: (expected: number, read: number) => Error;
}

/**
 * Walk `flair.<table>` by primary key: `SELECT <select> ... [WHERE <filter> AND] id > cursor
 * ORDER BY id LIMIT <pageSize>`, resuming strictly after the last id read. A duplicate id
 * across pages, or a read that differs in size from `expected`, refuses. A full final page at
 * the cap is accepted when a read after its last id returns no row and the rows read equal
 * `expected`, the same evidence an uncapped walk ends on. The page allowance is
 * `ceil(expected / pageSize) + 1`, capped by `maxPages`
 * (default MAX_MEMORY_PAGES). Duplicates raise InconsistentReadError. Outside the cap branch a
 * size mismatch raises InconsistentReadError by default, but `mismatch` can return any Error;
 * a mismatch on a full final page at the cap raises the page-cap error. Errors from `opsPost`
 * propagate unchanged.
 */
export async function readTableByIdPaged(opsPost: OpsPost, opts: KeysetReadOptions): Promise<any[]> {
  const pageSize = opts.pageSize ?? MEMORY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_MEMORY_PAGES;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("invalid keyset paging bounds");
  }
  // The allowance is the pages the expected count needs plus one, or the caller's hard cap
  // when that is smaller; the request count never follows a server-reported value without
  // a bound.
  const pageAllowance = Math.min(maxPages, Math.ceil(opts.expected / pageSize) + 1);
  const mismatch = opts.mismatch ?? ((expected: number, read: number) => new InconsistentReadError(`${opts.table}: server reports ${expected} rows, integrity read ${read}`));
  const rows: any[] = [];
  let lastId: string | undefined;
  const seen = new Set<string>();

  for (let page = 0; page < pageAllowance; page++) {
    if (lastId?.includes("\\")) throw new Error(`${opts.table} cursor contains an unsupported backslash`);
    const where: string[] = [];
    if (opts.filter) where.push(`(${opts.filter})`);
    if (lastId !== undefined) where.push(`id > '${lastId.replace(/'/g, "''")}'`);
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const body = await opsPost({
      operation: "sql",
      sql: `SELECT ${opts.select} FROM flair.${opts.table}${clause} ORDER BY id LIMIT ${pageSize}`,
    });
    const batch = asRows(body);
    if (batch === null) throw new Error(`${opts.table} search returned a body that is neither a row array nor { results: [...] }`);
    for (const r of batch) {
      if (!r || typeof r.id !== "string" || r.id.length === 0) {
        throw new Error(`${opts.table} search returned a row without a usable id`);
      }
      if (seen.has(r.id)) throw new InconsistentReadError(`${opts.table} search returned duplicate id ${r.id} across pages`);
      seen.add(r.id);
      lastId = r.id;
      rows.push(r);
    }
    if (batch.length < pageSize) break;
    if (page === pageAllowance - 1) {
      if (lastId?.includes("\\")) throw new Error(`${opts.table} cursor contains an unsupported backslash`);
      const probeWhere = opts.filter ? `(${opts.filter}) AND ` : "";
      const probe = asRows(await opsPost({
        operation: "sql",
        sql: `SELECT id FROM flair.${opts.table} WHERE ${probeWhere}id > '${lastId!.replace(/'/g, "''")}' ORDER BY id LIMIT 1`,
      }));
      if (probe?.length === 0 && rows.length === opts.expected) break;
      throw new Error(`${opts.table} read reached the ${pageAllowance}-page cap`);
    }
  }

  if (rows.length !== opts.expected) throw mismatch(opts.expected, rows.length);
  return rows;
}

/** Read id and durability (and, when asked, the stored row timestamps) in primary-key order. */
export async function readMemoryRowsPaged(
  opsPost: OpsPost,
  opts: { pageSize?: number; maxPages?: number; expected?: number; withWriteTimes?: boolean } = {},
): Promise<MemoryRowLite[]> {
  const withWriteTimes = opts.withWriteTimes ?? false;
  const expected = opts.expected ?? await readMemoryRowCount(opsPost);
  const raw = await readTableByIdPaged(opsPost, {
    table: "Memory",
    select: withWriteTimes ? "id, durability, createdAt, updatedAt" : "id, durability",
    expected,
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
    mismatch: () => new InconsistentReadError("writes during checkpoint"),
  });
  const after = await readMemoryRowCount(opsPost);
  if (after !== expected) {
    throw new InconsistentReadError("writes during checkpoint");
  }
  return raw.map((r) =>
    withWriteTimes
      ? { id: r.id, durability: typeof r.durability === "string" ? r.durability : "standard", createdAt: asTime(r.createdAt), updatedAt: asTime(r.updatedAt) }
      : { id: r.id, durability: typeof r.durability === "string" ? r.durability : "standard" },
  );
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

/** Reduce a row set to a checkpoint (sorted ids, tier counts, origin, time). */
export function buildCheckpoint(input: {
  node: string;
  at: string;
  rows: readonly MemoryRowLite[];
}): MemoryCheckpoint {
  const node = normalizeOrigin(input.node);
  const host = new URL(node).host;
  const ids = input.rows.map((r) => r.id).slice().sort();
  return {
    version: CHECKPOINT_VERSION,
    node,
    host,
    at: input.at,
    ids,
    byDurability: tallyByDurability(input.rows),
  };
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("node must be an HTTP(S) origin without credentials");
  }
  return url.origin;
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
 *  - ids present with no tier-count drop → verified (new ids are fine).
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
    detail: `verified — all ${checkpoint.ids.length} checkpointed Memory id(s) present; no tier-count drop; counts: ${ALL_TIERS.map((t) => `${t} ${counts[t]}`).join(", ")}`,
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
    lstatSync(path);
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
    const node = normalizeOrigin(parsed.node);
    if (new URL(node).host !== parsed.host) {
      return { kind: "unreadable", reason: "checkpoint host does not match its origin" };
    }
    // Built from the validated fields only: a key the file adds beyond the
    // version-1 shape is not carried into the checkpoint.
    const byDurability = Object.create(null) as Record<Tier, number>;
    for (const t of ALL_TIERS) byDurability[t] = parsed.byDurability[t];
    const checkpoint = Object.create(null) as MemoryCheckpoint;
    checkpoint.version = CHECKPOINT_VERSION;
    checkpoint.node = node;
    checkpoint.host = parsed.host;
    checkpoint.at = parsed.at;
    checkpoint.ids = [...parsed.ids];
    checkpoint.byDurability = byDurability;
    return { kind: "ok", checkpoint };
  } catch {
    return { kind: "unreadable", reason: "checkpoint is not valid JSON or has an invalid origin" };
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
  opsTarget?: string;
  pageSize?: number;
  user?: string;
  password?: string;
  opsPost?: OpsPost;
}

/**
 * Read the live instance and compare it against the checkpoint. Any read
 * failure (unreachable instance, a page, or a short read) is UNKNOWN.
 * The walk shares the reader's no-snapshot limit (see integrityReader in
 * src/commands/integrity.ts), so a balanced concurrent write can leave a `verified`
 * result that no single instant matched; #2679 tracks a consistent read.
 */
export async function verifyCheckpoint(opts: VerifyOptions): Promise<VerifyResult> {
  try {
    const target = normalizeOrigin(opts.opsTarget ?? opts.target);
    const node = normalizeOrigin(opts.checkpoint.node);
    if (target !== node) {
      return unknownVerify(`checkpoint was taken from node ${node} but this target is ${target} — refusing to compare across origins`);
    }
    const opsPost = opts.opsPost ?? buildOpsPost(target, opts.user, opts.password);
    const expected = await readMemoryRowCount(opsPost);
    const rows = await readMemoryRowsPaged(opsPost, { expected, pageSize: opts.pageSize });
    return compareCheckpoint(opts.checkpoint, rows);
  } catch (err) {
    return unknownVerify(err instanceof Error ? err.message : String(err));
  }
}

/** Render the comparison report. */
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
    lines.push(`  ✓ every checkpointed Memory id present; no tier-count drop`);
  }
  return lines.join("\n");
}
