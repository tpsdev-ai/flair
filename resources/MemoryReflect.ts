/**
 * POST /MemoryReflect
 *
 * Gathers recent memories for an agent and either (a) returns a structured
 * reflection prompt for a human/agent to run through their own LLM, or (b)
 * with execute:true, runs the distillation server-side via Harper's models
 * facade and stages the results as MemoryCandidate rows for review. See
 * issue #707 (§3A).
 *
 * Request:
 *   agentId      string   — which agent to reflect on
 *   scope        string   — "recent" | "tagged" | "all" (default: "recent")
 *   since        string?  — ISO timestamp lower bound (default: 24h ago)
 *   maxMemories  number?  — cap (default: 50)
 *   focus        string?  — "lessons_learned" | "patterns" | "decisions" | "errors" | "continuity"
 *                            (default: "lessons_learned"; a continuity-tag run — scope="tagged" with an
 *                            adk:continuity:* tag — always uses "continuity", flair#1257 slice 3)
 *   tag          string?  — required when scope="tagged"
 *   execute      boolean? — default false. When true, distill server-side and
 *                            stage MemoryCandidate rows instead of returning a prompt.
 *
 * Response (execute: false, default — unchanged from pre-#707 behavior):
 *   memories       Memory[]   — source memories included in the prompt
 *   prompt         string     — structured LLM prompt
 *   suggestedTags  string[]   — tags Flair detected in the source set
 *   count          number     — number of memories included
 *
 * Response (execute: true):
 *   candidates  MemoryCandidate[] — staged rows (rationalePrompt omitted — see below)
 *   count       number
 *   model       string            — resolved model id (see generatedBy note below)
 *   droppedStaleIntent number?    — continuity runs only (flair#1257 slice 3): candidates
 *                                    dropped by the stale-intent post-filter
 *
 * The pure logic behind execute mode (prompt building, actor resolution,
 * generate+validate+retry, dedup) lives in ./memory-reflect-lib.ts — see that
 * file's header for why: importing Resource/databases/models here pulls in
 * the Harper runtime and can't be unit-tested directly (Harper injects
 * `Resource` as a runtime global; bun's ESM linker rejects `import {
 * Resource }` outright — see test/unit/resource-allow.test.ts). This
 * resource is a thin orchestrator over the lib's tested functions.
 */

import { Resource, databases, models, logger } from "harper";
import { randomBytes } from "node:crypto";
import { isAdmin, allowVerified } from "./agent-auth.js";
import { patchRecordSilent } from "./table-helpers.js";
import {
  buildReflectionPrompt,
  buildExecutePrompt,
  resolveReflectActor,
  generateCandidates,
  dedupeCandidates,
  memoryMatchesReflectScope,
  buildStagedCandidateRow,
  isContinuityScopeTag,
  filterStaleSessionIntentCandidates,
  resolveCandidateVisibilityRuling,
  DEFAULT_STALE_INTENT_HORIZON_MS,
  type ReflectMemoryInput,
} from "./memory-reflect-lib.js";

