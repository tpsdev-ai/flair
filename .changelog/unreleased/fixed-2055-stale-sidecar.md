- **A leftover daemon identity sidecar no longer makes a stop or restart refuse.**
  After `flair stop` ends a directly started (non-launchd) Harper,
  `<dataDir>/flair-daemon.json` still named the stopped pid; a later instance
  under a DIFFERENT supervisor (for example a systemd user unit whose Harper
  writes its own pid to `hdb.pid`) then made the port-based stop/restart refuse
  with "its identity could not be verified". A sidecar naming a pid that is
  confirmed gone is now treated as stale rather than as a disagreement with
  `hdb.pid`, so the live process is re-adopted from its own evidence: the
  missing-sidecar self-heal runs when `/Health` identifies flair and the
  pid-to-port and instance checks each match or are unavailable (a best-effort
  skip, never a proof). A pid whose liveness cannot be determined is never read
  as gone. The port-based stop removes the sidecar once the pid it names is
  confirmed gone — opened with `O_NOFOLLOW` and removed only while a re-read
  still names that pid. A start racing that re-read/unlink can lose its fresh
  sidecar, leaving a live daemon with none; the next status/stop/restart
  re-adopts it (`test/unit/stale-sidecar-2055.test.ts`).
  (`test/unit/daemon-liveness.test.ts`, `test/unit/daemon-sidecar-cleanup-2055.test.ts`)
