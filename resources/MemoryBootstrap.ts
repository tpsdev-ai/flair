import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { getEmbedding } from "./embeddings-provider.js";
import { wrapUntrusted } from "./content-safety.js";
import { isTeammate, formatTeamLine, isZeroRowNoOpEvent } from "./memory-bootstrap-lib.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { isValidEntity } from "./entity-vocab.js";
import { withDetachedTxn } from "./table-helpers.js";
import { getPresenceRoster } from "./presence-internal.js";
import {
  buildCollisionEntries,
  buildEntityMatchCondition,
  freshPresenceByAgent,
  type EntityMatchInput,
  type SemanticMatchInput,
} from "./collision-lib.js";
// The bounded HNSW candidate-pool retrieval for the task-relevant/teammate/
// collision surfaces (flair-bootstrap-scale-fix) — the SAME pure core
// SemanticSearch.ts's post() wraps, called bare here so an internal
// bootstrap call never trips SemanticSearch's rate-limit or
// retrievalCount hit-tracking side effects (see resources/
// semantic-retrieval-core.ts's module doc for the full boundary).
import { retrieveCandidates, DEFAULT_SELECT } from "./semantic-retrieval-core.js";
import { hybridEnabled } from "./bm25.js";
import { buildTrustBlock } from "./trust-block.js";
import { bestSemanticSimilarity, evaluateAbstention } from "./abstention.js";
import { estimateTokens } from "./token-estimate.js";

/**
 * POST /MemoryBootstrap
 *
 * Predictive context builder for agent session starts.
 * Returns prioritized, token-budgeted context with:
 *   1. Soul records (identity, role, preferences)
 *   2. Permanent memories (safety rules, core principles)
 *   3. Recent memories (adaptive window)
 *   4. Task-relevant memories (semantic search if currentTask provided)
 *   4b. Teammate findings relevant to your task (flair#550 — the SAME scored
 *      task-relevant set as #4, split by origin: any other in-org agent's
 *      NON-PRIVATE memory that scores against currentTask lands here instead
 *      of #4, attributed via "[via <agentId>]" — no MemoryGrant required
 *      (open-within-org read, per #578). Presentation only — what's readable
 *      is entirely resolveReadScope()'s job; this only changes how an
 *      already-read cross-agent record is formatted/sectioned)
 *   5. Relationship context (active relationships for mentioned entities)
 *   6. Predicted context (based on channel/surface/subject hints)
 *   7. Team roster (other active agents in this office + a search-first nudge —
 *      bootstrap loads the caller's own memories plus every other in-org
 *      agent's non-private memories (open-within-org read, never anyone's
 *      private ones), so this section nudges toward memory_search for
 *      anything beyond that window)
 *   8. Others in the room (flair#681, the attention-plane flagship —
 *      collision surfacing): joins two independently-scoped surfaces —
 *      WorkspaceState/OrgEvent entity overlap (exact vocabulary-string
 *      match against the caller's OWN declared `entities`, read via the
 *      SAME internal server-side path #678's AttentionQuery established —
 *      never broadening WorkspaceState's per-agent read model) and the
 *      semantic teammate-Memory matches #550 (above, 4b) ALREADY computed
 *      (no new embedding code — Memory is the semantic surface, WorkspaceState/
 *      OrgEvent are the entity surface, per the K&S verdict). Gated on
 *      freshness (Presence, via the SAME internal roster path, never the raw
 *      table); drawn from #550's fused-rank scored pool (flair#1246 — no
 *      relevance floor). See resources/collision-lib.ts for the pure
 *      join/rank/format logic.
 *
 * Prediction: when context signals (channel, surface, subjects) are provided,
 * the bootstrap loads more aggressively — Flair is fast enough that the
 * bottleneck is prediction quality, not load time.
 *
 * Request:
 *   { agentId, currentTask?, maxTokens?, includeSoul?, since?,
 *     channel?, surface?, subjects?, entities?, includeContext? }
 *   `includeContext` (flair#1199): whether to assemble the prose `context`
 *   mirror. Default true here (the resource/REST/CLI path); the /mcp bootstrap
 *   wrapper passes false so a token-budgeted connector — which reads the
 *   structured containers — never receives the same bodies twice.
 *   `entities` (flair#681): the caller's own declared attention-plane
 *   vocabulary strings (see resources/entity-vocab.ts) for collision
 *   surfacing's entity-overlap join. Invalid entries are silently dropped
 *   (never a 400 — this is an optional awareness hint, not a write path).
 *   When omitted, falls back to the caller's own most-recent WorkspaceState
 *   row's `entities`.
 *
 * Response:
 *   { context, sections, tokenEstimate, maxTokens, memoriesIncluded, memoriesAvailable,
 *     memoriesTruncated, teammateFindingsIncluded, teammateFindingsTruncated,
 *     teammateFindingsMatched, agentId, scope, soul, memories, predicted,
 *     teammateFindings, events[, currentTaskHint][, predictedHint] }
 *   The self-describing keys (flair#1182 part 1) — `agentId` (resolved caller),
 *   `scope` (read model applied to the caller), `soul`/`memories`/`predicted`
 *   (the caller's OWN records as structured containers), and `currentTaskHint`
 *   (present only when currentTask is absent/blank) — are ALWAYS emitted so a
 *   client can tell an empty instance from one that doesn't support them.
 *   flair#1199 — the structured containers are CANONICAL; `context` is a prose
 *   mirror (opt-in via includeContext). Cross-agent teammate findings ship in
 *   the `teammateFindings` container (own memories in `memories`), counted by
 *   `teammateFindingsIncluded` (a separate denominator from `memoriesIncluded`,
 *   which is own-scoped so it never exceeds `memoriesAvailable`). flair#1206 —
 *   org events ship in their OWN structured `events` container (ALWAYS present,
 *   `[]` when none), so a connector reading the structured payload gets them even
 *   when the prose `context` is off (the /mcp default); before #1206 they lived
 *   ONLY in the prose string and were orphaned at includeContext=false.
 *
 *   CAP CONTRACT: `maxTokens` is the HARD cap on CONTENT SELECTION — the shared
 *   `tokenBudget` starts at `maxTokens` and every admitted soul/memory/finding
 *   AND every org event (flair#1199 — events are content too; before this they
 *   were assembled but NEVER charged, so a maxTokens=4000 request serialized at
 *   6286) is gated against the remaining budget, so the sum of selected CONTENT
 *   never exceeds `maxTokens`. Each item is charged the cost of what it ACTUALLY
 *   SHIPS on the requested surface (see contentCost): on the /mcp connector path
 *   (includeContext=false) the prose `context` is a pointer, so only the
 *   STRUCTURED container object ships and is charged; on the REST/CLI prose path
 *   (includeContext=true) the prose IS the shipped surface and is charged (0.44.6
 *   capacity — flair#1207). `tokenEstimate` HONESTLY reports the real serialized
 *   payload (`JSON.stringify(responseBody)`). On the connector path — where the
 *   selection charge and `tokenEstimate` measure the SAME structured bytes —
 *   `tokenEstimate` exceeds `maxTokens` only by the FIXED JSON scaffolding
 *   (keys/braces, counters, the sections map, hints); the connector-conformance
 *   budgetCap asserts tokenEstimate <= maxTokens within a small tolerance for
 *   exactly that scaffolding. On the prose path the payload ALSO carries the
 *   structured mirror, so `tokenEstimate` may exceed `maxTokens` by that mirror —
 *   that overage is honest measurement, and shrinking prose selection to hide it
 *   is the flair#1207 regression (below). flair#1199 (0.44.11): charging the
 *   PROSE line but shipping the heavier STRUCTURED object on the /mcp path let
 *   teammate findings ride OUTSIDE the enforced budget (soulTokens 377 +
 *   memoryTokens 3574 = 3951 prose, just under a 4000 cap, yet tokenEstimate 5337
 *   = +33%; teammateFindingsIncluded crept 4→5) — fixed by charging structured
 *   on the connector path. flair#1207: #1199 had ALSO folded a per-item
 *   structured overhead + a scaffolding reserve INTO the selection budget, which
 *   silently shrank recall below 0.44.6 for the same `maxTokens`; that flat
 *   per-item overhead is a reporting concern (already captured by `tokenEstimate`)
 *   and no longer shrinks the content budget — the 0.44.11 fix charges the
 *   item's REAL shipped serialization, not a flat surcharge, and only on the path
 *   where that serialization is the shipped surface.
 *
 *   COUNT CONTRACT (flair#1207): `memoriesIncluded + memoriesTruncated <=
 *   memoriesAvailable` — included and truncated are disjoint sets of UNIQUE own
 *   memories (a memory budget-skipped in one section but admitted in another counts
 *   as included, never both). `teammateFindingsMatched` is the teammate match pool
 *   that entered the scored candidate set — since flair#1246 that is the
 *   K-bounded fused-rank retrieval pool (no relevance floor; the historical
 *   `_score > 0.3` gate was measured inert and removed); `teammateFindingsIncluded
 *   + teammateFindingsTruncated == teammateFindingsMatched` (the #1199 contract,
 *   unchanged), so "truncated" means "retrieved but no budget," not "every
 *   candidate not selected."
 *   `predictedHint` is present only when subjects were provided but `predicted`
 *   came back empty.
 */

// Collision surfacing (flair#681) tunables.
const COLLISION_WINDOW_DAYS = 7;
const MAX_COLLISION_ENTRIES = 10;

// flair#1201/#1225 — trust-block sections that are a lifecycle-window LOAD, not
// a retrieval surface. A trust entry from one of these carries `matchQuality:
// null` (no relevance score to band), which is CORRECT (Kern's #1220 ruling),
// never a scoring failure — see the `matchQualityNote` in the response tail.
const LIFECYCLE_SECTIONS = new Set(["permanent", "recent", "predicted"]);

// flair#1199 trust-admission — build the EXACT trust entry that ships for one
// included memory (id + section + block + the conditional matchQualityNote), so
// the admission loop can charge its REAL serialized cost at the same moment it
// charges the content cost. Single source of truth: the response tail reuses
// this same builder, so the charged size and the shipped size can never drift
// (the #1226 "charge what ships" principle, extended to the per-item trust
// block). The block is assembled purely for SIZING + the response — its content
// never enters any authority/scope/attribution/dedup decision (the #735/#744
// zero-authority invariant).
//
// flair#1225 — Kern ruled (on #1220) that a null `matchQuality` on an own-recent
// (lifecycle) entry is CORRECT: lifecycle sections (permanent/recent/predicted)
// are a window LOAD, not a retrieval surface, so there is no similarity to band
// — the null means "not scored here", never a scoring failure on the caller's
// own records (the #1201 misread: own-recent null beside a teammate band).
// Behavior is unchanged (per Kern); the matchQualityNote only makes the null
// self-describing in the payload — Fix 3's "any absent field says why" — so a
// connector reads it right without knowing the #1201 contract.
function buildTrustEntry(m: any, section: string): Record<string, unknown> {
  const block = buildTrustBlock(m);
  const matchQualityNote = block.matchQuality === null
    ? (LIFECYCLE_SECTIONS.has(section)
        ? `matchQuality is null because '${section}' is a lifecycle-window section, not a retrieval `
          + `surface — there is no relevance score to band. This is correct (per flair#1225), not a scoring failure.`
        : "matchQuality is null because no semantic similarity was attached to this result "
          + "(e.g. a by-id read or a keyword-only degraded match).")
    : undefined;
  return { id: m.id, section, ...block, ...(matchQualityNote ? { matchQualityNote } : {}) };
}

