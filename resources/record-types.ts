/**
 * record-types.ts — the RecordType registry (record-types slice 2, flair#520).
 *
 * ─── What this is ────────────────────────────────────────────────────────
 * The declared, PR-reviewed policy layer over resources/record-type-kit.ts
 * (slice 1, flair#729): a static `RECORD_TYPES` map naming, for every
 * flair-owned table, WHICH read-scope model it uses, WHICH no-forge
 * attribution idiom it stamps on writes, whether it stamps provenance,
 * whether it carries an embedding column, and whether it participates in
 * federation — the five capabilities the flair#520 design draft's §4 laid
 * out (identity / read-scope / provenance / semantic recall / REM), plus
 * the attribution split slice 1 surfaced (four named idioms, not one) and
 * the federation/MCP-shape refinements Kern and Sherlock's DESIGN REVIEW
 * landed on the issue thread.
 *
 * This module is DATA, not a framework: `RecordTypePolicy` is a plain
 * interface, `RECORD_TYPES` is a plain object literal. It does not derive
 * MCP tools (that is slice 3 — see the `mcp` field's own doc below for why
 * its SHAPE lands now without any consumer reading it yet), does not wire
 * embeddings (Memory's embedding logic stays exactly where slice 1 left it
 * — dedup-gate-entangled inline code in resources/Memory.ts, not routed
 * through this registry), and does not change what Federation.ts/src/cli.ts
 * actually sync (their hardcoded table lists are untouched — see the
 * `federation` field's doc). Every field on every one of the five entries
 * below documents CURRENT shipped behavior; none of them CHANGE it.
 *
 * ─── The static-registry invariant (non-negotiable) ───────────────────────
 * Per §3 of the flair#520 design draft and Sherlock/Kern's unanimous
 * verdict: this registry is STATIC, COMPILED, and PR-REVIEWED — never
 * runtime-populated. A new entry lands via a PR to THIS file, same trust
 * level as an entry in resources/mcp-tools.ts's TOOLS map. No component,
 * consumer, or plugin can add itself to `RECORD_TYPES` at boot. This is the
 * structural rejection of the exact failure mode Sherlock's review closed
 * for cause on flair#541: Harper's native-MCP application profile
 * auto-exposing every resource as a tool, with no allow/deny, at runtime.
 * A dynamic `RECORD_TYPES` would reproduce that failure one layer up. If
 * this ever needs to become an out-of-tree-extensible SDK (flair#520 §9
 * calls that "a plausible later shape, not v1"), the review bar for that
 * relaxation must be at least as high as the original #520/#541 decision.
 *
 * ─── Field-by-field rationale ─────────────────────────────────────────────
 *
 * `identity` — always "gated" for all five entries today. `makeAuthGate()`
 * (record-type-kit.ts) only implements the "gated" posture (resolveAgentAuth
 * + allowVerified — verified agents, admins, and trusted internal calls
 * pass; anonymous HTTP is denied). "internal-only" is reserved for a future
 * system table with no agent-facing surface at all — nothing wires it yet;
 * a table setting it today would be a registry error, not a live capability.
 *
 * `readScope` — three values, not the two the original §4 draft proposed.
 * "owner-only" and "open-within-org" are the two K&S-approved models
 * (Relationship/WorkspaceState vs. Memory). The THIRD value, "none", names
 * a real state that already ships and that record-type-kit.ts's own file
 * header calls out explicitly: OrgEvent and Soul have NO get()/search()
 * override at all — any verified agent (past the identity gate) reads
 * every row, unscoped by owner, with no visibility field in play. That is
 * neither "owner-only" (it is strictly broader — no ownership filter at
 * all) nor "open-within-org" (there is no visibility-based private
 * exception — nothing is excluded). Labeling OrgEvent/Soul "owner-only" to
 * force them into the K&S-approved binary would be a FALSE registry entry —
 * exactly the kind of drift a policy registry exists to prevent, and worse
 * than just leaving the gap undocumented. This is a deliberate, disclosed
 * extension of the flair#520 design draft's §4 shape (flagged in the
 * slice-2 report for K&S to weigh in on), not a silent reinterpretation of
 * their "owner-only | open-within-org" verdict.
 *
 * `readScope` narrowing is a BREAKING CHANGE, not covered by the
 * additive-only discipline the design draft's §8 states for every other
 * field. Per Sherlock's DESIGN REVIEW comment (explicitly concurred by
 * Kern): flipping `open-within-org` → `owner-only`, or `none` → either
 * narrower model, would retroactively hide rows other agents could already
 * read — the same class of scrutiny as any other access-narrowing decision,
 * called out separately here because it is easy to mis-file as "just
 * editing a registry constant." WIDENING (owner-only → open-within-org, or
 * either → none) is a normal, reviewable capability-addition PR. NARROWING
 * requires the review bar of a genuine access-removal change: confirm
 * nothing currently depends on the wider read, and treat it with the same
 * weight as shipping a new private-visibility default.
 *
 * Review-gate tiering (Kern/Sherlock DESIGN REVIEW, Q1): a new entry with
 * `readScope: "owner-only"` ships on the standard architecture-review bar.
 * `readScope: "open-within-org"` (or, by the same logic, `"none"` — an even
 * wider grant than open-within-org for records with no visibility concept
 * at all) requires Sherlock's explicit security sign-off on the read-scope
 * decision specifically, the same scrutiny Memory's own visibility work
 * got. This registry's job is to make that decision a single reviewable
 * line per type; the review-bar tiering itself is a process discipline for
 * whoever reviews the PR, not something this module enforces in code.
 *
 * `attribution` — the four named `AttributionMode` idioms from
 * record-type-kit.ts (`validate-truthy` / `validate-strict` /
 * `stamp-default` / `stamp-strict`), keyed per WRITE METHOD
 * (`post`/`put`), not one mode per type. This is the concrete thing slice 1
 * surfaced that the original §4 draft did not anticipate: WorkspaceState
 * and OrgEvent use a DIFFERENT idiom on post() (`stamp-default` — silent
 * unconditional overwrite, never rejects) than on put()
 * (`validate-strict` — rejects a mismatch, including an absent field).
 * Collapsing that to one type-level `attributionMode` field would either be
 * wrong for one of the two methods or would require silently converging
 * post() onto put()'s stricter idiom — a real behavior change flagged but
 * explicitly deferred by Flint's post-slice-1 comment on #520 ("Sherlock
 * flagging stamp-default → stamp-strict convergence... Registry slice
 * follows" — convergence is a FUTURE decision, not made here). Each
 * sub-field is optional because not every table's write path calls
 * `stampAttribution` on both methods: Relationship has no post() override
 * at all (only `put`), so `attribution.post` is absent, not a placeholder.
 * The stamped attribute name is always `ownerField` above — no type uses a
 * different field for attribution vs. ownership scoping.
 *
 * `provenance` — true only for Memory and Relationship (the two tables that
 * call `buildProvenance()` today and carry a nullable `provenance: String`
 * schema field). WorkspaceState/OrgEvent/Soul are `false`: not an oversight
 * — nobody wired it, and none of the three declare the schema field, so
 * flipping this to `true` without a schema migration would be a lie the
 * registry tells about what actually gets stamped.
 *
 * `embedding` — set only for Memory (`content` is the embedded field; the
 * type has its own exposed semantic-search tool today — `memory_search` /
 * resources/SemanticSearch.ts — hence `exposedSearch: true`). Declared for
 * documentation ONLY in this slice: Memory's actual embedding logic stays
 * exactly where slice 1's kit-extraction doc said it would stay — inline in
 * resources/Memory.ts, dedup-gate-entangled, NOT routed through this
 * registry or through a `stampEmbedding()` kit helper. Wiring is a later
 * slice's job; this field exists so that slice doesn't need a breaking
 * schema change to the policy shape when it lands (same reserved-flag
 * pattern as `remEligible`).
 *
 * `remEligible` — MUST be `false` for every entry in v1 (typed as the
 * literal `false`, not `boolean`, so a stray `true` is a compile error, not
 * just a runtime policy mistake). REM's nightly gather step
 * (specs/FLAIR-NIGHTLY-REM.md §11) is hardcoded to `GET /Memory?agentId=…`
 * — single table, single agent, by construction. There is no multi-table
 * distillation input path to opt into yet; the field exists so a future
 * REM generalization doesn't require a breaking schema change to every
 * existing entry.
 *
 * `federation` — "included" or "excluded", naming whether the type's rows
 * currently CAN leave this instance via federation sync at all. This is
 * DECLARATIVE ONLY in this slice, same discipline as `embedding` above:
 * Federation.ts's `FederationSync.post()` table map and src/cli.ts's
 * `runFederationSyncOnce`'s push table list are the actual, unchanged,
 * hardcoded source of truth (`["Memory", "Soul", "Agent", "Relationship"]`)
 * — this field documents what that hardcoded list already does per type,
 * it does not drive it. Memory/Relationship/Soul are "included" because
 * they are already in both lists (Memory's push additionally excludes
 * `private`-visibility rows via classifyRecord — a finer-grained rule this
 * boolean-ish field does not attempt to express). WorkspaceState/OrgEvent
 * are "excluded" because they are in neither list today — org events and
 * workspace state never leave the instance.
 *
 * For any FUTURE (non-core, consumer-defined) type, `federation` MUST be
 * `"excluded"` — per Sherlock's DESIGN REVIEW (Q6, Kern concurring):
 * DESIGN.md sequenced Memory's own open-within-org read AFTER federation
 * hardening specifically so within-instance openness wouldn't outrun the
 * one hard cross-instance boundary it depends on. A new type's registration
 * must not silently inherit whatever Federation.ts's push filter does or
 * doesn't already exclude — the filter does not know about new tables at
 * all. Opting a new type into federation requires updating that filter
 * FIRST, in its own reviewed PR, never the other order. This registry does
 * not enforce that sequencing in code (there is no derivation from this
 * field yet — see above); it is a review-time invariant for whoever adds
 * the next entry.
 *
 * `mcp` — DECLARED AND ENFORCED as of slice 3 (flair#520 design review
 * round 2, issue comment 2026-07-18 — Kern APPROVE all four asks, Sherlock
 * APPROVE with one refinement, both unanimous). This field is the reviewed
 * DECLARATION of the MCP surface, not a runtime generator: resources/
 * mcp-tools.ts's hand-written `TOOLS` map stays the actual dispatch table.
 * The slice-3 design round audited all 12 shipped tools and found only 5
 * are simple table-verb wrappers (memory_get/store/delete, soul_get/set —
 * and even the soul pair does bespoke `agentId:key` id synthesis); the rest
 * are composite or bespoke (bootstrap, attention, memory_search,
 * memory_update, record_usage) and cannot be generated from a registry
 * entry without either losing schema/behavior specifics or duplicating the
 * handler. Generating the 5 simple tools would also touch the
 * security-critical `/mcp` dispatch path for zero behavior change, and
 * runtime derivation from a registry is structurally the same failure
 * flair#541 closed for cause (Harper's native-MCP auto-exposing every
 * resource as a tool) one layer up. What declare-and-enforce buys instead:
 * any PR that adds or removes an MCP tool must now also touch a policy
 * chokepoint — either a `RECORD_TYPES.<Table>.mcp` declaration (table-verb
 * tools) or the `COMPOSITE_MCP_TOOLS` allowlist below (everything else) —
 * enforced bidirectionally by test/unit/mcp-surface-tripwire.test.ts, or CI
 * fails. Declaring a verb here does not create a tool; it documents (and,
 * via the tripwire, locks in) a tool resources/mcp-tools.ts already
 * implements.
 *
 * Per Kern's DESIGN REVIEW refinement (Sherlock's Q5, Kern concurring): NOT
 * a flat `verbs` array. `readVerbs` (get/search — same review bar as adding
 * the type itself, since they exercise the same `readScope` the REST
 * surface already exposes) is structurally separate from `writeVerbs`
 * (store/delete/update — a write/delete/update surface over MCP, requiring
 * its own explicit line-item sign-off). `"update"` was added to the
 * `writeVerbs` union in slice 3 — APPROVED by both Kern and Sherlock as
 * documenting `memory_update`'s already-shipped two-branch
 * read-modify-write (in-place overwrite, or a `supersedes`-linked new
 * version), not a new capability.
 *
 * Backfilled on FOUR of the five core entries below, documenting the
 * CURRENT shipped surface exactly (slice-2 discipline: registration, not
 * behavior change) — Memory (`get`/`search` reads; `store`/`delete`/
 * `update` writes), Soul (`get` read; `store` write), WorkspaceState (no
 * reads; `store` write), OrgEvent (no reads; `store` write). Relationship
 * stays `mcp`-absent: it has no MCP tool today, and absent means no
 * exposure, exactly as slice 2 defined.
 *
 * Verb→tool-name mapping (default `${toolPrefix}_${verb}`, with three
 * overrides — `(Soul, store)` → `soul_set`, `(WorkspaceState, store)` →
 * `flair_workspace_set`, `(OrgEvent, store)` → `flair_orgevent`) lives in
 * resources/mcp-tools.ts's `TOOL_NAME_OVERRIDES`, not here. Per Kern/
 * Sherlock's unanimous verdict: the registry declares WHAT is exposed
 * (capability); mcp-tools.ts owns HOW (names, defaults, routing, input
 * schema). Keeping presentation out of this file is what keeps
 * `RecordTypeMcp` a pure capability declaration.
 *
 * See `COMPOSITE_MCP_TOOLS` below for the second — and only other —
 * reviewed chokepoint: tools that are cross-table, aggregate, or otherwise
 * cannot map to a single table + verb (`bootstrap`, `attention`,
 * `record_usage`). Sherlock's slice-3 refinement (Kern concurring on the
 * relocation) put that allowlist HERE, in record-types.ts, rather than in
 * mcp-tools.ts — so the FULL MCP surface (table-verb tools and composites
 * alike) is reviewable in this one file, not split across two.
 *
 * Design lineage: flair#520 design draft (issue comment, 2026-07-13) §4;
 * Sherlock's Security Review (readScope narrowing, mandatory-vs-optional
 * content-safety — NOT added here per Kern's Q3 verdict below —, structural
 * readVerbs/writeVerbs split, federation-excluded default); Kern's DESIGN
 * REVIEW (tiered review gate, readVerbs/writeVerbs, federation-excluded
 * default, provenance-stamp-identical-shape); slice 1 kit extraction
 * (flair#729, merged) whose file header first named the four attribution
 * idioms and the OrgEvent/Soul unscoped-read state this module's `readScope`
 * type makes explicit.
 *
 * Deliberately NOT added in this slice (Kern's DESIGN REVIEW Q3 verdict,
 * explicit): a `contentSafety`/`scanFields` field. Sherlock proposed making
 * content-safety scanning mandatory for any free-text field; Kern's verdict
 * (which this implementation follows, per the task's explicit slice-2 scope)
 * was NOT mandatory in v1 — generalizing `scanFields()` beyond Memory's
 * hand-wired `content`/`summary` call needs its own design pass, and making
 * it a blocking registration requirement would slow the easy win (data-layer
 * -only registration with no MCP exposure). Left as a documented follow-up,
 * not a silently-dropped field.
 */

