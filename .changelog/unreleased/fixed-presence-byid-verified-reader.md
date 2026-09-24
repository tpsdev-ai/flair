- **Signed per-agent `GET /Presence/<id>` reads no longer 401, and the read gate reuses the verdict the auth middleware already established.**

  The verified-reader gate re-ran `verifyAgentRequest()` on every read; on a
  by-id read the auth middleware has already verified the signature and
  consumed its nonce, so the second verification read as a replay and denied a
  legitimate agent. The gate now resolves the verdict the middleware
  established (`resolveAgentAuth`), so a signed by-id read returns the roster
  with its gated fields present, while a replayed header is still refused (the
  shared nonce store is unchanged). The admin-credential read path is unchanged
  and still redacts `currentTask` / `flairVersion` / `harperVersion`.

  (Refs #1880)
