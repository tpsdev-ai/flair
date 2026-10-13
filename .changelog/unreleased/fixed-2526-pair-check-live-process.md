- **The HTTP/ops pair check now requires both endpoints to report the same running Harper process, not only matching configured ports (#2526).**

  `flair doctor` and the local delete paths (`memory hygiene --apply`, `agent
  remove`) prove the pair through one shared check: the ops endpoint's live
  Harper process id — from its `system_information`, or from the instance's own
  PID file when that answer carries none — and the configured HTTP port's
  `/HealthDetail` must report the same process id. A configuration edited without
  a restart, or otherwise stale, that names ports the live process does not serve
  is refused — as not run for `flair doctor`, and as a refusal for the delete
  paths — even when neither instance has an `Instance` row.
