- **The canary's promote block now RESTORES a partially-moved `latest` instead of deleting it, and its rollback text matches the commands under it.**

  When a `npm dist-tag add` fails mid-promote, the block printed
  `npm dist-tag rm <pkg> latest` for the already-moved packages — which DELETES
  their `latest` rather than restoring it. The block now reads each package's
  current `latest` BEFORE the first move, and on any failure — a move or the final
  skew check — prints `npm dist-tag add <pkg>@<previous> latest` for every package
  it moved, plus the packages it did NOT move; it never removes a tag. A failed
  pre-move `dist-tag ls` stops before any move. Convergence is confirmed only on
  the all-succeeded path.

  (Refs #1671)
