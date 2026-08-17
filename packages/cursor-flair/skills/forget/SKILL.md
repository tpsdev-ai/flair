---
name: forget
description: Delete a specific memory after showing a preview. Use when the user asks to forget, drop, or remove a stored item. Search/get first; never wipe all memories.
---

# Forget

Delete by id, after a preview. No wipe-all.

## When to use

- "Forget that", "delete memory …", "remove the note about X"
- Cleaning a duplicate the user pointed at

Do **not** delete on a vague "clear my memory" with no target. There is no bulk-delete tool.

## Steps

1. Resolve ids:
   - If the user gave an id, `memory_get` it
   - Otherwise `memory_search` for the topic and pick the matching row(s)
2. Show a preview (content excerpt + id + type) and confirm before deleting.
3. Call `memory_delete` once per id. Loop if several were confirmed. Do not invent a wipe-all.
4. Report each deleted id.

## Do not

- Delete without a preview
- Delete soul entries (use the soul skill — soul is not a memory)
- Call `memory_delete` in a loop over search results the user did not confirm
