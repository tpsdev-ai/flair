- **`flair keys prune` no longer archives a key file it cannot identify.** `~/.flair/keys/<id>.key`
  is a namespace shared by two writers: plaintext Ed25519 seeds, and AES-256-GCM keystore blobs
  written by `FileKeyStore`. A keystore blob does not parse as a seed, and prune classified any
  unparseable file as `invalid` — which is prunable — so it would move a **live federation key**
  into `.pruned/`. Recoverable, since prune archives rather than deletes, but wrong in the
  direction of touching a key that is in use. Unparseable files are now classified
  `unidentified`, reported for a human, and left where they are. "I could not parse this" and
  "this is a stale agent key" are different findings, and only the second is safe to act on.
