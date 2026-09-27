- **The hermes-flair plugin now loads the raw-seed key `flair agent add` writes, defaults to Flair's port 19926, and describes search honestly.**
  `_load_private_key` reads the key file as BYTES and accepts, in order, an exact 32-byte
  raw seed (what `flair agent add` writes), a PEM key, or strict base64 of PKCS8 DER that
  round-trips — otherwise it raises a clear error naming the path and the accepted formats,
  never the key bytes. The default URL moves to `http://127.0.0.1:19926`, matching Flair's
  own default port. The `flair_search` tool description now says the results are the agent's
  own records plus other agents' non-private records on the instance. The README states the
  accepted key formats, the real default port, that startup fetches only a Memory collection
  (never Soul or the Agent registry, no recency ordering), and that the store tool does not
  expose or forward `visibility`.

  (Refs #1953)
