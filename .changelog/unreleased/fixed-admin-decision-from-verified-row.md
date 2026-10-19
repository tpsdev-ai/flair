- **The admin decision for a signed agent request uses the Agent row the signature is verified against, plus `FLAIR_ADMIN_AGENTS`.**
  The request gate and the per-resource verifier both decide from that one row
  (`role: "admin"`) or the configured admin ids, on every request. Nothing about
  admin status is kept between requests, so a role change, a removed Agent row, or
  a new row under the same id applies to the next request on every worker thread,
  whichever path wrote it: the Agent resource, the operations API, or a federation
  merge. Memory maintenance, consolidation, reflection and auto-promote first admit
  a request whose `tpsAgentIsAdmin` annotation is already true, without reading a
  row. The check they make next, which the reindex endpoint and a reindex write
  also make, keeps the gate's decision for a request the gate verified, and
  decides any other annotated caller (a Basic credential or an in-process context)
  from its Agent row read at that moment plus `FLAIR_ADMIN_AGENTS`.
