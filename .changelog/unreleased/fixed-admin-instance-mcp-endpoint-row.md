- **The admin Instance page no longer advertises an MCP endpoint that isn't there.** The
  Endpoints table printed `<public-url>/mcp` on every install, but that route is off by
  default — so a default install's own dashboard pointed operators at a URL that returns
  404, which reads as a broken install rather than a disabled feature. The row now shows
  "Not enabled" plus the environment variable that turns the surface on, and shows the URL
  only when the route is genuinely mounted. Nothing to do — the other rows are unchanged
  and were already accurate.

  The row renders from the state the route registration records about its own decision,
  not from a second read of the feature flag, so the page cannot drift from what is
  actually served. That matters because the flag alone was never sufficient: with the flag
  on but no issuer configured, the route still does not mount.
