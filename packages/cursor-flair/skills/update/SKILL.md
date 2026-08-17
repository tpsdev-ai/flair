---
name: update
description: Correct or version an existing memory by id with memory_update. Use when a stored fact is wrong, stale, or should be superseded rather than duplicated.
---

# Update

Intentional overwrite or version of one memory. Dedup is bypassed.

## When to use

- The user says a stored memory is wrong or outdated
- `memory_store` just flagged a similar `matchedId` and they want one record
- You have an id and new wording

Do **not** use this to add a new fact (use remember) or to delete (use forget).

## Steps

1. If you do not have an id, `memory_search` (or `memory_get` if they quoted an id) first. Show a one-line preview and confirm which id you will change.
2. Call `memory_update` with:
   - `id` — the existing memory
   - `content` — the full replacement text (not a diff)
   - `preserveHistory` — leave false (default) for an in-place overwrite; set `true` to write a new version linked via `supersedes` and close the old validity window
3. Confirm with the id the tool returned. If `preserveHistory` was true, mention that the new id supersedes the old one.

## Defaults

- In-place overwrite unless the user asked to keep history
- You must own the memory (or hold a write grant) to version another agent's row
