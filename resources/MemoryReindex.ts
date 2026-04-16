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
 *   its primary count has unindexed records. Re-PUT every record with the
 *   _reindex escape hatch so Memory.put() preserves every field byte-for-byte
 *   (no updatedAt bump, no embedding regen, no safety rescan).
 *
 * Why this exists: Harper's background runIndexing() pass populates secondary
 * indices only on schema changes that add a new indexed attribute. If that
 * pass is interrupted, or if a schema version change doesn't re-register an
 * existing index, older records live in the primary store but never make it
 * into the secondary index. Scoped search() via RequestTarget.conditions —
 * which uses the agentId index — then returns empty for those agents.
 *
 * This endpoint is idempotent: running it again finds zero drift.
 */

import { Resource, databases } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";

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
  errorSamples: Array<{ id: string; message: string }>;
};

export class MemoryReindex extends Resource {
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
    for await (const record of Memory.search()) {
      if (agentFilter && record.agentId !== agentFilter) continue;
      if (!record.id || !record.agentId) continue;
      primaryByAgent.set(record.agentId, (primaryByAgent.get(record.agentId) ?? 0) + 1);
      recordsToReindex.push(record.id);
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

    // Pass 3: re-PUT every primary-store record with _reindex=true so Memory.put()
    // preserves every field byte-for-byte. The re-PUT forces Harper to re-insert
    // into all secondary indices. Cheaper-than-sound variants (only re-PUT records
    // that appear missing) would miss rows the primary scan sees fine but that
    // Harper's read path can't locate via any index path.
    for (let i = 0; i < recordsToReindex.length; i += batchSize) {
      const chunk = recordsToReindex.slice(i, i + batchSize);
      for (const id of chunk) {
        try {
          const record = await Memory.get(id);
          if (!record) { stats.errors++; continue; }
          await Memory.put({ ...record, _reindex: true });
          stats.reindexed++;
        } catch (err: any) {
          stats.errors++;
          if (stats.errorSamples.length < 5) {
            stats.errorSamples.push({ id, message: err?.message ?? String(err) });
          }
        }
      }
    }

    return {
      message: `reindex complete: ${stats.reindexed} re-indexed, ${stats.errors} errors, ${stats.totalMissing} pre-existing index gap${stats.totalMissing === 1 ? "" : "s"} healed`,
      stats,
    };
  }
}
