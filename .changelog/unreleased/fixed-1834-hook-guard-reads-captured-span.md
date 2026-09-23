- **SessionStart hook re-pins hand the never-lower guard the exact span they rewrite, not the whole command.**

  The guard decoded the first `<pkg>@<ver>` occurrence in whatever text it was
  given. The hook command's agent-id and URL charsets admit `@`, `/`, `.` and
  digits, so a hand-edited id or URL could EMBED a decoy `<pkg>@<ver>` that
  decoded ahead of the real `-p` pin — the guard proved the decoy safe while the
  write lowered the real (ahead) pin. `repinSessionStartHook` and `installHook`
  now pass the captured `-p <pkg>@<ver>` span, so the version proven safe is the
  version the substitution writes.

  (Refs #1834)
