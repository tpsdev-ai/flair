/**
 * MemoryReindex.ts — One-shot migration: heal Harper secondary indices on Memory.
 *
 * POST /MemoryReindex — admin-only.
 *
 * Body:
 *   { dryRun?: boolean, agentId?: string, batchSize?: number }
 *
 * Behaviour:
 *   Scans the Memory primary store (unfiltered, via the base table class) and
 *   compares per-agent primary counts against per-agent secondary-index counts
 *   (an equals lookup on agentId). Any agent whose secondary count is below
 *   its primary count has unindexed records. Re-PUT every record with the row
 *   built by buildReindexRow (the path Memory.put()'s _reindex branch also
 *   uses): it retains declared and named allowed fields, restores stored
 *   provenance and preserves an existing incarnation token (or generates an
 *   absent one). Other undeclared fields are stripped.
 *   No updatedAt bump, embedding regeneration or safety rescan is performed.
 *
 * Why this exists: Harper's background runIndexing() pass populates secondary
 * indices only on schema changes that add a new indexed attribute. If that
 * pass is interrupted, or if a schema version change doesn't re-register an
 * existing index, older records live in the primary store but never make it
 * into the secondary index. Scoped search() via RequestTarget.conditions —
 * which uses the agentId index — then returns empty for those agents.
 */

import { Resource, databases } from "harper";
import { isAdmin, allowAdmin } from "./agent-auth.js";
import { WriteBackConflictError, writeBackCommittedRow, writeBackIdentity } from "./write-back.js";

/** The re-PUT's row is confirmed as staged, but a fresh agentId-index read
 *  does not list it: the row values are confirmed, the index is not. */
class ReindexIndexUnconfirmed extends Error {
  readonly outcome = "unconfirmed" as const;
  constructor(id: string) {
    super(`MemoryReindex: row ${id} is stored as staged, but the agentId index does not list it (index unconfirmed)`);
    this.name = "ReindexIndexUnconfirmed";
  }
}
import { txnPausePoint } from "./txn-pause-point.js";
import { buildReindexRow } from "./Memory.js";

type AgentDrift = { agentId: string; primary: number; indexed: number; missing: number };

type ReindexStats = {
  scanned: number;
  agentsWithDrift: number;
  totalMissing: number;
  reindexed: number;
  errors: number;
  dryRun: boolean;
  agentFilter: string | null;
  drift: AgentDrift[];
  errorSamples: Array<{ id: string; message: string; outcome?: WriteBackConflictError["outcome"] }>;
};

export class MemoryReindex extends Resource {
  // Admin-only: permit verified ADMIN agents (Basic-admin is super_user and
  // bypasses allow*); non-admin agents denied. Mirrors the handler's admin gate
  // but is the real authorization now that the gate no longer elevates agents.
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx ?? (this as any).request;
    const authAgent: string | undefined = request?.tpsAgent;
    const basicAgent = request?.headers?.get?.("x-tps-agent");
    const isBasicAdmin = basicAgent === "admin";
    const isEd25519Admin = Boolean(authAgent) && request?.tpsAgentIsAdmin === true;

