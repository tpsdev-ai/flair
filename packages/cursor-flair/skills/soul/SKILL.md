---
name: soul
description: Read or write personality and project context (role, standards, project) via soul_get / soul_set. Use when the user asks who you are, what your standards are, or explicitly wants to set soul. Soul is not a memory; it rides in every bootstrap.
---

# Soul

Personality and project context. Distinct from memory on purpose — it is included in every `bootstrap` and should not compete with daily notes.

## When to use

- "What's my role / standards / project context?"
- The user explicitly asks to set or change soul
- After bootstrap, when a soul key is missing and they asked you to define it

Write **only** on an explicit request. Do not silently reshape personality.

## Keys

Common keys (free text; stay consistent):

- `role` — who this agent is
- `standards` — how it works (review bar, language, constraints)
- `project` — current project context

## Steps

### Read

1. `soul_get` with the key. If they asked generally, get `role`, then `standards`, then `project`.
2. Quote the value. If empty, say there is no entry yet — do not invent one.

### Write

1. Confirm the key and the exact value with the user if they were vague.
2. `soul_set` with `key` and `value`.
3. Confirm `'<key>' set`. The next bootstrap will include it.

## Do not

- Store soul as a `memory_store` fact
- Overwrite soul because a single session went well or poorly
- Treat soul as searchable memory (use `memory_search` for that)
