- **The unit-test lane's home-isolation guard now ends a stuck helper probe on its 10-second bound instead of waiting on it.**

  Before every test run, the lane fingerprints a developer's real client config
  files to prove a sandboxed test stays inside its throwaway HOME, and resolves
  that real home through a short helper probe. When the probe stalled - for
  example a child that ignored the timeout's TERM signal - the guard could sit
  past its 10-second bound and stall the whole run. The timeout now forces the
  kill with SIGKILL, which no process can swallow, and the probe no longer leaves
  its pipes open to a lingering child, so a stuck probe ends on schedule and the
  run keeps going.

   (Refs #1865)
