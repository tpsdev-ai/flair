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
import { annotatedCallerIsAdmin } from "./agent-auth.js";
import { noteMemoryUpsert, noteMemoryDelete } from "./bm25-index-service.js";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { recordMemoryDeletion } from "./memory-deletion-history.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { withMemoryWriteLockOnce } from "./memory-write-lock.js";
import { verifyCommittedFields } from "./write-back.js";
import { AGENT_ID_RULE, isValidAgentId } from "../src/lib/agent-id-rule.js";

/** The 400 an admin run's refused `agentId` is answered with. */
const INVALID_AGENT_ID_ERROR = `agentId must be a string matching ${AGENT_ID_RULE}`;

/** The `remedy` the same 400 carries: what an operator can do today for a
 *  legacy stored id outside the rule. An admin-scoped run needs a conforming
 *  id. The agent's own authenticated run reaches its rows only when the stored
 *  id can authenticate: the signed TPS-Ed25519 header cannot carry a colon or
 *  whitespace. For an id the header cannot represent, a fleet-wide run reaches
 *  its rows and also acts on other agents' eligible rows. */
const INVALID_AGENT_ID_REMEDY =
  "for a legacy stored agent id outside this rule, run that agent's own authenticated non-admin " +
  "maintenance (POST /MemoryMaintenance with that agent's credential), which reaches its rows, when the " +
  "stored id can authenticate: the signed TPS-Ed25519 header cannot carry a colon or whitespace. For an " +
  "id the header cannot represent, omit agentId to run fleet-wide, which reaches that agent's rows and " +
  "also expires and archives other agents' eligible rows. A run scoped to an admin agentId needs an id " +
  "that matches the rule.";

/** The per-id Memory write lock store (flair#2478 slice 3b). */
function memoryLockStore(): unknown {
  return (databases as any)?.flair?.Memory?.primaryStore;
}

/** Report a per-row action this run did not apply, and why. An automatic
 *  writer's lock miss is a skip that is reported, never a row written
 *  unserialized over an owner's write. */
function noteSkipped(stats: { skipped: number }, id: unknown, reason: string): void {
  stats.skipped++;
  console.warn("[MemoryMaintenance] row skipped: %s (id %s)", reason, String(id));
}

/** What a request's `agentId` says about the run's target, for an ADMIN
 *  request: it is a named target only when the field is a string that is
 *  non-blank when trimmed, equal to its trimmed form, and accepted by Flair's
 *  shared agent-id rule (src/lib/agent-id-rule.ts); it is absent only when
 *  the body has no own `agentId` property and reading it yields `undefined`;
 *  every other present value (a present `undefined`, `null`, non-string or
 *  blank value included) is refused (400). A non-admin run ignores the field
 *  and targets the authenticated caller. */
type RequestedAgent =
  | { kind: "absent" }
  | { kind: "named"; agentId: string }
  | { kind: "invalid" };

/** This parser accepts only a non-blank string that equals its trimmed form;
 *  any other value names no target. */
function parseAgentIdValue(value: unknown): Exclude<RequestedAgent, { kind: "absent" }> {
  if (typeof value !== "string" || value.trim().length === 0) return { kind: "invalid" };
  if (value !== value.trim()) return { kind: "invalid" };
  return { kind: "named", agentId: value };
}

/** Classify a request body's `agentId`. Presence is decided on the body itself,
 *  before its value is parsed: the field is absent only when the body has no own
 *  `agentId` property and reading `agentId` yields `undefined`. A present field
 *  is parsed by value, so a supplied `undefined`, `null`, non-string, empty or
 *  blank value is invalid rather than read as absent. A value parseAgentIdValue
 *  accepts is then held to the shared agent-id rule. */
function parseRequestedAgent(body: unknown): RequestedAgent {
  const present = body != null && Object.prototype.hasOwnProperty.call(body, "agentId");
  const value = body == null ? undefined : (body as any).agentId;
  if (!present && value === undefined) return { kind: "absent" };
  const parsed = parseAgentIdValue(value);
  if (parsed.kind === "named" && !isValidAgentId(parsed.agentId)) return { kind: "invalid" };
  return parsed;
}

