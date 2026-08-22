- **adk-flair: HTTP timeouts are now configurable — hosted Flair no longer
  false-fails on the hardcoded 1.5s read timeout.** The shipped timeouts are
  deliberate localhost fail-fast tuning (ADK's search path swallows exceptions,
  so a down local Flair must fail instantly), but against a hosted Flair over
  TLS + WAN they timed out ordinary searches with no override available
  (flair#1323). New: `FlairMemoryService(timeout=...)` accepts float seconds
  (read/write, connect derived as `min(timeout, 5.0)`) or a verbatim
  `httpx.Timeout`, plus `FLAIR_HTTP_TIMEOUT` / `FLAIR_HTTP_CONNECT_TIMEOUT`
  env vars (constructor wins). Defaults are unchanged when nothing is set —
  local stays fail-fast. The effective timeouts now log once alongside the
  first-request URL line, so a timeout misconfiguration is diagnosable from
  the agent's own output.
