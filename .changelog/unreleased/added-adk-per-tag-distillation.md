- **REM nightly distillation is now per-user (per-tag) for ADK agents.**
  adk-flair collapses every `(app, user)` into one Flair agentId, separating
  users only by an `adk:<app>:<user>` tag; the nightly runner previously
  distilled per-agentId (`scope:"recent"`), mixing every user's sessions into
  shared claims (cross-user bleed). The cycle now derives the active
  `adk:<app>:<user>` tags for the agent (from the memories it already fetches
  for the snapshot — no extra query — with a recency cutoff that skips idle
  tags and is scoped to the agent's own records) and runs `ReflectMemories`
  once per tag under `scope:"tagged"`, so each user's candidates are distilled
  only from that user's sessions. Ordinary single-tenant agents (no `adk:`
  tags) fall back to the unchanged agentId-only distill. Candidates distilled
  under a tag now carry a `scopeTag` field, which `flair rem promote` consumes
  as the authoritative per-user lineage tag directly — closing the seam where a
  candidate whose source memories were all unreadable would otherwise promote
  tagless into the shared agentId namespace. Candidates still land
  `status:"pending"` for the existing human `rem promote` path (no
  auto-promote). Refs #1205.
