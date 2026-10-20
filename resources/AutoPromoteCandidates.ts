import { memoryPrimaryStore, stampMemoryPromotionIsolated, type PromotedRowIdentity } from "./promotion-stamp.js";
import { promotionBindingMatches } from "./promotion-binding.js";
import { withMemoryWriteLockOnce } from "./memory-write-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
/**
 * POST /AutoPromoteCandidates  (#1205b-2 — the UNATTENDED promotion path)
 *
 * Sweeps this agent's PENDING, ADK-sourced (scopeTag-bearing) MemoryCandidates
 * and auto-promotes each eligible one to the agent's OWN persistent Memory — no
 * human reviewer, replacing `flair rem promote` for this one narrow path. Wired
 * into the nightly runner (src/rem/runner.ts) as a post-distillation step.
 *
 * This is the SERVER-SIDE trust-tier enforcement cli.ts noted as deferred. The
 * whole reason it is a resource and not a CLI flag is Sherlock's req 1: the
 * "never Soul" invariant must live where a compromised agent key cannot flip it.
 *
 *   Req 1 — memory-only, enforced HERE, structurally. There is NO soul code
 *     path in this resource: the only write it can perform is a Memory write.
 *     Soul is agentId-scoped and cannot carry a per-user `adk:<app>:<user>` tag,
 *     so an ADK-sourced → Soul promotion is cross-user BY CONSTRUCTION. On top
 *     of the structural absence, an explicit `target` in the request body that
 *     is anything other than "memory" is REFUSED loudly (400) rather than
 *     silently ignored — so a caller trying to flip the target gets a hard no.
 *   Req 2 — fail-closed tag lineage: decideAutoPromote (auto-promote-lib.ts)
 *     refuses any candidate without an authoritative `adk:` stamped scopeTag,
 *     and the promoted Memory carries that scopeTag as its first tag.
 *   Req 3 — content-safety: decideAutoPromote scans the claim strict (always
 *     refuses a flag, independent of FLAIR_CONTENT_SAFETY), and the Memory.put()
 *     override below scans again on the write (defense-in-depth).
 *   Req 4 — machine reviewerId: the promoted Memory's `promotedBy` and the
 *     candidate row's `reviewerId` both record machine:adk-auto-promote.
 *
 * Request:
 *   agentId  string?  — whose candidates to sweep. A non-admin caller may only
 *                       sweep its OWN (resolveReflectActor); admin may name any.
 *   limit    number?  — per-call cap (default DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE)
 *                       on the candidates the sweep attempts a Memory write for
 *                       or takes a recorded row for (see the cost ceiling below).
 *   target   string?  — MUST be absent or "memory". Any other value is refused
 *                       (the hard-lock made explicit + testable).
 *
 * Response:
 *   { agentId, promoted: string[], skipped: {id, reason}[],
 *     incomplete: {memoryId, candidateId, error}[],
 *     unconfirmed: {memoryId, candidateId, error, readBack}[], count, considered }
 *
 *   `promoted` lists the Memory id of every candidate whose promoted update
 *   this call wrote without a throw, or that the confirming read below found
 *   promoted on this row; `count` is its length. flair#2714: when the
 *   candidate update throws after the Memory row was written and stamped, the
 *   throw does not say whether the update committed, so a fresh read of the
 *   candidate decides the report. That read establishes only the candidate's
 *   state now, not which write produced it: read back `pending` → listed under
 *   `incomplete`; read back `promoted` with this row and reviewer → listed
 *   under `promoted`; any other state, or a read that fails → listed under
 *   `unconfirmed` (the promotion on this row was not confirmed) with what the
 *   read found (`readBack`). Neither `incomplete` nor `unconfirmed` counts
 *   toward `count`. A later sweep can adopt the recorded row of a candidate
 *   still pending (findRecordedPromotedRow below), only when the row identity
 *   is recorded on the candidate and the row still passes its checks.
 *
 * Thin orchestrator over the pure, tested policy in ./auto-promote-lib.ts.
 */

