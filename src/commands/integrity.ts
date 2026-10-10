/**
 * integrity.ts — `flair integrity check` (flair#2213).
 *
 * Operator-invoked, one-shot: compare the live Memory corpus over the operations
 * API with the checkpoint. `--json` for machines, human output
 * otherwise. A corpus or checkpoint read failure reports UNKNOWN and leaves the
 * checkpoint unchanged.
 *
 * Command group lives here (flair#2213), bound via bindIntegrityCli() the same
 * way the other extracted command groups are.
 */
import { Command } from "commander";
import { readExactCountSince, readExactTableCount } from "../lib/ops-table-count.js";
import { writeConfirmed } from "../lib/instance-identity-row.js";
import { resolveHome } from "../lib/home.js";
import {
  compareScan,
  DELETION_HISTORY_MARGIN_MS,
  deletionReadSince,
  deletionRecordsToPrune,
  emptyCheckpoint,
  historyRowsToPrune,
  integrityCheckpointPath,
  readCheckpoint,
  retentionCutoff,
  unknownVerdict,
  writeCheckpoint,
  type DeletionRecordLite,
  type IntegrityVerdict,
  type MemoryRowLite,
  type IntegrityCheckpoint,
} from "../lib/memory-integrity.js";

export type IntegrityCli = {
  resolveOpsPort: (...args: any[]) => any;
  resolveAdminUser: (...args: any[]) => any;
};

let cli: IntegrityCli;

export function bindIntegrityCli(fns: IntegrityCli): void {
  cli = fns;
}

const OPS_TIMEOUT_MS = 30_000;

async function pruneDeletionHistory(opsPort: number | string, auth: string, checkpoint: IntegrityCheckpoint, deletions: readonly DeletionRecordLite[]): Promise<void> {
  await deleteHistoryIds(opsPort, auth, deletionRecordsToPrune(checkpoint, deletions));
}

/** A batch failed after `confirmed` rows were already confirmed deleted. */
class HistoryDeleteError extends Error {
  constructor(message: string, readonly confirmed: number) {
    super(message);
  }
}

/** Delete history rows by id in confirmed batches of at most 256. A batch that
 *  the operations API does not confirm deleted throws a HistoryDeleteError
 *  carrying the count confirmed before it. */
async function deleteHistoryIds(opsPort: number | string, auth: string, ids: readonly string[]): Promise<number> {
  let confirmed = 0;
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256);
    try {
      const res = await fetch(opsUrl(opsPort), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ operation: "delete", database: "flair", table: "MemoryDeletionHistory", hash_values: batch }),
        signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`operations API deletion history retention failed (${res.status})`);
      const body = await res.json();
      if (!batch.every(id => writeConfirmed(body, "deleted_hashes", id))) {
        throw new Error("operations API deletion history retention was not confirmed");
      }
    } catch (err) {
      throw new HistoryDeleteError(err instanceof Error ? err.message : String(err), confirmed);
    }
    confirmed += batch.length;
  }
  return confirmed;
}

function opsUrl(opsPort: number | string): string {
  return typeof opsPort === "number" ? `http://127.0.0.1:${opsPort}/` : `${String(opsPort).replace(/\/$/, "")}/`;
}

const DELETION_HISTORY_ATTRIBUTES = ["id", "memoryId", "memoryInstanceToken", "durability", "at"];

/**
 * The operations-API reads the integrity commands share. `search` reads a whole
 * table (bracketed by its exact count); `searchDeletionsSince` reads only history
 * at or after `since`, bracketed by the exact count of that range so a result
 * that differs from it is a read error, never a history that would read as a loss.
 */
