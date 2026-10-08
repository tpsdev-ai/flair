/**
 * MemoryMaintenance.ts — Maintenance worker for memory hygiene.
 *
 * POST /MemoryMaintenance — runs cleanup tasks:
 *   1. Delete expired ephemeral memories (expiresAt < now)
 *   2. Archive validTo-expired memories and old session memories (> 30 days, standard durability)
 *   3. Report stats
 *
 * Designed to run periodically (daily cron, scheduler, or REM nightly cycle).
 * Authenticated via Ed25519 (agent acts on own memories) or admin (system-wide).
 *
 * History: prior to slice-2 PR-3, this class used a static-ROUTE pattern
 * (`export default class MemoryMaintenance` with `static ROUTE`/`METHOD`)
 * that Harper 5.x does not auto-register. Both `flair rem light` and the
 * REM nightly runner were returning "Not found" against the endpoint.
 * Migrated to the standard `extends Resource` shape with `allowCreate()`
 * to gate auth correctly.
 */

import { Resource, databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { MEMORY_HOST_SOURCE_TABLE } from "./memory-host-source.js";

/** Maintenance creates an owned transaction for each expiry or archive item;
 *  the Memory and pointer operations join that owned transaction (both tables
 *  in database flair). Failures are NOT swallowed: a throw propagates to the
 *  caller's error path. A missing pointer table is REPORTED (throws), never
 *  silently skipped — cleanup is hygiene, so its failure must be visible. */
async function deletePointerRowOrThrow(memoryId: string, ctx: any): Promise<void> {
  const table = (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
  if (!table?.delete) {
    throw new Error("MemoryHostSource table unavailable");
  }
  await table.delete(memoryId, ctx);
}
import { isAdmin } from "./agent-auth.js";
import { noteMemoryUpsert, noteMemoryDelete } from "./bm25-index-service.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { recordMemoryDeletion } from "./memory-deletion-history.js";
import { txnPausePoint } from "./txn-pause-point.js";

export class MemoryMaintenance extends Resource {
  /** POST requires auth — either an agent acting on its own memories, or admin. */
  allowCreate(): boolean {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    return !!(request?.tpsAgent || request?.tpsAgentIsAdmin);
  }

  async post(data: any) {
    const { dryRun = false, agentId: bodyAgentId } = data || {};

    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (actorId ? await isAdmin(actorId) : false);

    // Scope rules:
    //   - Admin can pass agentId to maintain a specific agent (or omit it
    //     for fleet-wide maintenance).
    //   - Non-admin agents are scoped to their own memories — bodyAgentId
    //     either matches the authenticated agent or is ignored.
    const targetAgent: string | undefined = callerIsAdmin
      ? bodyAgentId
      : actorId;

    if (!targetAgent && !callerIsAdmin) {
      return new Response(JSON.stringify({ error: "agentId required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const now = new Date();
    const stats = { expired: 0, archived: 0, total: 0, errors: 0, orphans: 0, skipped: 0, agent: targetAgent || "all" };

    try {
      for await (const record of (databases as any).flair.Memory.search()) {
        // Skip records not belonging to target agent (unless admin running fleet-wide).
        if (targetAgent && record.agentId !== targetAgent) continue;
        stats.total++;

        // 1. Delete expired ephemeral memories. expiresAt is only a reap
        // signal for the ephemeral tier (docstring + Memory.post() TTL
        // stamp). A non-ephemeral row that acquired one (bug, import, API
        // misuse) must survive — missing / unexpected durability is treated
        // as non-ephemeral so we do not silently reap durable rows.
        if (
          record.durability === "ephemeral" &&
          record.expiresAt &&
          new Date(record.expiresAt) < now
        ) {
          if (!dryRun) {
            try {
              // flair#2275: another writer may open its transaction first and
              // commit a change to this row before OUR transaction opens. This
              // pause (inert unless the fault-injection opt-in is armed) holds
              // the scan-selected row still while that writer runs; the owned
              // transaction below then sees the change and skips.
              const beforeAct = txnPausePoint("maintenance-expiry-pre");
              if (beforeAct) await beforeAct;
              // A1'' item 2 (0c) + flair#2275: the delete runs in a transaction
              // this call OWNS, re-reads the row inside it, and acts only when
              // the row is STILL the one the scan selected. A change is a SKIP
              // (recorded as skipped), never a hard-delete of the changed row.
              let deleted = false;
              await withOwnedTransaction(ctx, async (c) => {
                const stored = await (databases as any).flair.Memory.get(record.id, c);
                if (!isDeepStrictEqual(stored, record)) return;
                // The transaction pauses here, between its read and its act.
                const pause = txnPausePoint("maintenance-expiry");
                if (pause) await pause;
                // Confirmation read: the committed row in an EXPLICIT fresh
                // context (never contextless — a contextless read joins the
                // request transaction and sees its old snapshot).
                const confirmed = await (databases as any).flair.Memory.get(record.id, {});
                if (!isDeepStrictEqual(confirmed, stored)) return;
                const result = await (databases as any).flair.Memory.delete(record.id, c);
                if (result !== true) throw new Error("Memory row delete was not confirmed");
                await deletePointerRowOrThrow(record.id, c);
                await recordMemoryDeletion({
                  memoryId: record.id,
                  memoryInstanceToken: stored.instanceToken ?? null,
                  durability: stored.durability ?? null,
                  actor: actorId ?? null,
                  sourceClass: callerIsAdmin ? "admin" : "agent",
                }, c);
                deleted = true;
              });
              if (!deleted) { stats.skipped++; continue; }
              // flair#1357 — ephemeral expiry removes the row from what the
              // lexical leg may score.
              noteMemoryDelete(record.id);
              stats.expired++;
            } catch (err) {
              stats.errors++;
              console.error("MemoryMaintenance: expiry delete failed (aborted, nothing deleted)", err);
            }
          } else {
            stats.expired++;
          }
          continue;
        }

        // 2. Archive memories whose validity ended, plus old standard session
        // notes (> 30 days) that weren't promoted to persistent. Use one
        // archive path so a row meeting both criteria is counted only once.
        // Soft-archive removes them from search results but keeps the data.
        const validToExpired = record.validTo && new Date(record.validTo) < now;
        const oldSession = record.durability === "standard" &&
          record.type === "session" && record.createdAt &&
          now.getTime() - new Date(record.createdAt).getTime() > 30 * 24 * 3600_000;
        if (!record.archived && (validToExpired || oldSession)) {
          if (!dryRun) {
            try {
              // flair#2275: as for expiry, hold the scan-selected row still so
              // another writer can commit first, then let the owned transaction
              // below see the change and skip.
              const beforeAct = txnPausePoint("maintenance-archive-pre");
              if (beforeAct) await beforeAct;
              // A1'' item 2 (0c) + flair#2275: the write is built from the row
              // read INSIDE the transaction (never from the scan copy), and the
              // action runs only when the row is still the one the scan
              // selected. A change is a SKIP, so a concurrent edit survives.
              let archivedRow: any;
              await withOwnedTransaction(ctx, async (c) => {
                const stored = await (databases as any).flair.Memory.get(record.id, c);
                if (!isDeepStrictEqual(stored, record)) return;
                const pause = txnPausePoint("maintenance-archive");
                if (pause) await pause;
                const confirmed = await (databases as any).flair.Memory.get(record.id, {});
                if (!isDeepStrictEqual(confirmed, stored)) return;
                archivedRow = {
                  ...stored,
                  archived: true,
                  archivedAt: now.toISOString(),
                };
                stripUndeclaredMemoryAttributes(archivedRow);
                // A1'' item 2 (0c): the archive write and its pointer delete
                // share ONE OWNED transaction; a failed pointer delete cannot
                // still commit the archived row.
                await (databases as any).flair.Memory.update(record.id, archivedRow, c);
                await deletePointerRowOrThrow(record.id, c);
              });
              if (!archivedRow) { stats.skipped++; continue; }
              // flair#1357 — an `archived` flip changes what the retrieval
              // conditions (`archived not_equal true`) admit, so the lexical
              // index has to see it, not just content writes.
              noteMemoryUpsert(archivedRow);
              stats.archived++;
            } catch (err) {
              stats.errors++;
              console.error("MemoryMaintenance: archive failed (aborted, nothing archived)", err);
            }
          } else {
            stats.archived++;
          }
        }
      }

      // 3. Orphan sweep: pointer rows whose Memory is MISSING or ARCHIVED. An
      // orphan is unreadable by construction (the only read path joins pointers
      // INTO Memory results), but it should not be left behind either. A
      // failed row read or delete is counted and the sweep continues; the
      // incomplete run is reported below (HTTP 500), never silently ignored.
      const pointerTable = (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
      if (!dryRun && !pointerTable?.search) {
        // Hygiene: a missing sweep table is REPORTED, never silently skipped.
        throw new Error("MemoryHostSource table unavailable (orphan sweep)");
      }
      if (pointerTable?.search && !dryRun) {
        for await (const ptr of pointerTable.search()) {
          const memoryId = ptr?.memoryId;
          if (typeof memoryId !== "string" || memoryId.length === 0) continue;
          try {
            // flair#2275: read the pointed Memory in an EXPLICIT fresh context
            // (never contextless). Is this pointer an orphan — its Memory
            // missing or archived?
            const mem = await (databases as any).flair.Memory.get(memoryId, {});
            if (mem && mem.archived !== true) continue;
            // 0d + flair#2275: a new row reusing this id, or a promotion out of
            // archived, may land before we open the owned transaction. Hold the
            // row still so that writer can commit first, then re-check INSIDE
            // the transaction and act only when the row is STILL the one the
            // selection read saw; otherwise SKIP (the pointer stands).
            const beforeAct = txnPausePoint("maintenance-orphan-pre");
            if (beforeAct) await beforeAct;
            //
            // Round 22: one orphan's failure must abort only THAT orphan, not
            // the whole sweep — catch it, count stats.errors, and continue (the
            // item loops above already work this way). stats.orphans counts a
            // row only AFTER its owned transaction COMMITS (the count moves out
            // of the callback). Pinned by test/unit/memory-host-source.test.ts
            // (r22-orphan-continues) — RED if the try/catch is removed.
            let committed = false;
            let skipped = false;
            await withOwnedTransaction(ctx, async (c) => {
              const again = await (databases as any).flair.Memory.get(memoryId, c);
              if (!isDeepStrictEqual(again, mem)) { skipped = true; return; }
              const pause = txnPausePoint("maintenance-orphan");
              if (pause) await pause;
              const confirmed = await (databases as any).flair.Memory.get(memoryId, {});
              if (!isDeepStrictEqual(confirmed, again)) { skipped = true; return; }
              await deletePointerRowOrThrow(memoryId, c);
              committed = true;
            });
            if (committed) stats.orphans++;
            else if (skipped) stats.skipped++;
          } catch (err) {
            stats.errors++;
            console.error("MemoryMaintenance: orphan sweep failed (continuing)", err);
          }
        }
      }
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message, stats }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    // A1-iv item 4 (cleanup is hygiene): if any item's cleanup FAILED, the run
    // is NOT complete — report a failure naming the counts, never a
    // "Maintenance complete" success. The work already committed stands; the
    // response is about the run's honesty.
    if (stats.errors > 0) {
      return new Response(
        JSON.stringify({
          error: "maintenance_incomplete",
          message: `${stats.errors} cleanup error(s); see counts`,
          stats, expired: stats.expired, archived: stats.archived, total: stats.total,
          errors: stats.errors, orphans: stats.orphans, skipped: stats.skipped,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    // Flatten the historical { stats } wrapper into the top level so callers
    // can read `.expired` / `.archived` directly. The wrapper shape is kept
    // for backward compatibility with `flair rem light`.
    return {
      message: dryRun ? "Dry run complete" : "Maintenance complete",
      stats,
      expired: stats.expired,
      archived: stats.archived,
      total: stats.total,
      errors: stats.errors,
      orphans: stats.orphans,
      skipped: stats.skipped,
    };
  }
}