import { randomUUID } from "node:crypto";
import { Resource, databases, logger } from "harper";
import { annotatedCallerIsAdmin, allowVerified } from "./agent-auth.js";
import { resolveReflectActor } from "./memory-reflect-lib.js";
import { agentContext } from "./in-process.js";
import {
  decideAutoPromote,
  buildAutoPromotedTags,
  decidePromotedVisibility,
  DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE,
} from "./auto-promote-lib.js";

/**
 * flair#2645 — the Memory row an earlier sweep recorded on this candidate, when
 * it passes the checks below. A retry uses that row instead of writing a
 * second promoted row (an unstamped row is stamped; flair#2714: a row with
 * this sweep's approval is adopted): Memory's dedup gate only reports a
 * near-duplicate and always proceeds with the write.
 *
 * The row is addressed by the id and incarnation token recorded on the
 * candidate, not by an owner, tag or content match: those fields are not proof
 * that the sweep wrote the row. The row is used only when its `id` and
 * `instanceToken` equal the recorded ones, its `agentId` is the sweeping
 * agent, `archived` is not true, `content` equals the candidate's claim,
 * `visibility` and `durability` equal the values this sweep writes, and `tags`
 * include every tag this sweep writes. No other field is compared, and an
 * ordinary same-id Memory write keeps the row's incarnation token (Memory.ts
 * stampInstanceToken), so a match identifies the incarnation, not an unedited
 * row. A row that fails any check at the sweep's first read falls through to
 * a fresh write attempt; an adoptable row that fails the re-check under the
 * Memory lock leaves the candidate pending (`recorded_row_changed`).
 *
 * Its verdict then decides how it is used:
 *   - `promotionStatus` unset → "unstamped": the sweep stamps it. The stamp
 *     re-checks the same fields, `archived` included, at its first read under
 *     the per-id Memory lock (promotion-stamp.ts isWrittenRow); a row that no
 *     longer passes is refused with nothing stamped and the candidate stays
 *     pending.
 *   - flair#2714: `promotionStatus` "approved", `promotedBy` this sweep's
 *     reviewer, a `promotionContentHash` that matches the row's content
 *     (promotionBindingMatches) and a nonempty `promotedAt` → "adoptable": an
 *     earlier sweep wrote and stamped this row and the candidate is still
 *     pending (for example, its candidate update threw before committing, or
 *     a stamp reported unconfirmed had in fact landed). The sweep adopts the
 *     row as written: no Memory write, no stamp, only the candidate update,
 *     which records the row's `promotedAt` as `decidedAt`. Through Flair's
 *     resource write paths the verdict fields are server-written (no REST
 *     Memory write can set them, an administrator's included, and a
 *     content-changing write clears them), so a verdict with this reviewer on
 *     the recorded incarnation, written through those paths, came from an
 *     auto-promote stamp. That is enforced by AUTHORITY_FIELDS.Memory in
 *     resources/authority-field-guard.ts, pinned by
 *     test/integration/memory-authority-fields.test.ts.
 *     The admin operations API writes rows directly and can set any
 *     field; this check does not defend against it. The adoption re-runs this
 *     check on a fresh read under the per-id Memory lock and holds the lock
 *     through the candidate update (see the adoption below).
 *   - any other verdict (another reviewer, another status, a binding that
 *     does not match the content, or no `promotedAt`) → null: a fresh write
 *     attempt, as before.
 */
function recordedRowUse(
  row: any,
  agentId: string,
  candidate: any,
  requiredTags: string[],
  visibility: string,
  durability: string,
  reviewerId: string,
): "unstamped" | "adoptable" | null {
  const recordedId = candidate.promotedRowId;
  const recordedToken = candidate.promotedRowInstanceToken;
  if (typeof recordedId !== "string" || recordedId.length === 0) return null;
  if (typeof recordedToken !== "string" || recordedToken.length === 0) return null;
  if (!row || typeof row !== "object") return null;
  if (String(row.id) !== recordedId) return null;
  if (row.agentId !== agentId) return null;
  if (row.instanceToken !== recordedToken) return null;
  if (row.archived === true) return null;
  if (row.content !== candidate.claim) return null;
  if (row.visibility !== visibility) return null;
  if (row.durability !== durability) return null;
  if (!Array.isArray(row.tags) || !requiredTags.every((tag) => row.tags.includes(tag))) return null;
  if (row.promotionStatus == null) return "unstamped";
  if (
    row.promotionStatus === "approved" && row.promotedBy === reviewerId && promotionBindingMatches(row) &&
    typeof row.promotedAt === "string" && row.promotedAt.length > 0
  ) {
    return "adoptable";
  }
  return null;
}

