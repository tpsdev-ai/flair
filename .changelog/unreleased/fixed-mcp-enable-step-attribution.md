- **A failed `flair mcp enable` step is now reported against the step that failed.** The catch
  attributed errors to `steps[steps.length - 1]` — the last step that *succeeded* — so a throw inside
  identity mapping was filed against secrets provisioning, which had just completed:

  ```
  ✓ secrets-provisioning   ...apply these 5 vars via Fabric Studio, then re-run
  ✗ secrets-provisioning   unexpected error: Identity mapping: ... (HTTP 404)
  ```

  Two results for one step name, and the `✓` instructs several minutes of manual work in a web UI
  that the `✗` makes pointless. Read in reading order — which is how people read — you do the work
  first and discover afterwards that the step failed anyway. It also makes a run un-skimmable:
  scanning for the first `✗` finds a `✓` for that same step above it.

  A test asserts the narrow fact (an identity-mapping failure reports `identity-mapping`) and a
  broader invariant: no step name may carry both a pass and a failure in one run.
