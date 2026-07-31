- **`flair doctor` no longer explains one unreadable key as two different wrong causes.** A key
  file that OpenSSL could not decode surfaced twice in the same report — once as `Embeddings: not
  verified` advising `Pass --agent <id>`, and once as `could not verify agent registration
  (instance unreachable: ...)` printed six lines beneath doctor's own `✓ Harper responding` tick
  (#1023). Neither was the cause: an agent had been selected, and the instance had demonstrably
  answered. The operator was sent to check firewalls and ports for a file on their own disk. The
  fix is structural rather than better wording — signing strictly precedes the request, so
  `authFetch` now raises a distinct `KeyLoadError` for the signing half only, and no caller has to
  infer from an error string whether the network was ever reached. Doctor names the file that
  failed and that it could not be parsed as an Ed25519 private key; an unrecognised failure
  reports the operation and the raw error and asserts **no** cause at all. `--agent` is suggested
  only where it can actually resolve an identity — a remedy that cannot change the outcome is now
  omitted rather than printed. Registration findings also carry the reachability the run already
  established, so `unreachable` can no longer be claimed after this run watched the instance
  respond. Key-decode failures are recognised by the crypto backend's structured error code
  across both OpenSSL and BoringSSL, whose wording for the identical failure differs.
