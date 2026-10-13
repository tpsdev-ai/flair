- **The HTTP/ops pair check now proves from the OS listener table that one Harper process listens on both ports (#2526).**

  `flair doctor` and the local delete paths (`memory hygiene --apply`, `agent
  remove`) share one pair check. Besides the ops endpoint's configuration, it
  now reads the OS listener table (`/proc/net/tcp*` and `/proc/<pid>/fd` on
  Linux, `lsof` elsewhere) and requires one process listening on both the ops
  port and the configured HTTP port, with a Harper command line. A
  configuration that names a port another process serves is refused, whatever
  PID file or process id an endpoint reports. The check sends nothing to the
  HTTP port, so the admin credential never reaches an unproven one.

  The table shows only what the running user can see: a Harper run by another
  user, inside a container, or behind a port forward (docker-proxy, `ssh -L`)
  is refused, never proven, and so is a host where the table cannot be read.
  Each refusal names the reason and a remedy — not run for `flair doctor`, a
  refusal for the delete paths.
