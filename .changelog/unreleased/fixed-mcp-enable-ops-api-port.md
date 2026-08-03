- **`flair mcp enable` sent its ops-API calls to the served origin, and blamed the wrong thing when
  they failed.** Against a hosted instance the ops target was the instance URL verbatim — so the
  calls went to port 443, where the flair REST component owns `/` and answers `404 Not found`.
  Measured against a live Fabric instance, same request:

  ```
  POST https://<host>/        -> HTTP 404  "Not found"
  POST https://<host>:9925/   -> HTTP 200  []
  ```

  The ops API now gets the hosted ops port rather than the served one, and `--ops-url` overrides it
  outright. **No arithmetic on the served port is trusted:** the codebase elsewhere documents
  "ops port = HTTP port − 1", which derives 442 — also measured dead, along with 19925. An operator
  can put the ops API anywhere, so an explicit target always wins.

- **The error no longer accuses the principal.** A failed lookup reported
  `failed to look up principal '<x>' (HTTP 404)`, which sends the reader to inspect principals. But a
  *missing* principal returns `200 []` and the very next branch creates it — reaching that error
  means the ops **call** failed, not that the identity is absent. It now names the URL it tried, and
  on a 404 says the address is probably the served origin and points at `--ops-url`. An error that
  misdirects costs more than one that simply says no.
