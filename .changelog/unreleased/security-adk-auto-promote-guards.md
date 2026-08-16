- **Unattended ADK auto-promote enforces four authz invariants server-side.**
  Because auto-promotion (see Added) removes the human reviewer that also
  guarded content and scope, the `AutoPromoteCandidates` resource enforces, in
  the server layer (never a flippable CLI flag): (1) the target is hard-locked
  to `memory` — there is no Soul code path, and an explicit non-memory target is
  refused, so an ADK-sourced claim can never land in the agentId-scoped Soul
  (cross-user by construction); (2) tag lineage is fail-closed — a candidate is
  promoted only if it carries an authoritative `adk:<app>:<user>` scope tag,
  which the promoted memory then carries, and the promoted memory is written
  `visibility:"private"` (owner-only) — NOT the `shared` (org-open) default a
  `persistent` write would otherwise get, which would make the distilled private
  session claim readable by every agent on the instance. So a claim is
  retrievable only through its own app agent's tag-filtered search (which
  re-verifies the tag), invisible both to another user's tag filter and to any
  other agent; a tagless promotion into the shared agentId namespace is refused,
  not written; (3) the claim is
  content-safety scanned strict — a prompt-injection payload is never
  auto-promoted regardless of `FLAIR_CONTENT_SAFETY`; (4) the promoted memory
  and its candidate record a reserved `machine:adk-auto-promote` reviewerId,
  never mistakable for a human or agent reviewer. A non-admin caller can sweep
  only its own candidates. Refs #1205.
