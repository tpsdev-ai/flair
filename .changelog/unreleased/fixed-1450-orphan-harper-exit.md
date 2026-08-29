- **An orphaned test-harness Harper now exits instead of EPIPE-looping until the disk fills** (Refs #1450).
  Harper's `detached: true` children survive a SIGKILL'd harness parent and were
  reparented to `systemd --user`; each failed write logged an error, logging that
  error also failed, and `hdb.log` grew ~3 GB/hour (17.8 GB in two hours on
  tps-anvil). `startHarper` now injects a child-side preload that exits on EPIPE
  or reparent (identified by ppid, never by process name). A Harper whose parent
  is alive and whose stdout is open is left running. Not a log-size cap: the
  process must stop. Distinct from #1440 (lock contention on the next start).
