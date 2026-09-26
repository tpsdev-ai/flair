- **Every capture path that asks for room purges first; a failed scan no longer strands a run, and `gateway_stop` clears the map.**

  Three leftovers from round 5, each a question asked in the wrong order.

  The abort path asked "is there room" WITHOUT purging the aged records that
  already qualified for removal, so a map full of them refused an abort that must
  be recorded — and that run's next callback was then admitted by admission's own
  purge, starting a capture write after the abort. The abort path now purges
  first, exactly as admission does.

  The entity scan ran between the reservation (`count++`, `hashes.add`,
  `inFlight++`) and the `try` that releases it, so a throw stranded `inFlight`
  above 0 and the record could never become removable — a slot held for the life
  of the process. The scan is now computed before the reservation, so nothing
  that can throw sits between taking the reservation and the block that releases
  it.

  `gateway_stop` cleared the sweep timer but left the run records reachable; it
  now aborts every run's controller and drops the map as well.

  (Refs #1751)