// flair#1199/#1206 — the default cap on how many org events bootstrap ships.
// Overridable per-request via `maxEvents`. Event slots are scarce AND (as of
// #1199) token-charged, so this bounds both the count and the spend; the shared
// tokenBudget is the harder ceiling (an event that doesn't fit is skipped even
// under the cap).
const MAX_ORG_EVENTS = 10;

// ─── Bootstrap scale fix (flair-bootstrap-scale-fix) tunables ───────────────
//
// Own-scoped, non-permanent memories (the "recent" adaptive-window source,
// ALSO reused as the "predicted" subject-match source — see the fetch below)
// are pulled bounded + createdAt-desc instead of the full org corpus. 500 is
// a generous ceiling: recent's own display is budget-limited (40% of
// remaining tokenBudget, in practice a handful of lines) and predicted's
// subject match is a narrow filter over the same set — an agent with more
// than 500 non-permanent memories in total would only miss an
// older-than-the-500th subject-tagged predicted candidate, a theoretical
// edge case traded for turning an O(org) scan into an O(own) bounded seek.
// If the recall harness ever shows this bound is too tight, widen it —
// never reintroduce the unbounded org-wide load.
const OWN_NONPERMANENT_FETCH_LIMIT = 500;

// Candidate-pool K formula (Kern-approved, K&S verdict on
// FLAIR-BOOTSTRAP-SCALE-FIX.md): K = max(3 × expected fill count,
// 5 × teammate count, MIN_CANDIDATE_POOL), capped at MAX_CANDIDATE_POOL.
// "Expected fill count" estimates how many formatted memory lines could fit
// in the remaining token budget (AVG_LINE_TOKEN_ESTIMATE is deliberately
// generous/low so the estimate — and thus K — errs LARGE, never small). The
// greedy token-budget fill loop AND collision's "one top cross-agent hit per
// teammate" (flair#681) both draw from this SAME pool, so it needs depth for
// both. If the recall harness ever shows a delta, widen K — never add a
// second scan (Kern's explicit instruction).
const AVG_LINE_TOKEN_ESTIMATE = 60;
const MIN_CANDIDATE_POOL = 50;
const MAX_CANDIDATE_POOL = 100;
// flair#1246 — the historical TASK_RELEVANCE_FLOOR (`_score > 0.3`, carried
// verbatim from the original raw JS dot-product scan) is REMOVED, not
// recalibrated: a 6-variant measurement on the shipped embedding model proved
// it inert (126 records across field-analog/nonce/contamination/control/
// max-dilution/scattered-senses shapes — nothing scored under ~0.44, so the
// floor cut zero records and never delivered "show nothing when nothing's
// relevant" either; fully-unrelated bland noise sits 0.44–0.63). Selection on
// the task-relevant surface is fused retrieval rank + the token budget. Do
// not reintroduce a constant floor — an absolute bar tight enough to exclude
// bland noise (max-dilution noise cosine 0.6086) also excludes the
// pathological on-task case (0.5656); a real relevance gate would need a
// corpus-relative instrument, which is a new feature, not a constant.

// flair#1207 — the per-item structured-payload overhead that #1199 charged
// against the content-selection budget (a `+ STRUCT_ITEM_OVERHEAD_TOKENS = 70`
// added to every item's cost, PLUS a `structOverheadReserve` pre-deducted from
// the starting budget) has been REMOVED. It conflated measurement with
// budgeting: `tokenEstimate` already measures the real serialized payload
// (JSON.stringify(responseBody)) — the structured JSON scaffolding overhead is
// captured there, honestly. Folding it into the SELECTION budget too
// double-penalized and silently shrank recall below 0.44.6 for the same
// `maxTokens` (6 findings → 3). The content budget is now `maxTokens` again
// (0.44.6 selection capacity), and each item's cost is just the rendered prose
// line — while `tokenEstimate` keeps reporting the true serialized size, which
// may exceed `maxTokens` by the scaffolding overhead. See the module-doc CAP
// CONTRACT above.

// Token estimate (~4 chars per token for English text) now lives in the
// harper-free ./token-estimate.js module, so the content-selection budget, the
// reported `tokenEstimate`, and the flair#1213 conformance tokenEstimate
// invariant are all computed with ONE definition. See that module's header.

// `agentId` is the BOOTSTRAPPING agent (the caller) — used only to decide
// whether to annotate attribution, never to change what's read (that
// boundary is resolveReadScope()'s job, upstream of this function). A
// cross-agent record always carries `_source` (tagged by
// retrieveCandidates() — see resources/semantic-retrieval-core.ts — when the
// record's own agentId differs from the bootstrapping agent), so
// `m._source !== agentId` is the "is this a teammate's finding" check; own
// memories never carry `_source` at all.
function formatMemory(m: any, agentId?: string): string {
  const tag = m.durability === "permanent" ? "🔒" : m.durability === "persistent" ? "📌" : "📝";
  const date = m.createdAt ? ` (${m.createdAt.slice(0, 10)})` : "";
  const chain = m.supersedes ? " [supersedes earlier decision]" : "";
  const attribution = m._source && m._source !== agentId ? `[via ${m._source}] ` : "";
  const base = `${tag} ${attribution}${m.content}${date}${chain}`;

  // Wrap flagged memories in safety delimiters — composes with attribution
  // above (attribution is baked into `base` before wrapping, so a flagged
  // teammate memory renders with BOTH the "[via <agent>]" tag and the
  // untrusted-content wrapper).
  if (m._safetyFlags && Array.isArray(m._safetyFlags) && m._safetyFlags.length > 0) {
    return wrapUntrusted(base, m._source);
  }
  return base;
}

