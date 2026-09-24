- **The client's caller abort signal works on every Node version the package allows.**

  `AbortSignal.any` landed in Node 20.3, but this package floors `engines.node`
  at 18, so a caller passing the new optional `signal` on Node 18 / 20.0–20.2
  hit `TypeError: AbortSignal.any is not a function` before the fetch started.
  The client now uses `AbortSignal.any` when it is present and otherwise links
  the per-request timeout signal and the caller signal by hand, honouring an
  already-aborted input and forwarding its abort reason.

  (Refs #1751)
