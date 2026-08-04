- **A deploy no longer ships the whole working tree.** `harper deploy` packs its root wholesale, and
  the code assumed that root was an npm-installed package — where the tree already *is* the published
  file set. That assumption is true for the intended path and silently false for the one our own
  deploy procedure prescribes: a git checkout.

  Measured on a production Fabric component: **36 top-level entries**, including `.git`, `.env`,
  `models/` (80 MB), `test/`, `packages/`, `src/`, and a scratch `pr-body.md` left in the clone that
  afternoon. **96 MB against the published tarball's 1.3 MB.**

  Two consequences. An operator deploying from a checkout shipped `.git` — every secret ever
  committed and later removed — and any `.env` sitting in the tree, into a component that is then
  persisted and replicated across the cluster. And a 96 MB payload is what puts a deploy inside
  HarperFast/harper#2062's aborted-transaction window, where the pre-saved blob is destroyed at the
  source. The bloat and the cluster failure were the same bug wearing two hats.

  Staging is now unconditional and restricted to the entries `files` declares, read from the deploy
  root's own `package.json`. The payload equals the published package **by construction** rather than
  by an operator happening to run from the right directory. For an npm-installed root the result is
  unchanged, because such a tree contains nothing else. Measured after: 10 entries, 3.8 MB — `.git`,
  `models/`, `packages/`, `test/`, `src/` all gone.

  `.env` is explicitly kept: it is not in `files` and never reaches npm, but `config.yaml`'s
  `loadEnv` reads it and shipping it is the point of the staging mechanism. Filtering it out broke
  `FLAIR_PUBLIC_URL` on every deploy — caught by an existing test rather than in production.

  A root with no usable `files` array is now **refused** rather than deployed unfiltered. The
  refusal names the remedy.
