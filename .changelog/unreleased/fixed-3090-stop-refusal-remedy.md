- **`flair stop` prints the instance detail and next-step guidance when a direct stop is not confirmed.**
  The refusal after the post-exit re-check appends the instance classification's
  detail, so a DISAGREEMENT or UNKNOWN shows its reason. A job that reads
  `loaded` names a second `flair stop` (the unload path). When the job reads
  `not-loaded` and the instance reads RUNNING (the pid in `hdb.pid` is alive and
  matches the identity sidecar, and Flair answers `/Health`), the refusal names
  a second `flair stop`; that run signals a pid directly only when its own
  fresh read verifies that pid's identity. A lookup that reads `unknown` keeps
  the `flair doctor` diagnostic. The re-check also reads a pid that disappears
  between the liveness probe's signal and its state read as gone, rather than
  as alive.

  > **Heads-up:** The exit is still non-zero; the added lines name what was
  > observed and the next step.