export class ReflectMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (auth reshape removes the gate's
  // admin elevation). Any verified agent may reflect; the isAdmin checks in post()
  // handle finer-grained authorization.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const {
      agentId: bodyAgentId,
      scope = "recent",
      since,
      maxMemories = 50,
      focus = "lessons_learned",
      tag,
      execute = false,
    } = data || {};

    // Authenticated identity comes from getContext().request, not this.request
    // (see SemanticSearch / MemoryBootstrap for the same bug class). The prior
    // check was silently bypassed — bob could reflect on alice's memories and
    // mutate alice's records via the lastReflected patchRecordSilent below.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const actorId: string | undefined = request?.tpsAgent;
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true
      || (actorId ? await isAdmin(actorId) : false);

    // Same actor rules for both modes (spec §3A item 9) — resolved once via
    // the shared, tested helper before either branch runs.
    const actorResolution = resolveReflectActor({ bodyAgentId, actorId, callerIsAdmin });
    if (actorResolution.error) {
      return new Response(JSON.stringify(actorResolution.error.body), { status: actorResolution.error.status });
    }
    const agentId = actorResolution.agentId!;

    const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
    const gatherNow = new Date();
    const memories: any[] = [];

    for await (const record of (databases as any).flair.Memory.search()) {
      if (record.agentId !== agentId) continue;
      if (record.archived) continue;
      if (record.durability === "permanent") continue; // permanent memories don't need reflection
      // flair#1257 slice 3: never gather a TTL-expired row. The reap
      // (MemoryMaintenance) is asynchronous, so an ephemeral row whose
      // expiresAt is past can still be in storage — distilling it would
      // resurrect exactly what the TTL killed (same rule the continuity
      // resume path applies on read, packages/flair-mcp/src/continuity.ts
      // isLive; scenario S4: expired rows are excluded even before the reap).
      if (typeof record.expiresAt === "string" && record.expiresAt !== "" && new Date(record.expiresAt) <= gatherNow) continue;

      // Scope selection — the cross-user-bleed boundary (#1205b-1). See
      // memoryMatchesReflectScope's doc: scope:"tagged" admits ONLY the one
      // adk:<app>:<user> tag's memories, so a candidate distilled here can
      // never cite another user's memory.
      if (!memoryMatchesReflectScope(record, { scope, tag, sinceDate })) continue;

      const { embedding, ...rest } = record;
      memories.push(rest);
      if (memories.length >= maxMemories) break;
    }

    memories.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    // Collect tags present in source memories
    const tagSet = new Set<string>();
    for (const m of memories) {
      for (const t of m.tags ?? []) tagSet.add(t);
    }

    // Update lastReflected on source memories (read-modify-write to preserve
    // embeddings). Unconditional for both modes — calling /ReflectMemories at
    // all means these memories were considered, regardless of what happens next.
    const nowISO = new Date().toISOString();
    for (const m of memories) {
      patchRecordSilent((databases as any).flair.Memory, m.id, { lastReflected: nowISO });
    }

    const promptInputs: ReflectMemoryInput[] = memories.map((m) => ({ id: m.id, createdAt: m.createdAt, content: m.content }));

    if (!execute) {
      const prompt = buildReflectionPrompt({ agentId, focus, scope, sinceISO: sinceDate.toISOString(), memories: promptInputs });
      return {
        memories,
        prompt,
        suggestedTags: [...tagSet].slice(0, 20),
        count: memories.length,
      };
    }

    // ── execute mode (spec §3A) ─────────────────────────────────────────────
    // flair#1257 slice 3 — continuity-journal runs. A scope:"tagged" run whose
    // tag is a continuity session tag (`adk:continuity:<sessionId>`) gets the
    // continuity guard set: the continuity focus prompt (the stale-intent
    // prompt rule is a Kern-ruled guard, so it is UNCONDITIONAL for continuity
    // runs — a caller-supplied focus cannot switch it off), the visibility
    // ruling contract in the prompt, and the stale-intent post-filter below.
    const isContinuityRun = scope === "tagged" && isContinuityScopeTag(tag);
    const effectiveFocus = isContinuityRun ? "continuity" : focus;
    // Session age = the NEWEST gathered entry's createdAt (memories are sorted
    // ascending above). Staleness horizon: default 72h, FLAIR_REM_STALE_INTENT_HOURS.
    const sessionNewestCreatedAt: string | undefined = memories.length > 0 ? memories[memories.length - 1].createdAt : undefined;
    const staleHorizonHours = Number(process.env.FLAIR_REM_STALE_INTENT_HOURS);
    const staleHorizonMs = Number.isFinite(staleHorizonHours) && staleHorizonHours > 0
      ? staleHorizonHours * 3600_000
      : DEFAULT_STALE_INTENT_HORIZON_MS;
    const executeNow = new Date();
    const sessionStale = !sessionNewestCreatedAt || executeNow.getTime() - new Date(sessionNewestCreatedAt).getTime() > staleHorizonMs;

    const executePrompt = buildExecutePrompt({
      agentId,
      focus: effectiveFocus,
      scope,
      sinceISO: sinceDate.toISOString(),
      memories: promptInputs,
      ...(isContinuityRun ? { continuity: { sessionStale } } : {}),
    });
    const gatheredMemoryIds = new Set(promptInputs.map((m) => m.id));
    const configuredModel = process.env.FLAIR_REM_MODEL || undefined;

    const outcome = await generateCandidates({
      prompt: executePrompt,
      model: configuredModel,
      gatheredMemoryIds,
      generate: (input, opts) => models.generate(input, opts),
    });

    if (!outcome.ok) {
      if (outcome.reason === "no_backend") {
        // Static body (K&S) — never echo Harper version, backend lists, or endpoints.
        return new Response(
          JSON.stringify({ error: "No generative backend configured. See the models configuration docs." }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" }),
        { status: 502 },
      );
    }

    if (outcome.usedJsonFallback) {
      logger.warn?.(`MemoryReflect: json-fallback path active for agent ${agentId} (schema-mode output failed validation)`);
    }

    // flair#1257 slice 3 — the stale-intent POST-FILTER (the testable second
    // layer of the two-layer guard; the prompt rule above is the primary).
    // Runs AFTER validation (a drop is a policy skip, never a batch failure)
    // and BEFORE dedup/staging. Only continuity runs are filtered — for every
    // other run this is a straight pass-through.
    const staleIntentResult = isContinuityRun
      ? filterStaleSessionIntentCandidates(outcome.candidates, {
          sessionNewestCreatedAt,
          now: executeNow,
          horizonMs: staleHorizonMs,
        })
      : { kept: outcome.candidates, droppedStaleIntent: [] };
    if (staleIntentResult.droppedStaleIntent.length > 0) {
      logger.warn?.(
        `MemoryReflect: stale-intent filter dropped ${staleIntentResult.droppedStaleIntent.length} candidate(s) for agent ${agentId} (stale continuity session)`,
      );
    }

    // Dedup against this agent's existing pending candidates (spec §3A item 4).
    const existingPendingClaims: string[] = [];
    for await (const c of (databases as any).flair.MemoryCandidate.search({})) {
      if (c.agentId !== agentId) continue;
      if (c.status !== "pending") continue;
      existingPendingClaims.push(c.claim);
    }
    const toStage = dedupeCandidates(staleIntentResult.kept, existingPendingClaims);

    // generatedBy: GenerateResult in the pinned harper 5.1.17 has
    // no model/backend-id field (content/finishReason/usage/toolCalls/trace
    // only) — the "from the generate result if available" branch is
    // unreachable in this version, so this always falls back to the
    // configured logical name, matching Harper's own default routing name.
    const resolvedModel = configuredModel ?? "default";
    const generatedAt = new Date().toISOString();
    const staged: any[] = [];
    for (const c of toStage) {
      // #1205b-1: buildStagedCandidateRow stamps `scopeTag` when this run was
      // scope:"tagged" — the authoritative per-user tag promotion consumes
      // directly (closing the #1205a source-re-read seam). Non-tagged runs
      // leave scopeTag absent, unchanged.
      const row = buildStagedCandidateRow({
        id: `cand_${randomBytes(8).toString("hex")}`,
        agentId,
        claim: c.claim,
        sourceMemoryIds: c.sourceMemoryIds,
        rationalePrompt: executePrompt,
        generatedBy: resolvedModel,
        generatedAt,
        scope,
        tag,
        // flair#1257 slice 3: record an AFFIRMATIVE shared ruling (with its
        // team-relevance justification) on the candidate — continuity runs
        // only. resolveCandidateVisibilityRuling returns null for anything
        // less than shared+justified, and null stamps nothing: the promoted
        // row then defaults private (Sherlock's default-private-unless).
        visibilityRuling: isContinuityRun ? resolveCandidateVisibilityRuling(c) : null,
      });
      await (databases as any).flair.MemoryCandidate.put(row);
      staged.push(row);
    }

    // Response omits rationalePrompt (spec §3A item 5: "no prompt field") —
    // it's identical across every row in this batch and already persisted
    // for audit on the MemoryCandidate row itself; echoing it back per
    // candidate would just repeat the same large string N times. Matches
    // `flair rem candidates`' own listing, which doesn't surface it either.
    const responseCandidates = staged.map(({ rationalePrompt, ...rest }) => rest);
    return {
      candidates: responseCandidates,
      count: responseCandidates.length,
      model: resolvedModel,
      // flair#1257 slice 3: continuity-run observability — how many candidates
      // the stale-intent post-filter dropped (0 for non-continuity runs).
      ...(isContinuityRun ? { droppedStaleIntent: staleIntentResult.droppedStaleIntent.length } : {}),
    };
  }
}
