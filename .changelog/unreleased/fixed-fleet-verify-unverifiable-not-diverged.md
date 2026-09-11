- **Fleet verify no longer calls a converged deploy failed because federation peers have no endpoint.** Unverifiable peers (couldn't check) exit 0 with a warning; a reachable peer on the wrong version still fails as diverged (flair#988).

  `flair fleet verify`, and the automatic post-`deploy` / `upgrade --target` sweep, used to treat "no endpoint on file" the same as a mixed-version fleet. That printed "deploy is NOT fully converged" and exited 3 for peers that were never federation-paired — standing config, unchanged by the deploy. Unverifiable rows are still listed (never green, never dropped). Exit 2 remains "a reachable node diverged."

  > **Heads-up:** exit 0 now includes "probed nodes match, some peers unverifiable." Exit 2 still means a reachable node was verified wrong. `deploy`/`upgrade` no longer print "NOT fully converged" for couldn't-check peers.
