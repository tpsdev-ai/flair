/**
 * memory-node-compare.ts — `flair memory compare-nodes` (flair#2216, slice 2 of
 * #971).
 *
 * Compares the Memory id sets of two or more explicitly configured physical
 * nodes, so a node that silently lost or never received writes is visible.
 * Physical peers come only from the operator's `--node` list: they are NEVER
 * inferred from Flair's federation peer table (src/fleet-verify.ts's header
 * states why — a Flair federation peer is a distinct, higher-level concept,
 * not a Fabric replica).
 *
 * Each node is read with the SAME operations-API read the memory checkpoint
 * uses (src/memory-id-checkpoint.ts: keyset paging in primary-key order, then
 * an exact-count recheck; a write during the read is an inconsistent read), and
 * with the same admin credentials. This module adds the row write time
 * (`updatedAt`, else `createdAt`) to that read and classifies the id sets.
 *
 * ── Classes ───────────────────────────────────────────────────────────────
 *  - `in-sync`  — it holds every id the other readable nodes hold, and holds no
 *                  id they do not.
 *  - `lagging`  — it is missing only ids written AFTER its own newest write; it
 *                  may still be catching up.
 *  - `divergent`— it is missing an id written AT OR BEFORE its own newest write,
 *                  or it holds an id no other readable node has.
 *  - `unknown`  — its read failed, its read was inconsistent (a row with no usable
 *                  write time), there was no other readable node to compare it
 *                  with, or it is missing ids but has no persisted write time to
 *                  compare them against.
 *
 * A node's newest write is the latest row write time it reports (max of
 * `updatedAt`, else `createdAt`, per row). A missing id's write time is the
 * latest such value among the readable nodes that hold it.
 *
 * The overall result is `healthy` ONLY when every node is `in-sync`. Any
 * `unknown` makes the overall result `unknown`, never healthy. This is the
 * data-convergence half of #971: a green health probe is not data convergence.
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

/** One row's id and its persisted write time (ISO), or null when it has none. */
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
  /** The node's newest persisted write time (ISO), or null when it has none. */
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
  /** id -> write time in ms; only for ok nodes, and only for ids with a usable time. */
  timeById: Map<string, number>;
  /** max of timeById's values, or null when the node has no usable write time. */
  newestMs: number | null;
}

/** Parse a node row's write time. A value that is absent or unparseable is null. */
export function parseWriteTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A row's write time: `updatedAt` when present, else `createdAt`; null when neither parses. */
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
      // A read that cannot say when a row was written cannot be classified.
      return { node: reading.node, ok: false, reason: `row ${row.id} has no usable write time`, rowCount: reading.rows.length, idSet, timeById, newestMs };
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
      // Missing ids, but no write time of its own to compare them against: it
      // cannot be shown to be catching up, so its class is unknown.
      return {
        ...base,
        verdict: "unknown",
        reason: `missing ${missing.length} id(s) but reports no persisted write time to compare against`,
        missing: sample(missing),
        extra: sample([]),
      };
    }

    // A missing id written at or before this node's newest write should already
    // be here — an id at exactly the boundary counts as divergence (the node
    // wrote it or newer and still lacks it).
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
      ? `healthy — all ${nodes.length} node(s) carry the same Memory ids`
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
 * Read one node's Memory ids and write times through the admin operations API,
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
    lines.push(`  ${n.node}  ${n.verdict.toUpperCase()}  (${n.rowCount} id(s), newest write ${n.newestWrite ?? "none"})`);
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
