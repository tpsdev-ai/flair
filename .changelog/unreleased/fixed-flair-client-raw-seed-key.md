- **`scripts/flair-client.mjs` loads the raw 32-byte key `flair agent add` writes.**
  The client now accepts a bare Ed25519 seed (or a base64 seed, or base64/DER
  PKCS8) and probes `~/.flair/keys/<agent>.key` before the legacy
  `~/.tps/secrets/flair/<agent>-priv.key`, so a freshly registered agent can make
  an authenticated call with no manual DER prefix and no key surgery. A malformed
  key now fails with an error naming the encoding problem, not a signature/auth
  failure. (Refs #1736)
