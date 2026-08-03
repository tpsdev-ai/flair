- Deactivated principals are now rejected on both authentication paths
  (Ed25519 and Basic/agent-auth).  A deactivated agent can no longer
  authenticate with a new Ed25519 signature or a Basic credential.

  **Known limit:** already-issued OAuth Bearer tokens survive deactivation
  until expiry or explicit revocation.  This slice covers "deactivation
  stops new authentications" only.  Full coverage (Bearer token
  revocation on deactivation) is a follow-up slice.
