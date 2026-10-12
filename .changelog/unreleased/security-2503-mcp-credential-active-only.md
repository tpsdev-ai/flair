- **The MCP credential resolver and the principal linker now share one allowlist: a Credential resolves only when its status is "active".**

  A missing, empty, "revoked" or unknown status maps nothing. The resolver refuses
  such a call by name and does not JIT-provision a principal for it, so a revoked
  mapping stays revoked and its row is left unchanged; the linker treats the row as
  not a mapping. Both surfaces import the same predicate.
