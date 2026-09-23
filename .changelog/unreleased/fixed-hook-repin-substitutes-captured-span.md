- **The SessionStart hook re-pin substitutes only the captured version span.**

  `flair upgrade`'s hook refresh and `flair doctor --fix` rebuilt a wired hook
  with a first-substring replace of the package spec. A hand-edited agent id or
  Flair URL that itself contained the package-spec string passed full-form
  validation, so the replacement landed inside the identity (or URL) instead of
  the `-p` pin: the real pin stayed stale and the run still reported
  "re-pinned". The re-pin now substitutes the exact span the form regex
  captured, so the id and URL are byte-identical and only the pin advances.

  The form's version group is also tightened from "anything up to the next
  delimiter" to a semver, so `@0.55.0;<cmd>` and `@0.55.0$X` are rejected by
  the form rather than being held only by the never-lower guard.

  (Refs #1834)
