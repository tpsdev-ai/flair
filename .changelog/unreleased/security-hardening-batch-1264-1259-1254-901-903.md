- **Hardening batch: anti-enumeration alignment, `agent add --admin-pass-file`,
  interpolation-literal env guard in flair-client, fail-closed snapshot tar
  handling.** Four small security/correctness fixes. (1) A cross-agent by-id
  `GET /Memory/<id>` of a private memory used to 403 from the auth middleware
  with an error naming the owning agent, while `Memory.get()` behind it
  deliberately answers a generic 404 so a denied caller can't enumerate ids —
  the middleware now returns the identical `not found` 404, so a denied private
  read is indistinguishable from a missing id at both layers and never
  discloses the owner (flair#1264). (2) `flair agent add` gains a real
  `--admin-pass-file <path>` read in-process via the same owner-only-mode
  reader `flair init` uses, so the admin password never appears in `ps` or
  shell history; as an explicit flag it works for remote targets too, without
  weakening the guard that keeps the ambient `FLAIR_ADMIN_PASS`/local-file
  fallbacks from ever traveling to a remote host, and the Fabric quickstart now
  leads with it (flair#1259). (3) `FlairClient`'s own env fallbacks
  (`FLAIR_URL`, `FLAIR_AGENT_ID`, `FLAIR_CLIENT`, `FLAIR_ADMIN_USER`,
  `FLAIR_ADMIN_PASSWORD`, `FLAIR_KEY_DIR`) now treat a wholesale unsubstituted
  `${...}` interpolation literal as unset so the existing defaults apply,
  covering every flair-client consumer at once; flair-mcp's process-boundary
  strip stays as defense-in-depth (flair#1254). (4) Snapshot tar handling is
  fail-closed: the containment check types its entry callback against
  node-tar's own `ReadEntry` contract and refuses an entry whose path or link
  target it cannot read (previously a missing property silently PASSED
  containment), and the two restore paths that extracted with node-tar's
  defaults — REM snapshot restore and `flair session snapshot restore`, which
  silently dropped tampered entries and reported success — now validate the
  whole archive first and abort a tampered restore before writing anything,
  naming the offending entry (flair#901, flair#903).
