- **`FeedMemories.post()` now attributes writes to the authenticated principal and refuses
  mismatched ones.** It previously read `agentId` from the request body and passed it into a
  full-record write, so a verified agent could write memories attributed to another agent, or target
  an existing record by supplying its `id`.

  `agentId` is now stamped from the authenticated principal; a body-supplied `agentId` that
  disagrees is rejected with `403` rather than silently overwritten. A body-supplied `id` is checked
  against the existing record's ownership before the write proceeds.

  **Upgrading is recommended for multi-agent deployments.** This path was previously documented
  in-code as deferred debt; it is now closed.