export class BootstrapMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin super_user elevation, so custom resources must self-gate or
  // Harper denies them for the least-privilege flair_agent role). Any verified
  // agent may bootstrap; per-agent scoping is enforced in post() below.
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any, _context?: any) {
    const {
      agentId: bodyAgentId,
      currentTask,
      maxTokens = 4000,
      includeSoul = true,
      since,
      channel,     // e.g., "discord", "tps-mail", "claude-code"
      surface,     // e.g., "tps-build", "tps-review", "cli-session"
      subjects,    // e.g., ["flair", "auth"] — entities to preload context for
      includeTrust = false,  // flair#744 slice 1 — opt-in per-memory trust block
      abstain = false,       // flair#744 slice 2 — opt-in task-relevance abstention
      // flair#1199 — org-event knobs. `maxEvents` caps how many events ship
      // (default MAX_ORG_EVENTS); `includeEventDetail` gates the verbose per-event
      // `detail` JSON (default OFF — mirrors the includeContext opt-in). By
      // default bootstrap ships LEAN events (id/kind/summary/createdAt/targetIds/
      // scope); `detail` restates the summary + migration internals and is pure
      // bloat for a connector, so it is opt-in. Both are also counted against the
      // shared tokenBudget below (before #1199 the events array was assembled but
      // NEVER charged, so a maxTokens=4000 request serialized well past budget).
      maxEvents,
      includeEventDetail = false,
      // flair#1199 — whether to assemble the prose `context` string. The
      // structured containers (soul/memories/predicted/teammateFindings) are the
      // CANONICAL payload; `context` is a human/agent-readable MIRROR of the same
      // bytes. Default TRUE here (the resource/REST/CLI path has always emitted
      // prose, and every direct caller reads it) — but the /mcp bootstrap wrapper
      // (resources/mcp-tools.ts) passes `false` by default, so a token-budgeted
      // connector, which consumes the structured fields, never receives the same
      // bodies twice. When false, `context` is a compact structural pointer (no
      // bodies), so nothing crosses the wire twice on that path.
      includeContext = true,
    } = data || {};

    // Authenticated identity lives on getContext().request — `this.request` is
    // NOT populated on Harper v5 Resources. Reading it returned undefined and
    // the scope check was silently bypassed, letting a non-admin agent read
    // another agent's soul + memories by passing the victim's id in the body.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authenticatedAgent: string | undefined =
      request?.tpsAgent ?? request?.headers?.get?.("x-tps-agent");
    const callerIsAdmin: boolean = request?.tpsAgentIsAdmin === true;

    if (!bodyAgentId && !authenticatedAgent) {
      return new Response(JSON.stringify({ error: "agentId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (authenticatedAgent && !callerIsAdmin && bodyAgentId && bodyAgentId !== authenticatedAgent) {
      return new Response(JSON.stringify({
        error: "forbidden: agentId must match authenticated agent",
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Pin scope to the authenticated agent for non-admins; admins can bootstrap
    // any agentId (needed for setup scripts and UI impersonation flows).
    const agentId: string = (authenticatedAgent && !callerIsAdmin)
      ? authenticatedAgent
      : bodyAgentId;

    const sections: Record<string, string[]> = {
      soul: [],
      skills: [],
      team: [],
      permanent: [],
      recent: [],
      predicted: [],
      relationships: [],
      relevant: [],
      teammate: [],
      collision: [],
      events: [],
    };
    // flair#1207 — the content-SELECTION budget is `maxTokens`, matching 0.44.6
    // capacity. #1199 pre-deducted a `structOverheadReserve` (min(600, 15% of
    // maxTokens)) here to "reserve headroom" for the structured-container JSON
    // scaffolding, on the theory that `maxTokens` should bound the serialized
    // payload. That silently shrank the content budget and, combined with the
    // per-item overhead (also removed), cut recall below 0.44.6 for the same
    // `maxTokens` (#1207). The reserve is gone: `maxTokens` is the HARD cap on
    // CONTENT SELECTION only. `tokenEstimate` (below) still reports the real
    // serialized size honestly — which may exceed `maxTokens` by the scaffolding
    // overhead, exactly as 0.44.6's payload did (0.44.6 just under-measured it).
    // Single shared budget across soul + every memory section (soul used to be
    // budgeted SEPARATELY and added ON TOP, so context alone could reach
    // 1.4×maxTokens; #1199 folded soul into this shared budget — that part
    // stays). Every admitted line is gated against the remaining budget, so the
    // sum of selected CONTENT never exceeds `maxTokens`.
    let tokenBudget = Math.max(0, maxTokens);
    // Own memories included in the payload (permanent + recent + predicted +
    // own task-relevant). Denominator is `memoriesAvailable` (own-scoped), so
    // memoriesIncluded ≤ memoriesAvailable always holds (#1199 coherent
    // counters). Cross-agent teammate findings are counted separately below.
    let memoriesIncluded = 0;
    let memoriesAvailable = 0;
    let memoriesTruncated = 0;
    // flair#1207 — count arithmetic by UNIQUE own-memory id, not raw increments.
    // The invariant `memoriesIncluded + memoriesTruncated <= memoriesAvailable`
    // MUST hold (0.44.9 reported available:3 included:2 truncated:2 — 2+2 > 3).
    // Two bugs produced the over-count, both fixed by keying off these sets:
    //   (1) a memory truncated for budget in an EARLY section (e.g. recent's
    //       40% sub-budget) reappears in the task-relevant candidate pool and is
    //       counted AGAIN (truncated twice, or truncated-then-included) — the
    //       same physical memory in two denominators; and
    //   (2) the task-relevant loop's "already included" exclusion set was built
    //       POSITIONALLY (recent.filter by index) and omitted `predicted`, so a
    //       predicted memory could be re-admitted to `relevant`.
    // `includedOwnIds` is now THE authoritative "own memory already placed" set
    // (used as the exclusion set in the predicted + task-relevant loops, replacing
    // the positional hack); `truncatedOwnIds` records own budget-skips. Final
    // counts are DERIVED from these sets (truncated = truncated-but-not-included),
    // so both are disjoint subsets of memoriesAvailable and the invariant holds.
    const includedOwnIds = new Set<string>();
    const truncatedOwnIds = new Set<string>();
    // flair#1199 — cross-agent teammate findings included (a DIFFERENT
    // denominator than own memories): counting these into `memoriesIncluded`
    // is what let one client see included(9) > available(3).
    let teammateFindingsIncluded = 0;
    // flair#1207 — teammate findings SKIPPED for size in the task-relevant
    // packing loop (entered the scored retrieval pool but didn't fit the
    // BUDGET; flair#1246 — the pool is the K-bounded fused-rank candidate
    // set, no relevance floor). Reported ALONGSIDE `teammateFindingsMatched`
    // (the whole scored pool considered), so "truncated" unambiguously means "relevant-but-no-budget",
    // NOT "every candidate not selected" — 0.44.9's `truncated:89` beside
    // `included:4` read as "89 relevant findings cut" with no pool to anchor it
    // (heskew's #1207 nit). Both are disjoint-and-exhaustive over the matched
    // pool (each matched teammate finding is EITHER included OR truncated), so
    // teammateFindingsIncluded + teammateFindingsTruncated == teammateFindingsMatched.
    let teammateFindingsTruncated = 0;

    // flair#1182 (part 1) — self-describing bootstrap. These structured
    // container keys are ALWAYS emitted on the response (empty `{}`/`[]` when
    // the caller has nothing), so a client can tell an *empty* instance from
    // one that doesn't support these keys at all — and can read the caller's
    // own soul/memories as structured data instead of parsing the `context`
    // markdown string. `soul`/`memories`/`predicted` are scoped to the CALLER'S
    // OWN records only (permanent/recent/relevant/predicted are all agentId==self
    // reads). flair#1199 — cross-agent teammate findings now have their OWN
    // structured container (`teammateFindings`, below), attributed via `source`,
    // rather than living only in the prose `context` (which is opt-in as of
    // #1199); the own-only containers still carry no other agent's data.
    const soulMap: Record<string, unknown> = {};
    const includedOwnMemories: any[] = [];
    const includedPredicted: any[] = [];
    // flair#1199 — teammate (cross-agent) findings get their OWN structured
    // container. Before #1199 they lived ONLY in the prose `context`; now that
    // `context` is an opt-in mirror (default off on the /mcp path), they need a
    // structured home so a connector that consumes the containers still sees
    // them. Kept SEPARATE from `memories`/`predicted` (which stay own-only per
    // the #1182 boundary) and clearly attributed via `source`.
    const includedTeammateFindings: any[] = [];
    // flair#1206 — org events get their OWN structured container. Before #1206
    // they lived ONLY in the prose `context` string ("## Recent Org Events"),
    // so at includeContext=false (the /mcp default) they were counted in
    // `sections.events` and measured into `tokenEstimate` (when prose was on) but
    // NEVER delivered in any field a connector could read — orphaned. Populated
    // from the SAME deduped+sliced set the prose lines are (so count, charge and
    // delivery all key off one thing), ALWAYS emitted (`[]` when none), and the
    // targetIds relevance filter is already applied upstream (see the OrgEvent
    // read below). Declared out here so it is in scope for the response body even
    // if the events read (in a try/catch) yields nothing.
    const includedEvents: any[] = [];
    const leanMemory = (m: any, section: string) => ({
      id: m.id,
      content: m.content,
      durability: m.durability ?? null,
      createdAt: m.createdAt ?? null,
      // #1201 — the record's own last-write time, so a structured consumer can
      // compute freshness off the same anchor the trust block's ageDays uses.
      updatedAt: m.updatedAt ?? null,
      agentId: m.agentId ?? agentId,
      subject: m.subject ?? null,
      section,
    });

    // flair#1199 (0.44.11) — the REAL cost an admitted content item adds to the
    // serialized payload the caller RECEIVES, which is exactly what
    // `tokenEstimate` measures. This is the fix for the teammate-findings
    // budget blowout: the selector used to charge every memory/finding its
    // PROSE line (`formatMemory`) but, on the /mcp connector path, ship the
    // heavier STRUCTURED container object — and `tokenEstimate` measures the
    // structured object. A teammate finding carries `id` + TWO ISO timestamps +
    // `source` + `section` + JSON field names/quotes that the prose line does
    // not, so the shipped object runs ~1.5–1.7× its prose line. Charging prose
    // but shipping structured let several teammate findings ride OUTSIDE the
    // enforced budget: a maxTokens=4000 bootstrap reported soulTokens 377 +
    // memoryTokens 3574 = 3951 (prose, just under cap) yet serialized at 5337
    // (+33%), and teammateFindingsIncluded crept 4→5. So charge what SHIPS:
    //   - /mcp connector path (includeContext=false): the prose `context` is a
    //     compact pointer (no bodies), so ONLY the structured container ships —
    //     charge its serialized size. Now the sum of admitted content ≈
    //     `tokenEstimate` minus the FIXED JSON scaffolding, so `tokenEstimate`
    //     stays within maxTokens + the small scaffolding tolerance.
    //   - REST/CLI prose path (includeContext=true): the prose IS the primary
    //     shipped surface and flair#1207 deliberately fixed the selection budget
    //     at 0.44.6 (prose) capacity — `tokenEstimate` is HONEST there and may
    //     exceed maxTokens by the structured mirror it also ships. Charging
    //     structured on THAT path would re-shrink prose recall below 0.44.6
    //     (the exact #1207 regression). So keep charging prose on the prose
    //     path. This is "fix the budget INPUT, not the cap": the figure the
    //     selector tests against maxTokens is now the figure that becomes
    //     `tokenEstimate` on each path.
    const contentCost = (structured: unknown, proseLine: string): number =>
      includeContext ? estimateTokens(proseLine) : estimateTokens(JSON.stringify(structured));

    // --- 1. Soul records (budgeted — prioritized by key importance) ---
    // Soul is who you are, but we still need to respect token budgets.
    // Workspace files (SOUL.md, AGENTS.md) can be massive — they're already
    // injected by the runtime via workspace context, so we prioritize
    // concise soul entries over full file dumps.
    const SOUL_KEY_PRIORITY: Record<string, number> = {
      role: 0, identity: 1, thinking: 2, communication_style: 3,
      team: 4, ownership: 5, infrastructure: 6, "user-context": 7,
      // Full workspace files — lowest priority (runtime already injects these)
      soul: 90, "workspace-rules": 91,
    };

    const skillAssignments: any[] = [];
    const soulMaxTokens = Math.floor(maxTokens * 0.4); // 40% of budget for soul
    if (includeSoul) {
      let soulTokens = 0;
      const soulEntries: { key: string; line: string; tokens: number; priority: number }[] = [];

      for await (const record of (databases as any).flair.Soul.search()) {
        if (record.agentId !== agentId) continue;
        if (record.key === "skill-assignment") {
          skillAssignments.push(record);
          continue;
        }
        // flair#1182 — the raw soul container (key→value), independent of the
        // token-budgeted/priority-truncated `sections.soul` lines built below.
        soulMap[record.key] = record.value;
        const line = `**${record.key}:** ${record.value}`;
        const tokens = estimateTokens(line);
        const priority = SOUL_KEY_PRIORITY[record.key] ?? 50;
        soulEntries.push({ key: record.key, line, tokens, priority });
      }

      // Sort by priority (lower = more important)
      soulEntries.sort((a, b) => a.priority - b.priority);

      for (const entry of soulEntries) {
        if (soulTokens + entry.tokens > soulMaxTokens) {
          // Skip large entries that exceed budget — truncate or skip
          if (entry.priority >= 90) continue; // skip full workspace files
          // Truncate if it's important but too long
          const maxChars = (soulMaxTokens - soulTokens) * 4;
          if (maxChars > 100) {
            const truncated = `**${entry.key}:** ${entry.line.slice(entry.key.length + 6, entry.key.length + 6 + maxChars)}…(truncated)`;
            sections.soul.push(truncated);
            const cost = estimateTokens(truncated);
            soulTokens += cost;
            tokenBudget -= cost; // #1199 — soul draws from the shared budget
          }
          continue;
        }
        sections.soul.push(entry.line);
        soulTokens += entry.tokens;
        tokenBudget -= entry.tokens; // #1199 — soul draws from the shared budget
      }
    }

    // --- 1b. Skill assignments (ordered by priority, conflict detection) ---
    if (skillAssignments.length > 0) {
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, standard: 2, low: 3 };
      skillAssignments.sort((a, b) => {
        const pa = priorityOrder[a.priority ?? "standard"] ?? 2;
        const pb = priorityOrder[b.priority ?? "standard"] ?? 2;
        return pa - pb;
      });

      // Detect conflicts at same priority level
      const byPriority = new Map<string, any[]>();
      for (const skill of skillAssignments) {
        const p = skill.priority ?? "standard";
        if (!byPriority.has(p)) byPriority.set(p, []);
        byPriority.get(p)!.push(skill);
      }

      for (const skill of skillAssignments) {
        const p = skill.priority ?? "standard";
        let meta: any = {};
        try { meta = typeof skill.metadata === "string" ? JSON.parse(skill.metadata) : (skill.metadata ?? {}); } catch {}
        const source = meta.source ? `, source: ${meta.source}` : "";
        let line = `- ${skill.value} (${p} priority${source})`;
        // Flag conflicts at same priority level
        const peers = byPriority.get(p) ?? [];
        if (peers.length > 1) {
          line += " [SKILL_CONFLICT]";
        }
        sections.skills.push(line);
      }
    }

    // --- 1c. Team roster + cross-agent search nudge ---
    // Soul is still caller-own-only (unaffected here). Memory loading below
    // (step 2) now also includes every other in-org agent's non-private
    // memories (open-within-org read, no MemoryGrant needed — #578) — but
    // this section stays: memory_search/SemanticSearch remains the
    // deliberate, query-driven way to find a teammate's finding, vs.
    // bootstrap's fixed recent/permanent window. This section is fixed-cost
    // (no query text to format per agent) so it's cheap enough to always
    // include, not budgeted.
    //
    // Permissive kind/status checks are DELIBERATE: Agent.ts registration
    // defaults both (`kind ||= "agent"`, `status ||= "active"`), so pre-1.0
    // records missing either field are legacy agents/active — a strict
    // `!== "agent"` check would silently drop them. Assumes single-tenant
    // (one instance = one office); grant-filtered roster is the multi-tenant follow-up.
    // Hoisted out of the try block below (not just team-roster-local) — the
    // task-relevant candidate pool's K formula (flair-bootstrap-scale-fix)
    // needs the teammate count too. Stays `[]` on an Agent.search() failure
    // (older/standalone deployments without the table), which K's formula
    // tolerates fine (falls back to its other terms).
    let teammateIds: string[] = [];
    try {
      for await (const record of (databases as any).flair.Agent.search()) {
        if (isTeammate(record, agentId)) teammateIds.push(record.id);
      }
      const line = formatTeamLine(teammateIds);
      if (line) sections.team.push(line);
    } catch {
      // Agent table may not exist in older / standalone deployments
    }

    // ─── Read-scope (flair-bootstrap-scale-fix) ─────────────────────────────
    // Read-scope: own (any visibility) + every OTHER in-org agent's
    // non-private memory — open-within-org read (#578), no MemoryGrant
    // consulted at all. Centralized in resolveReadScope(): `scope.condition`
    // is pushed into every Harper query below (so the table itself never
    // returns an out-of-scope row), and `scope.isAllowed` re-checks
    // in-process as defense-in-depth on every candidate (Sherlock's
    // non-negotiable — the pushdown condition is the primary gate, this is
    // the belt) — this is the #550 foundation: bootstrap can now safely
    // expand beyond own-only without a parallel scoping rule, and that rule
    // tracks resolveReadScope()'s model automatically (this file never
    // re-implements the rule, so it never has to change when the rule does).
    //
    // The org-wide "load everything, then filter/scan in JS" this section
    // used to do (`Memory.search({conditions:[scope.condition]})`, no
    // limit/select — every row's full embedding vector dragged into RAM on
    // every bootstrap) is replaced by targeted, bounded queries per
    // consumer: own-scoped pushdowns for the permanent/recent/predicted
    // lifecycle slices below (agentId==self — strictly NARROWER than the
    // full open-within-org scope, so no filter is dropped), a cheap
    // own-scoped count for `memoriesAvailable`, and a bounded HNSW candidate
    // pool (via retrieveCandidates(), further down) for the task-relevant/
    // teammate/collision surfaces — the only consumer that legitimately
    // spans the org. Each bounded query still re-checks `scope.isAllowed()`
    // on every record even where it's provably a no-op (e.g. an
    // agentId==self-only query) — uniform defense-in-depth, never skipped
    // because "the filter already pushed down."
    const scope = await resolveReadScope(agentId);

    // `memoriesAvailable`: dropped the org-wide exact count (computing it
    // exactly WAS the scan being removed — `visibility != private` isn't
    // index-seekable, so even a bare count would scan). Replaced with the
    // own-scoped count (`agentId==self`, cheap indexed seek) — a more
    // meaningful "how much do I actually have" figure, and O(own) not
    // O(org). Cosmetic change, called out to K&S in the spec.
    let ownMemoriesAvailable = 0;
    const availabilityRows = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search({
      conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }],
      select: ["id", "expiresAt", "validTo"],
    }));
    for await (const record of availabilityRows as AsyncIterable<any>) {
      if (!scope.isAllowed(record)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      ownMemoriesAvailable++;
    }
    memoriesAvailable = ownMemoriesAvailable;

    // Fields every own-scoped lifecycle slice below needs — explicit (no raw
    // `embedding`), matching the "select, no raw embedding" pushdown
    // requirement. flair#744 slice 1: when the caller opts into the per-memory
    // trust block, widen the projection with the extra stored fields the block
    // reads (`provenance`, `usageCount`, `validFrom`) — additive, and only when
    // requested, so a non-trust bootstrap fetches (and returns) exactly what it
    // did before. These records are never returned raw when the block is off,
    // so widening the select cannot change the off-path response bytes.
    // #1201 — `updatedAt` is projected on BOTH paths (not just the trust path):
    // the structured `memories`/`predicted` containers carry it so a consumer
    // can compute freshness, and the trust block's ageDays keys off it.
    const OWN_SELECT = includeTrust
      ? ["id", "agentId", "content", "durability", "createdAt", "updatedAt", "supersedes", "subject", "validTo", "expiresAt", "_safetyFlags", "provenance", "usageCount", "validFrom"]
      : ["id", "agentId", "content", "durability", "createdAt", "updatedAt", "supersedes", "subject", "validTo", "expiresAt", "_safetyFlags"];

    // flair#744 slice 1 — the Memory records that became visible lines in the
    // memory-bearing sections (permanent/recent/predicted/relevant/teammate),
    // collected as they're added so the opt-in `trust` array below can carry a
    // self-contained block per included memory. Stays empty (and unused) when
    // includeTrust is off. flair#1201 — each entry carries the SECTION it landed
    // in, so a trust entry's `matchQuality` is legible: null on a lifecycle
    // section (permanent/recent/predicted — not a retrieval surface) reads as
    // "not scored", not as a scoring failure, and a band on a retrieval section
    // (relevant/teammate) is applied by the SAME rule to own and teammate
    // records. Fixes the "own recent → null while teammate → strong looks like
    // my own records scored worse" misread.
    const includedTrustMemories: Record<string, unknown>[] = [];

    // flair#744 slice 2 — the best absolute semantic similarity seen while
    // scoring the task-relevant candidate pool (section 4). Drives the opt-in
    // abstention verdict on the *task-relevance* surface only (bootstrap always
    // returns identity/permanent/recent regardless — abstention is about "does
    // any memory cover your current task", not the whole session load). Stays
    // null when there's no currentTask / no embedding ⇒ never abstains.
    let taskBestSimilarity: number | null = null;

    // --- 2. Permanent memories (always included, highest priority) ---
    // Own-scoped pushdown: `agentId==self` + `durability==permanent`, both
    // @indexed (a seek, not a scan) — strictly narrower than the prior
    // load-then-filter (own records are always visible to their own agent
    // regardless of visibility, so agentId==self alone is the correct,
    // no-filter-dropped condition here; no other agent's data enters this
    // query at all).
    const permanentRows: any[] = [];
    const permanentQuery = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search({
      conditions: [
        { attribute: "agentId", comparator: "equals", value: agentId },
        { attribute: "durability", comparator: "equals", value: "permanent" },
      ],
      select: OWN_SELECT,
    }));
    for await (const record of permanentQuery as AsyncIterable<any>) {
      if (!scope.isAllowed(record)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      // A past validTo ALWAYS means the record has been closed out (server
      // supersede path — Memory.ts closeSupersededRecord — sets validTo
      // without necessarily setting `archived`), same root cause and fix as
      // SemanticSearch.ts's unconditional past-validTo exclusion.
      // Unconditional so a server-superseded record can't resurface just
      // because its successor isn't co-present in THIS bounded set (the
      // per-set supersededIds filter below only catches co-presence).
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      permanentRows.push(record);
    }
    // Per-set supersededIds (flair-bootstrap-scale-fix, Kern-approved
    // narrowing): computed from THIS bounded set alone, never cross-applied
    // to the recent/predicted sets or the candidate pool below — each is
    // independent. The uncovered case (predecessor and successor landing in
    // DIFFERENT bounded sets) is a theoretical gap already covered by the
    // unconditional past-validTo guard above (the primary supersede
    // defense); this co-presence check is a secondary belt, same as before
    // this refactor, just now scoped per-set instead of per the old
    // org-wide load.
    const permanentSupersededIds = new Set<string>();
    for (const m of permanentRows) if (m.supersedes) permanentSupersededIds.add(m.supersedes);
    const permanent = permanentRows.filter((m) => !permanentSupersededIds.has(m.id));
    for (const m of permanent) {
      const line = formatMemory(m, agentId);
      const struct = leanMemory(m, "permanent");
      // #1199 (0.44.11) — charge what SHIPS (structured on the /mcp path, prose
      // on the REST path); see contentCost. #1207 stays honored: on the prose
      // path this is still the prose-line cost, so REST recall is unchanged.
      const cost = contentCost(struct, line);
      // flair#1199 trust-admission — charge the trust block's real serialized
      // cost at the same moment as the content cost (per-item trust is CONTENT,
      // not fixed scaffolding; see buildTrustEntry).
      const trustEntry = includeTrust ? buildTrustEntry(m, "permanent") : null;
      const trustCost = trustEntry ? estimateTokens(JSON.stringify(trustEntry)) : 0;
      if (cost + trustCost <= tokenBudget) {
        sections.permanent.push(line);
        includedOwnMemories.push(struct);
        if (trustEntry) includedTrustMemories.push(trustEntry);
        tokenBudget -= cost + trustCost;
        includedOwnIds.add(m.id); // #1207 — count by unique own-memory id
      } else {
        truncatedOwnIds.add(m.id); // #1207 — budget-skip, deduped against inclusions at the end
      }
    }

    // --- 3. Recent memories (adaptive window) ---
    // Own-scoped, non-permanent, bounded + createdAt-desc pushdown (agentId
    // and durability are both @indexed) — replaces the org-wide load's
    // post-hoc JS filter. This SAME fetched set also feeds "predicted"
    // (3b, below): both draw from "my own non-permanent memories" bounded to
    // OWN_NONPERMANENT_FETCH_LIMIT (see that constant's doc for the bound's
    // rationale) — same shared-source relationship the pre-refactor code
    // had via `ownMemories`, just bounded now instead of org-wide.
    const nonPermanentRows: any[] = [];
    const nonPermanentQuery = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search({
      conditions: [
        { attribute: "agentId", comparator: "equals", value: agentId },
        { attribute: "durability", comparator: "not_equal", value: "permanent" },
      ],
      select: OWN_SELECT,
      sort: { attribute: "createdAt", descending: true },
      limit: OWN_NONPERMANENT_FETCH_LIMIT,
    }));
    for await (const record of nonPermanentQuery as AsyncIterable<any>) {
      if (!scope.isAllowed(record)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      nonPermanentRows.push(record);
    }
    // Per-set supersededIds — independent of `permanentSupersededIds` above
    // (see that block's doc for the full per-set rationale).
    const nonPermanentSupersededIds = new Set<string>();
    for (const m of nonPermanentRows) if (m.supersedes) nonPermanentSupersededIds.add(m.supersedes);
    const nonPermanentActive = nonPermanentRows.filter((m) => !nonPermanentSupersededIds.has(m.id));

    // Start with 48h. If nothing found, widen to 7d, then 30d.
    // This prevents empty recent sections for agents that were idle.
    const nonPermanent = nonPermanentActive
      .filter((m) => m.createdAt)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    let effectiveSince: Date;
    if (since) {
      effectiveSince = new Date(since);
    } else {
      const windows = [48 * 3600_000, 7 * 24 * 3600_000, 30 * 24 * 3600_000];
      effectiveSince = new Date(Date.now() - windows[0]);
      for (const w of windows) {
        effectiveSince = new Date(Date.now() - w);
        const count = nonPermanent.filter((m) => new Date(m.createdAt!) >= effectiveSince).length;
        if (count >= 3) break; // found enough recent memories
      }
    }

    const recent = nonPermanent.filter((m) => new Date(m.createdAt!) >= effectiveSince);

    // Budget: up to 40% of remaining for recent
    const recentBudget = Math.floor(tokenBudget * 0.4);
    let recentSpent = 0;
    for (const m of recent) {
      const line = formatMemory(m, agentId);
      const struct = leanMemory(m, "recent");
      const cost = contentCost(struct, line); // #1199 (0.44.11) — charge what ships; see contentCost
      // flair#1199 trust-admission — charge the trust block's real serialized
      // cost against BOTH the recent sub-budget and the shared tokenBudget.
      const trustEntry = includeTrust ? buildTrustEntry(m, "recent") : null;
      const trustCost = trustEntry ? estimateTokens(JSON.stringify(trustEntry)) : 0;
      if (recentSpent + cost + trustCost > recentBudget) {
        truncatedOwnIds.add(m.id); // #1207 — budget-skip; may still be admitted later via the task-relevant loop (deduped at the end)
        continue;
      }
      sections.recent.push(line);
      includedOwnMemories.push(struct);
      if (trustEntry) includedTrustMemories.push(trustEntry);
      recentSpent += cost + trustCost;
      tokenBudget -= cost + trustCost;
      includedOwnIds.add(m.id); // #1207 — count by unique own-memory id
    }

    // --- 3b. Subject-predicted context ---
    // When subjects are provided (e.g., ["flair", "auth"]), load memories
    // tagged with those subjects that aren't already included. This is the
    // "predictive" part — the caller knows what topics are likely relevant
    // based on channel/surface/recent-activity.
    const predictedSubjects: string[] = Array.isArray(subjects)
      ? subjects.map((s: string) => s.toLowerCase())
      : [];

    if (predictedSubjects.length > 0 && tokenBudget > 200) {
      // flair#1207 — exclude by the AUTHORITATIVE included-own set (permanent +
      // recent actually admitted), not the old positional `recent.filter(by
      // index)` hack, which mis-tracked when the recent loop skipped an early
      // memory for budget and admitted a later one.
      // Draws from the SAME bounded own-scoped, non-permanent set "recent"
      // uses (nonPermanentActive — see that fetch's doc above for the
      // shared-source rationale and OWN_NONPERMANENT_FETCH_LIMIT's bound).
      // `durability !== "permanent"` is now redundant with the source
      // query's own condition but kept for parity/clarity with the
      // pre-refactor filter shape.
      const subjectMemories = nonPermanentActive
        .filter((m: any) =>
          !includedOwnIds.has(m.id) &&
          m.subject &&
          predictedSubjects.includes(m.subject.toLowerCase()) &&
          m.durability !== "permanent" // already loaded
        )
        .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));

      const predictedBudget = Math.floor(tokenBudget * 0.3);
      let predictedSpent = 0;
      for (const m of subjectMemories) {
        const line = formatMemory(m, agentId);
        const struct = leanMemory(m, "predicted");
        const cost = contentCost(struct, line); // #1199 (0.44.11) — charge what ships; see contentCost
        // flair#1199 trust-admission — charge the trust block's real serialized
        // cost against BOTH the predicted sub-budget and the shared tokenBudget.
        const trustEntry = includeTrust ? buildTrustEntry(m, "predicted") : null;
        const trustCost = trustEntry ? estimateTokens(JSON.stringify(trustEntry)) : 0;
        if (predictedSpent + cost + trustCost > predictedBudget) {
          truncatedOwnIds.add(m.id); // #1207 — budget-skip (deduped against inclusions at the end)
          continue;
        }
        sections.predicted.push(line);
        includedPredicted.push(struct);
        if (trustEntry) includedTrustMemories.push(trustEntry);
        predictedSpent += cost + trustCost;
        tokenBudget -= cost + trustCost;
        includedOwnIds.add(m.id); // #1207 — count by unique own-memory id; also the task-relevant loop's exclusion set (no predicted→relevant double-admit)
      }
    }

    // --- 3c. Active relationships for predicted subjects ---
    if (predictedSubjects.length > 0 && tokenBudget > 100) {
      try {
        for (const subj of predictedSubjects) {
          for await (const rel of (databases as any).flair.Relationship.search({
            conditions: [
              { attribute: "agentId", comparator: "equals", value: agentId },
              {
                operator: "or",
                conditions: [
                  { attribute: "subject", comparator: "equals", value: subj },
                  { attribute: "object", comparator: "equals", value: subj },
                ],
              },
            ],
            operator: "and",
          })) {
            // Only include active relationships (no validTo or validTo in future)
            if (rel.validTo && rel.validTo < new Date().toISOString()) continue;
            const line = `- ${rel.subject} → ${rel.predicate} → ${rel.object}${rel.confidence < 1.0 ? ` (${Math.round(rel.confidence * 100)}%)` : ""}`;
            const cost = estimateTokens(line);
            if (cost > tokenBudget) break;
            sections.relationships.push(line);
            tokenBudget -= cost;
          }
        }
      } catch {
        // Relationship table may not exist yet
      }
    }

    // Collision surfacing's semantic-match candidates (flair#681) — the
    // BEST (top fused-rank) cross-agent memory per teammate from #550's
    // `scored` list below, captured here (before that list's tokens get
    // spent on the relevant/teammate sections) so the collision block can
    // reuse the IDENTICAL scored set (flair#1246 — fused retrieval rank, no
    // floor gate) without recomputing or re-embedding anything. Stays empty
    // when there's no currentTask (no `scored` list is ever built) or no
    // cross-agent hits.
    const semanticTeammateMatches: SemanticMatchInput[] = [];

    // --- 4. Task-relevant memories (semantic search) ---
    if (currentTask && tokenBudget > 200) {
      let queryEmbedding: number[] | null = null;
      try {
        // flair#504 Phase 2: 'query' — currentTask is the bootstrap's
        // task-relevance search query, not stored content.
        queryEmbedding = await getEmbedding(currentTask, "query");
      } catch {}

      if (queryEmbedding) {
        // flair#1207 — exclude own memories ALREADY placed via the authoritative
        // set (permanent + recent + predicted actually admitted). The old set was
        // built positionally (recent.filter by index) AND omitted `predicted`, so
        // a predicted memory could be re-admitted here — double-counting it into
        // memoriesIncluded and shipping it twice (once in `predicted`, once in
        // `memories`). Keying off includedOwnIds fixes both.
        const includedIds = includedOwnIds;

        // Bounded HNSW candidate pool (flair-bootstrap-scale-fix) — replaces
        // the full-corpus JS dot-product scan (`allMemories` × queryEmbedding,
        // O(org corpus size) every bootstrap). K formula (Kern-approved):
        // max(3 × expected fill, 5 × teammate count, MIN_CANDIDATE_POOL),
        // capped at MAX_CANDIDATE_POOL — deep enough for BOTH the
        // token-budget fill loop below AND collision's "one top cross-agent
        // hit per teammate" (flair#681), which draws from the SAME pool. If
        // the recall harness ever shows a delta, widen K — never add a
        // second scan (Kern's explicit instruction).
        const expectedFill = Math.max(1, Math.ceil(tokenBudget / AVG_LINE_TOKEN_ESTIMATE));
        const candidatePoolK = Math.min(
          MAX_CANDIDATE_POOL,
          Math.max(3 * expectedFill, 5 * teammateIds.length, MIN_CANDIDATE_POOL),
        );

        const candidates = await retrieveCandidates({
          queryEmbedding,
          conditions: [scope.condition],
          limit: candidatePoolK,
          // flair#1246 — ONE RANKER, ONE SCALE: this pass now invokes the
          // core in the SAME mode memory_search does (hybrid + q via the
          // shared hybridEnabled() selector, so the FLAIR_HYBRID_RETRIEVAL
          // kill-switch moves BOTH surfaces together — a split mode IS the
          // #1246 bug). HNSW-only here was an accident of early code, and it
          // made bootstrap's teammate picks diverge from search on the same
          // store+query: a record whose task-relevance is LEXICAL (exact task
          // terms in semantically-atypical prose) ranks BELOW bland-generic
          // noise on pure cosine (measured at N=21: on-task 0.5656 vs noise
          // 0.6086 — HNSW rank 6 while search fused it to rank 1), and at
          // field scale (corpus >> candidatePoolK) that inversion becomes
          // exclusion from the K-bounded pool entirely. The BM25 leg is the
          // rescue: it admits the record at lexical rank 1 and union-RRF
          // fusion carries it to the top, same as search. Perf (Kern-ratified
          // trade): the BM25 corpus scan this adds to the bootstrap path is
          // the same per-call scan every memory_search request already runs.
          hybrid: hybridEnabled(),
          // The lexical leg — same query text the embedding was computed
          // from, so both legs rank the same question (parity with search,
          // where `q` drives BM25 and the keyword bump).
          q: currentTask,
          // Per-set (this K-bounded pool only, never cross-applied to the
          // permanent/recent/predicted sets above) — see this function's
          // supersededIds docs above and resources/
          // semantic-retrieval-core.ts's own doc for the full caveat. The
          // unconditional past-validTo guard (inside retrieveCandidates)
          // stays the primary supersede defense either way.
          includeSuperseded: false,
          // Matches the original raw JS dot product exactly — no
          // composite/durability-recency weighting for bootstrap's own
          // relevance ranking.
          scoring: "raw",
          agentId,
          // Sherlock's non-negotiable belt: re-checked on every candidate
          // even though `conditions` already scoped the query.
          isAllowed: scope.isAllowed,
          ctx,
          // flair#744 slice 1: widen the projection with `provenance` (omitted
          // by the default select) ONLY when the trust block was requested, so
          // the block's provenance fields are populated for teammate/relevant
          // records without changing a non-trust bootstrap's fetch.
          select: includeTrust ? [...DEFAULT_SELECT, "provenance"] : undefined,
          // flair#744 slice 2 + confidence-band refinement: attach the absolute
          // cosine confidence (HNSW-leg, pre keyword bump) when abstention OR
          // the trust block is requested — abstention reads the best of it for
          // its verdict, and the per-memory trust block classifies each
          // task-relevant candidate's into a `matchQuality` band (Kern BINDING
          // condition 2: matchQuality needs `_semSimilarity`, so includeTrust
          // must turn this on too). Only the task-relevant candidates get a
          // similarity — permanent/recent/predicted come from raw own-scoped
          // reads with no retrieval score, so their block's matchQuality is
          // null (honest: those are lifecycle-window loads, not a retrieval
          // surface — confidence bands are a retrieval-surface feature). The
          // field is never returned raw (bootstrap renders memories as text
          // lines + a trust array), so no strip is needed here. Neither flag ⇒
          // candidates carry no `_semSimilarity` and the response is unchanged.
          withSemSimilarity: abstain || includeTrust,
        });

        // flair#744 slice 2: the best-match confidence for the abstention
        // decision — the max absolute cosine across the retrieved pool, read
        // ONLY from `_semSimilarity` (never any principal/authority field).
        // Abstention is unaffected by #1246's floor removal: it only ADDS an
        // explicit "nothing covered this" signal against its own GLOBAL
        // threshold (resources/abstention.ts), it never removes a memory the
        // reader would otherwise have seen.
        if (abstain) taskBestSimilarity = bestSemanticSimilarity(candidates);

        // flair#1246 — selection is FUSED RETRIEVAL RANK + the token budget
        // in the packing loop below; there is NO score floor (see the
        // TASK_RELEVANCE_FLOOR removal note by the pool constants above —
        // measured inert on the shipped embedding model). `candidates` arrive
        // best-first on the same ranking memory_search uses (fused RRF order
        // under hybrid; see retrieveCandidates), so this filter+map preserves
        // that order. `score` carries `_score` — the honest absolute cosine
        // (+ legacy keyword bump) per #985/#1267 — for display/reporting;
        // ORDER and score can legitimately disagree (a BM25 rank-1 rescue
        // outranks higher-cosine bland hits, which is the recall win).
        const scored = candidates
          .filter((m: any) => !includedIds.has(m.id))
          .map((m: any) => ({ memory: m, score: m._score }));

        // flair#681: the collision block's semantic surface — one candidate
        // per teammate (`scored` is sorted best-first by the fused retrieval
        // rank, so the first occurrence of a given `_source` IS that
        // teammate's best-ranked hit; its `score` field reports the honest
        // absolute cosine, which per #985/#1267 can disagree with rank).
        // `m._source` is only ever set for a cross-agent record (see
        // retrieveCandidates()'s `_source` tagging) — an own memory never
        // contributes here.
        const seenCollisionAgents = new Set<string>();
        for (const { memory: m, score } of scored) {
          if (!m._source || seenCollisionAgents.has(m._source)) continue;
          seenCollisionAgents.add(m._source);
          semanticTeammateMatches.push({ agentId: m._source, score, content: m.summary || m.content || "" });
        }

        // #550: split the scored, task-relevant set by origin. Own findings
        // go to `relevant` as before; any other in-org agent's non-private
        // record — already read-scoped by resolveReadScope(), no grant
        // required (`m._source` is only ever set for a cross-agent record) —
        // goes to the new `teammate` section so the agent can tell it apart
        // at a glance. Both draw from the SAME `tokenBudget` in one
        // score-ordered pass — highest-relevance memories win the remaining
        // budget regardless of which section they land in, so neither
        // section double-spends.
        for (const { memory: m } of scored) {
          const line = formatMemory(m, agentId);
          // flair#1199 (0.44.11) — build the STRUCTURED container object BEFORE
          // the budget check so the finding is charged the cost of what actually
          // ships (structured on the /mcp path), not its cheaper prose line. A
          // teammate finding's structured object (id + two ISO timestamps +
          // source + section) runs well over its prose line, and it — not the
          // prose — is what `tokenEstimate` measures on the connector path. This
          // is the fix for the teammate-findings blowout: charging prose but
          // shipping structured let extra findings ride outside the enforced
          // budget (see contentCost). Cross-agent findings (`m._source` set)
          // ship in `teammateFindings`; own findings in `memories`.
          const struct = m._source
            ? {
                id: m.id,
                content: m.content,
                durability: m.durability ?? null,
                createdAt: m.createdAt ?? null,
                updatedAt: m.updatedAt ?? null,
                subject: m.subject ?? null,
                source: m._source,
                section: "teammate",
              }
            : leanMemory(m, "relevant");
          const cost = contentCost(struct, line);
          // flair#1199 trust-admission — charge the trust block's real serialized
          // cost at the same moment as the content cost. The section (teammate vs
          // relevant) is decided by `m._source`, so build the entry with the right
          // section before the budget check.
          const trustEntry = includeTrust ? buildTrustEntry(m, m._source ? "teammate" : "relevant") : null;
          const trustCost = trustEntry ? estimateTokens(JSON.stringify(trustEntry)) : 0;
          if (cost + trustCost > tokenBudget) {
            // flair#1207 — a size-skip in the score-ordered task-relevant loop
            // is no longer silent: record it on the denominator matching the
            // record's origin (own → truncatedOwnIds, teammate → the separate
            // teammateFindingsTruncated), so a client can distinguish "no relevant
            // finding" from "a relevant finding didn't fit the budget".
            if (m._source) teammateFindingsTruncated++;
            else truncatedOwnIds.add(m.id);
            continue;
          }
          if (m._source) {
            sections.teammate.push(line);
            // flair#1199 — cross-agent teammate findings join their OWN
            // structured container (attributed via `source`), so a connector
            // consuming the containers still sees them when prose `context` is
            // off. Counted separately (teammateFindingsIncluded), NOT into
            // memoriesIncluded — that different-denominator mix is what let
            // included exceed available.
            includedTeammateFindings.push(struct);
            if (trustEntry) includedTrustMemories.push(trustEntry);
            tokenBudget -= cost + trustCost;
            teammateFindingsIncluded++;
          } else {
            sections.relevant.push(line);
            // flair#1182 — own task-relevant records join the `memories`
            // container.
            includedOwnMemories.push(struct);
            if (trustEntry) includedTrustMemories.push(trustEntry);
            tokenBudget -= cost + trustCost;
            includedOwnIds.add(m.id); // #1207 — count by unique own-memory id
          }
        }
      }
    }

    // --- 4c. Collision surfacing (flair#681 — "others in the room") ---
    // Joins two independently-scoped surfaces into a single ranked list:
    //   - Entity overlap (WorkspaceState + OrgEvent): exact vocabulary-string
    //     match, high-precision, no separate relevance score needed.
    //   - Semantic match (Memory, via #550/4 above): `semanticTeammateMatches`,
    //     each teammate's best-ranked hit from the fused retrieval pool
    //     (flair#1246 — no score floor) — reused as-is, no new scoring.
    // Gated on freshness (Presence, via the internal roster path) — a
    // teammate absent from the roster, or whose presenceStatus is "offline",
    // never surfaces regardless of how strong the entity/semantic match is.
    // Best-effort: any failure here (WorkspaceState/OrgEvent/Presence briefly
    // unavailable) must never break bootstrap's core memory context.
    try {
      // The caller's own declared entities: an explicit `entities` field on
      // the request (validated against the SAME closed vocabulary every
      // write path gates writes on — resources/entity-vocab.ts; invalid
      // entries are silently dropped, not a 400, since this is an optional
      // awareness hint), falling back to the caller's own most-recent
      // WorkspaceState row's `entities` when not declared. Reading the
      // caller's OWN WorkspaceState rows is not a scoping concern (an agent
      // always has read access to its own data) — this raw read exists
      // purely because MemoryBootstrap.ts already reads every other table
      // (Soul/Agent/Memory/Relationship/OrgEvent) directly, the same idiom.
      let callerEntities: string[] = Array.isArray(data?.entities)
        ? data.entities.filter((e: unknown) => isValidEntity(e))
        : [];

      if (callerEntities.length === 0) {
        const ownRows = withDetachedTxn(ctx, () => (databases as any).flair.WorkspaceState.search({
          conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }],
          select: ["entities", "timestamp"],
        }));
        let latestEntities: string[] = [];
        let latestTs = "";
        for await (const row of ownRows as AsyncIterable<any>) {
          if (!Array.isArray(row.entities) || row.entities.length === 0) continue;
          if ((row.timestamp || "") > latestTs) {
            latestTs = row.timestamp || "";
            latestEntities = row.entities;
          }
        }
        callerEntities = latestEntities;
      }

      const entityMatches: EntityMatchInput[] = [];

      if (callerEntities.length > 0) {
        const sinceIso = new Date(Date.now() - COLLISION_WINDOW_DAYS * 24 * 3600_000).toISOString();
        // buildEntityMatchCondition, NOT a hand-rolled OR wrapper: Harper's
        // query engine throws ("An 'or' operator requires at least two
        // conditions") for a single-entity OR condition — see collision-lib.ts's
        // doc. A single declared entity is the common case, so this matters.
        const entityCondition = buildEntityMatchCondition(callerEntities);
        const byAgent = new Map<string, EntityMatchInput>();

        // WorkspaceState — the INTERNAL server-side path (Sherlock Option 1,
        // binding per the K&S verdict): the RAW generated table object,
        // never the exported `WorkspaceState` resource class — that class's
        // search() re-applies strict per-agent scoping keyed off THIS
        // caller's own identity, which would just filter every teammate's
        // row back out. This does NOT broaden WorkspaceState's general
        // (still per-agent, still 403) read model — see resources/
        // AttentionQuery.ts's module doc for the full rationale (the exact
        // pattern this reuses).
        const wsRows = withDetachedTxn(ctx, () => (databases as any).flair.WorkspaceState.search({
          conditions: [entityCondition, { attribute: "timestamp", comparator: "greater_than_equal", value: sinceIso }],
          select: ["agentId", "entities", "summary", "taskId", "timestamp"],
        }));
        for await (const row of wsRows as AsyncIterable<any>) {
          if (row.agentId === agentId) continue; // exclude self
          const overlap = (Array.isArray(row.entities) ? row.entities : []).filter((e: string) => callerEntities.includes(e));
          if (overlap.length === 0) continue;
          const candidate: EntityMatchInput = {
            agentId: row.agentId, entities: overlap, summary: row.summary ?? null,
            taskId: row.taskId ?? null, timestamp: row.timestamp, source: "workspace",
          };
          const existing = byAgent.get(row.agentId);
          if (!existing || existing.timestamp < candidate.timestamp) byAgent.set(row.agentId, candidate);
        }

        // OrgEvent — org-open read model, no per-agent scoping to respect
        // (mirrors resources/AttentionQuery.ts's queryOrgEvent).
        const evRows = withDetachedTxn(ctx, () => (databases as any).flair.OrgEvent.search({
          conditions: [entityCondition, { attribute: "createdAt", comparator: "greater_than_equal", value: sinceIso }],
          select: ["authorId", "entities", "summary", "createdAt", "expiresAt"],
        }));
        const now = Date.now();
        for await (const row of evRows as AsyncIterable<any>) {
          if (row.authorId === agentId) continue; // exclude self
          if (row.expiresAt && new Date(row.expiresAt).getTime() < now) continue;
          const overlap = (Array.isArray(row.entities) ? row.entities : []).filter((e: string) => callerEntities.includes(e));
          if (overlap.length === 0) continue;
          const candidate: EntityMatchInput = {
            agentId: row.authorId, entities: overlap, summary: row.summary ?? null,
            taskId: null, timestamp: row.createdAt, source: "event",
          };
          const existing = byAgent.get(row.authorId);
          if (!existing || existing.timestamp < candidate.timestamp) byAgent.set(row.authorId, candidate);
        }

        entityMatches.push(...byAgent.values());
      }

      // Freshness gate: the SAME internal Presence roster path #678
      // established (never the raw table) — see resources/
      // presence-internal.ts. `resolveAgentAuth` is called independently
      // here (not reusing the manual agentId-scoping derivation above,
      // which is deliberately narrow per its own bug-fix comment) purely to
      // build the delegation verdict this internal read needs.
      const collisionAuth = await resolveAgentAuth(ctx);
      const roster = await getPresenceRoster(collisionAuth);
      const freshByAgent = freshPresenceByAgent(roster);

      const collisionEntries = buildCollisionEntries(entityMatches, semanticTeammateMatches, freshByAgent, agentId);
      for (const entry of collisionEntries.slice(0, MAX_COLLISION_ENTRIES)) {
        const line = `- ${entry.line}`;
        const cost = estimateTokens(line);
        if (cost > tokenBudget) continue;
        sections.collision.push(line);
        tokenBudget -= cost;
      }
    } catch {
      // Collision surfacing is best-effort awareness, never a hard
      // dependency — WorkspaceState/OrgEvent/Presence being briefly
      // unavailable must not break bootstrap's core memory context.
    }

    // --- 5. Recent OrgEvents for this agent ---
    try {
      const eventSince = data?.lastBootAt
        ? new Date(data.lastBootAt)
        : new Date(Date.now() - 24 * 3600_000);
      const eventSinceStr = eventSince.toISOString();
      const eventResults: any[] = [];

      for await (const event of (databases as any).flair.OrgEvent.search()) {
        if (!event.createdAt || event.createdAt < eventSinceStr) continue;
        if (event.expiresAt && new Date(event.expiresAt) < new Date()) continue;
        const targets = event.targetIds;
        const isRelevant = !targets || targets.length === 0 || targets.includes(agentId);
        if (!isRelevant) continue;
        // flair#1200 — suppress zero-row no-op auto-heal migration events at
        // render. On a healthy store every boot emits a "migration graph-heal
        // success (0 rows processed)" ledger event beside an "HNSW graph-heal:
        // recall verified healthy" observability event — near-identical, zero
        // signal, and (as of #1199) token-charged. Filtered HERE only: the
        // ledger still records every migration on the table (invariant IV is
        // untouched — this is a display filter, never a write-path change).
        if (isZeroRowNoOpEvent(event)) continue;
        eventResults.push(event);
      }

      // flair#1200 — collapse byte-identical duplicate events before rendering.
      // The same logical event can land in the table more than once (a producer
      // that double-fires, or the same broadcast emitted from two paths); each
      // physical row has a distinct id/createdAt (OrgEvent.post keys the id off
      // a millisecond timestamp), so they aren't caught by primary-key upsert
      // and render as exact dupes. Org-event slots are scarce, so dedup BEFORE
      // admission — otherwise ~half the slots are wasted on duplicates. Keyed on
      // the CONTENT (kind + summary + detail + targets), keeping the most-recent
      // occurrence per signature.
      const eventBySignature = new Map<string, any>();
      for (const evt of eventResults) {
        const sig = JSON.stringify([
          evt.kind ?? "",
          evt.summary ?? "",
          evt.detail ?? "",
          Array.isArray(evt.targetIds) ? [...evt.targetIds].sort() : (evt.targetIds ?? null),
        ]);
        const prev = eventBySignature.get(sig);
        if (!prev || (evt.createdAt || "") > (prev.createdAt || "")) eventBySignature.set(sig, evt);
      }
      // flair#1199 — admit events in RECENCY order (most recent first, the
      // score-analogue for events) against the SHARED tokenBudget, capped at
      // `maxEvents`. Before #1199 the events array was assembled uncounted and
      // NEVER charged: a maxTokens=4000 request serialized at 6286 (+57%), the
      // bulk being 10 events each shipping a `detail` JSON. Now each event's
      // REAL serialized cost (the structured object that actually ships — lean by
      // default, `detail` only under includeEventDetail) is charged against the
      // remaining budget, so events respect maxTokens the same way every other
      // content section does. An event that doesn't fit is skipped, not silently
      // over-budget; smaller later events may still fit (hence continue, not
      // break), and admission stops at the maxEvents cap.
      const eventCap = Number.isFinite(maxEvents) && (maxEvents as number) >= 0
        ? Math.floor(maxEvents as number)
        : MAX_ORG_EVENTS;
      const dedupedEvents = [...eventBySignature.values()]
        .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      for (const evt of dedupedEvents) {
        if (sections.events.length >= eventCap) break;
        // The structured object a connector actually reads (flair#1206). Lean by
        // default; `detail` (the verbose migration-internals/summary-restating
        // JSON) only when explicitly requested. Optional fields are omitted when
        // absent so the object stays compact.
        const structured: Record<string, unknown> = {
          id: evt.id,
          kind: evt.kind,
          summary: evt.summary,
          ...(includeEventDetail && evt.detail != null ? { detail: evt.detail } : {}),
          ...(Array.isArray(evt.targetIds) && evt.targetIds.length > 0 ? { targetIds: evt.targetIds } : {}),
          createdAt: evt.createdAt ?? null,
          ...(evt.scope != null ? { scope: evt.scope } : {}),
        };
        // Charge the REAL serialized cost of what ships (structured object on the
        // /mcp path; the prose line is a subset of it). This is the #1199 fix:
        // events are content and must be budgeted like content.
        const cost = estimateTokens(JSON.stringify(structured));
        if (cost > tokenBudget) continue;
        const elapsed = Date.now() - new Date(evt.createdAt).getTime();
        const mins = Math.floor(elapsed / 60_000);
        const relTime = mins < 60 ? `${mins}min ago` : `${Math.floor(mins / 60)}h ago`;
        sections.events.push(`- ${evt.kind}: ${evt.summary} (${relTime})`);
        // Same admitted event ⇒ `sections.events` (the count), the `tokenEstimate`
        // charge, and the structured delivery all key off ONE thing.
        includedEvents.push(structured);
        tokenBudget -= cost;
      }
    } catch {
      // non-fatal: OrgEvent table may not exist yet
    }

    // flair#1207 — derive the own-memory counters from the unique-id sets so the
    // invariant memoriesIncluded + memoriesTruncated <= memoriesAvailable holds.
    // `truncated` counts only own memories that were budget-skipped AND never
    // ultimately admitted (a memory skipped in `recent` but later admitted via
    // the task-relevant loop is INCLUDED, not truncated) — so included/truncated
    // are disjoint subsets of the own corpus (memoriesAvailable), never
    // double-counting the same physical memory across sections.
    memoriesIncluded = includedOwnIds.size;
    let memoriesTruncatedUnique = 0;
    for (const id of truncatedOwnIds) if (!includedOwnIds.has(id)) memoriesTruncatedUnique++;
    memoriesTruncated = memoriesTruncatedUnique;
    // flair#1207 — the teammate MATCH POOL considered (flair#1246: the
    // cross-agent records that entered the scored set — drawn from the
    // K-bounded fused-rank candidate pool, no relevance floor): every matched
    // teammate finding is EITHER included OR budget-truncated, so this equals their sum.
    // Reporting it anchors `teammateFindingsTruncated` as "relevant-but-no-budget"
    // rather than an unexplained large number beside a small `included`.
    const teammateFindingsMatched = teammateFindingsIncluded + teammateFindingsTruncated;

    // --- Build context string ---
    const parts: string[] = [];

    if (sections.soul.length > 0) {
      parts.push("## Identity\n" + sections.soul.join("\n"));
    }
    if (sections.skills.length > 0) {
      parts.push("## Active Skills\n" + sections.skills.join("\n"));
    }
    if (sections.team.length > 0) {
      parts.push("## Team\n" + sections.team.join("\n"));
    }
    if (sections.permanent.length > 0) {
      parts.push("## Core Principles\n" + sections.permanent.join("\n"));
    }
    if (sections.recent.length > 0) {
      parts.push("## Recent Context\n" + sections.recent.join("\n"));
    }
    if (sections.predicted.length > 0) {
      parts.push("## Predicted Context\n" + sections.predicted.join("\n"));
    }
    if (sections.relationships.length > 0) {
      parts.push("## Active Relationships\n" + sections.relationships.join("\n"));
    }
    if (sections.relevant.length > 0) {
      parts.push("## Relevant Knowledge\n" + sections.relevant.join("\n"));
    }
    // #550: teammate findings relevant to the current task — right after the
    // agent's own task-relevant knowledge. Empty section renders nothing
    // (no header) so a bootstrap with no task-relevant teammate findings for
    // this task looks exactly as it did before this feature.
    if (sections.teammate.length > 0) {
      parts.push("## Teammate findings relevant to your task\n" + sections.teammate.join("\n"));
    }
    // flair#681: the attention-plane flagship — "the office moment". Empty
    // section renders nothing (no header), same convention as every other
    // optional section here: no entity/semantic overlap with a fresh
    // teammate looks exactly like bootstrap did before this feature.
    if (sections.collision.length > 0) {
      parts.push("## Others in the room\n" + sections.collision.join("\n"));
    }
    if (sections.events.length > 0) {
      parts.push("## Recent Org Events\n" + sections.events.join("\n"));
    }

    const fullContext = parts.join("\n\n");
    // flair#1199 — the structured containers are canonical; `context` is a prose
    // MIRROR of the same bytes. When includeContext is off (the /mcp default),
    // ship a compact structural pointer instead of re-embedding every body — so
    // no field's bytes cross the wire twice. Always a string, so a client can
    // still tell an empty instance from an unsupported one. When on, the prose
    // is the full assembled context (the resource/REST/CLI behaviour, unchanged).
    const context = includeContext
      ? fullContext
      : (fullContext.length === 0
          ? ""
          : `Structured payload in soul/memories/predicted/teammateFindings `
            + `(${memoriesIncluded} own + ${teammateFindingsIncluded} teammate memories, `
            + `${sections.soul.length} soul entries). Pass includeContext:true for the assembled prose context.`);
    const soulTokens = sections.soul.reduce((sum, line) => sum + estimateTokens(line), 0);
    // #1199 — memory-line token spend (informational breakdown), independent of
    // the reserve/soul now sharing the budget. Sum of the rendered memory lines.
    const memoryTokens = [
      ...sections.permanent, ...sections.recent, ...sections.predicted,
      ...sections.relevant, ...sections.teammate,
    ].reduce((sum, line) => sum + estimateTokens(line), 0);

    // flair#744 slice 1 — opt-in per-memory trust block. Bootstrap renders
    // memories as text lines rather than result objects, so the block is
    // surfaced as a `trust` array of self-contained entries (each carries its
    // own `id` to correlate to a rendered line), one per INCLUDED memory. Built
    // HERE, in the response tail, strictly after all read-scope resolution and
    // purely for the response — never consulted for any authority decision
    // (#735-spirit zero-authority invariant). Default OFF ⇒ the `trust` key is
    // absent ⇒ the response is byte-identical to pre-slice-1. flair#1201 — each
    // entry carries its `section` so `matchQuality: null` on a lifecycle section
    // reads as "not a retrieval surface", not as a scoring failure on the
    // caller's own records. flair#1225 (0.44.11) — the null on a lifecycle
    // section is now SELF-EXPLAINING (matchQualityNote below), not just legible
    // via `section`.
    // flair#1199 trust-admission — the trust entries were built (and their real
    // serialized cost charged) at admission time via buildTrustEntry, so the
    // response tail just ships them as-is. The #1225 matchQualityNote logic now
    // lives in buildTrustEntry (single source of truth — the charged size and
    // the shipped size can never drift).
    const trust = includeTrust ? includedTrustMemories : undefined;

    // flair#744 slice 2 — opt-in abstention verdict for the task-relevance
    // surface. Present ONLY when `abstain` is requested (byte-identical to
    // pre-slice-2 otherwise); scoped to whether any memory covered
    // `currentTask` (bestScore null ⇒ no task/embedding ⇒ abstained:false). The
    // decision reads only the confidence number — never a principal — against
    // the single GLOBAL threshold.
    const abstention = abstain ? evaluateAbstention(taskBestSimilarity) : undefined;

    // flair#1182 (part 1) — resolved identity + read-scope descriptor. Reveals
    // ONLY the caller's own resolved identity/scope (who the server decided the
    // caller is, and the read model applied to them) — never another agent's
    // data. Would have made the #1181 read-gate bug a one-call diagnosis.
    const scopeInfo = {
      agentId,
      isAdmin: callerIsAdmin,
      // The read model resolveReadScope(agentId) enforces for this caller: the
      // caller's own records (any visibility) plus every other in-org agent's
      // non-private record. Keep in sync with resources/memory-read-scope.ts.
      reads: "own-and-org-non-private",
    };

    // flair#1182 (part 1) — currentTask is what turns on task-relevant
    // retrieval, teammate findings and collision surfacing. When it's absent or
    // blank, say so in the response so a caller learns the knob exists (present
    // ONLY when absent/blank — a provided task needs no hint).
    const taskProvided = typeof currentTask === "string" && currentTask.trim().length > 0;
    const currentTaskHint = taskProvided
      ? undefined
      : "No currentTask was provided. Pass currentTask (a short description of what you're working on) to enable task-relevant memory retrieval, teammate findings, and collision surfacing.";

    // flair#1199 — when `subjects` were provided but nothing surfaced in
    // `predicted`, say WHY (like currentTaskHint), so an empty `predicted: []`
    // next to a non-empty `subjects` doesn't read as broken. Predicted fills
    // from your OWN non-permanent memories whose `subject` matches one of the
    // provided subjects; it stays empty until you've tagged memories that way.
    const predictedHint = (predictedSubjects.length > 0 && includedPredicted.length === 0)
      ? `No memories tagged with the requested subjects (${predictedSubjects.join(", ")}) were found. `
        + `predicted surfaces your own non-permanent memories whose subject matches one of the provided `
        + `subjects — it fills as you store memories tagged with these subjects.`
      : undefined;

    // flair#1182 (0.44.11) — GENERALIZE the empty-container "say why" rule
    // beyond predictedHint. `events: []` (deliberate no-op filtering) was
    // byte-indistinguishable from the 0.44.8 silent-drop regression, where a
    // container that SHOULD have had content shipped empty — a connector could
    // only tell the difference by diffing against a previous payload. The rule
    // (now applied consistently across the structured containers): any container
    // that ships EMPTY carries a short hint naming WHY it is empty and what
    // fills it, so "deliberately empty" is never confused with "silently
    // dropped". Present ONLY when the container is empty (a populated container
    // needs no hint), so a healthy payload is unchanged.

    // events: [] — no org event in the lookback window was relevant to the
    // caller after zero-row no-op auto-heal filtering (#1200). Present-but-empty
    // by design, not a drop.
    const eventsHint = includedEvents.length === 0
      ? "No org events in the lookback window were relevant to you (org-wide, or targeted at you) "
        + "after zero-row no-op auto-heal filtering. This container is present-but-empty by design, not dropped."
      : undefined;

    // teammateFindings: [] — name WHICH legitimate empty this is (no task → no
    // retrieval; matched-but-budget-truncated; or no cross-agent record entered
    // the task-relevant retrieval pool at all — flair#1246: there is no
    // relevance floor, so "empty" means empty retrieval, never a score cut),
    // so it never reads as a silent drop.
    const teammateFindingsHint = includedTeammateFindings.length === 0
      ? (!taskProvided
          ? "No teammateFindings: cross-agent findings are retrieved against your currentTask, and none was provided. "
            + "Pass currentTask to populate this."
          : teammateFindingsTruncated > 0
            ? `No teammateFindings fit the token budget: ${teammateFindingsTruncated} relevant cross-agent finding(s) `
              + "were retrieved but budget-truncated. Raise maxTokens to include them."
            : "No cross-agent (teammate) memory entered the task-relevant retrieval pool for this currentTask. "
              + "This container is present-but-empty by design, not dropped.")
      : undefined;

    const responseBody: Record<string, unknown> = {
      context,
      // flair#1182 (part 1) — always-present self-describing keys: who the
      // server resolved the caller as, the read model applied, and the caller's
      // own soul/memories/predicted as structured containers (empty `{}`/`[]`,
      // never absent, so "empty" is distinguishable from "unsupported").
      agentId,
      scope: scopeInfo,
      soul: soulMap,
      memories: includedOwnMemories,
      predicted: includedPredicted,
      // flair#1199 — cross-agent teammate findings as a structured container
      // (always present, `[]` when none), so a connector that consumes the
      // containers still gets them when prose `context` is off.
      teammateFindings: includedTeammateFindings,
      // flair#1206 — org events as a structured container (always present, `[]`
      // when none, same self-describing-empty-state pattern as the containers
      // above). Before #1206 events lived ONLY in the prose `context`, so at the
      // /mcp default (includeContext=false) they were counted+measured but never
      // delivered. Deduped (#1200) and targetIds-scoped (same set as the prose
      // "## Recent Org Events" lines), so count/charge/delivery all agree.
      events: includedEvents,
      ...(currentTaskHint ? { currentTaskHint } : {}),
      ...(predictedHint ? { predictedHint } : {}),
      // flair#1182 (0.44.11) — empty-container hints, present only when the
      // container ships empty (see above), so a deliberately-empty container is
      // never confused with a silent drop.
      ...(eventsHint ? { eventsHint } : {}),
      ...(teammateFindingsHint ? { teammateFindingsHint } : {}),
      ...(trust ? { trust } : {}),
      ...(abstention ? { abstention } : {}),
      sections: {
        soul: sections.soul.length,
        skills: sections.skills.length,
        team: sections.team.length,
        permanent: sections.permanent.length,
        recent: sections.recent.length,
        predicted: sections.predicted.length,
        relationships: sections.relationships.length,
        relevant: sections.relevant.length,
        teammate: sections.teammate.length,
        collision: sections.collision.length,
        events: sections.events.length,
      },
      soulTokens,
      memoryTokens,
      // flair#1199 — the content-selection budget this response was built
      // against (echoed so a connector can relate tokenEstimate to the budget it
      // asked for — and so the conformance tokenEstimate<=maxTokens invariant is
      // self-contained). Defaults to 4000 when unset.
      maxTokens,
      // flair#1199 — own memories included (denominator: memoriesAvailable, also
      // own-scoped). flair#1207 — DERIVED from unique own-memory ids, so
      // memoriesIncluded + memoriesTruncated <= memoriesAvailable always holds.
      memoriesIncluded,
      memoriesAvailable,
      // Cross-agent teammate findings included — a SEPARATE denominator, labelled
      // so it's never confused with the own-memory counters.
      teammateFindingsIncluded,
      memoriesTruncated,
      // flair#1207 — teammate findings skipped for size in the task-relevant loop
      // (own size-skips there feed truncatedOwnIds). Surfacing this makes a
      // size-skip self-describing: "a relevant teammate finding didn't fit" is
      // now distinguishable from "no relevant teammate finding".
      teammateFindingsTruncated,
      // flair#1207 — the teammate match POOL considered (flair#1246: entered
      // the scored fused-rank retrieval set; no relevance floor).
      // teammateFindingsIncluded + teammateFindingsTruncated ==
      // teammateFindingsMatched, so "truncated" reads as "relevant-but-no-budget"
      // against a stated pool, not an unanchored large number.
      teammateFindingsMatched,
    };

    // flair#1199 — tokenEstimate must reflect the ACTUAL serialized payload the
    // caller receives (the structured containers included), not just the prose
    // `context`. The old `soulTokens + memoryTokens` counted only the context
    // string, so it under-reported by ~2× once the structured fields shipped
    // alongside. Measured over the assembled body (the ~1-line tokenEstimate
    // field it omits is negligible). CAP CONTRACT: this is an HONEST report of
    // the real serialized size. Every CONTENT section — soul, memories, findings,
    // AND events (flair#1199) — is now gated against the shared `maxTokens`
    // budget, so no section blows the budget with uncounted content the way the
    // 0.44.9 events array did (maxTokens=4000 → 6286). flair#1199 (0.44.11): on
    // the /mcp connector path each content item is charged its STRUCTURED shipped
    // cost — the same bytes tokenEstimate measures — so tokenEstimate exceeds
    // `maxTokens` only by the FIXED structural JSON scaffolding (container
    // keys/braces, counters, sections map, hints, char/4 rounding): genuine
    // payload the caller pays for, small and bounded, NOT uncounted content. The
    // connector-conformance suite asserts tokenEstimate <= maxTokens within a
    // small tolerance for exactly that scaffolding. On the PROSE path
    // (includeContext=true) the payload ALSO carries the structured mirror, so
    // tokenEstimate legitimately exceeds `maxTokens` by that mirror — do NOT
    // "fix" THAT overrun by shrinking prose selection: that is the #1199→#1207
    // regression (it dropped relevant findings, charging a flat per-item overhead
    // against the content budget). If the real payload consistently overruns for
    // a use case, raise `maxTokens`.
    const tokenEstimate = estimateTokens(JSON.stringify(responseBody));
    return { ...responseBody, tokenEstimate };
  }
}
