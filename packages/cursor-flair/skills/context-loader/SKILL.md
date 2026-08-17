---
name: context-loader
description: Load prior decisions and lessons for a new task or context switch. Use when the user starts a different task or asks "what did we decide about X?". Read-only — bootstrap once, then 2–3 parallel memory_search angles.
---

# Context loader

Read-only recall for a new task. Complements bootstrap; does not replace it on a fresh session.

## When to use

- New task or context switch mid-session
- "What did we decide about X?"
- "Any lessons from the last time we touched this?"

Stay silent (no invented history) if search returns nothing.

## Steps

1. Extract 1–3 topic phrases from the user message and the current repo/folder names.
2. If this session has not bootstrapped yet, call `bootstrap` once (`channel`: `"cursor"`, `currentTask` from the user message, `subjects` from the topics). Skip a second bootstrap if you already ran one this session.
3. Fire 2–3 `memory_search` calls in parallel, one angle each:
   - decision — `"decision about <topic>"`
   - lesson — `"lesson learned <topic>"`
   - error — `"error bug failure <topic>"`
   Use `limit` 5 per call.
4. Dedup results by memory `id`. Cap the working set at about 10.
5. Present a short list: type, one-line preview, id. Do not paste huge raw content.
6. If every search is empty, say so in one sentence and continue without fabricating prior decisions.

## Do not

- Write, update, or delete memories
- Invent a consolidate / dream pass
- Re-bootstrap on every follow-up in the same task
