- **`@tpsdev-ai/flair-client` now sends `X-Flair-Client: flair-client/<version>` on every request.**

  Current published clients (0.18–0.54) sent no library version. A current
  server uses this header to refuse an identified adapter older than 0.18.0 with
  HTTP 426 `stale_flair_client`. Lockstep with the server write-path gate
  (flair#1383). A missing header is still served.

  > **Heads-up:** upgrade `@tpsdev-ai/flair-client` (and `@tpsdev-ai/flair-mcp`)
  > with this release. A server upgrade alone does not identify a silent old
  > client.
