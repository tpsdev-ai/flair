- **The launchd launcher and `resolveInstanceServingPid` now identify the process behind `hdb.pid`, not just the pid (flair#2056).**

  A `hdb.pid` is trusted as a live instance only when the flair#1454 identity sidecar matches (the same pid and a start time within ±2 s of `ps -o lstart=`) AND the process command line is node running harper. Otherwise the pid may have been reused and is treated as stale: the launcher execs Harper, whose own `hdb.pid` check still applies, and `resolveInstanceServingPid` falls back to the port listener.
