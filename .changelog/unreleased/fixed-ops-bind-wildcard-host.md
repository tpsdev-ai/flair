- **Health checks now flag wildcard ops-API binds, not just bare ports.** An
  install configured with `--ops-bind 0.0.0.0` (or `::`, `[::]`, or any other
  non-loopback host) writes a host-qualified bind that used to be mistaken for
  a narrowed one, so `flair doctor` and `flair status` could both stay green
  while the ops API was reachable off-box. Only a loopback host (`127.0.0.1`,
  `localhost`, `::1`) now counts as narrowed; everything else is reported as
  exposed. This closes a blind spot that predates the two commands agreeing.
