- **The error no longer accuses the principal.** A failed lookup reported
  `failed to look up principal '<x>' (HTTP 404)`, which sends the reader to inspect principals. But a
  *missing* principal returns `200 []` and the very next branch creates it — reaching that error
  means the ops **call** failed, not that the identity is absent. It now names the URL it tried, and
  on a 404 says the address is probably the served origin and points at `--ops-url`. An error that
  misdirects costs more than one that simply says no.
