- **A cross-agent Memory supersede re-checks its write grant before the close commits (#2333).**

  Closing a superseded memory on behalf of another agent stands on a `write` memory
  grant checked at authorization time. A grant revoked after that check but before
  the close committed still closed the owner's memory. The close now re-checks the
  grant on committed state inside its transaction, after it stages its write — the
  same write-back confirm it already applies to the target row — and stops without
  closing when the grant is gone.