export class MemoryMaintenance extends Resource {
  /** POST requires auth — either an agent acting on its own memories, or admin. */
  allowCreate(): boolean {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    return !!(request?.tpsAgent || request?.tpsAgentIsAdmin);
  }

  async post(data: any) {
    const body = data || {};
    const { dryRun = false } = body;

    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (await annotatedCallerIsAdmin(request));

    // Scope rules:
    //   - Admin can pass agentId to maintain a specific agent (or omit the
    //     field for fleet-wide maintenance). An admin request whose body has
    //     the field with a value that is not a string the shared agent-id rule
    //     accepts — `undefined` included — is refused, dry run or not.
    //   - Non-admin agents are scoped to their own memories — a body agentId
    //     either matches the authenticated agent or is ignored.
    const requestedAgent = parseRequestedAgent(body);
    if (callerIsAdmin && requestedAgent.kind === "invalid") {
      return new Response(JSON.stringify({ error: INVALID_AGENT_ID_ERROR, remedy: INVALID_AGENT_ID_REMEDY }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const targetAgent: string | undefined = callerIsAdmin
      ? (requestedAgent.kind === "named" ? requestedAgent.agentId : undefined)
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
      // A scoped run supplies the target agent as an indexed agentId condition
      // (agentId is @indexed in schemas/memory.graphql), rather than scanning
      // the whole table and filtering in process. The per-row check below still
      // decides every row. No target means fleet-wide admin maintenance, which
      // scans every row.
      const memorySearch = targetAgent
        ? (databases as any).flair.Memory.search({ conditions: [{ attribute: "agentId", comparator: "equals", value: targetAgent }] })
        : (databases as any).flair.Memory.search();
      for await (const record of memorySearch) {
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
              // the row is STILL the one the scan selected. A change seen by that
              // re-read or the confirmation read below is a SKIP (recorded as
              // skipped); a change committed between the confirmation read and
              // the commit is not checked.
              // flair#2478 slice 3b: the whole read-decide-write runs under the
              // id's per-id Memory write lock, taken once with no wait. A held
              // id (or one carrying an outcome-unknown marker) is skipped and
              // reported, never deleted over an owner's write.
              const outcome = await withMemoryWriteLockOnce(memoryLockStore(), [record.id], async () => {
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
                  // Test-only: the delete is staged and the lock is still held.
                  const staged = txnPausePoint("maintenance-expiry-staged");
                  if (staged) await staged;
                  // Test-only: the last confirmation has passed and the
                  // transaction has not committed yet.
                  const commitPoint = txnPausePoint("maintenance-expiry-commit");
                  if (commitPoint) await commitPoint;
                  deleted = true;
                });
                if (!deleted) return { kind: "skipped" as const };
                // Test-only: the delete committed and the lock is still held.
                const committed = txnPausePoint("maintenance-expiry-committed");
                if (committed) await committed;
                return { kind: "deleted" as const };
              }, { phase: "maintenance-expiry" });
              if (outcome.kind !== "done") {
                noteSkipped(stats, record.id, outcome.kind);
                continue;
              }
              if (outcome.value.kind !== "deleted") { stats.skipped++; continue; }
              // The committed row must be gone: a delete whose commit did not
              // land is not counted as expired. An unreadable read is reported
              // as a failed item, never as a success.
              let after: any;
              try {
                after = await (databases as any).flair.Memory.get(record.id, {});
              } catch (err) {
                stats.errors++;
                console.error("MemoryMaintenance: expiry outcome unconfirmed (committed row unreadable)", err);
                continue;
              }
              if (after != null) {
                noteSkipped(stats, record.id, "unconfirmed_delete");
                continue;
              }
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
              // selected. A change seen by that read or the confirmation read is
              // a SKIP; a change committed between the confirmation read and the
              // commit is not checked.
              // flair#2478 slice 3b: the whole read-decide-write runs under the
              // id's per-id Memory write lock, taken once with no wait. A held
              // id (or one carrying an outcome-unknown marker) is skipped and
              // reported, never archived over an owner's write.
              let archivedRow: any;
              let archiveBasis: any;
              let archivePatch: Record<string, unknown> | undefined;
              const outcome = await withMemoryWriteLockOnce(memoryLockStore(), [record.id], async () => {
                await withOwnedTransaction(ctx, async (c) => {
                  const stored = await (databases as any).flair.Memory.get(record.id, c);
                  if (!isDeepStrictEqual(stored, record)) return;
                  const pause = txnPausePoint("maintenance-archive");
                  if (pause) await pause;
                  const confirmed = await (databases as any).flair.Memory.get(record.id, {});
                  if (!isDeepStrictEqual(confirmed, stored)) return;
                  // flair#2470: the archive flip is written as an INCREMENTAL update of
                  // exactly `archived` and
                  // `archivedAt` — never a full-row put of the row read above. A
                  // full-row write would carry every field the read saw and could
                  // revert an owner PUT that started earlier and commits after this
                  // one (Harper orders the two by transaction timestamp) while that
                  // PUT still answered 200. The merged row marks a non-skipped
                  // operation and supplies the lexical-index note below.
                  archivePatch = { archived: true, archivedAt: now.toISOString() };
                  archivedRow = { ...stored, ...archivePatch };
                  stripUndeclaredMemoryAttributes(archivedRow);
                  // A1'' item 2 (0c): the archive write and its pointer delete
                  // share ONE OWNED transaction; a failed pointer delete cannot
                  // still commit the archived row.
                  await (databases as any).flair.Memory.update(record.id, archivePatch, c);
                  await deletePointerRowOrThrow(record.id, c);
                  archiveBasis = stored;
                  // Test-only: the update and its pointer delete are staged and
                  // the lock is still held.
                  const staged = txnPausePoint("maintenance-archive-staged");
                  if (staged) await staged;
                  // Test-only: the last confirmation has passed and the
                  // transaction has not committed yet.
                  const commitPoint = txnPausePoint("maintenance-archive-commit");
                  if (commitPoint) await commitPoint;
                });
                if (!archivedRow) return { kind: "skipped" as const };
                // Test-only: the archive committed and the lock is still held.
                const committed = txnPausePoint("maintenance-archive-committed");
                if (committed) await committed;
                return { kind: "archived" as const };
              }, { phase: "maintenance-archive" });
              if (outcome.kind !== "done") {
                noteSkipped(stats, record.id, outcome.kind);
                continue;
              }
              if (outcome.value.kind !== "archived") { stats.skipped++; continue; }
              // The committed row must still show the staged archive fields. On
              // a mismatch the row read now does not show this run's write, so
              // the archive is unconfirmed; it is reported as skipped. An
              // unreadable read is reported as a failed item.
              const verdict = await verifyCommittedFields(
                (databases as any).flair.Memory,
                record.id,
                archiveBasis,
                archivePatch ?? {},
              );
              if (verdict === "unreadable") {
                stats.errors++;
                console.error("MemoryMaintenance: archive outcome unconfirmed (committed row unreadable)");
                continue;
              }
              if (verdict === "mismatch") {
                noteSkipped(stats, record.id, "unconfirmed_archive");
                continue;
              }
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
      // A dry run skips the sweep entirely and reports no orphans.
      const pointerTable = (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
      if (!dryRun && !pointerTable?.search) {
        // Hygiene: a missing sweep table is REPORTED, never silently skipped.
        throw new Error("MemoryHostSource table unavailable (orphan sweep)");
      }
      if (pointerTable?.search && !dryRun) {
        // Scope the sweep by the same rule as the Memory loop above: a run
        // that names an agent searches the pointer table by its indexed
        // `authorId`, so that agent's rows are the rows supplied; a fleet-wide
        // run scans every row. The in-process check applies the same rule to
        // each row before the pointed Memory read and every later per-row effect
        // (count, error, delete). A pointer's owner is the `authorId` the write
        // path stamped on the row; a pointer with an empty author has no owner
        // and is outside an owner-targeted run.
        // How a pointer replaced after this selection is handled, and the bound
        // on that, is stated at the owned transaction below.
        const pointerInScope = (pointer: any): boolean => {
          if (!targetAgent) return true;
          const author = parseAgentIdValue(pointer?.authorId);
          return author.kind === "named" && author.agentId === targetAgent;
        };
        // A scoped run's pointer search reads only the target agent's rows:
        // authorId is @indexed in schemas/memory.graphql, so the search is an
        // indexed condition rather than a table-wide scan filtered in process.
        // No target means fleet-wide admin maintenance, which scans every row.
        const pointerSearch = targetAgent
          ? pointerTable.search({ conditions: [{ attribute: "authorId", comparator: "equals", value: targetAgent }] })
          : pointerTable.search();
        for await (const ptr of pointerSearch) {
          if (!pointerInScope(ptr)) continue;
          const memoryId = ptr?.memoryId;
          if (typeof memoryId !== "string" || memoryId.length === 0) continue;
          try {
            // flair#2275: read the pointed Memory in an EXPLICIT fresh context
            // (never contextless). Is this pointer an orphan — its Memory
            // missing or archived?
            const mem = await (databases as any).flair.Memory.get(memoryId, {});
            if (mem && mem.archived !== true) continue;
            // 0d + flair#2275: a new row reusing this id, a promotion out of
            // archived, or a replaced pointer may land before we open the owned
            // transaction. Hold the row still so that writer can commit first,
            // then re-check the Memory row AND the pointer row inside the
            // transaction and at the confirmation read, and act only when both
            // are STILL the ones the selection read saw; otherwise SKIP.
            const beforeAct = txnPausePoint("maintenance-orphan-pre");
            if (beforeAct) await beforeAct;
            //
            // Round 22: one orphan's failure must abort only THAT orphan, not
            // the whole sweep — catch it, count stats.errors, and continue (the
            // item loops above already work this way). Pinned by
            // test/unit-isolated/memory-host-source.test.ts (r22-orphan-continues) — RED
            // if the try/catch is removed.
            //
            // The candidate re-reads and the staged delete run in ONE owned
            // transaction (`c`); the confirmation reads run inside its callback
            // but through fresh contexts, so they see committed state. Harper
            // has no compare-and-delete on a row's contents:
            // the delete carries no condition on the pointer row it removes.
            // Harper stamps the transaction's writes with one time,
            // taken at its first read (the in-transaction Memory re-read below,
            // before the confirmation reads), and applies a row's writes in the
            // order of those times:
            //   - a replacement committed before the confirmation read is SEEN
            //     by it, and the pointer is skipped;
            //   - a replacement whose own transaction takes its time after this
            //     transaction's first read carries a later time, so Harper
            //     applies it after this delete and it stays stored
            //     (test/integration/memory-maintenance-owner-scope-2084.test.ts
            //     commits one at the `maintenance-orphan-commit` pause).
            // Not covered: a write whose own transaction took its time before
            // this transaction's first read and commits after the confirmation
            // read. There is no compare-and-set; per-id serialization is
            // tracked in flair#2478.
            //
            // Harper can skip a staged delete at commit (a newer write wins), so
            // stats.orphans counts a pointer only when a read AFTER the commit
            // finds no row for its memoryId; a row found there is counted as
            // skipped, never as removed.
            let committed = false;
            let skipped = false;
            await withOwnedTransaction(ctx, async (c) => {
              const again = await (databases as any).flair.Memory.get(memoryId, c);
              if (!isDeepStrictEqual(again, mem)) { skipped = true; return; }
              const ptrAgain = await pointerTable.get(memoryId, c);
              if (!isDeepStrictEqual(ptrAgain, ptr)) { skipped = true; return; }
              const pause = txnPausePoint("maintenance-orphan");
              if (pause) await pause;
              const confirmed = await (databases as any).flair.Memory.get(memoryId, {});
              if (!isDeepStrictEqual(confirmed, again)) { skipped = true; return; }
              const ptrConfirmed = await pointerTable.get(memoryId, {});
              if (!isDeepStrictEqual(ptrConfirmed, ptrAgain)) { skipped = true; return; }
              await deletePointerRowOrThrow(memoryId, c);
              // Held after the final confirmation and the staged delete, before
              // the commit, so a replacement can commit in that window.
              const beforeCommit = txnPausePoint("maintenance-orphan-commit");
              if (beforeCommit) await beforeCommit;
              committed = true;
            });
            if (committed) {
              const afterCommit = await pointerTable.get(memoryId, {});
              if (afterCommit == null) stats.orphans++;
              else stats.skipped++;
            } else if (skipped) stats.skipped++;
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
