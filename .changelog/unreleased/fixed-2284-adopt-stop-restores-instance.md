- **A failed adopt stop that already stopped the instance restores it instead of leaving Flair stopped.**
  When `flair doctor --fix` clean-stops the directly started instance for adoption and observes
  the old process exit, a later listener-probe failure that could not determine the port's state
  now re-checks the port and restarts the instance directly, reporting the state it left. A stop
  failure where the process survived SIGTERM still restarts nothing (flair#2284).
