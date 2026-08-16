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
  DEFAULT_MAX_AUTO_PROMOTE_PER_CYCLE,
} from "./auto-promote-lib.js";

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

    for await (const c of (databases as any).flair.MemoryCandidate.search({})) {
      if (!c || typeof c !== "object") continue;
      if (c.agentId !== agentId) continue;   // owner scope (no cross-agent)
      if (c.status !== "pending") continue;   // perf pre-skip (not the gate)
      considered++;

      const decision = decideAutoPromote(c);
      if (!decision.promote) {
        skipped.push({ id: c.id, reason: decision.reason });
        continue;
      }

      const decidedAt = new Date().toISOString();
      const memId = `${agentId}-promoted-${Date.now()}-${promoted.length}`;
      const memRow = {
        id: memId,
        agentId,
        content: c.claim,
        durability: "persistent",
        // scopeTag FIRST — the per-user access-control boundary (Req 2).
        tags: buildAutoPromotedTags(c.id, decision.scopeTag),
        derivedFrom: Array.isArray(c.sourceMemoryIds) ? c.sourceMemoryIds : [],
        promotionStatus: "approved",
        promotedAt: decidedAt,
        // Req 4 — non-impersonating machine reviewerId.
        promotedBy: decision.reviewerId,
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

      // ── Mark the candidate promoted (commit point) ─────────────────────────
      // Ordered AFTER the Memory write, matching the human promote path: the
      // safe failure state is a promoted Memory whose candidate is still pending
      // (re-swept next cycle; the Memory dedup gate absorbs the duplicate),
      // never a candidate marked promoted with no Memory behind it.
      try {
        await (databases as any).flair.MemoryCandidate.put({
          ...c,
          status: "promoted",
          target: "memory",
          reviewerId: decision.reviewerId,
          reviewRationale: decision.rationale,
          decidedAt,
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
