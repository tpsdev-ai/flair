- **`flair stop` prints the instance detail and next-step guidance when a direct stop is not confirmed.**
  The refusal after the post-exit re-check appends the instance classification's
  detail, so a DISAGREEMENT or UNKNOWN shows its reason. A job that reads
  `loaded` names a second `flair stop` (the unload path), and a successor that
  has recorded its identity names a second `flair stop` (which stops the
  recorded successor). A lookup that reads `unknown` keeps the `flair doctor`
  diagnostic. The re-check also reads a pid that disappears between the
  liveness probe's signal and its state read as gone, rather than as alive.

  > **Heads-up:** The exit is still non-zero; the added lines name what was
  > observed and the next step.