    if (!isBasicAdmin && !(isEd25519Admin && (await isAdmin(authAgent!)))) {
      return new Response(
        JSON.stringify({ error: "forbidden: admin required" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const dryRun = data?.dryRun === true;
    const agentFilter: string | null = typeof data?.agentId === "string" ? data.agentId : null;
    const batchSize = Math.max(1, Math.min(Number(data?.batchSize) || 100, 1000));

    const Memory = (databases as any).flair.Memory;
    const stats: ReindexStats = {
      scanned: 0,
      agentsWithDrift: 0,
      totalMissing: 0,
      reindexed: 0,
      errors: 0,
      dryRun,
      agentFilter,
      drift: [],
      errorSamples: [],
    };

    // Pass 1: primary-store scan. Count records per agent.
    const primaryByAgent = new Map<string, number>();
    const recordsToReindex: string[] = [];
    const selectedRows = new Map<string, any>();
    for await (const record of Memory.search()) {
      if (agentFilter && record.agentId !== agentFilter) continue;
      if (!record.id || !record.agentId) continue;
      primaryByAgent.set(record.agentId, (primaryByAgent.get(record.agentId) ?? 0) + 1);
      recordsToReindex.push(record.id);
      // Only the identity fields the write-back compares (never the
      // embedding): the full row is re-read inside each owned write.
      selectedRows.set(record.id, writeBackIdentity(record));
    }
    stats.scanned = recordsToReindex.length;

    // Pass 2: for each agent, probe the secondary index via an agentId-only equals
    // lookup. Harper's query planner can't reorder a single condition, so this
    // actually hits Table.indices.agentId. Drift = primary - indexed.
    for (const [agentId, primary] of primaryByAgent) {
      let indexed = 0;
      try {
        for await (const _ of Memory.search({
          conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }],
        })) {
          indexed++;
        }
      } catch (err: any) {
        stats.errors++;
        if (stats.errorSamples.length < 5) {
          stats.errorSamples.push({ id: agentId, message: err?.message ?? String(err) });
        }
        continue;
      }
      const missing = primary - indexed;
      if (missing > 0) {
        stats.agentsWithDrift++;
        stats.totalMissing += missing;
        stats.drift.push({ agentId, primary, indexed, missing });
      }
    }
    stats.drift.sort((a, b) => b.missing - a.missing);

    if (dryRun) {
      return {
        message: `dry run: ${stats.totalMissing} record${stats.totalMissing === 1 ? "" : "s"} missing from agentId index across ${stats.agentsWithDrift} agent${stats.agentsWithDrift === 1 ? "" : "s"}. Reindex will re-PUT all ${stats.scanned} records to heal.`,
        stats,
      };
    }

    // Pass 3: re-PUT every primary-store record through buildReindexRow, retaining
    // declared/named fields and stored provenance, stripping other undeclared
    // fields and generating an absent token. Variants that only re-PUT records
    // that appear missing would miss rows the primary scan sees fine but that
    // Harper's read path can't locate via any index path.
    for (let i = 0; i < recordsToReindex.length; i += batchSize) {
      const chunk = recordsToReindex.slice(i, i + batchSize);
      for (const id of chunk) {
        try {
          let commitPauses = 0;
          const outcome = await writeBackCommittedRow(
            Memory,
            id,
            (record: any) => {
              if (!record) return { skip: true };
              // Built by the function Memory.put()'s `_reindex` branch uses,
              // from this transaction's read.
              const built = buildReindexRow({ ...record, _reindex: true }, record);
              if (!("row" in built)) throw new Error(`${built.error}: ${built.message}`);
              return { idempotent: true, write: built.row };
            },
            {
              ctx, label: "MemoryReindex", expectedRow: selectedRows.get(id),
              pausePre: () => txnPausePoint("reindex-put-pre"),
              pausePoint: () => txnPausePoint("reindex-put"),
              pauseBeforeCommit: () => {
                switch (commitPauses++) {
                  case 0: return txnPausePoint("reindex-put-commit");
                  case 1: return txnPausePoint("reindex-put-commit-retry");
                  default: return txnPausePoint("reindex-put-commit-retry-retry");
                }
              },
            },
          );
          if ("skip" in outcome) { stats.errors++; continue; }
          if (!("write" in outcome)) throw new Error("MemoryReindex: expected a full-row plan");
          let indexed = false;
          for await (const row of Memory.search({
            conditions: [{ attribute: "agentId", comparator: "equals", value: outcome.write.agentId }],
          }, {})) {
            if (String(row.id) === id) { indexed = true; break; }
          }
          if (!indexed) throw new ReindexIndexUnconfirmed(id);
          stats.reindexed++;
        } catch (err: any) {
          stats.errors++;
          if (stats.errorSamples.length < 5) {
            stats.errorSamples.push({ id, message: err?.message ?? String(err), ...(err instanceof WriteBackConflictError || err instanceof ReindexIndexUnconfirmed ? { outcome: err.outcome } : {}) });
          }
        }
      }
    }

    return {
      message: `reindex complete: ${stats.reindexed} re-indexed, ${stats.errors} errors, ${stats.totalMissing} pre-existing index gap${stats.totalMissing === 1 ? "" : "s"}`,
      stats,
    };
  }
}