async function findRecordedPromotedRow(
  agentId: string,
  candidate: any,
  requiredTags: string[],
  visibility: string,
  durability: string,
  reviewerId: string,
): Promise<{ row: any; use: "unstamped" | "adoptable" } | null> {
  const recordedId = candidate.promotedRowId;
  if (typeof recordedId !== "string" || recordedId.length === 0) return null;
  if (typeof candidate.promotedRowInstanceToken !== "string" || candidate.promotedRowInstanceToken.length === 0) return null;
  // A failed read propagates: "unknown" must not be read as "no earlier row".
  const row = await (databases as any).flair.Memory.get(recordedId, {});
  const use = recordedRowUse(row, agentId, candidate, requiredTags, visibility, durability, reviewerId);
  return use ? { row, use } : null;
}

function errorMessage(err: any): string {
  return typeof err?.message === "string" ? err.message : String(err);
}

/** flair#2714: the outcome of marking a candidate promoted. When the update
 *  throws, the outcome is the candidate's state at a fresh read. */
type CandidateCommit =
  | { kind: "promoted" }
  | { kind: "pending"; error: string }
  | { kind: "unconfirmed"; error: string; readBack: string };

/**
 * Write the candidate's promoted row in a transaction this call owns, so an
 * update that returns without a throw has committed. A thrown update does not
 * say whether it committed: the commit may have landed before the error. So a
 * throw is followed by a fresh committed read of the candidate (an explicit
 * `{}` context, the confirmCommittedRow discipline in write-back.ts). The read
 * establishes only the candidate's state now, not whether this update landed
 * (another write may have changed it since):
 *   - `pending` now → "pending";
 *   - `promoted` now, with this Memory row and reviewer → "promoted";
 *   - anything else, or a read that fails → "unconfirmed" (the promotion on
 *     this row was not confirmed), with what was read.
 */
async function commitCandidatePromotion(
  row: Record<string, any>, memId: string, reviewerId: string,
): Promise<CandidateCommit> {
  try {
    await withOwnedTransaction({}, (shared) => (databases as any).flair.MemoryCandidate.put(row, shared));
    return { kind: "promoted" };
  } catch (err: any) {
    const error = errorMessage(err);
    let stored: any;
    try {
      stored = await (databases as any).flair.MemoryCandidate.get(row.id, {});
    } catch (readErr: any) {
      return { kind: "unconfirmed", error, readBack: `read failed: ${errorMessage(readErr)}` };
    }
    if (!stored || typeof stored !== "object") return { kind: "unconfirmed", error, readBack: "no candidate row" };
    if (stored.status === "pending") return { kind: "pending", error };
    if (stored.status === "promoted" && stored.promotedRowId === memId && stored.reviewerId === reviewerId) {
      return { kind: "promoted" };
    }
    return {
      kind: "unconfirmed",
      error,
      readBack: `status ${String(stored.status)}, promotedRowId ${String(stored.promotedRowId ?? null)}, reviewerId ${String(stored.reviewerId ?? null)}`,
    };
  }
}

interface SkipRecord {
  id: string;
  reason: string;
}

/** flair#2714: a promotion whose Memory row was written and stamped but whose
 *  candidate update threw, and a fresh read then found the candidate pending. */
interface IncompleteRecord {
  memoryId: string;
  candidateId: string;
  error: string;
}

/** flair#2714: as IncompleteRecord, but the fresh read failed or found the
 *  candidate neither pending nor promoted on this row, so the promotion on
 *  this row was not confirmed; `readBack` says what the read found. */
