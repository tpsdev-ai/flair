- **`flair start`'s unconfirmed-launchd warning reports what the confirmation probe saw (#2422).**
  When a CLI-managed launchd start was not confirmed, the warning said "Flair is running on port <port>"
  even though the confirmation's second health probe can find a foreign listener, a refused connection or
  an unreachable port. It now names the reachability wait that passed, the probe's result, and the failed
  check, and claims Flair is running only for a Flair-shaped answer.
