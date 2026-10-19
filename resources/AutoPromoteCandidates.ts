import { stampMemoryPromotionIsolated, type PromotedRowIdentity } from "./promotion-stamp.js";
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
 *   limit    number?  — per-call cap (default DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE).
 *   target   string?  — MUST be absent or "memory". Any other value is refused
 *                       (the hard-lock made explicit + testable).
 *
 * Response:
 *   { agentId, promoted: string[], skipped: {id, reason}[], count, considered }
 *
 * Thin orchestrator over the pure, tested policy in ./auto-promote-lib.ts.
 */

import { Resource, databases, logger } from "harper";
import { isAdmin, allowVerified } from "./agent-auth.js";
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
 * it passes the checks below. A retry stamps that row instead of writing a
 * second promoted row: Memory's dedup gate only reports a near-duplicate and
 * always proceeds with the write.
 *
 * The row is addressed by the id and incarnation token recorded on the
 * candidate, not by an owner, tag or content match: those fields are not proof
 * that the sweep wrote the row. The row is reused only when its `id` and
 * `instanceToken` equal the recorded ones, its `agentId` is the sweeping
 * agent, `promotionStatus` is unset, `archived` is not true, `content` equals
 * the candidate's claim, `visibility` and `durability` equal the values this
 * sweep writes, and `tags` include every tag this sweep writes. No other field
 * is compared, and an ordinary same-id Memory write keeps the row's incarnation
 * token (Memory.ts stampInstanceToken), so a match identifies the incarnation,
 * not an unedited row. A row that fails any check falls through to a fresh write.
 * The stamp re-checks the same fields, `archived` included, at its first read
 * under the per-id Memory lock (promotion-stamp.ts isWrittenRow); a row that no
 * longer passes is refused with nothing stamped and the candidate stays pending.
 */
async function findReusablePromotedRow(
  agentId: string,
  candidate: any,
  requiredTags: string[],
  visibility: string,
  durability: string,
): Promise<any | null> {
  const recordedId = candidate.promotedRowId;
  const recordedToken = candidate.promotedRowInstanceToken;
  if (typeof recordedId !== "string" || recordedId.length === 0) return null;
  if (typeof recordedToken !== "string" || recordedToken.length === 0) return null;
  // A failed read propagates: "unknown" must not be read as "no earlier row".
  const row = await (databases as any).flair.Memory.get(recordedId, {});
  if (!row || typeof row !== "object") return null;
  if (String(row.id) !== recordedId) return null;
  if (row.agentId !== agentId) return null;
  if (row.instanceToken !== recordedToken) return null;
  if (row.promotionStatus != null) return null;
  if (row.archived === true) return null;
  if (row.content !== candidate.claim) return null;
  if (row.visibility !== visibility) return null;
  if (row.durability !== durability) return null;
  if (!Array.isArray(row.tags) || !requiredTags.every((tag) => row.tags.includes(tag))) return null;
  return row;
}

interface SkipRecord {
  id: string;
  reason: string;
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
      request?.tpsAgentIsAdmin === true || (actorId ? await isAdmin(actorId) : false);

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
    // decideAutoPromote re-checks status authoritatively. The `cap` bounds the
    // number PROMOTED (the expensive part — a Memory write + embedding each),
    // Kern's cost ceiling; overflow stays pending for a later cycle.
    const MemoryCls = (await import("./Memory.js")).Memory;
    const promoted: string[] = [];
    const skipped: SkipRecord[] = [];
    let considered = 0;

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

      // ── Reuse this candidate's earlier row on a retry ─────────────────────
      // A sweep whose stamp is reported refused leaves the candidate pending.
      // When that sweep's recording of the row's id and incarnation token was
      // persisted (a failed recording is logged and ignored below) and the
      // recorded row passes findReusablePromotedRow — including carrying no
      // promotionStatus — this sweep stamps it instead of writing a second
      // promoted row. Otherwise it writes a fresh row: without a persisted
      // recording nothing is reused, and a recorded row that already carries
      // a verdict, including one whose stamp was reported unconfirmed, is not
      // reused. Memory's dedup gate only reports a near-duplicate and never
      // suppresses the write.
      const reusable = await findReusablePromotedRow(
        agentId, c, promotedTags, promotedVisibility, promotedDurability,
      );
      let memId: string;
      let writtenRow: PromotedRowIdentity;
      // The candidate row Harper hands the sweep is frozen; the recorded
      // identity is kept in locals and submitted with the next candidate write.
      let recordedRowId: unknown = c.promotedRowId;
      let recordedRowToken: unknown = c.promotedRowInstanceToken;
      if (reusable) {
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
        memId = `${agentId}-promoted-${Date.now()}-${promoted.length}`;
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
        // When this write persists, a refused stamp leaves the identity behind
        // for the next sweep; the status write below carries the same fields
        // on success. A failed recording is logged and does not abort the
        // promotion: the stamp still runs, but if it is refused the next sweep
        // has no recorded row to reuse and writes a new one.
        if (typeof writtenRow.instanceToken === "string" && writtenRow.instanceToken.length > 0) {
          recordedRowId = memId;
          recordedRowToken = writtenRow.instanceToken;
          try {
            await (databases as any).flair.MemoryCandidate.put({
              ...c, promotedRowId: recordedRowId, promotedRowInstanceToken: recordedRowToken,
            });
          } catch (err: any) {
            logger.warn?.(`AutoPromoteCandidates: could not record the promoted row on candidate ${c.id}: ${err?.message ?? err}`);
          }
        }
      }

      const stamped = await stampMemoryPromotionIsolated(memId, decision.reviewerId, decidedAt, ctx, writtenRow);

      // ── A refused stamp leaves its candidate pending ───────────────────────
      // The stamp reports false when it refuses (the row its first read
      // returns is no longer the one this sweep wrote, e.g. a concurrent
      // replace) or when its outcome cannot be confirmed. Marking the candidate
      // promoted then would record a promotion whose verdict is not confirmed
      // on the row, so leave it pending for the next sweep — the safe failure
      // state above.
      if (!stamped) {
        skipped.push({ id: c.id, reason: "stamp_refused" });
        continue;
      }

      // ── Mark the candidate promoted (commit point) ─────────────────────────
      // Ordered AFTER the Memory write and its verdict, matching the human
      // promote path: the safe failure state is a promoted Memory whose
      // candidate is still pending, never a candidate marked promoted with no
      // Memory behind it. In the refused-stamp case above the candidate stays
      // pending; a later sweep stamps the recorded row only when the recording
      // persisted and the row still passes findReusablePromotedRow, unstamped.
      try {
        await (databases as any).flair.MemoryCandidate.put({
          ...c,
          status: "promoted",
          target: "memory",
          reviewerId: decision.reviewerId,
          reviewRationale: decision.rationale,
          decidedAt,
          promotedRowId: recordedRowId,
          promotedRowInstanceToken: recordedRowToken,
        });
      } catch (err: any) {
        logger.warn?.(`AutoPromoteCandidates: candidate row update failed for ${c.id} (Memory ${memId} written): ${err?.message ?? err}`);
      }

      promoted.push(memId);
      // Cost ceiling (Kern): cap the number PROMOTED this cycle. Remaining
      // eligible candidates stay pending and are swept on a later cycle.
      if (promoted.length >= cap) break;
    }

    return {
      agentId,
      promoted,
      skipped,
      count: promoted.length,
      considered,
    };
  }
}
