# Spike: Flair memories over BDP (read-only) — finding

**Question** (flair#2177): can Flair serve a read-only [Bead Protocol (BDP)](https://github.com/gastownhall/bdp)
view of its memories, so a beads user or tool can read a Flair memory as a Bead and link to it
from its own graph?

**Answer in one line:** the read *auth* model maps cleanly and a thin Read Scope is feasible, but the
mapping is lossy exactly where Flair's memory model is load-bearing (signed provenance, the supersede
chain, semantic recall), and BDP's own write/history surface is still ahead — so **wait**, and
re-check when BDP history lands.

Timeboxed spike. **Reads only.** Not run against a live BDP client or a live Fabric instance. Sources at
the end.

## 1. BDP, as far as a Read view needs it

BDP is an HTTP/JSON protocol over a graph of **Beads** (nodes) and **Links** (edges), in a **Scope**
(a bounded, owned graph with one canonical base URL and one writer). Profiles are cumulative: **Read**
(discovery + retrieval), Read+Update, Transactional. The spike target is Read.

- **Bead** — `{ id, type, properties, attribution?, ownedLinks? }`. `id` and `type` immutable; `type` is
  the absolute URL of its **Type Descriptor**. (`bdp/docs/specs/bdp.md`, "Bead Data Model → Beads and
  Links".)
- **Link** — `{ id, type, source, target, properties, attribution? }`, its own identity, **unowned
  unless the source's Type declares it**. An **owned** outgoing Link is part of the source Bead's
  versioned state (`ownsOutgoing`, with a `"*"` wildcard). ("Owned Links".)
- **Reference** — a URI, or a **Pinned Reference** = URI + an opaque `revision` (recorded provenance,
  not resolved in v0). ("Beads and Links".)
- **Type URL** — a Type ID is the absolute URL of its Type Descriptor; the descriptor names a JSON
  Schema for `properties` (optional) and, for a Link Type, endpoint constraints. ("Types", "Types and
  Type Descriptors".)
- **Wire** — a Bead/Link `GET` returns the self-contained record plus an opaque **`revision`** (mirrored
  as an `ETag`); `?view=properties`, `?view=links&direction=…`, `?include=links` are the derived views;
  collections (`beads/`, `links/`, `types/`) return `{ items, next }` with **snapshot-preserving cursor
  pagination** and structural predicates (`type`, `conformsTo`, `source`, `target`, `endpoint`,
  `selector`, `limit`, `cursor`) — **no relevance ranking**. ("Resource records", "Resource views",
  "Collection retrieval and selection".)
- **Read profile minimum** — Scope discovery (`service-desc`), the three inventories, canonical Bead/Link
  reads, paginated collections, `properties` and `links` views. No mutation target. ("Conformance
  profiles and reading guide".)
- **Authorization** — the authority binds the principal to one opaque **Authorization View**; the client
  cannot name or widen it; the canonical URLs do not vary by view. A Link is visible only when it and
  every in-Scope endpoint Bead are visible. ("Authorization views".)

## 2. Mapping a Flair Memory onto a Bead + Links

Flair's Memory row (`schemas/memory.graphql`) has far more state than a Bead. Proposed projection into a
Scope whose canonical base is `…/bdp/`:

| Flair (`Memory`) | Bead/Link placement | Verdict |
|---|---|---|
| `id` | Bead `id` = `https://…/bdp/beads/<memoryId>` | fits (URL-encoded local id) |
| (Flair-defined Type) | Bead `type` = `https://…/bdp/types/memory` (+ descriptor) | fits, new asset to publish |
| `content`, `subject`, `summary`, `tags`, `type`, `durability`, `validFrom`, `validTo`, `entities`, `metadata`, `contentHash`, `trigger` | Bead `properties` (one JSON object) | fits; `metadata` is opaque JSON already, so it nests |
| `updatedAt` (fallback `createdAt`) | Bead `revision` / `ETag` | synthesized — Flair has no revision token; `contentHash` alone misses `tags`/`subject` edits |
| `provenance.verified.agentId` | Bead `attribution` = `{ principal, status }` | partial — `attribution` is a closed `{principal,status}` object and BDP calls it **data, not evidence** |
| `provenance` (v, verified{agentId,timestamp,receivedAt}, claimed{model,client}) | cannot go in `attribution`; must ride in `properties` as opaque JSON | **lossy** — the signature/receipt becomes unverified data |
| `agentId` (owner) | `attribution.principal` | fits, but cross-agent read is org-open (see §3) |
| `visibility`, `archived`, `expiresAt` | not a Bead field; expressed by the **View** (hidden/missing) | fits via the view; no field-level equivalent |
| `supersedes` (id) | synthesized **Link** `supersedes` (child → parent), own `id`/`revision` | needs synthesis (see below) |
| `derivedFrom[]`, `parentId` | synthesized **Links** | needs synthesis |
| `retrievalCount`, `usageCount`, `sessionId`, `lastReflected`, `promotion*`, `originatorInstanceId`, `instanceToken`, `_safetyFlags` | Flair-internal; `properties` or omitted | no place on a Bead; omit or carry as opaque properties |
| Flair semantic search (`Memory.search`, `SemanticSearch`) | — | **no BDP equivalent** — BDP selection is structural (JSONPath Selector), never relevance |

**What has no place:** BDP has no evidence/verification slot; `attribution` is explicitly *data*. So the
one thing Flair's memory model treats as authoritative — the signed, server-received provenance — is
unrepresentable as BDP evidence and can only be republished as unverified `properties`.

**What must be synthesized:** BDP Links are first-class and addressable (`GET links/{id}`), with their own
`id` and `revision`. Flair stores `supersedes`/`derivedFrom` as *properties*, so a BDP projection must
(a) mint deterministic Link ids, (b) answer them as resources, and (c) give each a stable `revision` —
none of which exist today. Moving those ids **out of `properties` and into Links** is also what lets the
authorization view withhold a link whose endpoint is hidden (a `supersedes` id left in `properties` would
leak the id of a hidden memory).

**Where BDP is stricter than Flair:** one canonical Scope URL; `beads/`, `links/`, `types/` roots plus a
discovery document; `revision`/`ETag` on every resource; a total collection `order`; opaque cursor
fences. Flair has none of these and would synthesize them per request.

## 3. Auth model

The view must return **only** memories the caller can already read through Flair's own paths. Flair's
read rule lives in one place:

- `resources/memory-read-scope.ts` → **`resolveReadScope(authAgentId)`**: own records (any visibility)
  OR any record whose `visibility != "private"` — "open-within-org". It returns that as a Harper
  `condition` **and** an in-process `isAllowed(record)` predicate.
- Every cross-agent read path resolves through it: `Memory.search()`/`Memory.get()`
  (`resources/Memory.ts:315` → `memoryByIdReadGate`), `SemanticSearch` (line 130) and `MemoryBootstrap`
  (line 631). The HTTP by-id guard in `resources/auth-middleware.ts` defers the same denial to the
  resource-layer gate.

**The view would reuse `resolveReadScope(authAgentId)`**, resolving it once per request from the
authenticated principal and projecting with `isAllowed` (and/or pushing `condition` into the Harper
query).

BDP expresses this well: its **Authorization View** is exactly a server-selected, per-principal,
opaque read projection the client cannot widen — so the Flair view maps onto "the View is
`resolveReadScope(principal)`". Two nuances:

- BDP keeps the **canonical URLs identical across views** and only *omits* hidden Beads; Flair's
  `visibility` is per-record, which the view handles by omission, not by a field.
- BDP's closure rule ("a Link is visible only when both endpoints are visible") forces the supersede
  Links to be withheld when an endpoint is hidden — an argument for §2's "synthesize Links, don't leave
  ids in `properties`". Because Flair's links would be **unowned**, a visible Bead may keep its visible
  Links and simply withhold hidden incident ones, which matches BDP's latitude.

BDP **cannot** express a per-record `visibility` value as data, and it has no field for "archived" or
"expiresAt"; those become view membership only.

## 4. Can `bd prime` / a BDP client consume it?

- **`bd prime` — no.** It is a local-store command (`bd docs/cli-reference/prime.md`; `cmd/bd/prime.go`):
  it emits workflow context and the local persistent memories, with no BDP Scope URL or remote-read path.
  (The blog notes the beads CLI and a BDP server front the *same local* engine — not that `bd` is a BDP
  client.)
- **A BDP client — yes, in principle.** The reference stack ships a generic Read client
  (`bdp/packages/client`, `read-session.ts`) and a reference server that adapts the `bd` CLI
  (`bdp/apps/bdpbd`). Anything that speaks the Read profile — discovery, canonical reads, collections,
  `properties`/`links` views — is consumable without Flair-specific code, **provided** the synthesized
  `revision`/`ETag`/pagination/`order` contracts hold.

## 5. Recommendation: **wait for BDP history**

Reasons, in order of weight:

1. **Provenance is unrepresentable as evidence.** Flair's signed, server-received provenance is the
   part worth federating; BDP would carry it as unverified JSON. A consumer could not tell a signed
   Flair memory from an unsigned one through BDP.
2. **The supersede chain needs synthesized, addressable Links with stable revisions** — real machinery,
   and the wrong shape until BDP's history model settles.
3. **Semantic recall is not reachable through BDP.** BDP selects structurally; Flair's value is
   relevance-ranked recall. A BDP consumer gets the *corpus*, not the ranking.
4. **BDP writes and history are still ahead** (issue #2177 "Wait for:"; the write-up's own status).
   Serving reads now fixes a projection before the model is done.

**What would change the answer:** if a concrete beads consumer needs to *link to* a Flair memory today
(not to search it), a **narrow, flag-gated Read Scope** is buildable — the auth mapping is the easy part
and is already centralized in `resolveReadScope`. Re-check when BDP's history API lands; that is also
when the supersede chain and pinned References can be represented honestly.

## 6. Prototype

**Not built.** The spike brief marks it optional; the timebox went to reading the spec and the Flair
read/provenance model, and the finding above is the deliverable. If built, the first slice is a pure
`memoryToBead()` mapper plus a `resolveReadScope`-derived `isAllowed` projection, unit-tested on Linux
without a Harper boot, before any HTTP surface.

## Sources

- BDP spec: `gastownhall/bdp` `docs/specs/bdp.md` (draft), `schemas/bdp-v0.schema.json`; sections named
  inline above.
- Beads write-up: "Extending Beads: Memories, Versions and the Wire Protocol" (Gas City blog);
  Memory Beads proposal `gastownhall/beads#5877`.
- Flair code: `schemas/memory.graphql`; `resources/memory-read-scope.ts`
  (`resolveReadScope`); `resources/record-type-kit.ts` (`makeReadScope`, `makeByIdReadGate`);
  `resources/Memory.ts:315-316`; `resources/auth-middleware.ts`.
- Beads code: `cmd/bd/prime.go`, `docs/cli-reference/prime.md`.
