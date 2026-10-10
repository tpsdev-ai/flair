- **`flair start`'s unconfirmed-launchd warning reports what the confirmation probe saw (#2422).**
  When a CLI-managed launchd start was not confirmed, the warning said "Flair is running on port <port>"
  even though the confirmation's second health probe can get a response that is not a Flair health answer
  (non-2xx or not Flair-shaped), get a refused connection, or fail to reach the port (timeout or network
  error). It now names the reachability wait that passed, the probe's result, and the failed check, and
  claims Flair is running only for a Flair-shaped answer. The launchd state the warning already printed
  (for example "is loaded but not running") is now on its own line.
