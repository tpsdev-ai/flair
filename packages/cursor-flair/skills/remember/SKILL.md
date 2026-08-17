---
name: remember
description: Store a durable decision, lesson, preference, fact, or explicit "remember this" with memory_store. Use when the user asks you to remember something, or when a decision/lesson should survive this session.
---

# Remember

Write one memory via `memory_store`. Confirm with id + preview.

## When to use

- The user says "remember this", "save that", or "don't forget"
- A decision, lesson, preference, or fact should outlive this chat
- You are about to close a task and have a durable takeaway

Do **not** store scratch notes, huge logs, or secrets. Do **not** write during bootstrap.

## Map the write

| What it is | `type` | Typical `durability` |
|---|---|---|
| Identity / never-forget | `fact` | `permanent` |
| Decision that should last weeks | `decision` | `persistent` |
| Lesson from a failure or review | `lesson` | `persistent` |
| How the user likes to work | `preference` | `persistent` |
| Ordinary working fact | `fact` | `standard` (default) |
| Goal / intent | `goal` | `standard` or `persistent` |
| This-session scratch | `session` | `ephemeral` (auto-expires ~72h) |

Durability meanings:

- `permanent` — identity, explicit never-forget
- `persistent` — key decisions and lessons
- `standard` — default working memory
- `ephemeral` — scratch; expires

## Visibility

A bare `memory_store` often lands **private** because the default durability is `standard`, and `standard` / `ephemeral` default to `private`. Shared teammate facts need `visibility: "shared"` (or durability `permanent` / `persistent`, which default to shared). Say what you mean.

## Steps

1. Draft one concise `content` string. Prefer the user's wording over a paraphrase when they said "remember this".
2. Call `memory_store` with `type`, `durability`, optional `tags`, and `visibility` when sharing matters.
3. Read the result. If it flags a similar `matchedId`, both rows were kept — offer `memory_update` on that id instead of leaving a duplicate. Use the update skill.
4. Confirm to the user with the new `id` and a short preview (not the full blob).

## Do not

- Duplicate a memory you just saw in search without offering update
- Store API keys, passwords, or key-file contents
- Invent extra fields the tool does not accept
