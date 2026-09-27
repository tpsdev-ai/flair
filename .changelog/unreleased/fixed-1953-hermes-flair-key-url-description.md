- **The hermes-flair plugin now loads the raw-seed key `flair agent add` writes, defaults to Flair's port 19926, and describes search honestly.**
  `_load_private_key` reads bytes and treats every exact 32-byte file as a raw seed. It also
  accepts Ed25519 PEM and canonical base64 PKCS8 DER after stripping outer whitespace; the
  decoder decodes text strictly, so invalid UTF-8 bytes are refused, and a PEM file must be
  one whole block (junk before or after the block is refused). Unsupported readable
  non-32-byte files raise a format `ValueError` naming the path; file read errors propagate.
  The default URL moves to `http://127.0.0.1:19926`, matching Flair's own default port. The
  `flair_search` tool description now names the read scope. The README states the accepted key
  formats, the real default port, and the collection-only startup.

  (Refs #1953)
