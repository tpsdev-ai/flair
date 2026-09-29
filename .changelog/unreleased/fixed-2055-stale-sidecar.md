- **`flair stop` drops the daemon identity sidecar once the process it named is
  confirmed gone.** A leftover `<dataDir>/flair-daemon.json` naming a stopped pid
  used to make a later instance under a DIFFERENT supervisor (for example a
  systemd user unit whose Harper writes its own pid to `hdb.pid`) refuse
  `flair stop` and `flair restart` with "its identity could not be verified". A
  sidecar that names a pid which is confirmed gone is now treated as stale, not
  as a disagreement with `hdb.pid`, so the live process is identified on its own
  evidence (the same self-heal that covers a missing sidecar); a sidecar naming
  a live or undetermined pid is left alone, and a process whose liveness cannot
  be determined still refuses. The removal opens the sidecar with `O_NOFOLLOW`
  and only unlinks it while it still names the confirmed-dead pid, so a sidecar
  another supervisor rewrote in between is kept. (`test/unit/stale-sidecar-2055.test.ts`,
  `test/unit/daemon-liveness.test.ts`)
