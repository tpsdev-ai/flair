# Entity Vocabulary

The **attention plane** — an agent seeing what its teammates are actively touching, and
where its own work collides with theirs — needs one thing to work at all: a single,
consistent way to name the "things" (repos, issues, customers, subsystems, people, agents)
that memories, workspace state, org events, and relationships all reference. Without it,
"what touches entity E" can never be an indexed lookup — it degenerates into fuzzy string
matching across free-text fields.

This document is that convention. It's written down and enforced by a small validator
(`resources/entity-vocab.ts`) **before** anything is built on top of it, because three
surfaces already consume entity strings today (the `Relationship` graph's `subject`/`object`,
and the new `entities` fields on `WorkspaceState`/`OrgEvent`/`Memory`), plus a future
attention query and any future MCP scope field — retrofitting a divergent vocabulary later
is expensive.

> This doc covers the vocabulary and validator only — the foundation slice of the attention
> plane (flair#675). The attention query ("what touches entity E in the last N days") and
> bootstrap collision surfacing are separate, later slices. See `FLAIR-ATTENTION-PLANE.md`
> for the full design.

## The form

An entity is a single string: `type:value`.

- **type** — lowercase, drawn from a **closed** set (below). Not user-extensible at write
  time; new types are added deliberately, by changing `ENTITY_TYPES` in
  `resources/entity-vocab.ts` (and this doc) in the same change.
- **value** — a stable identifier whose grammar depends on the type (see table).

Matching is **exact on the full string** — `repo:tpsdev-ai/flair` and
`repo:tpsdev-ai/flair-mcp` are unrelated entities, not prefix-related. This is what makes the
indexed `entities: [String] @indexed` fields a plain equality lookup rather than a scan.

## The closed type set

| Type | Form | Example | Value grammar |
|------|------|---------|---------------|
| `repo` | `repo:<owner>/<name>` | `repo:tpsdev-ai/flair` | Two lowercase path segments (alnum + `.`/`-`/`_` internal separators) joined by exactly one `/`. |
| `issue` | `issue:<repo>#<n>` | `issue:tpsdev-ai/flair#504` | A valid `repo` value, then `#`, then a positive integer with no leading zero. |
| `customer` | `customer:<slug>` | `customer:acme` | A lowercase slug (alnum segments joined by single `-`/`_`). |
| `subsystem` | `subsystem:<slug>` | `subsystem:embeddings` | Same slug grammar as `customer`. |
| `agent` | `agent:<agentId>` | `agent:flint` | Same slug grammar — the agent's registered id. |
| `person` | `person:<id>` | `person:nathan` | Same slug grammar. |

Rules that apply across every type:

- The type prefix is **always lowercase** — `Repo:x`, `CUSTOMER:x` etc. are invalid (not a
  case-insensitive match against the closed set — they simply aren't in it).
- No leading/trailing whitespace anywhere in the string.
- No empty type or empty value (`:acme`, `repo:`, `repo` with no colon are all invalid).
- Slugs never have leading/trailing/doubled separators (`-embeddings`, `embeddings-`,
  `embed--dings` are all invalid).

## The validator

`resources/entity-vocab.ts` is the single source of truth — every write path that persists
an `entities` value validates against it, not a local reimplementation of the grammar.

```ts
import { isValidEntity, validateEntities, invalidEntitiesResponse } from "./entity-vocab.js";

isValidEntity("repo:tpsdev-ai/flair");      // true
isValidEntity("project:flair");             // false — "project" isn't in the closed type set
isValidEntity("Customer:Acme");             // false — uppercase type and value both reject

validateEntities(["repo:tpsdev-ai/flair", "bogus"]);
// => { valid: false, invalid: ["bogus"] }

validateEntities(undefined);
// => { valid: true, invalid: [] }  — the field is additive/optional; absence is not an error
```

`invalidEntitiesResponse(entities)` is a thin convenience wrapper for Harper resource write
paths: it returns a ready-to-return `400 { error: "invalid_entities", invalid: [...] }`
`Response` when validation fails, or `null` when the field is absent or every entry is valid.
`WorkspaceState.ts`, `OrgEvent.ts`, and `Memory.ts` all call it early in `post()`/`put()`.

## Where `entities` lives today

Per the attention-plane spec's K&S-approved refinements, `entities: [String] @indexed` is an
**additive, nullable** field on:

- `WorkspaceState` (`schemas/workspace.graphql`)
- `OrgEvent` (`schemas/event.graphql`)
- `Memory` (`schemas/memory.graphql`) — added in v1 (not deferred to v2) for index-pushdown
  uniformity across all three sources the future attention query joins.

Existing rows on all three tables simply carry no `entities` — readers must tolerate absence,
the same pattern already used for `Presence.activityUpdatedAt`. No migration, no backfill.

`Relationship` gets **no** `entities` field: its `subject`/`object` columns already carry
free-form entity-reference strings and are already indexed — they're the vocabulary carrier
for that table. They are lowercased on write today but not yet validated against this
vocabulary; wiring that validation is a follow-up, not part of this foundation slice.

## What's explicitly NOT in this slice

- The attention query (`AttentionQuery` / `flair attention <entity>`) that joins Memory,
  Relationship, WorkspaceState, Presence, and OrgEvent by entity — shipped in flair#678
  (`resources/AttentionQuery.ts`), a later slice.
- Bootstrap collision surfacing ("others in the room") — shipped in flair#681
  (`resources/collision-lib.ts` + `MemoryBootstrap.ts`'s "Others in the room" section), a
  later slice.
- Automatic entity extraction/tagging on write (producers set `entities` themselves today,
  where they choose to; there's no NLP-derived auto-population yet).
- Validating `Relationship.subject`/`object` against this vocabulary.

These are tracked as follow-ups in `FLAIR-ATTENTION-PLANE.md`.
