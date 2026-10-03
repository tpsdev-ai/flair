/**
 * integrity.ts — `flair integrity check` (flair#2213).
 *
 * Operator-invoked, one-shot: read the live Memory corpus over the operations
 * API, compare it to the out-of-store checkpoint, report, and (only on a
 * non-alerting scan or `--accept`) advance the checkpoint. Two reads with
 * explicit timeouts, no server-side job. `--json` for machines, human output
 * otherwise. A read failure reports UNKNOWN and never overwrites the checkpoint.
 *
 * Command group lives here (flair#2213), bound via bindIntegrityCli() the same
 * way the other extracted command groups are.
 */
import { Command } from "commander";
import { resolveHome } from "../lib/home.js";
import {
  compareScan,
  emptyCheckpoint,
  integrityCheckpointPath,
  readCheckpoint,
  unknownVerdict,
  writeCheckpoint,
  type DeletionRecordLite,
  type IntegrityVerdict,
  type MemoryRowLite,
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

function opsUrl(opsPort: number | string): string {
  return typeof opsPort === "number" ? `http://127.0.0.1:${opsPort}/` : `${String(opsPort).replace(/\/$/, "")}/`;
}

/**
 * Read Memory ids, durability, instanceToken and deletion records through
 * the operations API. Throws on any read failure — the caller reports UNKNOWN.
 */
async function readCorpus(
  opsPort: number | string,
  auth: string,
): Promise<{ rows: MemoryRowLite[]; deletions: DeletionRecordLite[] }> {
  const search = async (table: string, attributes: string[]): Promise<any[]> => {
    const res = await fetch(opsUrl(opsPort), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "search_by_value",
        database: "flair",
        table,
        search_attribute: "id",
        search_value: "*",
        get_attributes: attributes,
      }),
      signal: AbortSignal.timeout(OPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`operations API ${table} search failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`operations API ${table} search returned a non-array body`);
    return body;
  };

  const memoryRows = await search("Memory", ["id", "durability", "instanceToken"]);
  const deletionRows = await search("MemoryDeletionHistory", ["id", "memoryId", "memoryInstanceToken", "durability", "at"]);

  const rows: MemoryRowLite[] = [];
  for (const r of memoryRows) {
    if (!r || typeof r.id !== "string" || r.id.length === 0) throw new Error("operations API Memory search returned an invalid id");
    rows.push({ id: r.id, durability: typeof r.durability === "string" ? r.durability : "standard", instanceToken: typeof r.instanceToken === "string" ? r.instanceToken : null });
  }
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
  return { rows, deletions };
}

function renderHuman(v: IntegrityVerdict, checkpointPath: string): string {
  const lines: string[] = [];
  const counts = v.counts;
  lines.push(`Integrity scan: ${v.status.toUpperCase()}`);
  lines.push(v.status === "unknown" ? "  corpus: unavailable" : `  corpus: ${v.total} rows (permanent ${counts.permanent}, persistent ${counts.persistent}, standard ${counts.standard}, ephemeral ${counts.ephemeral})`);
  lines.push(`  checkpoint: ${checkpointPath}`);
  if (v.status === "unknown") {
    lines.push(`  ⚠️  UNKNOWN — scan failed: ${v.reason}`);
    lines.push("  The checkpoint was not changed.");
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
  else lines.push("  checkpoint NOT advanced (unresolved loss). Use --accept to re-baseline deliberately.");
  return lines.join("\n");
}

export function register(program: Command): void {
  const integrity = program
    .command("integrity")
    .description("Detect missing or replaced checkpointed durable Memory IDs");

  integrity
    .command("check")
    .description("Report missing or replaced checkpointed durable IDs; rows created and lost entirely between scans are not observed")
    .option("--json", "Print the verdict as JSON")
    .option("--accept", "Advance the checkpoint even when a loss is open (re-baseline; deliberate)")
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
      try {
        const { rows, deletions } = await readCorpus(opsPort, auth);
        const read = readCheckpoint(checkpointPath);
        if (read.kind === "unreadable") {
          verdict = unknownVerdict(`checkpoint unreadable: ${read.reason}`, scannedAt);
        } else if (read.kind === "absent") {
          const cp = emptyCheckpoint(scannedAt, rows, deletions);
          writeCheckpoint(checkpointPath, cp);
          verdict = { ...compareScan({ checkpoint: cp, rows, deletions, scannedAt }), status: "baseline", checkpointWritten: true };
        } else {
          verdict = compareScan({ checkpoint: read.checkpoint, rows, deletions, scannedAt });
          if (verdict.status === "healthy" || opts.accept) {
            writeCheckpoint(checkpointPath, emptyCheckpoint(scannedAt, rows, deletions));
            verdict.checkpointWritten = true;
          }
        }
      } catch (err) {
        verdict = unknownVerdict(err instanceof Error ? err.message : String(err), scannedAt);
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(verdict)}\n`);
      } else {
        console.log(renderHuman(verdict, checkpointPath));
      }
      // Exit codes: 0 healthy/baseline, 2 alert, 3 unknown.
      process.exit(verdict.status === "alert" ? 2 : verdict.status === "unknown" ? 3 : 0);
    });
}
