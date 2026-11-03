- **The CLI's agent-key fallback now reports the server's answer instead of resending the same request signed as a different agent.**
  In `src/lib/auth-resolve.ts`, the tier-5 key fallback moves to the next key
  when the server refuses the Ed25519 credential itself (its 401 authentication
  codes) or when a connect-phase failure shows the request never left the host.
  Any other answer — such as a 500, 409, policy 403, refused redirect or a GET
  404 — is thrown as itself, with the server's status and any error code its
  body carries, and a request that was sent with credentials no longer
  surfaces the caller's "no credentials sent" message (#2955).
