- **`flair mcp enable` now pushes its secrets to the target when the target can take them**, instead
  of always ending in a manual paste. When the instance supports Harper's encrypted env-secrets, the
  five vars are sealed locally and set over the ops API — no Fabric Studio step, no re-run with
  `--confirm-secrets-applied`.

  Values are encrypted **before** they leave the machine, using the same `enc:v1:` envelope Harper
  reads: AES-256-GCM on the value, RSA-OAEP(SHA-256) wrapping the key, addressed to a public key
  fetched from the target. Plaintext never appears in a request body, and never in the command's
  output — results carry variable NAMES and outcomes only.

  **The mechanism is chosen by asking the target, not by looking at its hostname.** The previous
  selector was `hostname.endsWith(".harperfabric.com") ? automated : manual`, which was wrong in both
  directions at the moment it was replaced: the Fabric instance it was written for runs Harper 5.1.26
  and has no secrets operations at all, while a self-hosted Harper 5.2 with the env-secrets component
  was sent down the manual path for having the wrong name. A hostname is not a capability, and
  neither is a version — the write operations and the decryptor that makes the secret reach the
  process ship separately.

  So `enable` asks for the public key it would need anyway. If that answers, it pushes. If the target
  says the operation does not exist, refuses the probe, is unreachable, or answers with something
  unusable, it falls back to today's staged file and **says which of those happened**. The staging
  file is written either way, so a fallback never leaves an operator stranded mid-run.

  What the probe deliberately does not claim: that the secret will be *decrypted*. No read-only call
  can establish that. The existing self-verify step already does — the issuer's OAuth metadata is
  only served once `FLAIR_MCP_OAUTH` is live in the process — so a secret that is stored and never
  decrypted fails there, with the push named as a candidate cause, rather than passing quietly.

  `--secrets-mechanism` remains an explicit override and skips the probe entirely: an operator who
  has said what they want is not second-guessed.