import type { AttributionMode, ReadScopeMode } from "./record-type-kit.js";

// ─── Policy shape ───────────────────────────────────────────────────────────

/** (a) Identity gating. See this module's header — "internal-only" is
 *  reserved and unimplemented; every current entry is "gated". */
export type RecordTypeIdentityMode = "gated" | "internal-only";

/**
 * (b) Read-scope. `ReadScopeMode` ("owner-only" | "open-within-org") is the
 * K&S-approved two-value shape from the flair#520 design draft's §4. "none"
 * is this module's disclosed extension — see the header doc's `readScope`
 * section for why OrgEvent/Soul's actual shipped behavior (any verified
 * agent reads every row, no ownership filter, no visibility field) cannot
 * be truthfully expressed as either of the other two values.
 */
export type RecordTypeReadScopeMode = ReadScopeMode | "none";

/**
 * (c) No-forge attribution, keyed per write method. See this module's
 * header doc — a single type-level mode cannot express WorkspaceState/
 * OrgEvent's real divergence between post() ("stamp-default") and put()
 * ("validate-strict"). Absent means the table has no override on that
 * method calling `stampAttribution` at all (e.g. Relationship has no
 * post() override — `attribution.post` is absent, not a placeholder).
 */
export interface RecordTypeAttribution {
  post?: AttributionMode;
  put?: AttributionMode;
}

