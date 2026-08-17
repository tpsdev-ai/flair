---
name: relate
description: Record an entity relationship as a subject/predicate/object triple with relationship_store. Use when the user states who manages, owns, reviews, or depends on what — not for free-text memories.
---

# Relate

Assert a graph triple. Not prose.

## When to use

- "Nathan manages Flair", "this service depends on Redis", "Alice reviews the CLI"
- Updating or closing a relationship you already stored

Do **not** use this for a paragraph of context (use remember). Skip it for solo local notes that are not entity-to-entity.

## Preferred predicates

`manages`, `works_on`, `reviews`, `depends_on`, `replaces`, `owns`, `reports_to`, `advises`

Predicate is free text, but a small vocabulary stays queryable.

## Semantics

- The **same** subject + predicate + object **upserts** (refreshes confidence / `validTo` / source). Safe to re-assert.
- A **new** predicate is a **separate** row. It does **not** close the old one.
- To contradict (e.g. `manages` → `advises`): re-assert the **old** triple with `validTo` set to now, then store the new triple.

## Steps

1. Reduce the statement to `subject`, `predicate`, `object` (entities, not sentences).
2. Call `relationship_store`. Optional:
   - `confidence` (0–1, default 1.0)
   - `validFrom` / `validTo` (ISO timestamps)
   - `source` — a memory id when the triple was learned from a stored memory
3. Confirm `subject → predicate → object` and the returned id.

## Do not

- Encode a story in the predicate
- Forget to close the old triple when the predicate changes
- Imply history the graph does not keep — current state is what you last asserted
