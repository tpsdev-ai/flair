- **The HTTP/ops pair check now proves from the OS listener table that one process with a Harper command line listens on both ports (#2526).**

  `flair doctor` and the local delete paths (`memory hygiene --apply`, `agent
  remove`) share one pair check. Besides the ops endpoint's configuration, it
  reads the OS listener table (`/proc/net/tcp*` and `/proc/<pid>/fd` on Linux,
  `lsof` elsewhere) and requires one listening process on the ops port and on
  the configured HTTP port: a recognized Harper command line, one pid, and the
  same pid and start time when both are read again. A configuration that names
  a port another process serves is refused, whatever PID file or process id an
  endpoint reports. The check itself sends nothing to the HTTP port, and
  `flair doctor` now runs it before any credentialed request to that port and
  holds those requests until the pair is proven, reporting NOT RUN with the
  reason. One exception: when doctor has no usable admin credential to check
  the pair with, and the probed port's own listener is one stable process
  whose command line matches a Harper pattern, doctor sends that port
  requests with no Authorization header or an Ed25519 signature. No Basic or
  Bearer header goes out in that mode, from any source. A reused pid is refused when the recorded start time
  differs; on macOS the start time has one-second resolution.

  The table shows only the listeners this CLI can see. A listener in another
  network namespace or container, or owned by a user this CLI may not
  inspect, is refused, and so is a port held by a forwarder whose command
  line does not match Harper's (such as docker-proxy or `ssh -L`). The
  command-line check does not authenticate the program. Each refusal names the
  reason and a remedy — not run for `flair doctor`, a refusal for the delete
  paths.
