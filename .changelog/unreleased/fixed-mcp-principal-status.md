- **The native `/mcp` path checks the principal's status on each tool call it dispatches through a credential mapping.**
  A token's subject maps to a principal through its credential, and that
  principal must exist and be active each time a tool call is dispatched
  through the mapping — the same rule the Ed25519 path applies (a principal
  with no `status` field counts as active). A deactivated or missing principal
  is refused on every tool with an error that names the principal and what an
  operator has to do. A token minted while the principal was active stops
  working when `flair principal disable` deactivates it, and, while the token
  remains valid, works again once the principal's status is set back to
  `active`. If the credential or the principal cannot be read, the call is
  refused, and JIT provisioning runs only for a subject that the credential
  lookup answered for. The credential's `lastUsedAt` is updated, best effort,
  after a tool has run, not when a call is refused or its arguments are
  rejected; the update writes that field alone.
