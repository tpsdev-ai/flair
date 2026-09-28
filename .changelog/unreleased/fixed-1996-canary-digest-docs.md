- **The release guide and the release run's summary give all three post-publish canary inputs.**
  `docs/releasing.md` names `package_set_digest` beside `version` and `expected_sha256`, with where it is printed, how to recompute it, and a dispatch example. The release run's summary now prints the digest and asks for it.

  (Closes #1996)
