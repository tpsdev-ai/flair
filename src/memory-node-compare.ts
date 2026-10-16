/**
 * memory-node-compare.ts — `flair memory compare-nodes` (flair#2216, slice 2 of
 * #971).
 *
 * Compares observed Memory id sets of explicitly named physical nodes.
 * Peers come only from `--node`, never Flair's federation peer table.
 *
 * Reads use the checkpoint's keyset paging and exact-count recheck, with the
 * same admin credentials. Count checks cannot detect equal-count concurrent
 * updates or replacements. An id absent on every named node is invisible
 * without a reference set.
 *
 * Classes use stored timestamps: parseable `updatedAt`, else `createdAt`.
 * `createdAt` can be caller-supplied and nodes can use different clocks;
 * timestamp comparisons do not establish actual write order.
 *  - `in-sync` — observed ids equal the union of the other usable readings.
 *  - `lagging` — missing ids only, each with a timestamp greater than this
 *                node's maximum timestamp.
 *  - `divergent` — an extra id, or a missing id whose timestamp is at or below
 *                  this node's maximum timestamp.
 *  - `unknown` — failed read, unusable row timestamp, no usable peer, or
 *                missing ids with no local timestamp to compare against.
 * A missing id uses the maximum timestamp among usable peers holding it.
 * The overall result is `healthy` only when every node is `in-sync`;
 * any `unknown` makes the overall result `unknown`.
 */
import {
  buildOpsPost,
  normalizeOrigin,
  readMemoryRowCount,
  readMemoryRowsPaged,
  type OpsPost,
} from "./memory-id-checkpoint.js";
import type { MemoryRowLite } from "./lib/memory-integrity.js";

/** How many missing/extra ids the report names per node before it just counts. */
export const NODE_ID_SAMPLE_LIMIT = 10;

export type NodeClass = "in-sync" | "lagging" | "divergent" | "unknown";
export type CompareNodesVerdict = "healthy" | "lagging" | "divergent" | "unknown";

/** Documented exit codes for `flair memory compare-nodes --help`. */
export const COMPARE_EXIT_CODES: Record<CompareNodesVerdict, number> = {
  healthy: 0,
  divergent: 2,
  unknown: 3,
  lagging: 4,
};

/** One row's id and stored timestamp string, or null when unavailable. */
export interface NodeRowTime {
  id: string;
  writeTime: string | null;
}

/** A node's reading: its rows, or why the read could not be used. */
export type NodeReading =
  | { kind: "read"; node: string; rows: readonly NodeRowTime[] }
  | { kind: "failed"; node: string; reason: string };

export interface NodeIdSample {
  count: number;
  sample: string[];
}

export interface NodeVerdict {
  node: string;
  verdict: NodeClass;
  /** Present for `unknown`: why the node could not be classified. */
  reason?: string;
  rowCount: number;
  /** The maximum parsed stored timestamp as ISO, or null when unavailable. */
  newestWrite: string | null;
  missing: NodeIdSample;
  extra: NodeIdSample;
}

export interface CompareNodesResult {
  verdict: CompareNodesVerdict;
  nodes: NodeVerdict[];
  /** One-line operator summary. */
  detail: string;
}

interface Prepared {
  node: string;
  ok: boolean;
  reason?: string;
  rowCount: number;
  idSet: Set<string>;
  /** id -> stored timestamp in ms; only for ok nodes with usable timestamps. */
  timeById: Map<string, number>;
  /** max of timeById's values, or null when no timestamp is usable. */
  newestMs: number | null;
}