function integrityReader(opsPort: number | string, auth: string) {
  const opsPost = async (body: Record<string, unknown>, context: string): Promise<unknown> => {
    const res = await fetch(opsUrl(opsPort), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`operations API ${context} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  };
  const project = (table: string, body: unknown): any[] => {
    if (!Array.isArray(body)) throw new Error(`operations API ${table} search returned a non-array body`);
    const ids = new Set<string>();
    for (const row of body) {
      if (!row || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) {
        throw new Error(`operations API ${table} search returned an invalid or duplicate id`);
      }
      ids.add(row.id);
    }
    return body as any[];
  };
  const search = async (table: string, attributes: string[]): Promise<any[]> => {
    const expected = await readExactTableCount(opsPost, table);
    const body = await opsPost({
      operation: "search_by_value",
      database: "flair",
      table,
      search_attribute: "id",
      search_value: "*",
      get_attributes: attributes,
    }, `${table} search`);
    const rows = project(table, body);
    if (rows.length !== expected) {
      throw new Error(`${table}: server reports ${expected} rows, integrity read ${rows.length}; retry integrity check when writes are paused`);
    }
    const after = await readExactTableCount(opsPost, table);
    if (after !== expected) {
      throw new Error(`${table}: source count changed from ${expected} to ${after}; integrity read ${rows.length}; retry integrity check when writes are paused`);
    }
    return rows;
  };
  // The watermark-bounded read: only history at or after `deletionSince`, bracketed
  // by that range's exact count (the table count is not this query's count, so
  // `describe_table` cannot bracket it — the count comes from the SQL count of the
  // same range). The bracketed full read is still used whenever the watermark is
  // unknown.
  const searchDeletionsSince = async (since: string): Promise<any[]> => {
    const expected = await readExactCountSince(opsPost, "MemoryDeletionHistory", "at", since);
    const body = await opsPost({
      operation: "search_by_conditions",
      database: "flair",
      table: "MemoryDeletionHistory",
      operator: "and",
      conditions: [{ search_attribute: "at", search_type: "greater_than_equal", search_value: since }],
      get_attributes: DELETION_HISTORY_ATTRIBUTES,
    }, "MemoryDeletionHistory search");
    const rows = project("MemoryDeletionHistory", body);
    if (rows.length !== expected) {
      throw new Error(`MemoryDeletionHistory: the bounded read reports ${expected} rows, integrity read ${rows.length}; retry integrity check when writes are paused`);
    }
    const after = await readExactCountSince(opsPost, "MemoryDeletionHistory", "at", since);
    if (after !== expected) {
      throw new Error(`MemoryDeletionHistory: the bounded read count changed from ${expected} to ${after}; integrity read ${rows.length}; retry integrity check when writes are paused`);
    }
    return rows;
  };
  return { search, searchDeletionsSince };
}

function toMemoryRows(memoryRows: any[]): MemoryRowLite[] {
  const rows: MemoryRowLite[] = [];
  for (const r of memoryRows) {
    if (!r || typeof r.id !== "string" || r.id.length === 0) throw new Error("operations API Memory search returned an invalid id");
    rows.push({ id: r.id, durability: typeof r.durability === "string" ? r.durability : "standard", instanceToken: typeof r.instanceToken === "string" ? r.instanceToken : null });
  }
  return rows;
}

function toDeletions(deletionRows: any[]): DeletionRecordLite[] {
  const deletions: DeletionRecordLite[] = [];
  for (const d of deletionRows) {
    if (!d || typeof d.id !== "string" || !d.id || typeof d.memoryId !== "string" || !d.memoryId) {
      throw new Error("operations API MemoryDeletionHistory search returned an invalid id");
    }
    deletions.push({
      id: d.id,
      memoryId: d.memoryId,
      memoryInstanceToken: typeof d.memoryInstanceToken === "string" ? d.memoryInstanceToken : null,
      durability: typeof d.durability === "string" ? d.durability : null,
      at: typeof d.at === "string" ? d.at : "",
    });
  }
  return deletions;
}

/**
 * Read Memory ids, durability, instanceToken and deletion records through
 * the operations API. Throws on any read failure — the caller reports UNKNOWN.
 */
async function readCorpus(
  opsPort: number | string,
  auth: string,
  deletionSince: string | null,
): Promise<{ rows: MemoryRowLite[]; deletions: DeletionRecordLite[] }> {
  const { search, searchDeletionsSince } = integrityReader(opsPort, auth);
  const memoryRows = await search("Memory", ["id", "durability", "instanceToken"]);
  const deletionRows = deletionSince === null
    ? await search("MemoryDeletionHistory", DELETION_HISTORY_ATTRIBUTES)
    : await searchDeletionsSince(deletionSince);
  return { rows: toMemoryRows(memoryRows), deletions: toDeletions(deletionRows) };
}

/**
 * Read only the deletion-history rows retention may prune — no Memory rows.
 */
async function readDeletions(
  opsPort: number | string,
  auth: string,
  deletionSince: string | null,
): Promise<DeletionRecordLite[]> {
  const { search, searchDeletionsSince } = integrityReader(opsPort, auth);
  const deletionRows = deletionSince === null
    ? await search("MemoryDeletionHistory", DELETION_HISTORY_ATTRIBUTES)
    : await searchDeletionsSince(deletionSince);
  return toDeletions(deletionRows);
}

function renderHuman(v: IntegrityVerdict, checkpointPath: string): string {
  const lines: string[] = [];
  const counts = v.counts;
  lines.push(`Integrity scan: ${v.status.toUpperCase()}`);
  lines.push(v.status === "unknown" ? "  corpus: unavailable" : `  corpus: ${v.total} rows (permanent ${counts.permanent}, persistent ${counts.persistent}, standard ${counts.standard}, ephemeral ${counts.ephemeral})`);
  lines.push(`  checkpoint: ${checkpointPath}`);
  if (v.status === "unknown") {
    lines.push(`  ⚠️  UNKNOWN — scan failed: ${v.reason}`);
    lines.push(v.checkpointWritten ? "  checkpoint advanced before retention failed." : "  The checkpoint was not changed.");
    return lines.join("\n");
  }
  if (v.status === "baseline") {
    lines.push("  baseline established from this scan (no prior checkpoint).");
    return lines.join("\n");
  }
  if (v.attributedDeletes.length > 0) {
    lines.push(`  ${v.attributedDeletes.length} history-backed attribution(s):`);
    for (const d of v.attributedDeletes.slice(0, 20)) lines.push(`    - ${d.id} (${d.tier}) at ${d.at}`);
    if (v.attributedDeletes.length > 20) lines.push(`    … ${v.attributedDeletes.length - 20} more`);
  }
  if (v.tierChanges.length > 0) {
    lines.push(`  ${v.tierChanges.length} tier change(s) observed:`);
    for (const c of v.tierChanges.slice(0, 20)) lines.push(`    - ${c.id}: ${c.from} -> ${c.to}`);
    if (v.tierChanges.length > 20) lines.push(`    … ${v.tierChanges.length - 20} more`);
  }
  if (v.losses.length > 0) {
    lines.push(`  ❌ ${v.losses.length} UNEXPLAINED durable row loss(es) — no new matching deletion record:`);
    for (const l of v.losses) lines.push(`    - ${l.id} (${l.tier}${l.reason ? `, ${l.reason}` : ""})`);
  }
  for (const [tier, delta] of Object.entries(v.unexplainedDecrease)) {
    lines.push(`  ❌ unexplained ${tier} decrease of ${delta} not accounted for by the id set`);
  }
  if (v.checkpointWritten) lines.push("  checkpoint advanced.");
  else lines.push("  checkpoint NOT advanced (unresolved loss).");
  return lines.join("\n");
}

interface PrunePlan {
  status: "refused" | "planned" | "pruned" | "failed";
  reason?: string;
  cutoff?: string;
  planned: number;
  pruned: number;
  prunedIsLowerBound?: true;
  more: boolean;
  checkpoints: string[];
  ids?: string[];
}

function renderPrunePlan(plan: PrunePlan): string {
  if (plan.status === "refused") {
    return [
      "Deletion-history retention: REFUSED — nothing pruned.",
      `  reason: ${plan.reason}`,
      `  checkpoints: ${plan.checkpoints.join(", ")}`,
    ].join("\n");
  }
  if (plan.status === "failed") {
    return [
      `Deletion-history retention: FAILED — at least ${plan.pruned} rows pruned before the failure.`,
      `  reason: ${plan.reason}`,
      `  checkpoints: ${plan.checkpoints.join(", ")}`,
    ].join("\n");
  }
  const lines = [
    `Deletion-history retention: ${plan.status === "pruned" ? "PRUNED" : "DRY RUN"}`,
    `  checkpoints: ${plan.checkpoints.join(", ")}`,
    `  eligible: history rows dated before ${plan.cutoff}`,
  ];
  if (plan.status === "pruned") lines.push(`  rows pruned: ${plan.pruned}`);
  else lines.push(`  rows that would be pruned: ${plan.planned}`, "  nothing was deleted (pass --apply to delete)");
  if (plan.more) lines.push("  more rows are eligible than the per-run cap; re-run to continue");
  return lines.join("\n");
}

/**
 * The retention plan: read every named checkpoint; refuse (prune nothing) when
 * one is missing or unreadable or a watermark cannot be parsed; otherwise prune
 * history older than the OLDEST watermark minus the margin (never later than
 * now minus the margin), at most `cap` rows, and only when `apply`. A delete
 * failure returns "failed" with the count confirmed before it.
 */
async function planPruneHistory(opts: {
  opsPort: number | string;
  auth: string;
  checkpoints: string[];
  cap: number;
  apply: boolean;
}): Promise<PrunePlan> {
  const { opsPort, auth, checkpoints, cap, apply } = opts;
  const watermarks: string[] = [];
  for (const path of checkpoints) {
    const read = readCheckpoint(path);
    if (read.kind === "absent") return { status: "refused", reason: `${path}: no checkpoint`, planned: 0, pruned: 0, more: false, checkpoints };
    if (read.kind === "unreadable") return { status: "refused", reason: `${path}: checkpoint unreadable: ${read.reason}`, planned: 0, pruned: 0, more: false, checkpoints };
    watermarks.push(read.checkpoint.watermark ?? "");
  }
  const watermarkCutoff = retentionCutoff(watermarks);
  if (watermarkCutoff === null) {
    return { status: "refused", reason: "a checkpoint watermark is missing or unreadable", planned: 0, pruned: 0, more: false, checkpoints };
  }
  const cutoff = new Date(Math.min(Date.parse(watermarkCutoff), Date.now() - DELETION_HISTORY_MARGIN_MS)).toISOString();
  // Retention reads only the history it may prune — never the Memory corpus.
  const deletions = await readDeletions(opsPort, auth, null);
  const eligible = historyRowsToPrune(deletions, cutoff, deletions.length);
  const planned = eligible.slice(0, cap);
  if (!apply) {
    return { status: "planned", cutoff, planned: planned.length, pruned: 0, more: eligible.length > planned.length, checkpoints, ids: planned.map(row => row.id) };
  }
  const more = eligible.length > planned.length;
  try {
    const pruned = await deleteHistoryIds(opsPort, auth, planned.map(row => row.id));
    return { status: "pruned", cutoff, planned: planned.length, pruned, more, checkpoints, ids: planned.map(row => row.id) };
  } catch (err) {
    if (!(err instanceof HistoryDeleteError)) throw err;
    return { status: "failed", reason: err.message, cutoff, planned: planned.length, pruned: err.confirmed, prunedIsLowerBound: true, more, checkpoints, ids: planned.slice(0, err.confirmed).map(row => row.id) };
  }
}

export function register(program: Command): void {
  const integrity = program
    .command("integrity")
    .description("Detect missing checkpointed durable Memory IDs or changed or missing previously nonempty tokens");

  integrity
    .command("check")
    .description("Report missing checkpointed durable IDs or changed or missing previously nonempty tokens; rows created and lost entirely between scans are not observed")
    .option("--json", "Print the verdict as JSON")
    .option("--accept", "On an alert, advance the whole checkpoint only if no reported replacement lacks a token; otherwise write no checkpoint, even with other losses")
    .option("--checkpoint <path>", "Checkpoint file path (default: ~/.flair/integrity-checkpoint.json)")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .action(async (opts) => {
      const opsPort = cli.resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const adminUser = cli.resolveAdminUser(opts.adminUser);
      const checkpointPath: string = opts.checkpoint ?? integrityCheckpointPath(resolveHome());
      const scannedAt = new Date().toISOString();

      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for integrity check");
        process.exit(1);
      }
      const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;

      let verdict: IntegrityVerdict;
      let checkpointWritten = false;
      try {
        const read = readCheckpoint(checkpointPath);
        if (read.kind === "unreadable") {
          verdict = unknownVerdict(`checkpoint unreadable: ${read.reason}`, scannedAt);
        } else {
          // Bound the deletion-history read by this checkpoint's watermark; an
          // absent or unknown watermark reads the whole table (see deletionReadSince).
          const { rows, deletions } = await readCorpus(opsPort, auth, deletionReadSince(read.kind === "ok" ? read.checkpoint : null));
          if (read.kind === "absent") {
            const cp = emptyCheckpoint(scannedAt, rows, deletions);
            writeCheckpoint(checkpointPath, cp);
            checkpointWritten = true;
            verdict = { ...compareScan({ checkpoint: cp, rows, deletions, scannedAt }), status: "baseline", checkpointWritten: true };
            await pruneDeletionHistory(opsPort, auth, cp, deletions);
          } else {
            verdict = compareScan({ checkpoint: read.checkpoint, rows, deletions, scannedAt });
            const missingTokenLoss = verdict.losses.some(loss => loss.reason === "replaced" &&
              rows.some(row => row.id === loss.id && !row.instanceToken));
            if (verdict.status === "healthy" || (opts.accept && !missingTokenLoss)) {
              const cp = emptyCheckpoint(scannedAt, rows, deletions, read.checkpoint.historyIds);
              writeCheckpoint(checkpointPath, cp);
              checkpointWritten = true;
              verdict.checkpointWritten = true;
              await pruneDeletionHistory(opsPort, auth, cp, deletions);
            }
          }
        }
      } catch (err) {
        verdict = unknownVerdict(err instanceof Error ? err.message : String(err), scannedAt);
        verdict.checkpointWritten = checkpointWritten;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(verdict)}\n`);
      } else {
        console.log(renderHuman(verdict, checkpointPath));
      }
      // Exit codes: 0 healthy/baseline, 2 alert, 3 unknown.
      process.exit(verdict.status === "alert" ? 2 : verdict.status === "unknown" ? 3 : 0);
    });

  // Retention. A separate, operator-invoked, one-shot command so the scan path
  // above is unchanged by it. A job that deletes rows is off by default (nothing
  // is deleted without --apply), bounded by --max per run, and reports in a dry
  // run what it would prune. Stopping it needs no instance restart: it is a
  // bounded one-shot process, and the next run simply omits --apply. It prunes
  // nothing — with a named reason — when a checkpoint is missing or a watermark
  // is unreadable.
  integrity
    .command("prune-history")
    .description("Prune MemoryDeletionHistory rows older than the oldest named checkpoint watermark minus a margin; dry-run unless --apply")
    .option("--checkpoint <path...>", "Checkpoint file whose watermark bounds the prune; repeat for several (default: ~/.flair/integrity-checkpoint.json)")
    .option("--apply", "Delete the eligible rows; without it nothing is deleted")
    .option("--max <n>", "Hard cap on rows pruned in one run (default: 500)")
    .option("--json", "Print the plan as JSON")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS env)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .action(async (opts) => {
      const opsPort = cli.resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      const adminUser = cli.resolveAdminUser(opts.adminUser);
      const checkpoints: string[] = Array.isArray(opts.checkpoint) && opts.checkpoint.length > 0
        ? opts.checkpoint.map((path: unknown) => String(path))
        : [integrityCheckpointPath(resolveHome())];
      const maxText = String(opts.max ?? "500");
      const cap = /^\d+$/.test(maxText) ? Number.parseInt(maxText, 10) : Number.NaN;
      if (!Number.isSafeInteger(cap)) {
        console.error("Error: --max must be a non-negative integer");
        process.exit(1);
      }
      if (!adminPass) {
        console.error("Error: --admin-pass or FLAIR_ADMIN_PASS required for integrity prune-history");
        process.exit(1);
      }
      const auth = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
      let plan: PrunePlan;
      try {
        plan = await planPruneHistory({ opsPort, auth, checkpoints, cap, apply: !!opts.apply });
      } catch (err) {
        plan = { status: "refused", reason: err instanceof Error ? err.message : String(err), planned: 0, pruned: 0, more: false, checkpoints };
      }
      if (opts.json) process.stdout.write(`${JSON.stringify(plan)}\n`);
      else console.log(renderPrunePlan(plan));
      process.exit(plan.status === "refused" || plan.status === "failed" ? 3 : 0);
    });
}
