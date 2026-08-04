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