/**
 * (d) Semantic recall. `field` names the attribute embedded (`getEmbedding`
 * input); `exposedSearch` marks whether the type has (or, for a future
 * type, would get) its own dedicated single-table search surface — never
 * fused into Memory's `memory_search` (flair#520 §9 v1 exclusion). Declared
 * for documentation only in this slice — see header doc. Absent → no
 * embedding column, no recall, the default for every table but Memory.
 */
export interface RecordTypeEmbedding {
  field: string;
  exposedSearch: boolean;
}

/**
 * (e) REM eligibility. RESERVED, MUST be the literal `false` for every v1
 * entry — see header doc. Typed as the literal (not `boolean`) so a stray
 * `true` fails to compile rather than merely being a policy mistake nobody
 * notices until REM tries to use it.
 */
export type RecordTypeRemEligible = false;

/**
 * Federation/sync participation. See header doc's `federation` section:
 * declarative-only in this slice (Federation.ts's hardcoded table list is
 * the real, unchanged source of truth for the three "included" core
 * tables); any FUTURE non-core entry MUST be "excluded" per Sherlock/Kern's
 * Q6 verdict, until a later slice generalizes the push filter and updates
 * it FIRST, in its own reviewed PR.
 */
export type RecordTypeFederation = "excluded" | "included";

