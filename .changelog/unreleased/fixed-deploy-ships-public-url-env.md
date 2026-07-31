- **A deploy now supplies `FLAIR_PUBLIC_URL`, and proves it took effect.** A publicly-reachable
  instance served an OAuth discovery document whose issuer and every endpoint were
  `http://127.0.0.1:9980`, so remote clients followed discovery to their own loopback and no
  authorization flow could complete (#1000). `flair deploy` and `flair init --remote` now ship a
  `.env` in the component payload carrying `FLAIR_PUBLIC_URL`, taken from the target the deploy
  already resolves and verifies against; after deploying, `flair deploy` reads
  `GET <target>/OAuthMetadata` and fails if the advertised issuer is still loopback — an
  unreadable document is reported as a check that did not run, never as a pass. `flair doctor`
  reports the same misconfiguration locally, naming the file, the key and the `loadEnv`
  requirement. An existing `.env` is merged and a value you set is never overwritten; the deploy
  prints the disagreement and keeps yours, and your file on disk is never written to. The
  `flair init --remote` tarball builder had written a `.env` since April and packed an entries
  list that never contained it, so its output was discarded on every call — `.env` is now in that
  list, and the tests assert against the packed payload rather than against a file on disk. That
  builder's admin-password parameter is **removed** rather than validated: the deploy payload is
  ingested into Harper's replicated deployment record, so it must carry no credential, and
  `HDB_ADMIN_PASSWORD` could not configure Harper from a component `.env` in any case — Harper
  composes its own configuration before component env files load (#1005, #1011).
