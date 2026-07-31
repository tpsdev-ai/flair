- **A `.env` in a deployed Flair component is now actually read.** Harper does
  not load a component's `.env` implicitly — it loads env files only for
  components that declare its `loadEnv` plugin, and Flair's `config.yaml` never
  did. So a `.env` sitting next to `config.yaml` on a deployed instance was
  inert: the file arrived intact and its values never reached `process.env`. The
  visible symptom was a public deployment whose OAuth discovery document (and
  A2A agent card) kept advertising a `127.0.0.1` issuer and endpoints even
  though `FLAIR_PUBLIC_URL` was set in the component's `.env`, so no external
  client could complete an authorization flow against it (#1000, #1005).

  Nothing to do on an existing install, and nothing changes for one. A `.env` is
  optional: when the file is absent — which is the normal case for a local
  install driven by a launchd plist or a systemd unit — the plugin never fires
  and boot is line-for-line identical to before. Deployments that want to set
  `FLAIR_PUBLIC_URL` (or any other `FLAIR_*` variable) this way can now do so by
  putting a `.env` in the app root.

  Application variables only. Harper composes its own configuration before
  component `.env` files load, so Harper's own settings — `HDB_ADMIN_PASSWORD`,
  `HTTP_PORT` — must still come from the process environment, and
  `HARPER_CONFIG` / `HARPER_DEFAULT_CONFIG` / `HARPER_SET_CONFIG` are refused
  outright by Harper with a warning at boot. `.env.example` said Flair never
  read a `.env` at all; it now describes which process reads what, and where
  the boundary is.
