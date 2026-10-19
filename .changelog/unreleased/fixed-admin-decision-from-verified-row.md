- **The admin decision for a signed agent request uses the Agent row the signature is verified against, plus `FLAIR_ADMIN_AGENTS`.**
  The request gate and the per-resource verifier both decide from that one row
  (`role: "admin"`) or the configured admin ids, on every request. Nothing about
  admin status is kept between requests, so a role change, a removed Agent row, or
  a new row under the same id applies to the next request on every worker thread,
  whichever path wrote it: the Agent resource, the operations API, or a federation
  merge. The handlers that also admit a caller by its annotated id (memory
  maintenance, consolidation, reflection, auto-promote and reindex) reuse the
  gate's decision for a signed request, and read the caller's Agent row at the
  time of the call for any other caller.
