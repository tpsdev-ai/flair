- **The MCP credential resolver, the principal linker and XAA's jwt-bearer grant share one allowlist: a Credential is usable only when its status is "active".**

  A missing, empty, "revoked" or unknown status maps nothing, and neither does a
  row that names no principal. When Credential rows match a subject but none of
  them maps it, the resolver refuses the call by name, with the credential, its
  stored state and the remedy. The resolver's JIT provisioning runs only when no
  IdP Credential row matches the subject, so a revoked mapping stays revoked and
  its row is left unchanged. The linker treats such a row as not a mapping.
  XAA's jwt-bearer grant refuses, by name, an active credential that names no principal, and issues no grant.
