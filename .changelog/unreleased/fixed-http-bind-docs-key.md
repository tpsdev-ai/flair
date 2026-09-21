- **Deployment docs now name the HTTP bind keys Flair reads instead of the ignored `http.host`.**

  `docs/deployment.md` and `docs/standalone-local.md` documented widening the
  HTTP listener with a nested `http.host:` key that nothing in the tree reads.
  They now name what is actually consulted — `flair init --http-bind <host>`,
  the `FLAIR_HTTP_BIND` environment variable, and a top-level `httpBind:` key
  in `~/.flair/config.yaml`, in that precedence, defaulting to `127.0.0.1` —
  and state that only hosts including IPv4 loopback (`127.0.0.1` or a
  wildcard) are accepted, because Flair's credentialed self-calls are
  hardcoded to `127.0.0.1`. The old snippet is kept and labelled as ignored,
  so an operator who used `http.host` can find the migration. (Refs #1760)

  > **Heads-up:** `http.host` is not read and is now documented as such. An
  > install that was only wide because the pre-0.55.0 default bound every
  > interface narrows to `127.0.0.1` on the next `flair restart` or
  > `flair upgrade`. Set `httpBind:` (or `--http-bind` / `FLAIR_HTTP_BIND`) to
  > keep the HTTP listener reachable.
