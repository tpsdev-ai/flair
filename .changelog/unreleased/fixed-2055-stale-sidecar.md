- **A leftover daemon identity sidecar no longer makes a stop or restart refuse.**
  After `flair stop` ends a directly started (non-launchd) Harper,
  `<dataDir>/flair-daemon.json` still named the stopped pid; a later instance
  under a DIFFERENT supervisor (for example a systemd user unit whose Harper
  writes its own pid to `hdb.pid`) then made the port-based stop/restart refuse
  with "its identity could not be verified". A sidecar naming a pid that is
  confirmed gone is now treated as stale rather than as a disagreement with
  `hdb.pid`, so the live process is identified on its own evidence; a sidecar
  naming a live or undetermined pid is left alone, and an undetermined pid is
  never read as gone. The port-based stop removes the sidecar once the pid it
  names is confirmed gone — opened with `O_NOFOLLOW` and removed only while it
  still names that pid, under a per-data-directory lock shared with every
  sidecar writer, so a concurrent start never loses its fresh sidecar.
  (`test/unit/stale-sidecar-2055.test.ts`, `test/unit/daemon-liveness.test.ts`,
  `test/unit/daemon-sidecar-lock-2055.test.ts`)
