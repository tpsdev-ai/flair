- **`adk-flair` reads the keyfile `flair agent add` actually writes.** The ADK
  memory adapter (Python and JS) now accepts the raw 32-byte Ed25519 seed that
  `flair agent add` writes to `~/.flair/keys/<id>.key` — alongside base64-encoded
  seeds, base64 PKCS8 DER, and PEM — and expands a leading `~` in `FLAIR_KEYFILE`.
  Following the documented quickstart no longer fails with a cryptic ASN.1 decode
  error, and a missing keyfile now raises a clear message naming the resolved path.