/**
 * MCP tool-surface shape — see header doc's `mcp` section. Structurally
 * separates read-only verbs (reviewed at the "add a type" bar) from
 * mutating verbs (their own explicit line-item sign-off), per Sherlock's
 * Q5 / Kern's concurrence. DECLARE-AND-ENFORCE as of slice 3: nothing
 * generates a tool from this field — resources/mcp-tools.ts's hand-written
 * `TOOLS` map remains the actual dispatch — but every verb declared here
 * MUST resolve (via mcp-tools.ts's default naming or its
 * `TOOL_NAME_OVERRIDES`) to a tool that exists in `TOOLS`, and every
 * table-verb-shaped tool in `TOOLS` MUST be declared here, enforced
 * bidirectionally by test/unit/mcp-surface-tripwire.test.ts. Absent
 * (Relationship only, in this slice) = no MCP exposure for that type — the
 * tripwire proves zero tools carry its toolPrefix-style prefix.
 */
export interface RecordTypeMcp {
  toolPrefix: string;
  readVerbs: Array<"get" | "search">;
  writeVerbs: Array<"store" | "delete" | "update">;
}

export interface RecordTypePolicy {
  /** Harper table name — must match a `@table(database: "flair")` schema
   *  under schemas/*.graphql, and must equal this entry's own key in
   *  `RECORD_TYPES` (enforced by the registry validation test, not by the
   *  type system — TS object-literal keys and a `table` string field are
   *  not otherwise connected). */
  table: string;

