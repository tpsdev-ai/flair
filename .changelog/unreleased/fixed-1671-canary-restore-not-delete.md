- **The canary's promote block now PRINTS a rollback for a partially-moved `latest` instead of deleting it, and its rollback text matches the commands under it.**

  When a `npm dist-tag add` fails mid-promote, the block printed
  `npm dist-tag rm <pkg> latest` for the already-moved packages — which DELETES
  their `latest` rather than restoring it. The block now reads each package's
  current `latest` BEFORE the first move, and on failure prints
  `npm dist-tag add <pkg>@<previous> latest` (a RESTORE line) for every package it
  ATTEMPTED to move, and lists the packages NEVER attempted separately by name; it
  never removes a tag. The package whose add FAILED is reported as ATTEMPTED with
  its state UNKNOWN and gets a restore line too, because npm can apply a tag
  server-side and still exit non-zero; and when
  the final check cannot READ the state it says so instead of claiming every
  package moved. A failed pre-move `dist-tag ls` stops before any move.

  (Refs #1671)
