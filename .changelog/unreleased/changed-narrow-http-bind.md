- **Flair's HTTP listener is now bound by host and port, defaulting to loopback.**

  Every place Flair hands Harper an HTTP listener address — the launchd service
  file, the direct-spawn environment used by `restart`/`upgrade`, and the
  `HARPER_SET_CONFIG` payloads written by `init` and by `doctor --fix` — now
  writes a host-qualified `host:port` value built by one constructor, defaulting
  to `127.0.0.1`. A new escape hatch (`flair init --http-bind`,
  `FLAIR_HTTP_BIND`, persisted as `httpBind` in `~/.flair/config.yaml`) records a
  deliberate widening, and only hosts that include IPv4 loopback (loopback or a
  wildcard) are accepted — Flair's own credentialed self-calls are hardcoded to
  `127.0.0.1`, so a bind that excludes it would leave them pointing at a dead
  port while every bind check still passed.

  `flair doctor --fix` preserves an instance's existing listener coordinates —
  a bare or qualified HTTP bind, plus its enabled/disabled TLS listeners —
  instead of rewriting them, and refuses rather than substituting a default for
  a value it cannot read.

  This changes behaviour for EXISTING installs, not only fresh ones: the
  direct-spawn path backs `restart` and `upgrade`, so an existing install picks
  the change up on its next restart. (Refs #1502)
