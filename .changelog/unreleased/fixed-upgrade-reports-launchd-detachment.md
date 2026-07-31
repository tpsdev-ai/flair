- **An upgrade that drops the instance out of launchd now says so, instead of reporting success.**
  On macOS, `flair upgrade` and `flair restart` fall back to a plain detached start when a launchd
  operation fails. The fallback is right — a running instance beats a down one — but it leaves the
  process outside the manager that owns it, so it will not come back after a reboot, and the run
  still finished with `✅ verified: healthy, authenticated, running <version>`. Every one of those
  facts was true; none of them was the one that mattered (#1022). After a restart, both commands now
  ask launchd what it is actually running and compare it against the process serving the instance.
  A run that ends detached reports the verified facts **without** a success marker, names the job,
  says the instance will not survive a reboot, and gives the commands that restore it. A clean run
  prints exactly the line it always did.

  The launchd start also no longer waits out its full startup budget to discover a plist it could
  never have run. `launchctl load` and `launchctl start` both exit 0 for a job whose program does not
  exist, so the only symptom was a 60-second timeout naming a port — twice, once for the stop and
  once for the start. A plist records absolute paths, and switching Node runtimes moves all of them,
  so those paths are now checked before launchd is asked to do anything: a stale one fails
  immediately, naming the path that moved and the `flair init && flair restart` that re-points it.
  Likewise, the stop leg asks whether launchd is running this instance before waiting a minute for a
  process it does not control to exit. The fallbacks are unchanged; only the waiting and the
  reporting are.