interface UnconfirmedRecord extends IncompleteRecord {
  readBack: string;
}

export class AutoPromoteCandidates extends Resource {
  // Any verified agent may trigger a sweep of ITS OWN candidates; the actor
  // resolution in post() enforces the own-only scope. Same gate ReflectMemories
  // uses (allowVerified — verified agents, admins, trusted internal calls).
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { agentId: bodyAgentId, limit, target } = data || {};

    // ── Req 1: target hard-lock, made explicit ────────────────────────────────
    // This resource NEVER writes Soul — there is no soul branch anywhere below.
    // An explicit non-memory `target` in the body is refused loudly so a caller
    // (or a compromised agent key) attempting to flip the target gets a hard no,
    // not a silent memory write it did not ask for.
    if (target !== undefined && target !== "memory") {
      return new Response(
        JSON.stringify({
          error: "auto_promote_target_locked",
          message:
            "auto-promote is hard-locked to memory server-side; soul (or any non-memory target) is refused — an ADK-sourced promotion to Soul would leak across users",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Identity / actor resolution (own candidates only, unless admin) ────────
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean =
      request?.tpsAgentIsAdmin === true || (await annotatedCallerIsAdmin(request));

    const actorResolution = resolveReflectActor({ bodyAgentId, actorId, callerIsAdmin });
    if (actorResolution.error) {
      return new Response(JSON.stringify(actorResolution.error.body), { status: actorResolution.error.status });
    }
    const agentId = actorResolution.agentId!;

    const cap =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE;

    // ── Sweep this agent's pending candidates ──────────────────────────────────
    // Owner-scoped in JS by `c.agentId !== agentId` (the raw table search is
    // org-wide — same discipline ReflectMemories uses), so a non-admin actor can
    // only ever sweep its own candidates: no cross-agent promotion, no oracle.
    //
    // decideAutoPromote (auto-promote-lib.ts) is the SINGLE fail-closed gate:
    // it — not this loop — decides eligibility (ADK scope tag present + content
    // safe). The `status !== "pending"` skip here is a pure enumeration
    // optimization (don't build a skip record for every historical decided row);
    // decideAutoPromote re-checks status authoritatively.
    //
    // Cost ceiling (Kern; flair#2714): the `cap` bounds `handled`, the number of
    // eligible candidates this call attempts a Memory write for (the expensive
    // part — a Memory write + embedding each) or takes a recorded row for
    // (a stamp, or an adoption with no write). `handled` is counted before the
    // attempt, so every Memory write attempt counts, whatever its outcome:
    // promoted, incomplete, unconfirmed, stamp refused, or an attempt that is
    // rejected or throws. Overflow stays pending for a later cycle. `count`
    // reports only the candidates listed under `promoted`.
    const MemoryCls = (await import("./Memory.js")).Memory;
    const promoted: string[] = [];
    const skipped: SkipRecord[] = [];
    const incomplete: IncompleteRecord[] = [];
    const unconfirmed: UnconfirmedRecord[] = [];
    let considered = 0;
    let handled = 0;

    // Bounded enumeration (Sherlock non-blocking + Kern's cost ceiling): filter
    // to THIS agent's PENDING candidates in the DB query so a large backlog of
    // other-status / other-agent rows is never scanned each cycle. The JS
    // agentId/status re-checks below stay as FAIL-CLOSED defense-in-depth — the
    // owner-scope guarantee does not rely on the query alone.
    const candidateQuery = {
      operator: "and",
      conditions: [
        { attribute: "agentId", comparator: "equals", value: agentId },
        { attribute: "status", comparator: "equals", value: "pending" },
      ],
    };
    for await (const c of (databases as any).flair.MemoryCandidate.search(candidateQuery)) {
      // The cap was reached by the previous candidate: stop before examining
      // another one.
      if (handled >= cap) break;
      if (!c || typeof c !== "object") continue;
      if (c.agentId !== agentId) continue;   // owner scope (no cross-agent) — defense-in-depth
      if (c.status !== "pending") continue;   // defense-in-depth
      considered++;

      const decision = decideAutoPromote(c);
      if (!decision.promote) {
        skipped.push({ id: c.id, reason: decision.reason });
        continue;
      }

      const decidedAt = new Date().toISOString();
      const promotedTags = buildAutoPromotedTags(c.id, decision.scopeTag);
      const promotedVisibility = decidePromotedVisibility(c);
      const promotedDurability = "persistent";

      // ── Use this candidate's earlier row on a retry ───────────────────────
      // A sweep that leaves its candidate pending after writing a row — its
      // stamp reported refused, or (flair#2714) its candidate update threw
      // after the stamp — may leave a reusable row behind (a refused stamp can
      // also follow a replacement or deletion of the row). When that sweep's
      // recording of the row's id and incarnation token is present on the
      // candidate (a thrown recording is logged and ignored below) and the
      // recorded row passes findRecordedPromotedRow, this sweep uses it instead
      // of writing a second promoted row: an unstamped row is stamped; a row
      // that already carries this sweep's approval, bound to its content, is
      // adopted as is and only the candidate is updated. Otherwise it attempts a
      // fresh write: with no recorded identity on the candidate nothing is
      // reused, and a recorded row with any other verdict is not reused.
      // Memory's dedup gate only reports a near-duplicate and never suppresses
      // the write.
      const recorded = await findRecordedPromotedRow(
        agentId, c, promotedTags, promotedVisibility, promotedDurability, decision.reviewerId,
      );
      handled++;
      const report = (outcome: CandidateCommit, memoryId: string): void => {
        if (outcome.kind === "promoted") {
          promoted.push(memoryId);
          return;
        }
        logger.warn?.(`AutoPromoteCandidates: candidate row update threw for ${c.id} (Memory ${memoryId} written and stamped; candidate read back ${outcome.kind === "pending" ? "pending" : `with the promotion on this row not confirmed: ${outcome.readBack}`}): ${outcome.error}`);
        if (outcome.kind === "pending") incomplete.push({ memoryId, candidateId: c.id, error: outcome.error });
        else unconfirmed.push({ memoryId, candidateId: c.id, error: outcome.error, readBack: outcome.readBack });
      };

      // ── flair#2714: adopt a recorded row that carries this sweep's approval ─
      // The selection above read the row without a lock. An owner PUT/PATCH
      // that changes the content clears the verdict (authority-field-guard.ts)
      // under the per-id Memory lock, so the adoption takes that lock, re-reads
      // the row and re-runs recordedRowUse on the fresh read, and holds the
      // lock through the candidate update. A content-changing owner edit that
      // commits first leaves a row that no longer qualifies: nothing is written
      // and the candidate stays pending (`recorded_row_changed`), to be swept
      // again. A content-changing owner edit that waits for the lock commits
      // after the candidate update. When that update is reported promoted, the
      // edit clears the verdict on a row the candidate points to — the same as
      // a content change to any promoted Memory after its promotion (an edit
      // that changes no content need not clear it); when the update throws, the
      // candidate is reported from the confirming read (commitCandidatePromotion).
      // Writers that take no Memory lock (the admin operations API among them)
      // are not serialized by this.
      if (recorded?.use === "adoptable") {
        const memId = String(recorded.row.id);
        // Test-only: inert unless the fault-injection opt-in is armed.
        const selected = txnPausePoint("auto-promote-adopt-selected");
        if (selected) await selected;
        const locked = await withMemoryWriteLockOnce(memoryPrimaryStore(), [memId], async () => {
          const current = await (databases as any).flair.Memory.get(memId, {});
          const use = recordedRowUse(current, agentId, c, promotedTags, promotedVisibility, promotedDurability, decision.reviewerId);
          if (use !== "adoptable") return null;
          // Test-only: the row was re-checked and the lock is held.
          const held = txnPausePoint("auto-promote-adopt-locked");
          if (held) await held;
          return commitCandidatePromotion({
            ...c,
            status: "promoted",
            target: "memory",
            reviewerId: decision.reviewerId,
            reviewRationale: decision.rationale,
            // The candidate records when the verdict was stamped (the gate
            // requires a nonempty promotedAt).
            decidedAt: current.promotedAt,
            promotedRowId: c.promotedRowId,
            promotedRowInstanceToken: c.promotedRowInstanceToken,
          }, memId, decision.reviewerId);
        }, { phase: "auto-promote-adopt" });
        if (locked.kind !== "done") {
          skipped.push({ id: c.id, reason: `adoption_lock_${locked.kind}` });
          continue;
        }
        if (locked.value === null) {
          skipped.push({ id: c.id, reason: "recorded_row_changed" });
          continue;
        }
        report(locked.value, memId);
        continue;
      }

      let memId: string;
      // The identity the stamp is bound to.
      let writtenRow: PromotedRowIdentity;
      // The candidate row Harper hands the sweep is frozen; the recorded
      // identity is kept in locals and submitted with the next candidate write.
      let recordedRowId: unknown = c.promotedRowId;
      let recordedRowToken: unknown = c.promotedRowInstanceToken;
      if (recorded) {
        const reusable = recorded.row;
        memId = String(reusable.id);
        writtenRow = {
          agentId: reusable.agentId,
          content: reusable.content,
          instanceToken: reusable.instanceToken,
          // Re-checked at the stamp's first read, not only here.
          tags: promotedTags,
          visibility: promotedVisibility,
          durability: promotedDurability,
          unstamped: true,
          unarchived: true,
        };
      } else {
        // A random id, like PromoteMemoryCandidate's. A count suffix would
        // not advance past a row this call wrote but did not report promoted
        // (stamp_refused, incomplete, unconfirmed), so two writes in one
        // millisecond could share an id and the second would replace the first
        // row.
        memId = `${agentId}-promoted-${randomUUID()}`;
        const memRow = {
          id: memId,
          agentId,
          content: c.claim,
          durability: promotedDurability,
          // ── visibility: DEFAULT-PRIVATE-UNLESS, explicit (Sherlock) ───────────
          // MUST be set. Memory.put() defaults an unset visibility from durability
          // (Memory.ts) and "persistent" defaults to "shared" — and "shared" is
          // ORG-OPEN (memory-read-scope.ts): readable by EVERY verified agent on
          // the instance. The sources are the most sensitive tiers (a user's
          // PRIVATE session episodes, or an agent's ephemeral+private continuity
          // journal), so promotion is a visibility ESCALATION and the default —
          // including every uncertainty fallback — is "private".
          //
          // decidePromotedVisibility (auto-promote-lib.ts) returns "shared" ONLY
          // for a CONTINUITY-scoped candidate carrying an AFFIRMATIVE distiller
          // ruling with a recorded team-relevance justification (flair#1257
          // slice 3 — a shared row always traces to a justification on its
          // candidate, never to a default). ADK per-user candidates remain
          // ALWAYS private regardless of any ruling: their per-user boundary is
          // adk-flair's CLIENT-SIDE tag re-verification, which OTHER agents do
          // NOT run — a shared ADK promotion would leak a user's distilled
          // private data to every agent on the box, unattended. That is the
          // entire #1205 safety argument, unchanged.
          visibility: promotedVisibility,
          // scopeTag FIRST — the per-user access-control boundary (Req 2).
          tags: promotedTags,
          derivedFrom: Array.isArray(c.sourceMemoryIds) ? c.sourceMemoryIds : [],
          createdAt: decidedAt,
        };

        // ── The write — MEMORY ONLY ────────────────────────────────────────────
        // Static Cls.put(row, context) routes THROUGH Memory.put()'s override
        // (Req 3 content-safety scan on the write + embedding + provenance +
        // per-agent ownership), acting as the agent itself (agentContext). There
        // is deliberately no Soul equivalent here (Req 1). decideAutoPromote has
        // already refused any content-flagged claim strict, so a normal claim
        // sails through; a Memory.put refusal (e.g. instance-wide strict mode) is
        // treated as a skip and the candidate is left pending — never a lost claim.
        let writeRes: any;
        try {
          writeRes = await MemoryCls.put(memRow, agentContext(agentId));
        } catch (err: any) {
          logger.warn?.(`AutoPromoteCandidates: Memory write threw for candidate ${c.id}: ${err?.message ?? err}`);
          skipped.push({ id: c.id, reason: "memory_write_error" });
          continue;
        }
        if (writeRes instanceof Response && !writeRes.ok) {
          skipped.push({ id: c.id, reason: `memory_write_rejected:${writeRes.status}` });
          continue;
        }

        // Harper hands memRow itself to Memory.put(), which stamps the written
        // row's incarnation token onto it, so memRow names the row this write
        // produced. The stamp is bound to that row: a different row at its first
        // read is refused with nothing stamped.
        writtenRow = {
          agentId: memRow.agentId, content: memRow.content, instanceToken: (memRow as any).instanceToken,
        };

        // Record the row this sweep wrote on the candidate before its stamp.
        // When this write persists, a refused stamp (or a candidate update that
        // throws) leaves the identity behind for the next sweep; the status
        // write below carries the same fields on success. A thrown recording is
        // logged and does not abort the promotion: the stamp still runs. Whether
        // a thrown recording committed is not checked (a commit can precede the
        // throw); if the candidate stays pending and the identity is absent from
        // it, the next sweep has no recorded row to use and attempts a new
        // write. flair#2714: the recording runs in its own transaction, before
        // the stamp, like the status write below, so when both return without a
        // throw they have committed in that order.
        if (typeof writtenRow.instanceToken === "string" && writtenRow.instanceToken.length > 0) {
          recordedRowId = memId;
          recordedRowToken = writtenRow.instanceToken;
          try {
            await withOwnedTransaction({}, (shared) => (databases as any).flair.MemoryCandidate.put({
              ...c, promotedRowId: recordedRowId, promotedRowInstanceToken: recordedRowToken,
            }, shared));
          } catch (err: any) {
            logger.warn?.(`AutoPromoteCandidates: could not record the promoted row on candidate ${c.id}: ${err?.message ?? err}`);
          }
        }
      }

      // ── A refused stamp leaves its candidate pending ───────────────────────
      // The stamp reports false when it refuses (the row its first read
      // returns is no longer the one this sweep wrote, e.g. a concurrent
      // replace) or when its outcome cannot be confirmed. Marking the candidate
      // promoted then would record a promotion whose verdict is not confirmed
      // on the row, so leave it pending for the next sweep — the safe failure
      // state above.
      const stamped = await stampMemoryPromotionIsolated(memId, decision.reviewerId, decidedAt, ctx, writtenRow);
      if (!stamped) {
        skipped.push({ id: c.id, reason: "stamp_refused" });
        continue;
      }

      // ── Mark the candidate promoted (commit point) ─────────────────────────
      // Ordered AFTER the Memory write and its verdict, matching the human
      // promote path: this handler does not mark a candidate promoted before
      // its row is stamped (a concurrent Memory deletion after the stamp is
      // still possible). In the refused-stamp case above the candidate stays
      // pending; a later sweep stamps the recorded row only when the recorded
      // identity is present on the candidate and the row still passes
      // findRecordedPromotedRow, unstamped.
      //
      // flair#2714: when this update throws, commitCandidatePromotion reads the
      // candidate back and `report` lists the promotion under promoted
      // (promoted on this row now), incomplete (pending now) or unconfirmed.
      // A later sweep can adopt the recorded row of a candidate still pending
      // (above).
      report(await commitCandidatePromotion({
        ...c,
        status: "promoted",
        target: "memory",
        reviewerId: decision.reviewerId,
        reviewRationale: decision.rationale,
        decidedAt,
        promotedRowId: recordedRowId,
        promotedRowInstanceToken: recordedRowToken,
      }, memId, decision.reviewerId), memId);
    }

    return {
      agentId,
      promoted,
      skipped,
      incomplete,
      unconfirmed,
      count: promoted.length,
      considered,
    };
  }
}