  /** The attribute carrying record ownership — "agentId" for every table
   *  except OrgEvent ("authorId"). Used for BOTH the owner-only read-scope
   *  condition and the no-forge attribution stamp (always the same field —
   *  no table splits the two). */
  ownerField: string;

  identity: RecordTypeIdentityMode;
  readScope: RecordTypeReadScopeMode;
  attribution: RecordTypeAttribution;
  provenance: boolean;
  embedding?: RecordTypeEmbedding;
  remEligible: RecordTypeRemEligible;
  federation: RecordTypeFederation;
  mcp?: RecordTypeMcp;
}

// ─── The registry ───────────────────────────────────────────────────────────
//
// `as const satisfies Record<string, RecordTypePolicy>`: `satisfies` checks
// every entry against `RecordTypePolicy` (catching an invalid readScope
// value, a missing required field, etc. at compile time) WITHOUT widening
// the expression's inferred type the way a `: Record<string,
// RecordTypePolicy>` annotation would — so `RECORD_TYPES.Memory.readScope`
// keeps its literal type `"open-within-org"`, not the widened union
// `RecordTypeReadScopeMode`. That literal-preservation is what lets the five
// resource classes below pass `RECORD_TYPES.<Table>.<field>` straight into
// `makeReadScope()`/`stampAttribution()` (which expect the narrow literal
// unions, not the wide ones) with no runtime cast or non-null assertion.