/** Parse a stored timestamp; absent or unparseable values yield null. */
export function parseWriteTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** First parseable timestamp: `updatedAt`, then `createdAt`; null when neither parses. */
export function rowWriteTime(row: MemoryRowLite): string | null {
  for (const value of [row.updatedAt, row.createdAt]) {
    if (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function sample(ids: readonly string[]): NodeIdSample {
  const sorted = [...ids].sort();
  return { count: sorted.length, sample: sorted.slice(0, NODE_ID_SAMPLE_LIMIT) };
}

function prepare(reading: NodeReading): Prepared {
  if (reading.kind === "failed") {
    return { node: reading.node, ok: false, reason: reading.reason, rowCount: 0, idSet: new Set(), timeById: new Map(), newestMs: null };
  }
  const idSet = new Set<string>();
  const timeById = new Map<string, number>();
  let newestMs: number | null = null;
  for (const row of reading.rows) {
    idSet.add(row.id);
    const ms = parseWriteTime(row.writeTime);
    if (ms === null) {
      // A row without a usable timestamp makes this reading unknown.
      return { node: reading.node, ok: false, reason: `row ${row.id} has no usable stored timestamp`, rowCount: reading.rows.length, idSet, timeById, newestMs };
    }
    timeById.set(row.id, ms);
    if (newestMs === null || ms > newestMs) newestMs = ms;
  }
  return { node: reading.node, ok: true, rowCount: reading.rows.length, idSet, timeById, newestMs };
}

/**
 * Classify the readings. Pure and deterministic: the caller supplies each
 * node's rows or a read failure. Fewer than two nodes is a misuse.
 */
export function classifyNodeSets(readings: readonly NodeReading[]): CompareNodesResult {
  if (readings.length < 2) throw new Error("compare-nodes needs at least two nodes to compare");
  const prepared = readings.map(prepare);
  const readable = prepared.filter((p) => p.ok);

  const nodes: NodeVerdict[] = prepared.map((p) => {
    if (!p.ok) {
      return {
        node: p.node,
        verdict: "unknown",
        reason: p.reason,
        rowCount: p.rowCount,
        newestWrite: null,
        missing: { count: 0, sample: [] },
        extra: { count: 0, sample: [] },
      };
    }

    // The union of the OTHER readable nodes' ids. A failed node's ids are not
    // used: its set is not trustworthy, and comparing against it would invent
    // missing/extra ids. With no other readable node there is nothing to
    // compare against, so this node cannot be classified either.
    const others = new Set<string>();
    const peers = readable.filter((q) => q !== p);
    for (const q of peers) for (const id of q.idSet) others.add(id);

    const extra = [...p.idSet].filter((id) => !others.has(id));
    const missing = [...others].filter((id) => !p.idSet.has(id));

    const base = { node: p.node, rowCount: p.rowCount, newestWrite: p.newestMs === null ? null : new Date(p.newestMs).toISOString() };

    if (peers.length === 0) {
      return {
        ...base,
        verdict: "unknown",
        reason: "no other node could be read to compare against",
        missing: sample(missing),
        extra: sample(extra),
      };
    }
    if (extra.length > 0) {
      return { ...base, verdict: "divergent", missing: sample(missing), extra: sample(extra) };
    }
    if (missing.length === 0) {
      return { ...base, verdict: "in-sync", missing: sample([]), extra: sample([]) };
    }
    if (p.newestMs === null) {
      // Missing ids with no local timestamp to compare against yield unknown.
      return {
        ...base,
        verdict: "unknown",
        reason: `missing ${missing.length} id(s) but reports no stored timestamp to compare against`,
        missing: sample(missing),
        extra: sample([]),
      };
    }

    // A missing id's maximum peer timestamp at or below the local maximum
    // counts as divergence, including equality.
    const older = missing.filter((id) => {
      let latest: number | null = null;
      for (const q of peers) {
        const ms = q.idSet.has(id) ? q.timeById.get(id) ?? null : null;
        if (ms !== null && (latest === null || ms > latest)) latest = ms;
      }
      return latest !== null && latest <= p.newestMs!;
    });

    if (older.length > 0) {
      return { ...base, verdict: "divergent", missing: sample(missing), extra: sample([]) };
    }
    return { ...base, verdict: "lagging", missing: sample(missing), extra: sample([]) };
  });

  const verdict: CompareNodesVerdict = nodes.some((n) => n.verdict === "unknown")
    ? "unknown"
    : nodes.some((n) => n.verdict === "divergent")
      ? "divergent"
      : nodes.some((n) => n.verdict === "lagging")
        ? "lagging"
        : "healthy";

  const counts: Record<NodeClass, number> = { "in-sync": 0, lagging: 0, divergent: 0, unknown: 0 };
  for (const n of nodes) counts[n.verdict]++;
  const detail =
    verdict === "healthy"
      ? `healthy — all ${nodes.length} node(s) have the same observed Memory ids`
      : `${verdict} — ${(["in-sync", "lagging", "divergent", "unknown"] as NodeClass[])
          .filter((c) => counts[c] > 0)
          .map((c) => `${counts[c]} ${c}`)
          .join(", ")}`;

  return { verdict, nodes, detail };
}

// ─── Reading a node (reuse the checkpoint's paged admin read) ───────────────

export interface ReadNodeOptions {
  pageSize?: number;
  user?: string;
  password?: string;
  opsPost?: OpsPost;
}

/**
 * Read one node's Memory ids and stored timestamps through the admin operations API,
 * using the checkpoint's read (keyset paging + exact-count recheck). A read
 * failure is a `failed` reading, never an empty id set.
 */
export async function readNode(opsUrl: string, opts: ReadNodeOptions = {}): Promise<NodeReading> {
  let node = opsUrl;
  try {
    node = normalizeOrigin(opsUrl);
    const opsPost = opts.opsPost ?? buildOpsPost(node, opts.user, opts.password);
    const expected = await readMemoryRowCount(opsPost);
    const rows = await readMemoryRowsPaged(opsPost, { expected, pageSize: opts.pageSize, withWriteTimes: true });
    return { kind: "read", node, rows: rows.map((row) => ({ id: row.id, writeTime: rowWriteTime(row) })) };
  } catch (err) {
    return { kind: "failed", node, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

export function renderCompareNodesHuman(result: CompareNodesResult): string {
  const lines: string[] = [];
  lines.push(`Memory node comparison: ${result.verdict.toUpperCase()}`);
  if (result.verdict !== "healthy") lines.push(`  ⚠️  ${result.detail}`);
  for (const n of result.nodes) {
    lines.push(`  ${n.node}  ${n.verdict.toUpperCase()}  (${n.rowCount} id(s), maximum timestamp ${n.newestWrite ?? "none"})`);
    if (n.verdict === "unknown") lines.push(`    ⚠️  ${n.reason ?? "the node could not be classified"}; NOT healthy`);
    if (n.missing.count > 0) {
      lines.push(`    missing ${n.missing.count} id(s): ${n.missing.sample.join(", ")}${n.missing.count > n.missing.sample.length ? ", …" : ""}`);
    }
    if (n.extra.count > 0) {
      lines.push(`    holds ${n.extra.count} id(s) no other node has: ${n.extra.sample.join(", ")}${n.extra.count > n.extra.sample.length ? ", …" : ""}`);
    }
  }
  return lines.join("\n");
}
