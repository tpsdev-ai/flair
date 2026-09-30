- **A leftover daemon identity sidecar no longer makes a stop or restart refuse.**
  A sidecar whose pid is confirmed gone is treated as stale; stop and restart
  can re-adopt the live process from current health and pid evidence: the
  missing-sidecar self-heal runs when `/Health` identifies flair and the
  pid-to-port and instance checks each match or are unavailable (a best-effort
  skip, never a proof). A pid whose liveness cannot be determined is never read
  as gone. The port-based stop removes the sidecar once the pid it names is
  confirmed gone — opened with `O_NOFOLLOW` and removed only while a re-read
  still names that pid. A start racing that re-read/unlink can lose its fresh
  sidecar, leaving a live daemon with none; a later port-based stop or
  restart can re-adopt it once the live process supplies the required pidfile
  and health evidence (`test/unit/stale-sidecar-2055.test.ts`).
  (`test/unit/daemon-liveness.test.ts`, `test/unit/daemon-sidecar-cleanup-2055.test.ts`)