export const RECORD_TYPES = {
  Memory: {
    table: "Memory",
    ownerField: "agentId",
    identity: "gated",
    readScope: "open-within-org",
    attribution: { post: "validate-truthy", put: "validate-truthy" },
    provenance: true,
    embedding: { field: "content", exposedSearch: true },
    remEligible: false,
    federation: "included",
    mcp: { toolPrefix: "memory", readVerbs: ["get", "search"], writeVerbs: ["store", "delete", "update"] },
  },

  Relationship: {
    table: "Relationship",
    ownerField: "agentId",
    identity: "gated",
    readScope: "owner-only",
    // No `post` — Relationship.ts has no post() override at all; only
    // put() (upsert) calls stampAttribution.
    attribution: { put: "stamp-strict" },
    provenance: true,
    remEligible: false,
    federation: "included",
  },

  WorkspaceState: {
    table: "WorkspaceState",
    ownerField: "agentId",
    identity: "gated",
    readScope: "owner-only",
    attribution: { post: "stamp-default", put: "validate-strict" },
    provenance: false,
    remEligible: false,
    federation: "excluded",
    mcp: { toolPrefix: "flair_workspace", readVerbs: [], writeVerbs: ["store"] },
  },

  OrgEvent: {
    table: "OrgEvent",
    ownerField: "authorId",
    identity: "gated",
    // No get()/search() override — any verified agent reads every org
    // event, unscoped. See this module's header doc's `readScope` section.
    readScope: "none",
    attribution: { post: "stamp-default", put: "validate-strict" },
    provenance: false,
    remEligible: false,
    federation: "excluded",
    mcp: { toolPrefix: "flair_orgevent", readVerbs: [], writeVerbs: ["store"] },
  },

  Soul: {
    table: "Soul",
    ownerField: "agentId",
    identity: "gated",
    // No get()/search() override — souls are identity/discovery data,
    // intentionally readable by any verified agent. See header doc.
    readScope: "none",
    attribution: { post: "validate-truthy", put: "validate-truthy" },
    provenance: false,
    remEligible: false,
    federation: "included",
    mcp: { toolPrefix: "soul", readVerbs: ["get"], writeVerbs: ["store"] },
  },
} as const satisfies Record<string, RecordTypePolicy>;

export type RecordTypeName = keyof typeof RECORD_TYPES;

// ─── Composite MCP tools (the second, and only other, reviewed chokepoint) ─
//
// Tools that do not map to a single table + verb — cross-table aggregates,
// bespoke resources, or multi-source composites. These cannot be expressed
// via `RECORD_TYPES.<Table>.mcp` (there is no single `table` to attach them
// to), so slice 3's design round (Sherlock's refinement, Kern concurring —
// see the `mcp` header doc above) makes this array the SECOND reviewed
// chokepoint for the MCP surface: test/unit/mcp-surface-tripwire.test.ts
// requires every tool name in resources/mcp-tools.ts's `TOOLS` map to be
// either derived from a declared `RECORD_TYPES.<Table>.mcp` verb OR listed
// here. A PR adding a new composite MCP tool (or renaming/removing one of
// these three) must touch this array — same review bar as touching a
// table's `mcp` field.
//
//   bootstrap    — Soul + Memory + predicted-context composite (BootstrapMemories)
//   attention    — cross-table aggregate query (AttentionQuery.ts), not a table verb
//   record_usage — usage-signal resource (RecordUsage.ts), not a table verb
//
export const COMPOSITE_MCP_TOOLS = ["bootstrap", "attention", "record_usage"] as const;

export type CompositeMcpTool = (typeof COMPOSITE_MCP_TOOLS)[number];

// ─── Runtime immutability ───────────────────────────────────────────────────
// Belt-and-suspenders backstop for the "static, compiled" invariant (see
// header doc). TypeScript's `as const satisfies` already gives compile-time
// readonly types, but that alone does not stop a runtime consumer (a
// resource file, a test, a hypothetical future dynamic-registration attempt)
// from mutating a nested object in place — `RECORD_TYPES.Memory.readScope =
// "owner-only"` is a type error at compile time but would silently SUCCEED
// at runtime without this. Deep-freezing every entry and every nested
// sub-object (attribution/embedding/mcp) makes an attempted mutation throw
// (every .ts file in this repo compiles as an ES module, which is always
// strict mode) instead of silently desyncing the registry from what a
// resource file already composed at its own module-load time. Same
// treatment for `COMPOSITE_MCP_TOOLS` — it is the second reviewed MCP-surface
// chokepoint (see its own doc above) and gets the same static-registry
// guarantee as RECORD_TYPES itself.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
deepFreeze(RECORD_TYPES);
deepFreeze(COMPOSITE_MCP_TOOLS);
