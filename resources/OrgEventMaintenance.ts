/**
 * OrgEventMaintenance.ts — Maintenance worker for expired OrgEvents.
 *
 * POST /OrgEventMaintenance/ — attempts expired ordinary deletions.
 * Counts staged deletes with confirmed committed absence as `deleted`;
 * reports skipped selections as `skipped` and thrown errors as `failed`.
 * Auth: admin only.
 */

import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { isReservedEventRecord } from "./org-event-reserved.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { sameStoredRow, writeBackIdentity } from "./write-back.js";

export class OrgEventMaintenance extends Resource {
  // Admin-only: permit verified ADMIN agents (Basic-admin is super_user and
  // bypasses allow*); non-admin agents denied. Real authorization now that the
  // gate no longer elevates agents to admin.
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(_data: any) {
    // Admin-only — the same predicate allowCreate uses. Harper passes the
    // request target, not the auth context, as post()'s second argument, so
    // the authorization context is this.getContext().
    if (!(await allowAdmin((this as any).getContext?.()))) {
      return new Response(
        JSON.stringify({ error: "forbidden: admin only" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const now = new Date().toISOString();
    const table = (databases as any).flair.OrgEvent;
    const toDelete: Record<string, any>[] = [];

    for await (const event of table.search()) {
      // Reserved rows are excluded here and at the transactional re-read.
      if (isReservedEventRecord(event)) continue;
      if (event.expiresAt && event.expiresAt < now) {
        toDelete.push(writeBackIdentity(event));
      }
    }

    const selected = txnPausePoint("org-event-expiry-pre");
    if (selected) await selected;
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    for (const basis of toDelete) {
      const id = String(basis.id);
      try {
        const staged = await withOwnedTransaction((this as any).getContext?.(), async (c) => {
          const row = await table.get(id, c);
          if (!row || !sameStoredRow(row, basis) || isReservedEventRecord(row) ||
              !row.expiresAt || row.expiresAt >= now) return false;
          const pause = txnPausePoint("org-event-expiry-read");
          if (pause) await pause;
          await table.delete(id, c);
          const commit = txnPausePoint("org-event-expiry-commit");
          if (commit) await commit;
          return true;
        });
        if (staged && !await table.get(id, {})) deleted++;
        else skipped++;
      } catch {
        failed++;
      }
    }

    return { deleted, skipped, failed };
  }
}
